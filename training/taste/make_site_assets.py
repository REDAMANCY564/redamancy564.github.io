"""Generate website data for taste-predictor/ from the exported ONNX model.

Outputs:
  model/labels.json            output order with en/zh names (zh reviewed by the user)
  data/presets.json            13 dairy-related presets: deployed-model probabilities,
                               train-split-only model probabilities, dataset labels
  tests/parity_fixtures.json   for tests/parity.html:
                               - "featurize": standardized SMILES -> Python X, A, probs
                               - "standardize": raw input (salts, charges, stereo) ->
                                 Python standardized SMILES and probs
                               - "occlusion": per-atom contributions (training/occlusion.py)
Presets carry per-atom occlusion contributions for all 4 tastes, in the atom order of
std_smiles (the structure the page draws).
Predictions come from onnxruntime with the same model file the browser loads.
"""
import json

import numpy as np
import onnxruntime as ort
import pandas as pd
import torch
from rdkit import Chem

from common import DATA_DIR, LABELS, ROOT, load
from clean_data import standardize
from export_taste_onnx import ONNX_PATH, load_model
from featurize import featurize, featurize_many
from occlusion import contributions
from presets_taste import PRESETS

SITE = ROOT / "taste-predictor"
N_PARITY = 50
SEED = 0
LABEL_NAMES = {"sweet": "甜", "bitter": "苦", "umami": "鲜", "tasteless": "无味"}

# Same featurizer stress cases as the odor parity test
EDGE_CASES = [
    "c1cc[nH]c1", "c1ccc2[nH]ccc2c1", "C[N+](=O)[O-]", "[O-][n+]1ccccc1", "c1ccncc1", "c1ccsc1",
    "ClC(Cl)(Cl)Br", "Ic1ccccc1F", "COP(=O)(OC)OC", "C[N+](C)(C)C", "C1CC1",
    "CC12CCC(CC1)C(C)(C)O2", "O=C1OC(=O)c2ccccc21", "Cc1ncc(C)nc1C",
]
# Inputs that need standardization (salts, ions, zwitterions, stereo): checks the JS standardizer
STANDARDIZE_CASES = [
    "CC(=O)[O-].[Na+]", "[NH3+]CC(=O)[O-]", "C[N+](C)(C)CC(=O)[O-]",
    "[Na+].O=C1[N-]S(=O)(=O)c2ccccc21", "Cl.COc1ccc2nccc(C(O)C3CC4CCN3CC4C=C)c2c1",
    "CC[NH+](CC)CC.[Cl-]", "[K+].CC=CC=CC(=O)[O-]", "OC(=O)CC(O)(CC(=O)[O-])C(=O)[O-].[Na+].[Na+]",
    "C[C@@H](O)C(=O)O", "N[C@@H](CCC(=O)[O-])C(=O)[O-].[Na+].[Na+]",
]


def write_json(path, obj, indent=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=indent), encoding="utf-8")
    print(f"Wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e3:.1f} kB)")


def main():
    d = load()
    clean = pd.read_csv(DATA_DIR / "clean.csv")
    sess = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
    run = lambda X, A, M: sess.run(None, {"X": X, "A": A, "mask": M})[0]  # noqa: E731
    eval_model, _ = load_model("taste_gnn_eval.pt")

    write_json(SITE / "model" / "labels.json",
               [{"id": l, "en": l, "zh": LABEL_NAMES[l]} for l in LABELS], indent=1)

    index = {s: i for i, s in enumerate(d["smiles"])}
    presets = []
    print(f"  {'preset':26s} {'data':6s} " + " ".join(f"{l:>9s}" for l in LABELS) + "   (train-only model)")
    for pid, en, zh, smi, cid in PRESETS:
        std = standardize(smi)
        X, A, M = (a[None] for a in featurize(std))
        p, contrib = contributions(run, X[0], A[0], M[0])
        with torch.no_grad():
            pe = eval_model(*(torch.from_numpy(a) for a in (X, A, M))).numpy()[0]
        i = index.get(std)
        presets.append({
            "id": pid, "name_en": en, "name_zh": zh, "smiles": smi, "std_smiles": std, "pubchem_cid": cid,
            "probs": {l: round(float(v), 4) for l, v in zip(LABELS, p)},
            "probs_train_only": {l: round(float(v), 4) for l, v in zip(LABELS, pe)},
            # contrib[taste][atom]: probability change when that atom is removed (atom order of std_smiles)
            "contrib": {l: [round(float(v), 4) for v in contrib[:, j]] for j, l in enumerate(LABELS)},
            "dataset_split": None if i is None else str(d["split"][i]),
            "dataset_labels": None if i is None else {
                l: None if np.isnan(v) else int(v) for l, v in zip(LABELS, d["Y"][i])},
            "dataset_sources": None if i is None else clean.loc[i, "sources"].split("+"),
            # sour / salty are not modelled but shown next to the predictions
            "dataset_sour_salty": None if i is None else {
                c: None if pd.isna(clean.loc[i, c]) else int(clean.loc[i, c]) for c in ("sour", "salty")},
            "dataset_raw_labels": None if i is None else clean.loc[i, "raw_labels"].split(" | "),
        })
        where = "-" if i is None else str(d["split"][i])
        print(f"  {en:26s} {where:6s} " + " ".join(f"{v:9.2f}" for v in p)
              + "   (" + " ".join(f"{v:.2f}" for v in pe) + ")")
    write_json(SITE / "data" / "presets.json", presets, indent=1)

    test_idx = np.flatnonzero(d["split"] == "test")
    pick = np.random.default_rng(SEED).choice(test_idx, size=N_PARITY, replace=False)
    feat_smiles = [d["smiles"][i] for i in pick] + EDGE_CASES
    X, A, M = featurize_many(feat_smiles)
    probs = run(X, A, M)
    featurize_fx = []
    for k, s in enumerate(feat_smiles):
        n = int(M[k].sum())
        assert n == Chem.MolFromSmiles(s).GetNumAtoms()
        featurize_fx.append({"smiles": s, "num_atoms": n, "X": X[k, :n].astype(int).tolist(),
                             "A": A[k, :n, :n].tolist(), "probs": probs[k].tolist()})

    std_inputs = [p[3] for p in PRESETS] + STANDARDIZE_CASES
    std_fx = []
    for s in std_inputs:
        std = standardize(s)
        X1, A1, M1 = (a[None] for a in featurize(std))
        std_fx.append({"input": s, "std_smiles": std, "num_atoms": int(M1.sum()),
                       "probs": run(X1, A1, M1)[0].tolist()})
    print(f"  standardize cases: " + "; ".join(f"{f['input']} -> {f['std_smiles']}" for f in std_fx[-len(STANDARDIZE_CASES):]))
    occ_smiles = [d["smiles"][i] for i in pick[:10]] + [standardize(p[3]) for p in PRESETS]
    occlusion = [{"smiles": s, "contrib": contributions(run, *featurize(s))[1].tolist()} for s in occ_smiles]
    write_json(SITE / "tests" / "parity_fixtures.json",
               {"tolerance": {"A": 1e-6, "probs": 1e-5, "contrib": 1e-5}, "featurize": featurize_fx,
                "standardize": std_fx, "occlusion": occlusion})


if __name__ == "__main__":
    main()
