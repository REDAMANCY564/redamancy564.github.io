"""Morgan count fingerprint (radius 2, 2048 bits) re-implemented from RDKit's algorithm.

RDKit.js (MinimalLib) only returns bit fingerprints, so taste-predictor/engine.js computes the
counts itself with this algorithm; this Python copy exists to check the algorithm against
RDKit (rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)
.GetCountFingerprintAsNumPy) on every training molecule:  python morgan_counts.py

Algorithm (RDKit MorganGenerator, default options):
  hash_combine(seed, v): seed ^= v + 0x9e3779b9 + (seed << 6) + (seed >> 2), all uint32
  atom invariant = hash_range([atomic number, total degree, total H, formal charge, delta mass,
                   1 if the atom is in a ring])
  layer l (0, 1): new invariant = hash_combine over l, the atom's invariant, then each
                  (bond type, neighbour invariant) pair sorted (pair hash = hash_range of the
                  two); bond type = RDKit enum (single 1, double 2, triple 3, aromatic 12)
  an environment (set of bonds within the radius) already seen, in this layer or an earlier
  one, is dropped and its atom stops growing; within a layer, equal environments keep the
  smallest invariant. Bit = invariant mod 2048; count = number of environments on that bit.
"""
from rdkit import Chem

M32 = 0xFFFFFFFF
BOND_TYPE = {Chem.BondType.SINGLE: 1, Chem.BondType.DOUBLE: 2, Chem.BondType.TRIPLE: 3, Chem.BondType.AROMATIC: 12}


def hash_combine(seed, v):
    return (seed ^ ((v & M32) + 0x9E3779B9 + ((seed << 6) & M32) + (seed >> 2))) & M32


def hash_range(vals):
    seed = 0
    for v in vals:
        seed = hash_combine(seed, v)
    return seed


def morgan_counts(mol, radius=2, n_bits=2048):
    n = mol.GetNumAtoms()
    ri = mol.GetRingInfo()
    inv = []
    for a in mol.GetAtoms():
        comp = [a.GetAtomicNum(), a.GetTotalDegree(), a.GetTotalNumHs(), a.GetFormalCharge(), 0]
        if ri.NumAtomRings(a.GetIdx()):
            comp.append(1)
        inv.append(hash_range(comp))
    codes = list(inv)
    nbh = [frozenset() for _ in range(n)]
    dead = [False] * n
    seen = []
    for layer in range(radius):
        nxt = list(inv)
        round_nbh = list(nbh)
        this_round = []
        for i in range(n):
            if dead[i]:
                continue
            a = mol.GetAtomWithIdx(i)
            if a.GetDegree() == 0:
                dead[i] = True
                continue
            bonds = set(nbh[i])
            pairs = []
            for b in a.GetBonds():
                bonds.add(b.GetIdx())
                o = b.GetOtherAtomIdx(i)
                bonds |= nbh[o]
                pairs.append((BOND_TYPE.get(b.GetBondType(), int(b.GetBondType())), inv[o]))
            round_nbh[i] = frozenset(bonds)
            pairs.sort()
            h = layer
            h = hash_combine(h, inv[i])
            for bt, v in pairs:
                h = hash_combine(h, hash_range([bt, v]))
            nxt[i] = h
            this_round.append((round_nbh[i], h, i))
        # equal environments: smallest invariant first (then atom index), as RDKit's tuple sort
        this_round.sort(key=lambda t: (sorted(t[0]), t[1], t[2]))
        for env, h, i in this_round:
            if env in seen:
                dead[i] = True
            else:
                codes.append(h)
                seen.append(env)
        inv = nxt
        nbh = round_nbh
    counts = {}
    for c in codes:
        counts[c % n_bits] = counts.get(c % n_bits, 0) + 1
    return counts


if __name__ == "__main__":
    import numpy as np
    from rdkit.Chem import rdFingerprintGenerator

    from common import load
    gen = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)
    bad = 0
    smiles = load()["smiles"]
    for s in smiles:
        m = Chem.MolFromSmiles(s)
        ref = gen.GetCountFingerprintAsNumPy(m)
        got = np.zeros(2048, dtype=ref.dtype)
        for k, v in morgan_counts(m).items():
            got[k] = v
        if not (ref == got).all():
            bad += 1
            if bad <= 5:
                print("differs:", s)
    print(f"{len(smiles) - bad}/{len(smiles)} molecules identical to RDKit")
