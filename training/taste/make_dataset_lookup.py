"""Website data for showing training-data records and the applicability-domain hint.

Outputs (taste-predictor/data/):
  dataset.json   {"notice": licence notice, "records": [...]}, one record per training molecule
                 (3,937), same order as clean.csv:
                 [InChIKey, dataset name, labels, sources, split, raw labels]
                 labels = 6 characters for sweet, bitter, umami, tasteless, sour, salty:
                 "1" recorded, "0" recorded as not, "-" unknown
                 sources = "C" ChemTastesDB, "V" VirtuousMultiTaste, "CV" both
                 The InChIKey is computed on the standardized training structure, which has no
                 stereo (training/clean_data.py). The page matches a searched molecule by full
                 InChIKey, else by the first 14 characters (connectivity only: "stereo not
                 distinguished").
  fps.bin        Morgan fingerprints (radius 2, 2048 bits) of the same molecules as on-bit lists:
                 uint32 offsets [n + 1] then uint16 bit indices (same format as
                 ingredient-finder/data/fps.bin)
  domain.json    applicability-domain threshold: 5th percentile of the nearest-neighbour Tanimoto
                 between each test-split molecule and the train split
Also adds Morgan / InChIKey cases to tests/parity_fixtures.json ("domain" key).

Licences (checked 2026-11-20): ChemTastesDB v2.1 is CC BY 4.0 (Rojas et al. 2022), the
VirtuousMultiTaste data are MIT (Androutsos et al. 2024); both allow showing the labels with
attribution, which the page and its about page give.
"""
import json

import numpy as np
import pandas as pd
from rdkit import Chem, DataStructs
from rdkit.Chem import rdFingerprintGenerator

from common import DATA_DIR, ROOT, load

SITE = ROOT / "taste-predictor"
COLS = ["sweet", "bitter", "umami", "tasteless", "sour", "salty"]
PERCENTILE = 5
NOTICE = ("Taste labels and raw taste descriptions compiled from ChemTastesDB v2.1 (Rojas et al. 2022, "
          "Food Chemistry: Molecular Sciences 4, 100090; doi:10.5281/zenodo.15051366; CC BY 4.0) and "
          "VirtuousMultiTaste (Androutsos et al. 2024, npj Science of Food; MIT License, Copyright (c) 2023 "
          "Lorenzo Pallante: Permission is hereby granted, free of charge, to any person obtaining a copy of "
          "this software and associated documentation files, to deal in the Software without restriction, "
          "subject to the condition that the above copyright notice and this permission notice shall be "
          "included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED \"AS IS\", "
          "WITHOUT WARRANTY OF ANY KIND). Changes: structures standardized (largest fragment, neutralized, "
          "stereo removed), duplicates merged, labels mapped to sweet / bitter / umami / tasteless / sour / salty.")
# Inputs for the JS parity test: stereo, salts, molecules in and out of the training data
PARITY_CASES = [
    "CCCCCC=CCC=CCCCCCCCC(=O)O", "CCCCC/C=C\\C/C=C\\CCCCCCCC(=O)O", "CCCCCCCCC=CCCCCCCCC(=O)O",
    "CCCCCCCC/C=C\\CCCCCCCC(=O)O", "CCCCCCCCCCCCCCCCCC(=O)O", "N[C@@H](CCC(=O)O)C(=O)O",
    "NC(CCC(=O)O)C(=O)O", "OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O", "CC(C)=CCCC(C)=CC=O",
    "O=C1NS(=O)(=O)c2ccccc21", "CCCCCCCCCCCCCCCC(=O)OCC(COC(=O)CCCCCCCCCCCCCCC)OC(=O)CCCCCCCCCCCCCCC",
    "CC/C=C\\C/C=C\\C/C=C\\C/C=C\\C/C=C\\C/C=C\\CCC(=O)O", "c1ccc2c(c1)ccc1ccccc12",
]


