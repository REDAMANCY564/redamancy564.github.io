"""Molecule -> (atom features X, normalized adjacency A, atom mask).

These rules are the contract with the browser (odor-predictor/app.js); they are
written to odor-predictor/model/feature_spec.json. Any change here must be mirrored in JS.

Atom features (one-hot blocks, concatenated in this order):
  element        C N O S F Cl Br I P, other           (10)
  heavy degree   0..5, values > 5 -> 5                (6)
  total H count  0..4, values > 4 -> 4                (5)
  formal charge  -1, 0, +1, any other value -> 0      (3)
  is aromatic                                          (1)
  is in ring                                           (1)
Adjacency: 1 if bonded (bond type ignored), plus self loops, then symmetric
normalization D^-1/2 (A + I) D^-1/2 over real atoms. Padded rows/cols are 0.
"""
import json
from pathlib import Path

import numpy as np
from rdkit import Chem

MAX_ATOMS = 64
ELEMENTS = ["C", "N", "O", "S", "F", "Cl", "Br", "I", "P"]
DEGREES = [0, 1, 2, 3, 4, 5]
NUM_HS = [0, 1, 2, 3, 4]
CHARGES = [-1, 0, 1]
NUM_FEATURES = len(ELEMENTS) + 1 + len(DEGREES) + len(NUM_HS) + len(CHARGES) + 2

ROOT = Path(__file__).resolve().parent.parent
SPEC_PATH = ROOT / "odor-predictor" / "model" / "feature_spec.json"


def atom_features(atom):
    sym = atom.GetSymbol()
    elem = [float(sym == e) for e in ELEMENTS] + [float(sym not in ELEMENTS)]
    deg = min(atom.GetDegree(), DEGREES[-1])
    nh = min(atom.GetTotalNumHs(), NUM_HS[-1])
    chg = atom.GetFormalCharge()
    chg = chg if chg in CHARGES else 0
    return (
        elem
        + [float(deg == d) for d in DEGREES]
        + [float(nh == h) for h in NUM_HS]
        + [float(chg == c) for c in CHARGES]
        + [float(atom.GetIsAromatic()), float(atom.IsInRing())]
    )


def featurize(smiles):
    """Return X [64, F], A [64, 64], mask [64] as float32 arrays."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"Invalid SMILES: {smiles}")
    n = mol.GetNumAtoms()
    if n > MAX_ATOMS:
        raise ValueError(f"Too many atoms ({n} > {MAX_ATOMS}): {smiles}")

    X = np.zeros((MAX_ATOMS, NUM_FEATURES), dtype=np.float32)
    for atom in mol.GetAtoms():
        X[atom.GetIdx()] = atom_features(atom)

    adj = np.eye(n, dtype=np.float64)
    for bond in mol.GetBonds():
        i, j = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        adj[i, j] = adj[j, i] = 1.0
    d = 1.0 / np.sqrt(adj.sum(axis=1))
    A = np.zeros((MAX_ATOMS, MAX_ATOMS), dtype=np.float32)
    A[:n, :n] = adj * d[:, None] * d[None, :]

    mask = np.zeros(MAX_ATOMS, dtype=np.float32)
    mask[:n] = 1.0
    return X, A, mask


def featurize_many(smiles_list):
    out = [featurize(s) for s in smiles_list]
    return tuple(np.stack(a) for a in zip(*out))


def write_spec():
    spec = {
        "max_atoms": MAX_ATOMS,
        "num_features": NUM_FEATURES,
        "atom_features": [
            {"name": "element", "values": ELEMENTS, "other_bucket": True},
            {"name": "heavy_degree", "values": DEGREES, "clip": "above max -> max"},
            {"name": "total_num_hs", "values": NUM_HS, "clip": "above max -> max"},
            {"name": "formal_charge", "values": CHARGES, "other_value_maps_to": 0},
            {"name": "is_aromatic", "binary": True},
            {"name": "is_in_ring", "binary": True},
        ],
        "adjacency": "bonded=1 (bond type ignored) + self loops; D^-1/2 (A+I) D^-1/2; padded rows/cols 0",
        "mask": "1 for real atoms, 0 for padding",
        "atom_order": "RDKit atom index of the parsed (non-stereo) SMILES, hydrogens implicit",
        "model_inputs": {"X": "[B, 64, F] float32", "A": "[B, 64, 64] float32", "mask": "[B, 64] float32"},
    }
    SPEC_PATH.parent.mkdir(parents=True, exist_ok=True)
    SPEC_PATH.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    print(f"Wrote {SPEC_PATH}")


if __name__ == "__main__":
    write_spec()
    X, A, m = featurize_many(["CC(=O)C(C)=O", "COc1cc(C=O)ccc1O"])
    print("NUM_FEATURES =", NUM_FEATURES, "| shapes:", X.shape, A.shape, m.shape)
    print("vanillin atom 0 (methyl C):", X[1, 0].astype(int).tolist())
    print("vanillin row sums of A (first 3):", A[1, :3].sum(axis=1).round(3).tolist())
