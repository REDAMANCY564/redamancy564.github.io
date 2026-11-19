/*
 * Hand-over of a molecule from the tool page (index.html) to the "How it predicts" page (process.html).
 *
 * process.html has a strict CSP under which RDKit.js cannot run, so the tool page parses the molecule
 * and stores only the model inputs in sessionStorage (same tab): SMILES, atom count n, the real rows of
 * X (n x 26, 0/1), the bonds with their 6 bond features, and 2D coordinates for the drawing.
 * process.html rebuilds X, E and mask exactly (checked by tests/parity-layers.html) and runs the same
 * model file itself with ONNX Runtime (allowed by 'wasm-unsafe-eval').
 */
(function () {
  const KEY = "odor-process-input";
  const VERSION = 1;
  const OUTPUTS = ["probs", "h0", "h1", "h2", "h3", "m1", "m2", "m3", "pool_mean", "pool_max"];

  /** 2D coordinates of an RDKit.js molecule (CoordGen, as the precomputed molecules). */
  function coordsOf(mol) {
    mol.set_new_coords(true);
    const c = JSON.parse(mol.get_json()).molecules[0].conformers[0].coords;
    return c.map(p => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]);
  }

  /** feats from OdorEngine.featurizeMol (MPNN spec) -> compact plain object. */
  function encode(feats, spec, smiles, coords) {
    const N = spec.max_atoms, F = spec.num_features, FB = spec.num_bond_features, n = feats.numAtoms;
    const bonds = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const o = (i * N + j) * FB;
        const v = Array.from(feats.E.subarray(o, o + FB));
        if (v.some(x => x !== 0)) bonds.push([i, j, v]);
      }
    }
    return { v: VERSION, smiles, n, X: Array.from(feats.X.subarray(0, n * F)), bonds, coords };
  }

  /** Compact object -> {X, E, mask, numAtoms} exactly as featurizeMol returns them. Throws on bad data. */
  function decode(obj, spec) {
    const N = spec.max_atoms, F = spec.num_features, FB = spec.num_bond_features;
    const bad = () => { throw new Error("invalid hand-over data"); };
    if (!obj || obj.v !== VERSION || typeof obj.smiles !== "string") bad();
    const n = obj.n;
    if (!Number.isInteger(n) || n < 1 || n > N) bad();
    if (!Array.isArray(obj.X) || obj.X.length !== n * F || obj.X.some(x => x !== 0 && x !== 1)) bad();
    if (!Array.isArray(obj.coords) || obj.coords.length !== n) bad();
    const X = new Float32Array(N * F), E = new Float32Array(N * N * FB), mask = new Float32Array(N);
    X.set(obj.X);
    mask.fill(1, 0, n);
    for (const b of obj.bonds || []) {
      const [i, j, v] = b;
      if (!(Number.isInteger(i) && Number.isInteger(j) && i >= 0 && j >= 0 && i < n && j < n && i !== j)) bad();
      if (!Array.isArray(v) || v.length !== FB || v.some(x => x !== 0 && x !== 1)) bad();
      E.set(v, (i * N + j) * FB);
      E.set(v, (j * N + i) * FB);
    }
    return { X, E, mask, numAtoms: n };
  }

  /** Store for the next page; returns false if sessionStorage is unavailable or full. */
  function save(obj) {
    try { sessionStorage.setItem(KEY, JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  /** Stored object for this SMILES, or null (missing, other molecule, storage unavailable). */
  function load(smiles) {
    try {
      const obj = JSON.parse(sessionStorage.getItem(KEY) || "null");
      return obj && obj.smiles === smiles ? obj : null;
    } catch (e) { return null; }
  }

  /** Every output of the model for one molecule, as {name: Float32Array}. Needs window.ort. */
  async function runAll(session, feats, spec) {
    const N = spec.max_atoms, F = spec.num_features, FB = spec.num_bond_features;
    const out = await session.run({
      X: new ort.Tensor("float32", feats.X, [1, N, F]),
      E: new ort.Tensor("float32", feats.E, [1, N, N, FB]),
      mask: new ort.Tensor("float32", feats.mask, [1, N]),
    }, OUTPUTS);
    const res = {};
    for (const k of OUTPUTS) res[k] = out[k].data;
    return res;
  }

  window.ProcessHandoff = { KEY, OUTPUTS, coordsOf, encode, decode, save, load, runAll };
})();
