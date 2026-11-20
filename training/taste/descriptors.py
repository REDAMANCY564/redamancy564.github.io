"""Whole-molecule descriptors for the taste model readout (case-fix-3, 2026-11-20).

Computed on the standardized structure (largest fragment, neutralized, no stereo), the same
structure the graph features come from. The browser computes the same values
(taste-predictor/engine.js globalDescriptors): the counts from RDKit.js commonchem JSON, logP,
TPSA and molecular weight from RDKit.js get_descriptors() (CrippenClogP, tpsa, amw).

  heavy_atoms     heavy atoms
  carbons         carbon atoms
  longest_chain   longest path of carbon atoms that are not in a ring (atoms; 0 if none).
                  The non-ring carbons form a forest, so this is the largest tree diameter.
  rings           cyclomatic number: bonds - atoms + connected components
  double_bonds    non-aromatic double bonds (any elements, C=C and C=O alike)
  logp            Wildman-Crippen logP (Crippen.MolLogP)
  tpsa            topological polar surface area (N, O only; RDKit default)
  mol_weight      average molecular weight including hydrogens (Descriptors.MolWt)

The model sees them z-scored with the train-split mean and standard deviation (stored in
feature_spec.json global_descriptors).
"""
from collections import deque

import numpy as np
from rdkit import Chem
from rdkit.Chem import Crippen, Descriptors, rdMolDescriptors

NAMES = ["heavy_atoms", "carbons", "longest_chain", "rings", "double_bonds", "logp", "tpsa", "mol_weight"]


def longest_chain(mol):
    nodes = {a.GetIdx() for a in mol.GetAtoms() if a.GetAtomicNum() == 6 and not a.IsInRing()}
    if not nodes:
        return 0
    adj = {i: [n.GetIdx() for n in mol.GetAtomWithIdx(i).GetNeighbors() if n.GetIdx() in nodes] for i in nodes}

    def far(start):
        dist = {start: 1}
        q = deque([start])
        while q:
            u = q.popleft()
            for v in adj[u]:
                if v not in dist:
                    dist[v] = dist[u] + 1
                    q.append(v)
        end = max(dist, key=lambda k: (dist[k], -k))
        return end, dist[end], dist

    best, seen = 0, set()
    for s in sorted(nodes):
        if s in seen:
            continue
        a, _, comp = far(s)
        seen |= set(comp)
        _, d, _ = far(a)
        best = max(best, d)
    return best


def components(mol):
    return len(Chem.GetMolFrags(mol))


def describe(mol):
    na, nb = mol.GetNumAtoms(), mol.GetNumBonds()
    return [
        na,
        sum(a.GetAtomicNum() == 6 for a in mol.GetAtoms()),
        longest_chain(mol),
        nb - na + components(mol),
        sum(b.GetBondType() == Chem.BondType.DOUBLE for b in mol.GetBonds()),
        Crippen.MolLogP(mol),
        rdMolDescriptors.CalcTPSA(mol),
        Descriptors.MolWt(mol),
    ]


def describe_many(smiles):
    return np.array([describe(Chem.MolFromSmiles(s)) for s in smiles], dtype=np.float64)
