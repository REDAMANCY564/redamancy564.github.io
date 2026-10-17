"""Flag drug-like molecules (ChEMBL max_phase >= 1) to assess source bias, e.g. in bitter.

Matching uses the InChIKey connectivity block (first 14 characters), because the taste
SMILES carry no stereo. Salts in ChEMBL have their own keys, but our molecules are
neutralized parents, which ChEMBL also lists.

Input:  data/taste/clean.csv, data/taste/chembl_clinical.csv
Output: data/taste/drug_flags.csv  (smiles, chembl_id, max_phase)
"""
import sys
from pathlib import Path

import pandas as pd
from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")
sys.stdout.reconfigure(encoding="utf-8")
DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "taste"
CLASSES = ["sweet", "bitter", "umami", "tasteless", "sour", "salty"]


def main():
    df = pd.read_csv(DATA_DIR / "clean.csv")
    ch = pd.read_csv(DATA_DIR / "chembl_clinical.csv")
    ch["k"] = ch["inchikey"].str[:14]
    ch = ch.sort_values("max_phase", ascending=False).drop_duplicates("k")
    df["k"] = df["smiles"].map(lambda s: Chem.MolToInchiKey(Chem.MolFromSmiles(s))[:14])
    df = df.merge(ch[["k", "chembl_id", "pref_name", "max_phase"]], on="k", how="left")
    df["drug"] = df["max_phase"].notna()
    df["approved"] = df["max_phase"] == 4
    df[["smiles", "chembl_id", "pref_name", "max_phase"]].to_csv(DATA_DIR / "drug_flags.csv", index=False)

    print(f"Molecules with ChEMBL max_phase >= 1: {df['drug'].sum()} / {len(df)} "
          f"(approved, phase 4: {df['approved'].sum()})")
    print(f"{'class':10s} {'pos':>5s} {'drug':>5s} {'%':>6s} {'approved %':>11s}")
    for c in CLASSES:
        p = df[df[c] == 1]
        print(f"{c:10s} {len(p):5d} {p['drug'].sum():5d} {100 * p['drug'].mean():5.1f}% "
              f"{100 * p['approved'].mean():10.1f}%")
    print("\nExamples of bitter drug matches:",
          df.loc[(df["bitter"] == 1) & df["drug"], "pref_name"].dropna().head(12).tolist())


if __name__ == "__main__":
    main()
