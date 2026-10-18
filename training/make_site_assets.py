"""Generate website data from the exported ONNX model.

Outputs (under odor-predictor/):
  model/labels.json            label order of the model output, with en/zh names
  data/presets.json            10 preset molecules with top-8 predictions
  tests/parity_fixtures.json   50 test molecules: Python features + model outputs,
                               used by tests/parity.html to check the JS featurizer;
                               plus occlusion contributions for 20 molecules
Presets also carry per-atom occlusion contributions (occlusion.py) for their top-8 labels.
Raw dataset labels are NOT published (no license explicitly allows it; user decision 2026-10-18):
each preset carries its odor description from the flavor knowledge base instead (Dunkel et al.
2014 with page number, else FlavorDB terms) plus whether it is in the training data.
Predictions come from onnxruntime (the same model file the browser loads).
"""
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pandas as pd
from rdkit import Chem

from clean_data import standardize
from evaluate import load_split
from featurize import featurize, featurize_many
from occlusion import contributions

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "odor-predictor"
TOP_K = 8
N_PARITY = 50
N_OCCLUSION = 10  # random test molecules with occlusion fixtures (plus the 10 presets)
SEED = 0

# Names and SMILES checked against PubChem (2026-10-16)
PRESETS = [
    ("diacetyl", "Diacetyl", "双乙酰", "CC(=O)C(C)=O", 650),
    ("acetoin", "Acetoin", "乙偶姻", "CC(O)C(C)=O", 179),
    ("butyric-acid", "Butyric acid", "丁酸", "CCCC(=O)O", 264),
    ("2-heptanone", "2-Heptanone", "2-庚酮", "CCCCCC(C)=O", 8051),
    ("delta-decalactone", "delta-Decalactone", "δ-癸内酯", "CCCCCC1CCCC(=O)O1", 12810),
    ("gamma-dodecalactone", "gamma-Dodecalactone", "γ-十二内酯", "CCCCCCCCC1CCC(=O)O1", 16821),
    ("vanillin", "Vanillin", "香兰素", "COc1cc(C=O)ccc1O", 1183),
    ("methional", "Methional", "甲硫基丙醛", "CSCCC=O", 18635),
    ("furaneol", "Furaneol", "呋喃酮", "CC1=C(O)C(=O)C(C)O1", 19309),
    ("2-acetyl-1-pyrroline", "2-Acetyl-1-pyrroline", "2-乙酰基-1-吡咯啉", "CC(=O)C1=NCCC1", 522834),
]


# Structures that stress the featurizer: [nH], charges, N-oxide, heteroaromatics, halogens, P, H count > 4 clip
EDGE_CASES = [
    "c1cc[nH]c1", "c1ccc2[nH]ccc2c1", "C[N+](=O)[O-]", "[O-][n+]1ccccc1", "c1ccncc1", "c1ccsc1",
    "ClC(Cl)(Cl)Br", "Ic1ccccc1F", "COP(=O)(OC)OC", "C[N+](C)(C)C", "CC(=O)[O-]", "C1CC1",
    "CC12CCC(CC1)C(C)(C)O2", "O=C1OC(=O)c2ccccc21", "Cc1ncc(C)nc1C",
]


def kb_odor(smi, kb):
    """Odor description of a preset from the flavor knowledge base: Dunkel first, else FlavorDB."""
    target = standardize(smi)
    for comp in kb.values():
        if standardize(comp["smiles"]) != target:
            continue
        if comp.get("dunkel", {}).get("odor"):
            return {"source": "dunkel", "terms": [comp["dunkel"]["odor"]], "page": comp["dunkel"].get("page")}
        if comp.get("flavor"):
            return {"source": "flavordb", "terms": comp["flavor"][:8]}
    return None


def to_ug_per_kg(entry):
    """Convert one threshold entry from mg/kg to ug/kg (x1000), rounded to 4 significant digits."""
    conv = lambda v: float(f"{v * 1000:.4g}")
    return {"rep_ug_kg": conv(entry["rep_mg_kg"]), "type": "detection", "rep_source": entry["rep_source"],
            "range_ug_kg": [conv(v) for v in entry["range_mg_kg"]]}


