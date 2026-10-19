"""Stage 1 data preparation for flavor-improver.

Combines: compound structures (PubChem), water odor thresholds (thresholds.py output),
base compositions (bases_source.json) and odor descriptor probabilities from the
project-1 GNN (odor-predictor/model/odor_gnn.onnx). Prints review tables and writes
training/data/fi_draft.json; with --final also writes flavor-improver/data/
palette.json, bases.json and presets.json (after user approval, 2026-10-16).

Profile vectors use the user-approved "lift": GNN probability divided by the label's
prevalence in the training data, which removes the bias towards frequent labels (fruity, sweet).
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort

HERE = Path(__file__).resolve().parent
TRAINING = HERE.parent
ROOT = TRAINING.parent
sys.path.insert(0, str(TRAINING))
from featurize import featurize  # noqa: E402

PROFILE_DIMS = ["dairy", "buttery", "creamy", "milky", "cheesy", "sweet", "sour",
                "fruity", "nutty", "caramellic", "fatty", "waxy"]

ZH = {
    "diacetyl": "双乙酰", "acetoin": "乙偶姻", "2,3-pentanedione": "2,3-戊二酮", "acetaldehyde": "乙醛",
    "butanoic acid": "丁酸", "hexanoic acid": "己酸", "2-heptanone": "2-庚酮", "2-nonanone": "2-壬酮",
    "delta-decalactone": "δ-癸内酯", "delta-dodecalactone": "δ-十二内酯", "gamma-dodecalactone": "γ-十二内酯",
    "delta-octalactone": "δ-辛内酯", "gamma-decalactone": "γ-癸内酯", "vanillin": "香兰素", "maltol": "麦芽酚",
    "furaneol": "呋喃酮", "ethyl butanoate": "丁酸乙酯", "ethyl hexanoate": "己酸乙酯",
    "acetic acid": "乙酸", "pentanoic acid": "戊酸", "octanoic acid": "辛酸", "decanoic acid": "癸酸",
    "2-methylpropanoic acid": "2-甲基丙酸", "2-methylbutanoic acid": "2-甲基丁酸", "3-methylbutanoic acid": "3-甲基丁酸",
    "3-methylbutanal": "3-甲基丁醛", "3-methyl-1-butanol": "3-甲基-1-丁醇", "2-phenylethanol": "2-苯乙醇",
    "phenylacetic acid": "苯乙酸", "hexanal": "己醛", "octanal": "辛醛", "nonanal": "壬醛", "(E)-2-octenal": "(E)-2-辛烯醛",
    "benzaldehyde": "苯甲醛", "furfural": "糠醛", "2-pentylfuran": "2-戊基呋喃", "2-undecanone": "2-十一酮",
    "1-butanol": "1-丁醇", "gamma-nonalactone": "γ-壬内酯",
}

# User-approved optimization directions (+1 increase, -1 decrease; other dims unchanged)
PRESETS = [
    {"id": "yogurt", "base": "yogurt_high_acid", "direction": {"milky": 1, "sweet": 1, "buttery": 1, "sour": -1},
     "rationale_en": "In the source study the low-acidity batch scored highest for milky, sweet and buttery notes, the high-acidity batch for sour and fermented notes.",
     "rationale_zh": "原研究中低酸度批次的奶香、甜香、黄油评分最高，高酸度批次的酸味和发酵味更重。"},
    {"id": "milk", "base": "milk_pasteurized", "direction": {"creamy": 1, "fatty": 1, "milky": 1},
     "rationale_en": "Richer, creamier milk aroma.", "rationale_zh": "让牛奶的香气更浓郁、更有奶油感。"},
    {"id": "young_gouda", "base": "gouda_4w", "direction": {"cheesy": 1, "buttery": 1},
     "rationale_en": "Move a young cheese towards a fuller cheesy, buttery aroma.", "rationale_zh": "让年轻奶酪的奶酪感、黄油感更饱满。"},
    {"id": "mature_gouda", "base": "gouda_30w", "direction": {"buttery": 1, "sour": -1},
     "rationale_en": "More buttery, less sour.", "rationale_zh": "增强黄油感，减弱酸感。"},
]


def intensity(conc_ug_kg, thr_mg_kg):
    """Mixture rule: I = log10(OAV) if OAV > 1 else 0; thresholds are in mg/kg, concentrations in ug/kg."""
    oav = conc_ug_kg / (thr_mg_kg * 1000.0)
    return oav, (math.log10(oav) if oav > 1 else 0.0)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    names = json.loads((HERE / "compound_names.json").read_text(encoding="utf-8"))
    pub = json.loads((TRAINING / "data" / "fi_pubchem.json").read_text(encoding="utf-8"))
    thr = json.loads((TRAINING / "data" / "fi_thresholds.json").read_text(encoding="utf-8"))
    bases = json.loads((HERE / "bases_source.json").read_text(encoding="utf-8"))["bases"]
    labels = [l["id"] for l in json.loads((ROOT / "odor-predictor" / "model" / "labels.json").read_text(encoding="utf-8"))]
    dim_idx = [labels.index(d) for d in PROFILE_DIMS]

    import pandas as pd
    prior = pd.read_csv(TRAINING / "data" / "clean.csv")[PROFILE_DIMS].mean().to_numpy()

    sess = ort.InferenceSession(str(ROOT / "odor-predictor" / "model" / "odor_gnn.onnx"), providers=["CPUExecutionProvider"])
    compounds = {}
    for n in names["palette"] + names["base_only"]:
        X, A, M = (a[None] for a in featurize(pub[n]["smiles"]))
        probs = sess.run(None, {"X": X, "A": A, "mask": M})[0][0]
        t = thr[n]
        compounds[n] = {
            "role": "palette" if n in names["palette"] else "base_only",
            "cid": pub[n]["cid"], "cas": pub[n]["cas"], "smiles": pub[n]["smiles"],
            "threshold_mg_kg": t.get("value_mg_kg"), "threshold_source": t.get("source"),
            "threshold_range_mg_kg": t.get("range_mg_kg"),
            "profile_probs": [round(float(probs[i]), 4) for i in dim_idx],
            "profile_lift": [round(float(probs[i] / prior[k]), 4) for k, i in enumerate(dim_idx)],
            "top3_all_labels": [labels[i] for i in np.argsort(-probs)[:3]],
        }

    print("== Candidate additives (palette) ==")
    print(f"{'compound':22s} {'thr mg/kg':>10s}  {'source':26s}  top-3 GNN labels | " + " ".join(d[:5] for d in PROFILE_DIMS))
    for n, c in compounds.items():
        if c["role"] != "palette":
            continue
        print(f"{n:22s} {c['threshold_mg_kg']!s:>10s}  {c['threshold_source']:26s}  {', '.join(c['top3_all_labels']):28s} | "
              + " ".join(f"{p:5.2f}" for p in c["profile_probs"]))

    draft_bases = []
    for b in bases:
        used, excluded, profile = [], [], np.zeros(len(PROFILE_DIMS))
        for n, conc in b["compounds"].items():
            c = compounds[n]
            if c["threshold_mg_kg"] is None:
                excluded.append(n)
                continue
            oav, I = intensity(conc, c["threshold_mg_kg"])
            used.append({"compound": n, "conc": conc, "oav": round(oav, 2), "I": round(I, 3)})
            profile += I * np.array(c["profile_lift"])
        prof = profile / profile.sum() if profile.sum() > 0 else profile
        draft_bases.append({"id": b["id"], "used": used, "excluded_no_threshold": excluded,
                            "profile": [round(float(x), 4) for x in prof]})
        print(f"\n== Base {b['id']} ({b['unit']}) ==")
        for u in sorted(used, key=lambda u: -u["oav"]):
            if u["oav"] >= 1:
                print(f"   {u['compound']:24s} conc {u['conc']:>10} OAV {u['oav']:>9}  I {u['I']}")
        print(f"   below OAV 1: {[u['compound'] for u in used if u['oav'] < 1]}")
        print(f"   excluded (no threshold): {excluded}")
        print("   profile: " + ", ".join(f"{d} {p:.2f}" for d, p in zip(PROFILE_DIMS, prof)))

    out = {"profile_dims": PROFILE_DIMS, "compounds": compounds, "bases": draft_bases}
    (TRAINING / "data" / "fi_draft.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    if "--final" in sys.argv:
        write_final(compounds, bases, draft_bases, prior)


def write_final(compounds, bases, draft_bases, prior):
    out_dir = ROOT / "flavor-improver" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    used_names = {n for b in bases for n in b["compounds"]} | {n for n, c in compounds.items() if c["role"] == "palette"}
    palette = {
        "profile_dims": PROFILE_DIMS,
        "label_prevalence": [round(float(p), 5) for p in prior],
        "profile_method": "lift = GNN probability / label prevalence in the training data",
        "threshold_source": "L.J. van Gemert (2011), Odour Thresholds, Part II (water). Rule: Czerny et al. (2008) detection > Buttery et al. detection > Karagul-Yuceer et al. (2003/2004) detection; otherwise excluded.",
        "compounds": {},
    }
    for n in sorted(used_names, key=lambda x: (compounds[x]["role"] != "palette", x)):
        c = compounds[n]
        if c["threshold_mg_kg"] is None:
            continue
        palette["compounds"][n] = {
            "name_en": n, "name_zh": ZH[n], "role": c["role"], "smiles": c["smiles"], "cid": c["cid"], "cas": c["cas"],
            "threshold_mg_kg": c["threshold_mg_kg"], "threshold_source": c["threshold_source"],
            "threshold_range_mg_kg": c["threshold_range_mg_kg"],
            "probs": c["profile_probs"], "lift": c["profile_lift"],
        }
    out_bases = []
    for b, d in zip(bases, draft_bases):
        out_bases.append({
            "id": b["id"], "name_en": b["name_en"], "name_zh": b["name_zh"], "sample": b["sample"], "unit": b["unit"],
            "source": b["source"], "note": b.get("note", ""), "note_zh": b.get("note_zh", ""), "method_by_compound": b.get("method_by_compound", {}),
            "composition_ug_kg": {u["compound"]: u["conc"] for u in d["used"]},
            "excluded_no_threshold": d["excluded_no_threshold"],
            "profile": d["profile"],
        })
    for name, obj in (("palette.json", palette), ("bases.json", out_bases), ("presets.json", PRESETS)):
        (out_dir / name).write_text(json.dumps(obj, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"Wrote flavor-improver/data/{name}")


if __name__ == "__main__":
    main()
