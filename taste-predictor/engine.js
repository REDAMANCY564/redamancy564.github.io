/*
 * Taste predictor engine: the odor engine (../odor-predictor/engine.js) plus the
 * standardization step used for the taste training data (training/clean_data.py):
 * largest fragment -> neutralize charges -> featurize.
 *
 * RDKit.js (MinimalLib 2026.3.6) has no neutralize(), so the RDKit Uncharger rules are
 * re-implemented on the molecule's JSON. Neutralization only changes formal charges and
 * hydrogen counts, which are exactly the atom features it affects; the result is passed
 * to OdorEngine.featurizeMol unchanged otherwise. tests/parity.html checks this against
 * Python on salts, ions and zwitterions.
 *
 * Since 2026-11-20 the model also takes whole-molecule descriptors (input D,
 * training/taste/descriptors.py), and the training-data lookup uses Morgan count fingerprints,
 * which RDKit.js does not provide. Both are computed here from the commonchem JSON;
 * tests/parity.html checks them against Python.
 */
(function () {
  const E = window.OdorEngine;

  /**
   * RDKit MolStandardize::Uncharger, applied to a commonchem JSON molecule in place:
   * - "permanent" cations (positive, no H, not next to an anion) cannot be neutralized;
   *   that many anions are kept, acid anions (O- on C/P/S=O) preferred
   * - every other anion not next to a cation gets H added
   * - cations with H, not next to an anion (or next to two), lose H
   * Returns the number of atoms changed.
   */
  function neutralizeJson(j) {
    const m = j.molecules[0];
    const dA = j.defaults.atom, dB = j.defaults.bond;
    const atoms = m.atoms || [], bonds = m.bonds || [];
    const get = (i, key) => (atoms[i][key] !== undefined ? atoms[i][key] : dA[key]);
    const nbrs = atoms.map(() => []);
    for (const b of bonds) {
      const [u, v] = b.atoms;
      const bo = b.bo !== undefined ? b.bo : dB.bo;
      nbrs[u].push([v, bo]);
      nbrs[v].push([u, bo]);
    }
    const chg = i => get(i, "chg");
    const nNbrCharged = (i, sign) => nbrs[i].filter(([k]) => Math.sign(chg(k)) === sign).length;

    let permanent = 0;
    const posH = [], neg = [];
    atoms.forEach((_, i) => {
      const c = chg(i), hs = get(i, "impHs");
      if (c > 0) {
        const nNeg = nNbrCharged(i, -1);
        if (hs > 0 && (nNeg === 0 || nNeg >= 2)) posH.push(i);
        else if (hs === 0 && nNeg === 0) permanent += c;
      } else if (c < 0 && nNbrCharged(i, 1) === 0) {
        neg.push(i);
      }
    });
    const isAcid = i => {
      const z = get(i, "z");
      if (z === 8) {
        return nbrs[i].some(([k]) => [6, 15, 16].includes(get(k, "z")) &&
          nbrs[k].some(([o, bo]) => o !== i && get(o, "z") === 8 && bo === 2));
      }
      return false;  // tetrazole anions are also "acids" in RDKit; not needed for our inputs
    };

    // Anions to neutralize: all of them, unless permanent cations need balancing
    let toNeutralize = neg;
    if (permanent > 0) {
      const surplus = neg.length - permanent;
      const ordered = neg.filter(i => !isAcid(i)).concat(neg.filter(isAcid));
      toNeutralize = surplus > 0 ? ordered.slice(0, surplus) : [];
    }
    let changed = 0;
    const set = (i, c, hs) => { atoms[i].chg = c; atoms[i].impHs = hs; changed++; };
    for (const i of toNeutralize) set(i, 0, get(i, "impHs") - chg(i));
    for (const i of posH) {
      const remove = Math.min(chg(i), get(i, "impHs"));
      set(i, chg(i) - remove, get(i, "impHs") - remove);
    }
    return changed;
  }

  class TasteError extends E.EngineError {}

  /**
   * SMILES -> standardized features. Returns {feats, smiles, fragmentsRemoved, neutralized
   * (atoms changed)}; smiles is the input if nothing changed, else the canonical standardized
   * SMILES, and atom indices of feats follow it. Throws EngineError codes from the odor
   * engine plus "no_carbon" (inorganic, e.g. NaCl: outside the training data).
   */
  function standardizedFeatures(rdkit, smiles, spec) {
    const { mol, fragmentsRemoved } = E.parseLargestFragment(rdkit, smiles);
    let j, fragSmiles;
    try {
      j = JSON.parse(mol.get_json());
      fragSmiles = mol.get_smiles();
    } finally {
      mol.delete();
    }
    const atoms = j.molecules[0].atoms || [];
    const z = a => (a.z !== undefined ? a.z : j.defaults.atom.z);
    if (!atoms.some(a => z(a) === 6)) throw new TasteError("no_carbon");
    const neutralized = neutralizeJson(j);
    const text = JSON.stringify(j);
    if (!fragmentsRemoved && !neutralized) {
      // Already standard: keep the input's atom order, so the input SMILES can be drawn as is
      return { feats: E.featurizeMol({ get_json: () => text }, spec), smiles, fragmentsRemoved, neutralized };
    }
    // Changed: featurize the canonical SMILES of the standardized structure (RDKit.js reads
    // commonchem JSON back), so atom indices match a drawing of the returned SMILES
    if (neutralized) {
      const m2 = rdkit.get_mol(text);
      if (m2) {
        try { fragSmiles = m2.get_smiles(); } finally { m2.delete(); }
      }
    }
    const m3 = rdkit.get_mol(fragSmiles);
    if (!m3) throw new TasteError("invalid_smiles");
    let feats;
    try { feats = E.featurizeMol(m3, spec); } finally { m3.delete(); }
    return { feats, smiles: fragSmiles, fragmentsRemoved, neutralized };
  }

  // ---------- Molecule graph from commonchem JSON ----------
  function graphOf(j) {
    const m = j.molecules[0];
    const dA = j.defaults.atom, dB = j.defaults.bond;
    const atoms = (m.atoms || []).map(a => ({
      z: a.z !== undefined ? a.z : dA.z, hs: a.impHs !== undefined ? a.impHs : dA.impHs,
      chg: a.chg !== undefined ? a.chg : dA.chg,
    }));
    const ext = (m.extensions || []).find(e => e.name === "rdkitRepresentation") || {};
    const aromaticBonds = new Set(ext.aromaticBonds || []);
    const inRing = new Array(atoms.length).fill(false);
    (ext.atomRings || []).forEach(r => r.forEach(i => { inRing[i] = true; }));
    const bonds = (m.bonds || []).map((b, idx) => ({
      u: b.atoms[0], v: b.atoms[1], bo: b.bo !== undefined ? b.bo : dB.bo, aromatic: aromaticBonds.has(idx),
    }));
    const nbrs = atoms.map(() => []);   // [other atom, bond index]
    bonds.forEach((b, k) => { nbrs[b.u].push([b.v, k]); nbrs[b.v].push([b.u, k]); });
    return { atoms, bonds, nbrs, inRing };
  }

  // ---------- Morgan count fingerprint (training/taste/morgan_counts.py) ----------
  // The Morgan algorithm of RDKit, radius 2, default invariants, uint32 hash_combine.
  function hashCombine(seed, v) {
    return (seed ^ (((v >>> 0) + 0x9e3779b9 + ((seed << 6) >>> 0) + (seed >>> 2)) >>> 0)) >>> 0;
  }
  function hashRange(vals) { let s = 0; for (const v of vals) s = hashCombine(s, v); return s; }

  /** {bits: sorted bit indices, counts: counts in the same order} for a commonchem JSON molecule. */
  function morganCounts(j, radius = 2, nBits = 2048) {
    const g = graphOf(j), n = g.atoms.length;
    let inv = g.atoms.map((a, i) => {
      const comp = [a.z, g.nbrs[i].length + a.hs, a.hs, a.chg, 0];
      if (g.inRing[i]) comp.push(1);
      return hashRange(comp);
    });
    const codes = inv.slice();
    let nbh = g.atoms.map(() => []);         // sorted bond indices within the radius
    const dead = new Array(n).fill(false);
    const seen = new Set();
    for (let layer = 0; layer < radius; layer++) {
      const nxt = inv.slice(), roundNbh = nbh.slice();
      const best = new Map();                // environment key -> [invariant, atom] kept
      const live = [];
      for (let i = 0; i < n; i++) {
        if (dead[i]) continue;
        if (!g.nbrs[i].length) { dead[i] = true; continue; }
        const bonds = new Set(nbh[i]);
        const pairs = [];
        for (const [o, k] of g.nbrs[i]) {
          bonds.add(k);
          nbh[o].forEach(x => bonds.add(x));
          const b = g.bonds[k];
          pairs.push([b.aromatic ? 12 : b.bo, inv[o]]);   // RDKit BondType: 1, 2, 3, aromatic 12
        }
        roundNbh[i] = Array.from(bonds).sort((a, b) => a - b);
        pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        let h = hashCombine(layer, inv[i]);
        for (const p of pairs) h = hashCombine(h, hashRange(p));
        nxt[i] = h;
        live.push(i);
        const key = roundNbh[i].join(",");
        const prev = best.get(key);
        if (!prev || h < prev[0] || (h === prev[0] && i < prev[1])) best.set(key, [h, i]);
      }
      // An environment seen in an earlier layer, or kept for another atom of this layer, is dropped
      // and its atom stops growing; of equal environments in one layer the smallest invariant is kept
      for (const i of live) {
        const key = roundNbh[i].join(",");
        if (seen.has(key) || best.get(key)[1] !== i) dead[i] = true;
        else codes.push(nxt[i]);
      }
      for (const key of best.keys()) seen.add(key);
      inv = nxt;
      nbh = roundNbh;
    }
    const counts = new Map();
    for (const c of codes) { const b = c % nBits; counts.set(b, (counts.get(b) || 0) + 1); }
    const bits = Array.from(counts.keys()).sort((a, b) => a - b);
    return { bits, counts: bits.map(b => counts.get(b)) };
  }

  // ---------- Whole-molecule descriptors (training/taste/descriptors.py) ----------
  /** Longest path of non-ring carbons, in atoms (largest tree diameter of that forest). */
  function longestChain(g) {
    const ok = i => g.atoms[i].z === 6 && !g.inRing[i];
    const far = start => {
      const dist = new Map([[start, 1]]), q = [start];
      for (let h = 0; h < q.length; h++) {
        const u = q[h];
        for (const [v] of g.nbrs[u]) if (ok(v) && !dist.has(v)) { dist.set(v, dist.get(u) + 1); q.push(v); }
      }
      let end = start;
      for (const [k, d] of dist) if (d > dist.get(end)) end = k;
      return { end, d: dist.get(end), comp: dist };
    };
    let best = 0;
    const done = new Set();
    for (let i = 0; i < g.atoms.length; i++) {
      if (!ok(i) || done.has(i)) continue;
      const a = far(i);
      a.comp.forEach((_, k) => done.add(k));
      best = Math.max(best, far(a.end).d);
    }
    return best;
  }

  /**
   * Raw descriptors by name for a standardized SMILES: counts from the JSON, logP / TPSA /
   * molecular weight from RDKit.js get_descriptors() (CrippenClogP, tpsa, amw).
   */
  function globalDescriptors(rdkit, smiles) {
    const mol = rdkit.get_mol(smiles);
    if (!mol) throw new TasteError("invalid_smiles");
    let j, desc;
    try {
      j = JSON.parse(mol.get_json());
      desc = JSON.parse(mol.get_descriptors());
    } finally {
      mol.delete();
    }
    const g = graphOf(j), na = g.atoms.length;
    const parent = g.atoms.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    g.bonds.forEach(b => { parent[find(b.u)] = find(b.v); });
    const comps = new Set(g.atoms.map((_, i) => find(i))).size;
    return {
      heavy_atoms: na,
      carbons: g.atoms.filter(a => a.z === 6).length,
      longest_chain: longestChain(g),
      rings: g.bonds.length - na + comps,
      double_bonds: g.bonds.filter(b => b.bo === 2 && !b.aromatic).length,
      logp: desc.CrippenClogP,
      tpsa: desc.tpsa,
      mol_weight: desc.amw,
    };
  }

  /** Model input D (z-scored, spec.global_descriptors) for a standardized SMILES; null if the model has none. */
  function descriptorInput(rdkit, smiles, spec) {
    const gd = spec.global_descriptors;
    if (!gd) return null;
    const raw = globalDescriptors(rdkit, smiles);
    return Float32Array.from(gd.names.map((k, i) => (raw[k] - gd.mean[i]) / gd.std[i]));
  }

  /**
   * The ONNX session with input D added to every run. All inputs of a batch get the same
   * descriptors: occlusion removes atoms from the graph but keeps the whole molecule's
   * descriptors, as training/taste/make_site_assets.py does.
   */
  function withDescriptors(session, D) {
    if (!D) return session;
    return {
      run(feeds, outputs) {
        const B = feeds.X.dims[0], arr = new Float32Array(B * D.length);
        for (let b = 0; b < B; b++) arr.set(D, b * D.length);
        const Tensor = feeds.X.constructor;
        return session.run(Object.assign({}, feeds, { D: new Tensor("float32", arr, [B, D.length]) }), outputs);
      },
    };
  }

  // ---------- Training-data records and applicability domain ----------
  const SOURCES = { C: "ChemTastesDB", V: "VirtuousMultiTaste" };
  const LABEL_COLS = ["sweet", "bitter", "umami", "tasteless", "sour", "salty"];

  /**
   * Parse data/dataset.json ({records: [[InChIKey, name, labels, sources, split, raw]]}) and
   * data/fps.bin (uint32 offsets [n + 1], uint16 Morgan bit indices, then uint8 counts in the
   * same order) built by training/taste/make_dataset_lookup.py.
   */
  function parseDataset(json, fpsBuf) {
    const recs = json.records, n = recs.length;
    const byKey = new Map(), by14 = new Map();
    const push = (m, k, i) => { if (!m.has(k)) m.set(k, []); m.get(k).push(i); };
    recs.forEach((r, i) => { push(byKey, r[0], i); push(by14, r[0].slice(0, 14), i); });
    const offsets = new Uint32Array(fpsBuf, 0, n + 1);
    const bits = new Uint16Array(fpsBuf, (n + 1) * 4, offsets[n]);
    const counts = new Uint8Array(fpsBuf, (n + 1) * 4 + offsets[n] * 2, offsets[n]);
    return { recs, n, byKey, by14, offsets, bits, counts };
  }

  /** Training record i as {name, labels {sweet..salty: 1 | 0 | null}, sources, split, raw}. */
  function record(ds, i) {
    const r = ds.recs[i];
    const labels = {};
    LABEL_COLS.forEach((c, k) => { labels[c] = r[2][k] === "-" ? null : +r[2][k]; });
    return { name: r[1], labels, sources: r[3].split("").map(c => SOURCES[c]), split: r[4], raw: r[5] };
  }

  /** Sorted on-bit list from an RDKit.js bit string ("0101..."). */
  function bitsFromString(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 49) out.push(i);
    return out;
  }

  /** Count Tanimoto (sum of min / sum of max) of two sorted bit lists with their counts. */
  function tanimoto(a, ca, b, cb) {
    let i = 0, j = 0, mn = 0, mx = 0;
    while (i < a.length || j < b.length) {
      if (j >= b.length || (i < a.length && a[i] < b[j])) { mx += ca[i++]; }
      else if (i >= a.length || b[j] < a[i]) { mx += cb[j++]; }
      else { mn += Math.min(ca[i], cb[j]); mx += Math.max(ca[i], cb[j]); i++; j++; }
    }
    return mx ? mn / mx : 0;
  }

  /**
   * Look up a (standardized) molecule in the training data.
   * matches: by full InChIKey (exact: true); if none, by its first 14 characters, i.e. the
   * connectivity without stereo (exact: false). The training structures carry no stereo, so a
   * searched stereoisomer matches here. nn: the most similar training molecule by count Tanimoto
   * of Morgan count fingerprints (radius 2, 2048 bits, same as Python).
   */
  function datasetMatch(rdkit, smiles, ds) {
    const mol = rdkit.get_mol(smiles);
    if (!mol) return null;
    let key = null, q;
    try {
      const inchi = mol.get_inchi();
      if (inchi) key = rdkit.get_inchikey_for_inchi(inchi) || null;
      q = morganCounts(JSON.parse(mol.get_json()));
      // self-check: the bits must be the Morgan bits RDKit.js computes itself
      const ref = bitsFromString(mol.get_morgan_fp(JSON.stringify({ radius: 2, nBits: 2048 })));
      if (ref.length !== q.bits.length || ref.some((b, k) => b !== q.bits[k])) {
        console.error("Morgan count fingerprint differs from the RDKit.js bits", smiles);
      }
    } finally {
      mol.delete();
    }
    let matches = [];
    if (key) {
      const ex = ds.byKey.get(key);
      matches = ex ? ex.map(index => ({ index, exact: true }))
        : (ds.by14.get(key.slice(0, 14)) || []).map(index => ({ index, exact: false }));
    }
    let best = -1, bestT = -1;
    for (let i = 0; i < ds.n; i++) {
      const a = ds.offsets[i], z = ds.offsets[i + 1];
      const t = tanimoto(q.bits, q.counts, ds.bits.subarray(a, z), ds.counts.subarray(a, z));
      if (t > bestT) { bestT = t; best = i; }
    }
    return { key, bits: q.bits, counts: q.counts, matches, nn: { index: best, tanimoto: bestT } };
  }

  window.TasteEngine = Object.assign({}, E, {
    neutralizeJson, standardizedFeatures, parseDataset, record, datasetMatch, tanimoto,
    morganCounts, globalDescriptors, descriptorInput, withDescriptors,
  });
})();
