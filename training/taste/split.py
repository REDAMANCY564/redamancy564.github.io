"""Train / valid / test split for the taste data, same mixed rule as the odor data:
cyclic molecules by Murcko scaffold group, acyclic molecules individually at random
(80/10/10, seed 42). Reuses the functions in training/split.py.

Input:  data/taste/clean.csv, data/taste/drug_flags.csv
Output: data/taste/split.csv  (smiles, split, scaffold)
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from rdkit import Chem
from rdkit.Chem.Scaffolds.MurckoScaffold import MurckoScaffoldSmiles

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from split import FRAC, SEED, split_acyclic, split_scaffold  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "taste"
MODELLED = ["sweet", "bitter", "umami", "tasteless"]


def main():
    df = pd.read_csv(DATA_DIR / "clean.csv")
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
    drug = pd.read_csv(DATA_DIR / "drug_flags.csv")["max_phase"].notna().to_numpy()
    df["drug"] = drug
    summary = df.groupby("split").agg(
        total=("smiles", "size"), acyclic=("acyclic", "sum"), drug=("drug", "sum"),
        scaffolds=("scaffold", lambda s: s[s != ""].nunique()),
    ).loc[list(FRAC)]
    summary["fraction"] = (summary["total"] / len(df)).round(3)
    print(f"Acyclic molecules: {df['acyclic'].sum()} / {len(df)} ({100 * df['acyclic'].mean():.1f}%)")
    print(summary.to_string())

    sc = {k: set(df.loc[(df["split"] == k) & ~df["acyclic"], "scaffold"]) for k in FRAC}
    print("\nShared scaffolds train&test:", len(sc["train"] & sc["test"]),
          "| train&valid:", len(sc["train"] & sc["valid"]),
          "| valid&test:", len(sc["valid"] & sc["test"]))

    print("\nPositives / negatives per split:")
    tab = {c: [f"{int((g[c] == 1).sum())}/{int((g[c] == 0).sum())}" for _, g in
               df.groupby("split").__iter__()] for c in MODELLED}
    order = [k for k, _ in df.groupby("split")]
    print(pd.DataFrame(tab, index=order).loc[list(FRAC)].to_string())


if __name__ == "__main__":
    main()
