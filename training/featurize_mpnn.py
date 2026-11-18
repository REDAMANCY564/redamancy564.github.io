"""Molecule -> (atom features X, bond features E, atom mask) for the bond-aware MPNN.

Atom features are exactly those of featurize.py (26 one-hot dims, featurize.atom_features),
so the GCN -> MPNN comparison changes only the model and the bond information.

Bond features E[i, j] (6 dims, symmetric, all zero where atoms i and j are not bonded):
  bond type   single, double, triple, aromatic, other     (5, one-hot)
  is in ring  RDKit bond.IsInRing()                        (1)
Bond order and aromaticity are both carried by the type: after RDKit sanitization an
aromatic bond has type AROMATIC (checked: GetIsAromatic() == (type == AROMATIC) on all
training molecules). Conjugation is not used: RDKit.js get_json() does not expose it, so
the browser could not reproduce it exactly.
The model derives adjacency as E.sum(-1) > 0; there is no separate adjacency input.

featurize.py, model.py and odor-predictor/engine.js (featurizeMol) stay unchanged:
the taste predictor depends on them.
"""
import numpy as np
from rdkit import Chem

from featurize import MAX_ATOMS, NUM_FEATURES, atom_features

BOND_TYPES = ["SINGLE", "DOUBLE", "TRIPLE", "AROMATIC"]
NUM_BOND_FEATURES = len(BOND_TYPES) + 1 + 1   # + other, + in ring


def bond_vector(bond, use_bond_features=True):
    """6-dim bond feature. use_bond_features=False: every bond is 'single', not in ring
    (control model: same architecture, bonds carry no information beyond connectivity)."""
    v = np.zeros(NUM_BOND_FEATURES, dtype=np.float32)
    if not use_bond_features:
        v[0] = 1.0
        return v
    name = bond.GetBondType().name
    v[BOND_TYPES.index(name) if name in BOND_TYPES else len(BOND_TYPES)] = 1.0
    v[-1] = float(bond.IsInRing())
    return v


def featurize(smiles, use_bond_features=True):
    """Return X [64, 26], E [64, 64, 6], mask [64] as float32 arrays."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"Invalid SMILES: {smiles}")
    n = mol.GetNumAtoms()
    if n > MAX_ATOMS:
        raise ValueError(f"Too many atoms ({n} > {MAX_ATOMS}): {smiles}")
    X = np.zeros((MAX_ATOMS, NUM_FEATURES), dtype=np.float32)
    for atom in mol.GetAtoms():
        X[atom.GetIdx()] = atom_features(atom)
    E = np.zeros((MAX_ATOMS, MAX_ATOMS, NUM_BOND_FEATURES), dtype=np.float32)
    for bond in mol.GetBonds():
        i, j = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        E[i, j] = E[j, i] = bond_vector(bond, use_bond_features)
    mask = np.zeros(MAX_ATOMS, dtype=np.float32)
    mask[:n] = 1.0
    return X, E, mask


def featurize_many(smiles_list, use_bond_features=True):
    out = [featurize(s, use_bond_features) for s in smiles_list]
    return tuple(np.stack(a) for a in zip(*out))


def check_bonds(smiles_list):
    """Bond type counts and the aromatic-flag consistency check run before training."""
    counts, mismatch, other = {}, 0, 0
    for s in smiles_list:
        for b in Chem.MolFromSmiles(s).GetBonds():
            name = b.GetBondType().name
            counts[name] = counts.get(name, 0) + 1
            mismatch += b.GetIsAromatic() != (name == "AROMATIC")
            other += name not in BOND_TYPES
    return {"bond_type_counts": counts, "aromatic_flag_mismatches": mismatch, "other_type_bonds": other}


if __name__ == "__main__":
    X, E, m = featurize_many(["CC(=O)C(C)=O", "c1ccccc1C=O", "O=C1OCCC1"])
    print("shapes:", X.shape, E.shape, m.shape)
    for k, smi in enumerate(["diacetyl", "benzaldehyde", "butyrolactone"]):
        pairs = np.argwhere(np.triu(E[k].sum(-1)) > 0)
        print(smi, [(int(i), int(j), E[k, i, j].astype(int).tolist()) for i, j in pairs])
