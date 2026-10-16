"""Clean the GS-LF dataset: parse, keep largest fragment, neutralize, canonicalize,
deduplicate (union of labels), drop large molecules and rare labels.

Input:  data/curated_GS_LF_merged_4983.csv
Output: data/clean.csv  (columns: smiles, <label_1>, ..., <label_N>)
"""
from pathlib import Path

import pandas as pd
from rdkit import Chem, RDLogger
from rdkit.Chem.MolStandardize import rdMolStandardize

RDLogger.DisableLog("rdApp.*")

DATA_DIR = Path(__file__).parent / "data"
RAW = DATA_DIR / "curated_GS_LF_merged_4983.csv"
OUT = DATA_DIR / "clean.csv"

MAX_ATOMS = 64        # must match the model's padded size (see feature_spec.json)
MIN_POSITIVES = 20    # drop labels with fewer positive molecules than this

_chooser = rdMolStandardize.LargestFragmentChooser()
_uncharger = rdMolStandardize.Uncharger()


def standardize(smiles):
    """Return canonical non-stereo SMILES of the neutralized largest fragment, or None."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    mol = _uncharger.uncharge(_chooser.choose(mol))
    return Chem.MolToSmiles(mol, isomericSmiles=False)


def main():
    raw = pd.read_csv(RAW)
    label_cols = [c for c in raw.columns if c not in ("nonStereoSMILES", "descriptors")]
    print(f"Raw: {len(raw)} molecules, {len(label_cols)} labels")

    smiles = raw["nonStereoSMILES"].map(standardize).rename("smiles")
    raw = pd.concat([smiles, raw[label_cols]], axis=1).copy()
    n_bad = raw["smiles"].isna().sum()
    raw = raw.dropna(subset=["smiles"])
    print(f"Unparsable dropped: {n_bad}")

    n_atoms = raw["smiles"].map(lambda s: Chem.MolFromSmiles(s).GetNumHeavyAtoms())
    print(f"Heavy atoms > {MAX_ATOMS} dropped: {(n_atoms > MAX_ATOMS).sum()}")
    raw = raw[n_atoms <= MAX_ATOMS]

    # Duplicates after standardization (e.g. a salt and its free acid): union of labels
    df = raw.groupby("smiles", sort=False)[label_cols].max().reset_index()
    print(f"Duplicates merged: {len(raw) - len(df)}")

    pos = df[label_cols].sum()
    kept = [c for c in label_cols if pos[c] >= MIN_POSITIVES]
    print(f"Labels with < {MIN_POSITIVES} positives dropped: {len(label_cols) - len(kept)}")

    df = df[["smiles"] + kept]
    no_label = df[kept].sum(axis=1) == 0
    print(f"Molecules left with no label dropped: {no_label.sum()}")
    df = df[~no_label].reset_index(drop=True)

    df.to_csv(OUT, index=False)
    print(f"\nClean: {len(df)} molecules, {len(kept)} labels -> {OUT}")


if __name__ == "__main__":
    main()
