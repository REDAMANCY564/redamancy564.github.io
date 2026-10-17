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
   * SMILES -> standardized features. Returns {feats, smiles (largest fragment, as parsed),
   * fragmentsRemoved, neutralized (atoms changed)}. Throws EngineError codes from the odor
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
    const feats = E.featurizeMol({ get_json: () => text }, spec);
    // Display SMILES of the neutralized structure (RDKit.js reads commonchem JSON back)
    if (neutralized) {
      const m2 = rdkit.get_mol(text);
      if (m2) {
        try { fragSmiles = m2.get_smiles(); } finally { m2.delete(); }
      }
    }
    return { feats, smiles: fragSmiles, fragmentsRemoved, neutralized };
  }

  window.TasteEngine = Object.assign({}, E, { neutralizeJson, standardizedFeatures });
})();
