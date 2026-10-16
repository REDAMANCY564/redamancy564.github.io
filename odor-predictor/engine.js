/*
 * Browser-side featurizer + ONNX model runner. Must match training/featurize.py exactly;
 * tests/parity.html checks this against Python on 50 test molecules.
 * Depends on RDKit.js (MinimalLib) and onnxruntime-web being loaded.
 */
(function () {
  const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
  const SYMBOL_TO_Z = { C: 6, N: 7, O: 8, S: 16, F: 9, Cl: 17, Br: 35, I: 53, P: 15 };

  class EngineError extends Error {
    constructor(code, details) {
      super(code);
      this.code = code;          // invalid_smiles | too_many_atoms | unsupported_element
      this.details = details || {};
    }
  }

  function featureLayout(spec) {
    const get = name => spec.atom_features.find(f => f.name === name);
    const elements = get("element").values;
    return {
      elementZ: elements.map(s => SYMBOL_TO_Z[s]),
      nElem: elements.length + 1,          // + "other" bucket
      degrees: get("heavy_degree").values,
      numHs: get("total_num_hs").values,
      charges: get("formal_charge").values,
    };
  }

  /** Parse SMILES with RDKit.js and keep the largest fragment. Returns {mol, fragmentsRemoved}. */
  function parseLargestFragment(rdkit, smiles) {
    const mol = rdkit.get_mol(smiles);
    if (!mol || !mol.is_valid()) {
      if (mol) mol.delete();
      throw new EngineError("invalid_smiles");
    }
    if (!smiles.includes(".")) return { mol, fragmentsRemoved: 0 };
    const frags = mol.get_frags();
    const list = frags.molList;
    let best = null;
    for (let i = 0; i < list.size(); i++) {
      const f = list.at(i);
      if (!best || f.get_num_atoms() > best.get_num_atoms()) {
        if (best) best.delete();
        best = f;
      } else {
        f.delete();
      }
    }
    const removed = list.size() - 1;
    list.delete();
    mol.delete();
    return { mol: best, fragmentsRemoved: removed };
  }

  /**
   * Featurize an RDKit.js molecule. Returns {X, A, mask, numAtoms}:
   * X Float32Array [maxAtoms*F], A Float32Array [maxAtoms*maxAtoms], mask Float32Array [maxAtoms].
   */
  function featurizeMol(mol, spec) {
    const L = featureLayout(spec);
    const N = spec.max_atoms, F = spec.num_features;
    const j = JSON.parse(mol.get_json());
    const m = j.molecules[0];
    const defAtom = j.defaults.atom;
    const atoms = m.atoms || [];
    const bonds = m.bonds || [];
    const ext = (m.extensions || []).find(e => e.name === "rdkitRepresentation") || {};
    const aromatic = new Set(ext.aromaticAtoms || []);
    const inRing = new Set((ext.atomRings || []).flat());

    const n = atoms.length;
    if (n > N) throw new EngineError("too_many_atoms", { n, max: N });

    const z = atoms.map(a => (a.z !== undefined ? a.z : defAtom.z));
    const allowed = new Set(L.elementZ.concat([1]));
    const bad = [...new Set(z.filter(v => !allowed.has(v)))];
    if (bad.length) throw new EngineError("unsupported_element", { z: bad });

    const degree = new Array(n).fill(0);
    const adj = Array.from({ length: n }, (_, i) => {
      const row = new Float64Array(n);
      row[i] = 1;  // self loop
      return row;
    });
    for (const b of bonds) {
      const [u, v] = b.atoms;
      degree[u]++; degree[v]++;
      adj[u][v] = 1; adj[v][u] = 1;
    }

    const X = new Float32Array(N * F);
    for (let i = 0; i < n; i++) {
      const a = atoms[i];
      const base = i * F;
      let k = 0;
      // element one-hot (+ other)
      const e = L.elementZ.indexOf(z[i]);
      X[base + k + (e >= 0 ? e : L.elementZ.length)] = 1;
      k += L.nElem;
      // heavy degree, clipped to max
      const d = Math.min(degree[i], L.degrees[L.degrees.length - 1]);
      X[base + k + L.degrees.indexOf(d)] = 1;
      k += L.degrees.length;
      // total H count, clipped to max
      const hs = a.impHs !== undefined ? a.impHs : defAtom.impHs;
      const h = Math.min(hs, L.numHs[L.numHs.length - 1]);
      X[base + k + L.numHs.indexOf(h)] = 1;
      k += L.numHs.length;
      // formal charge (-1, 0, +1; anything else counts as 0)
      let c = a.chg !== undefined ? a.chg : defAtom.chg;
      if (!L.charges.includes(c)) c = 0;
      X[base + k + L.charges.indexOf(c)] = 1;
      k += L.charges.length;
      X[base + k] = aromatic.has(i) ? 1 : 0;
      X[base + k + 1] = inRing.has(i) ? 1 : 0;
    }

    // D^-1/2 (A + I) D^-1/2, computed in float64 then stored as float32 (same as numpy)
    const dinv = adj.map(row => 1 / Math.sqrt(row.reduce((s, x) => s + x, 0)));
    const A = new Float32Array(N * N);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < n; k++) {
        if (adj[i][k]) A[i * N + k] = adj[i][k] * dinv[i] * dinv[k];
      }
    }
    const mask = new Float32Array(N);
    mask.fill(1, 0, n);
    return { X, A, mask, numAtoms: n };
  }

  async function loadModel(modelUrl) {
    ort.env.wasm.wasmPaths = ORT_DIST;
    ort.env.wasm.numThreads = 1;
    return ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] });
  }

  async function predict(session, feats, spec) {
    const N = spec.max_atoms, F = spec.num_features;
    const out = await session.run({
      X: new ort.Tensor("float32", feats.X, [1, N, F]),
      A: new ort.Tensor("float32", feats.A, [1, N, N]),
      mask: new ort.Tensor("float32", feats.mask, [1, N]),
    });
    return out[spec.model_output.name].data;
  }

  window.OdorEngine = { EngineError, parseLargestFragment, featurizeMol, loadModel, predict };
})();
