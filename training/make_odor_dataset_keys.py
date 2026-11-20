"""Which molecules are in the odor training data, for the odor page's search (case-fix-3).

Output odor-predictor/data/dataset_keys.json:
  {"notice": ..., "train": [InChIKey, ...], "valid": [...], "test": [...]}
InChIKeys of the standardized training structures (data/clean.csv: largest fragment,
neutralized, no stereo), sorted. Only membership and split, no odor labels: the curated
GS-LF dataset (OpenPOM) is CC BY-NC and its labels come from The Good Scents Company and
Leffingwell, which do not allow republishing them.
The page matches a searched molecule by full InChIKey, else by its first 14 characters
(connectivity only: stereo not distinguished).
"""
import json
from pathlib import Path

import pandas as pd
from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "odor-predictor" / "data" / "dataset_keys.json"


def main():
    sp = pd.read_csv(Path(__file__).parent / "data" / "split.csv", keep_default_na=False)
    out = {"notice": "InChIKeys of the molecules in the odor model's training data (curated GS-LF dataset, "
                     "OpenPOM) and the split each belongs to. Odor labels are not included."}
    n14 = {}
    for s in ("train", "valid", "test"):
        keys = sorted(Chem.MolToInchiKey(Chem.MolFromSmiles(x)) for x in sp.loc[sp["split"] == s, "smiles"])
        assert all(keys)
        out[s] = keys
        for k in keys:
            n14.setdefault(k[:14], set()).add(s)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    total = sum(len(out[s]) for s in ("train", "valid", "test"))
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e3:.1f} kB, {total} molecules; "
          f"first-14 groups in >1 split: {sum(len(v) > 1 for v in n14.values())})")


if __name__ == "__main__":
    main()
