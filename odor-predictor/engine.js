/*
 * Browser-side featurizer + ONNX model runner. Two model types, chosen by spec.model_type:
 *   "mpnn" (odor model since 2026-11): X + bond tensor E, must match training/featurize_mpnn.py
 *   absent (GCN, taste model): X + normalized adjacency A, must match training/featurize.py
 * tests/parity.html and tests/features-all.html check this against Python.
 * Depends on RDKit.js (MinimalLib) and onnxruntime-web being loaded.
 */
(function () {
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

  const isMpnn = spec => spec.model_type === "mpnn";

  /**
   * Bond tensor of the MPNN (training/featurize_mpnn.py): E [maxAtoms*maxAtoms*FB], symmetric.
   * Bond type one-hot (single, double, triple, aromatic, other): aromatic if RDKit lists the bond
   * as aromatic, else by bond order. In ring: the two atoms are consecutive in one of RDKit's
   * rings (same as RDKit bond.IsInRing(); checked on all molecules by tests/features-all.html).
   */
  function bondTensor(j, spec) {
    const N = spec.max_atoms, FB = spec.num_bond_features;
    const m = j.molecules[0];
    const bonds = m.bonds || [];
    const defBo = j.defaults.bond.bo;
    const ext = (m.extensions || []).find(e => e.name === "rdkitRepresentation") || {};
    const aromaticBonds = new Set(ext.aromaticBonds || []);
    const types = spec.bond_features.find(f => f.name === "bond_type").values;   // single double triple aromatic
    const ringPairs = new Set();
    for (const ring of ext.atomRings || []) {
      for (let k = 0; k < ring.length; k++) {
        const u = ring[k], v = ring[(k + 1) % ring.length];
        ringPairs.add(Math.min(u, v) + "," + Math.max(u, v));
      }
    }
    const E = new Float32Array(N * N * FB);
    bonds.forEach((b, idx) => {
      const [u, v] = b.atoms;
      const bo = b.bo !== undefined ? b.bo : defBo;
      let t;
      if (aromaticBonds.has(idx)) t = types.indexOf("aromatic");
      else if (bo === 1) t = types.indexOf("single");
      else if (bo === 2) t = types.indexOf("double");
      else if (bo === 3) t = types.indexOf("triple");
      else t = types.length;   // other
      const ring = ringPairs.has(Math.min(u, v) + "," + Math.max(u, v)) ? 1 : 0;
      for (const [a, c] of [[u, v], [v, u]]) {
        const base = (a * N + c) * FB;
        E[base + t] = 1;
        E[base + FB - 1] = ring;
      }
    });
    return E;
  }

  /**
   * Featurize an RDKit.js molecule. Returns {X, mask, numAtoms} plus
   * E Float32Array [maxAtoms*maxAtoms*FB] (MPNN) or A Float32Array [maxAtoms*maxAtoms] (GCN).
   * X Float32Array [maxAtoms*F], mask Float32Array [maxAtoms].
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

    const mask = new Float32Array(N);
    mask.fill(1, 0, n);
    if (isMpnn(spec)) return { X, E: bondTensor(j, spec), mask, numAtoms: n };

    // D^-1/2 (A + I) D^-1/2, computed in float64 then stored as float32 (same as numpy)
    const dinv = adj.map(row => 1 / Math.sqrt(row.reduce((s, x) => s + x, 0)));
    const A = new Float32Array(N * N);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < n; k++) {
        if (adj[i][k]) A[i * N + k] = adj[i][k] * dinv[i] * dinv[k];
      }
    }
    return { X, A, mask, numAtoms: n };
  }

  // ONNX Runtime Web is loaded on first use (assets/libs.js, self-hosted in assets/vendor/)
  async function loadModel(modelUrl) {
    const ort = await Libs.ort();
    ort.env.wasm.numThreads = 1;
    return ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] });
  }

  /** Model inputs for a batch of B molecules (arrays already concatenated). */
  function inputs(spec, B, X, AorE, mask) {
    const N = spec.max_atoms, F = spec.num_features;
    const feeds = { X: new ort.Tensor("float32", X, [B, N, F]), mask: new ort.Tensor("float32", mask, [B, N]) };
    if (isMpnn(spec)) feeds.E = new ort.Tensor("float32", AorE, [B, N, N, spec.num_bond_features]);
    else feeds.A = new ort.Tensor("float32", AorE, [B, N, N]);
    return feeds;
  }

  async function predict(session, feats, spec) {
    const out = await session.run(inputs(spec, 1, feats.X, isMpnn(spec) ? feats.E : feats.A, feats.mask));
    return out[spec.model_output.name].data;
  }

  /**
   * MPNN occlusion (training/occlusion.py occlusion_batch_mpnn): atom i is removed by zeroing its
   * feature row, its mask entry and row/column i of E. Runs in chunks of 8 inputs so the
   * pair-message tensors stay small; results equal one big batch.
   */
  async function occlusionMpnn(session, feats, spec) {
    const N = spec.max_atoms, F = spec.num_features, FB = spec.num_bond_features, n = feats.numAtoms;
    const B = n + 1, CHUNK = 8, P = [];
    for (let start = 0; start < B; start += CHUNK) {
      const b = Math.min(CHUNK, B - start);
      const X = new Float32Array(b * N * F), E = new Float32Array(b * N * N * FB), mask = new Float32Array(b * N);
      for (let k = 0; k < b; k++) {
        const r = start + k - 1;   // removed atom; -1 = full molecule
        X.set(feats.X, k * N * F);
        E.set(feats.E, k * N * N * FB);
        mask.set(feats.mask, k * N);
        if (r < 0) continue;
        X.fill(0, k * N * F + r * F, k * N * F + (r + 1) * F);
        mask[k * N + r] = 0;
        const off = k * N * N * FB;
        E.fill(0, off + r * N * FB, off + (r + 1) * N * FB);                  // row r
        for (let i = 0; i < N; i++) E.fill(0, off + (i * N + r) * FB, off + (i * N + r + 1) * FB);   // column r
      }
      const out = await session.run(inputs(spec, b, X, E, mask));
      P.push(out[spec.model_output.name].data);
    }
    const L = P[0].length / Math.min(CHUNK, B);
    const all = new Float32Array(B * L);
    let o = 0;
    for (const p of P) { all.set(p, o); o += p.length; }
    const probs = all.slice(0, L);
    const contrib = [];
    for (let r = 0; r < n; r++) {
      const c = new Float32Array(L);
      for (let j = 0; j < L; j++) c[j] = probs[j] - all[(r + 1) * L + j];
      contrib.push(c);
    }
    return { probs, contrib };
  }

  /**
   * Occlusion attribution (same as training/occlusion.py). Atom i is removed from the graph:
   * feature row and mask zeroed, bonds dropped, adjacency of the other atoms renormalized.
   * All numAtoms + 1 inputs run as one batch. Returns {probs: Float32Array [L],
   * contrib: Array(numAtoms) of Float32Array [L]} with contrib = p(full) - p(without atom i).
   */
  async function occlusion(session, feats, spec) {
    if (isMpnn(spec)) return occlusionMpnn(session, feats, spec);
    const N = spec.max_atoms, F = spec.num_features, n = feats.numAtoms, B = n + 1;
    const X = new Float32Array(B * N * F), A = new Float32Array(B * N * N), mask = new Float32Array(B * N);
    const raw = [];  // bonds + self loops, from the normalized adjacency
    for (let i = 0; i < n; i++) {
      const row = new Float64Array(n);
      for (let k = 0; k < n; k++) row[k] = feats.A[i * N + k] > 0 ? 1 : 0;
      raw.push(row);
    }
    X.set(feats.X, 0); A.set(feats.A, 0); mask.set(feats.mask, 0);
    for (let r = 0; r < n; r++) {
      const b = r + 1;
      X.set(feats.X, b * N * F);
      X.fill(0, b * N * F + r * F, b * N * F + (r + 1) * F);
      mask.set(feats.mask, b * N);
      mask[b * N + r] = 0;
      const deg = raw.map((row, i) => (i === r ? 0 : row.reduce((s, x, k) => s + (k === r ? 0 : x), 0)));
      const dinv = deg.map(v => (v > 0 ? 1 / Math.sqrt(v) : 0));
      for (let i = 0; i < n; i++) {
        if (i === r) continue;
        for (let k = 0; k < n; k++) {
          if (k !== r && raw[i][k]) A[b * N * N + i * N + k] = raw[i][k] * dinv[i] * dinv[k];
        }
      }
    }
    const out = await session.run({
      X: new ort.Tensor("float32", X, [B, N, F]),
      A: new ort.Tensor("float32", A, [B, N, N]),
      mask: new ort.Tensor("float32", mask, [B, N]),
    });
    const P = out[spec.model_output.name].data, L = P.length / B;
    const probs = P.slice(0, L);
    const contrib = [];
    for (let r = 0; r < n; r++) {
      const c = new Float32Array(L);
      for (let j = 0; j < L; j++) c[j] = probs[j] - P[(r + 1) * L + j];
      contrib.push(c);
    }
    return { probs, contrib };
  }

  window.OdorEngine = { EngineError, parseLargestFragment, featurizeMol, loadModel, predict, occlusion };
})();
