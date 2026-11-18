"""Reference features of every molecule for odor-predictor/tests/features-all.html.

Covers all cleaned training molecules (data/clean.csv) and the ingredient-finder library
(ingredient-finder/data/library.json), de-duplicated. For each molecule, compact integers:
  atoms: one int per atom, bit k set if X[atom, k] == 1 (26 atom features, featurize_mpnn.py)
  bonds: one int per bond i < j: ((i * 64 + j) * 8 + bond type index) * 2 + in_ring
The browser featurizer must reproduce both lists exactly (0 mismatches).
Multi-fragment SMILES: the largest fragment (first one with the most atoms), as the browser does.
Molecules with an element outside featurize.ELEMENTS (+ H) are refused by the browser on purpose
(engine.js "unsupported_element"); they are listed with "reject": the test expects that error.

Output: odor-predictor/tests/features_all.json
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from rdkit import Chem

from featurize import ELEMENTS
from featurize_mpnn import NUM_BOND_FEATURES, featurize

HERE = Path(__file__).parent
ROOT = HERE.parent
OUT = ROOT / "odor-predictor" / "tests" / "features_all.json"


def largest_fragment(smiles):
    if "." not in smiles:
        return smiles
    frags = Chem.GetMolFrags(Chem.MolFromSmiles(smiles), asMols=True)
    best = max(range(len(frags)), key=lambda k: (frags[k].GetNumAtoms(), -k))
    return Chem.MolToSmiles(frags[best])


def encode(smiles):
    X, E, M = featurize(largest_fragment(smiles))
    n = int(M.sum())
    atoms = [int(sum(1 << k for k in np.flatnonzero(X[i]))) for i in range(n)]
    bonds = []
    for i, j in np.argwhere(np.triu(E[:n, :n].sum(-1)) > 0):
        t = int(np.argmax(E[i, j, :NUM_BOND_FEATURES - 1]))
        bonds.append(((int(i) * 64 + int(j)) * 8 + t) * 2 + int(E[i, j, -1]))
    return atoms, bonds


def main():
    train = pd.read_csv(HERE / "data" / "clean.csv", usecols=["smiles"])["smiles"].tolist()
    lib = json.loads((ROOT / "ingredient-finder" / "data" / "library.json").read_text(encoding="utf-8"))
    library = [m[0] for m in lib["molecules"]]
    seen, mols, skipped = set(), [], []
    for s in train + library:
        if s in seen:
            continue
        seen.add(s)
        if any(a.GetSymbol() not in ELEMENTS for a in Chem.MolFromSmiles(largest_fragment(s)).GetAtoms()):
            mols.append([s, "reject", []])
            continue
        try:
            mols.append([s, *encode(s)])
        except ValueError as e:   # too many atoms: the browser rejects these too
            skipped.append([s, str(e)])
    OUT.write_text(json.dumps({"n_training": len(train), "n_library": len(library), "molecules": mols,
                               "skipped": skipped}, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB): {len(mols)} molecules, {len(skipped)} skipped "
          f"(multi-fragment: {sum('.' in m[0] for m in mols)}, browser rejects: {sum(m[1] == 'reject' for m in mols)})")


if __name__ == "__main__":
    main()