def main():
    d = load()
    clean = pd.read_csv(DATA_DIR / "clean.csv")
    gen = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)
    mols = [Chem.MolFromSmiles(s) for s in d["smiles"]]
    keys = [Chem.MolToInchiKey(m) for m in mols]
    assert all(keys), "InChIKey failed"
    fps = [gen.GetFingerprint(m) for m in mols]

    def lab(row):
        return "".join("-" if pd.isna(row[c]) else str(int(row[c])) for c in COLS)

    src = {"ChemTastesDB": "C", "VirtuousMultiTaste": "V"}
    records = [[keys[i], r["name"] if isinstance(r["name"], str) else "", lab(r),
                "".join(src[s] for s in r["sources"].split("+")), str(d["split"][i]),
                r["raw_labels"].split(" | ")]
               for i, r in clean.iterrows()]
    out = SITE / "data" / "dataset.json"
    doc = {"notice": NOTICE, "records": records}
    out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {out.relative_to(ROOT)} ({out.stat().st_size / 1e3:.1f} kB, {len(records)} molecules)")
    k14 = pd.Series([k[:14] for k in keys])
    print(f"  full InChIKeys unique: {len(set(keys))}; first-14 shared by >1 molecule: "
          f"{int((k14.value_counts() > 1).sum())} groups")

    on = [np.array(list(fp.GetOnBits()), dtype=np.uint16) for fp in fps]
    offsets = np.zeros(len(on) + 1, dtype=np.uint32)
    offsets[1:] = np.cumsum([len(b) for b in on])
    fp_path = SITE / "data" / "fps.bin"
    fp_path.write_bytes(offsets.tobytes() + np.concatenate(on).tobytes())
    print(f"Wrote {fp_path.relative_to(ROOT)} ({fp_path.stat().st_size / 1e3:.1f} kB)")

    # Threshold: nearest training neighbour of each test molecule (train split only)
    train = [fps[i] for i in np.flatnonzero(d["split"] == "train")]
    nn_test = np.array([max(DataStructs.BulkTanimotoSimilarity(fps[i], train))
                        for i in np.flatnonzero(d["split"] == "test")])
    thr = float(np.percentile(nn_test, PERCENTILE))
    dom = {"fingerprint": "Morgan radius 2, 2048 bits", "percentile": PERCENTILE,
           "threshold": round(thr, 4), "n_test": int(len(nn_test)),
           "test_nn_quantiles": {str(q): round(float(np.percentile(nn_test, q)), 4) for q in (1, 5, 10, 25, 50)}}
    (SITE / "data" / "domain.json").write_text(json.dumps(dom, indent=1), encoding="utf-8")
    print("domain:", dom)

    # Nearest-neighbour similarity of the presets (shown without loading RDKit)
    from clean_data import standardize
    pre_path = SITE / "data" / "presets.json"
    presets = json.loads(pre_path.read_text(encoding="utf-8"))
    for p in presets:
        fp = gen.GetFingerprint(Chem.MolFromSmiles(p["std_smiles"]))
        p["nn_tanimoto"] = round(float(max(DataStructs.BulkTanimotoSimilarity(fp, fps))), 4)
    pre_path.write_text(json.dumps(presets, ensure_ascii=False, indent=1), encoding="utf-8")
    print("presets nn:", [(p["name_en"], p["nn_tanimoto"]) for p in presets])

    # Parity cases: Python InChIKey and nearest-neighbour Tanimoto for the JS test
    fx = []
    for s in PARITY_CASES:
        m = Chem.MolFromSmiles(s)
        std = standardize(s)
        fp = gen.GetFingerprint(Chem.MolFromSmiles(std))
        sims = DataStructs.BulkTanimotoSimilarity(fp, fps)
        j = int(np.argmax(sims))
        fx.append({"input": s, "inchikey": Chem.MolToInchiKey(m), "std_smiles": std,
                   "on_bits": sorted(int(b) for b in fp.GetOnBits()),
                   "nn_index": j, "nn_tanimoto": float(sims[j])})
        print(f"  {s[:40]:40s} key {fx[-1]['inchikey']} nn {sims[j]:.3f} ({records[j][1]})")
    fx_path = SITE / "tests" / "parity_fixtures.json"
    allfx = json.loads(fx_path.read_text(encoding="utf-8"))
    allfx["domain"] = fx
    fx_path.write_text(json.dumps(allfx, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
