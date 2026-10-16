"""Train / valid / test split (80/10/10, fixed seed).

Cyclic molecules: grouped by Bemis-Murcko scaffold, whole groups go to one set.
Acyclic molecules (empty scaffold, ~45% of the data): split individually at random,
otherwise they would form one giant group that can only fit in the training set.

Input:  data/clean.csv
Output: data/split.csv  (columns: smiles, split, scaffold)
"""
from pathlib import Path

import numpy as np
import pandas as pd
from rdkit import Chem
from rdkit.Chem.Scaffolds.MurckoScaffold import MurckoScaffoldSmiles

DATA_DIR = Path(__file__).parent / "data"
SEED = 42
FRAC = {"train": 0.8, "valid": 0.1, "test": 0.1}


def split_acyclic(idx, rng):
    idx = rng.permutation(idx)
    n_tr = round(len(idx) * FRAC["train"])
    n_va = round(len(idx) * FRAC["valid"])
    return {"train": idx[:n_tr], "valid": idx[n_tr:n_tr + n_va], "test": idx[n_tr + n_va:]}


def split_scaffold(groups, n_total, rng):
    """Balanced scaffold split: big groups go to train first, the rest are shuffled."""
    n_va, n_te = FRAC["valid"] * n_total, FRAC["test"] * n_total
    big = [g for g in groups if len(g) > n_te / 2]
    small = [groups[i] for i in rng.permutation(len(groups)) if len(groups[i]) <= n_te / 2]
    out = {"train": [], "valid": [], "test": []}
    for g in big + small:
        if g in big:
            out["train"] += g
        elif len(out["valid"]) + len(g) <= n_va:
            out["valid"] += g
        elif len(out["test"]) + len(g) <= n_te:
            out["test"] += g
        else:
            out["train"] += g
    return out


def main():
    df = pd.read_csv(DATA_DIR / "clean.csv", usecols=["smiles"])
    df["scaffold"] = [MurckoScaffoldSmiles(mol=Chem.MolFromSmiles(s)) for s in df["smiles"]]
    rng = np.random.default_rng(SEED)

    acyclic = df.index[df["scaffold"] == ""].to_numpy()
    cyclic = df[df["scaffold"] != ""]
    groups = [list(g.index) for _, g in cyclic.groupby("scaffold", sort=True)]

    parts_a = split_acyclic(acyclic, rng)
    parts_c = split_scaffold(groups, len(cyclic), rng)

    df["split"] = ""
    for name in FRAC:
        df.loc[list(parts_a[name]) + list(parts_c[name]), "split"] = name
    assert (df["split"] != "").all()

    df[["smiles", "split", "scaffold"]].to_csv(DATA_DIR / "split.csv", index=False)

    df["acyclic"] = df["scaffold"] == ""
    summary = df.groupby("split").agg(
        total=("smiles", "size"), acyclic=("acyclic", "sum"),
        scaffolds=("scaffold", lambda s: s[s != ""].nunique()),
    ).loc[list(FRAC)]
    summary["fraction"] = (summary["total"] / len(df)).round(3)
    print(summary.to_string())

    # Scaffold leakage check (cyclic only)
    sc = {k: set(df.loc[(df["split"] == k) & ~df["acyclic"], "scaffold"]) for k in FRAC}
    print("\nShared scaffolds train&test:", len(sc["train"] & sc["test"]),
          "| train&valid:", len(sc["train"] & sc["valid"]),
          "| valid&test:", len(sc["valid"] & sc["test"]))

    full = pd.read_csv(DATA_DIR / "clean.csv")
    labels = [c for c in full.columns if c != "smiles"]
    for k in ("valid", "test"):
        pos = full.loc[df["split"] == k, labels].sum()
        print(f"{k}: labels with 0 positives = {(pos == 0).sum()}, with < 3 positives = {(pos < 3).sum()}")


if __name__ == "__main__":
    main()