def write_json(path, obj, indent=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=indent), encoding="utf-8")
    print(f"Wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e3:.1f} kB)")


def main():
    smiles, labels, Y, split, _ = load_split()
    sess = ort.InferenceSession(str(SITE / "model" / "odor_gnn.onnx"), providers=["CPUExecutionProvider"])

    def run(X, A, M):
        return sess.run(None, {"X": X, "A": A, "mask": M})[0]

    # labels.json
    tr = pd.read_csv(Path(__file__).parent / "label_translations.csv", keep_default_na=False)
    zh = dict(zip(tr["en"], tr["zh"]))
    en = dict(zip(tr["en"], tr["en_display"]))  # display spelling; "id" keeps the dataset name
    missing = [l for l in labels if not zh.get(l)]
    assert not missing, f"Missing translations: {missing}"
    write_json(SITE / "model" / "labels.json",
               [{"id": l, "en": en[l], "zh": zh[l]} for l in labels], indent=1)

    # presets.json (with literature odor thresholds in water, converted mg/kg -> ug/kg)
    thr = json.loads((Path(__file__).parent / "odor_thresholds.json").read_text(encoding="utf-8"))
    assert set(thr["compounds"]) == {p[0] for p in PRESETS}, "threshold table must cover all presets"
    index = {s: i for i, s in enumerate(smiles)}
    kb = json.loads((ROOT / "flavor-kb" / "data" / "compounds.json").read_text(encoding="utf-8"))
    presets = []
    for pid, en, zh_name, smi, cid in PRESETS:
        probs, contrib = contributions(run, *featurize(smi))
        top = np.argsort(-probs)[:TOP_K]
        i = index.get(standardize(smi))
        presets.append({
            "id": pid, "name_en": en, "name_zh": zh_name, "smiles": smi, "pubchem_cid": cid,
            "top": [{"label": labels[j], "prob": round(float(probs[j]), 4)} for j in top],
            # contrib[label][atom]: probability change when that atom is removed (atom order of "smiles")
            "contrib": {labels[j]: [round(float(v), 4) for v in contrib[:, j]] for j in top},
            "dataset_split": None if i is None else str(split[i]),
            "kb_odor": kb_odor(smi, kb),
            "threshold_water": to_ug_per_kg(thr["compounds"][pid]),
        })
        where = "not in dataset" if i is None else f"in {split[i]}"
        print(f"  {en:22s} {where:14s} top3: " + ", ".join(
            f"{labels[j]} {probs[j]:.2f}" for j in top[:3]))
    write_json(SITE / "data" / "presets.json", presets, indent=1)

    # parity_fixtures.json: 50 random test molecules + presets + edge cases for the JS featurizer.
    # Store only the real-atom block to keep the file small.
    test_idx = np.flatnonzero(split == "test")
    pick = np.random.default_rng(SEED).choice(test_idx, size=N_PARITY, replace=False)
    pick_smiles = [smiles[i] for i in pick] + [p[3] for p in PRESETS] + EDGE_CASES
    X, A, M = featurize_many(pick_smiles)
    probs = run(X, A, M)
    fixtures = []
    for k, s in enumerate(pick_smiles):
        n = int(M[k].sum())
        assert n == Chem.MolFromSmiles(s).GetNumAtoms()
        fixtures.append({
            "smiles": s, "num_atoms": n,
            "X": X[k, :n].astype(int).tolist(),
            "A": A[k, :n, :n].tolist(),
            "probs": probs[k].tolist(),
        })
    # Occlusion fixtures: contributions for the top-8 labels of each molecule
    occ_smiles = [smiles[i] for i in pick[:N_OCCLUSION]] + [p[3] for p in PRESETS]
    occlusion = []
    for s in occ_smiles:
        p, c = contributions(run, *featurize(s))
        top = np.argsort(-p)[:TOP_K]
        occlusion.append({"smiles": s, "labels": top.tolist(), "contrib": c[:, top].tolist()})

    write_json(SITE / "tests" / "parity_fixtures.json",
               {"tolerance": {"A": 1e-6, "probs": 1e-5, "contrib": 1e-5}, "molecules": fixtures,
                "occlusion": occlusion})


if __name__ == "__main__":
    main()
