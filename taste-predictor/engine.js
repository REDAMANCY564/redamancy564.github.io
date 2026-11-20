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

  // ---------- Training-data records and applicability domain ----------
  const SOURCES = { C: "ChemTastesDB", V: "VirtuousMultiTaste" };
  const LABEL_COLS = ["sweet", "bitter", "umami", "tasteless", "sour", "salty"];

  /**
   * Parse data/dataset.json ({records: [[InChIKey, name, labels, sources, split, raw]]}) and
   * data/fps.bin (uint32 offsets [n + 1], then uint16 Morgan on-bits) built by
   * training/taste/make_dataset_lookup.py.
   */
  function parseDataset(json, fpsBuf) {
    const recs = json.records, n = recs.length;
    const byKey = new Map(), by14 = new Map();
    const push = (m, k, i) => { if (!m.has(k)) m.set(k, []); m.get(k).push(i); };
    recs.forEach((r, i) => { push(byKey, r[0], i); push(by14, r[0].slice(0, 14), i); });
    const offsets = new Uint32Array(fpsBuf, 0, n + 1);
    const bits = new Uint16Array(fpsBuf, (n + 1) * 4, offsets[n]);
    return { recs, n, byKey, by14, offsets, bits };
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

  /** Tanimoto of two sorted on-bit lists. */
  function tanimoto(a, b) {
    let i = 0, j = 0, inter = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { inter++; i++; j++; } else if (a[i] < b[j]) i++; else j++;
    }
    const union = a.length + b.length - inter;
    return union ? inter / union : 0;
  }

  /**
   * Look up a (standardized) molecule in the training data.
   * matches: by full InChIKey (exact: true); if none, by its first 14 characters, i.e. the
   * connectivity without stereo (exact: false). The training structures carry no stereo, so a
   * searched stereoisomer matches here. nn: the most similar training molecule by Tanimoto of
   * Morgan fingerprints (radius 2, 2048 bits, same as Python).
   */
  function datasetMatch(rdkit, smiles, ds) {
    const mol = rdkit.get_mol(smiles);
    if (!mol) return null;
    let key = null, q;
    try {
      const inchi = mol.get_inchi();
      if (inchi) key = rdkit.get_inchikey_for_inchi(inchi) || null;
      q = bitsFromString(mol.get_morgan_fp(JSON.stringify({ radius: 2, nBits: 2048 })));
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
      const t = tanimoto(q, ds.bits.subarray(ds.offsets[i], ds.offsets[i + 1]));
      if (t > bestT) { bestT = t; best = i; }
    }
    return { key, bits: q, matches, nn: { index: best, tanimoto: bestT } };
  }

  window.TasteEngine = Object.assign({}, E, {
    neutralizeJson, standardizedFeatures, parseDataset, record, datasetMatch, tanimoto,
  });
})();
