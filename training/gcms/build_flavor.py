"""Offline build of the flavor data for gcms-interpreter (PLAN-gcms.md section 14).

Writes gcms-interpreter/data/flavor.json with, for the compounds of the flavor knowledge base:
  - odor thresholds in water: the 53 values already published on this site by flavor-improver
    (palette.json + reference.json; all from L.J. van Gemert 2011, Part II, each with its source
    line), matched to knowledge-base compounds by CAS number. No other values, no estimates.
  - odor descriptors from the knowledge base: Dunkel et al. 2014 odor quality (first tier) and
    FlavorDB flavor terms.
  - odor label probabilities of the project-1 GNN (odor-predictor/model/odor_gnn.onnx), computed
    here once so the page needs no RDKit/ONNX at run time. Stored sparsely: labels with
    probability >= PROB_MIN only (the profile rule weights each label by probability / prevalence,
    so the dropped values change a profile by well under 1 %).
  - label prevalence in the GNN training data (training/data/clean.csv), for the "lift" rule
    used by flavor-improver: lift = probability / prevalence.

Run with the training venv: training/.venv/Scripts/python.exe training/gcms/build_flavor.py
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "training"))
from featurize import featurize  # noqa: E402

KB = ROOT / "flavor-kb" / "data" / "compounds.json"
NAMES = ROOT / "gcms-interpreter" / "data" / "names.json"
OUT = ROOT / "gcms-interpreter" / "data" / "flavor.json"
PROB_MIN = 0.01


def site_thresholds():
    """CAS -> threshold record, from the two flavor-improver data files (same values as published there)."""
    out = {}
    for f in ("palette.json", "reference.json"):
        d = json.loads((ROOT / "flavor-improver" / "data" / f).read_text(encoding="utf-8"))
        for name, c in d["compounds"].items():
            if c.get("threshold_mg_kg") and c.get("cas"):
                out[c["cas"]] = {"name": c.get("name_en", name), "mg_kg": c["threshold_mg_kg"],
                                 "src": c["threshold_source"], "range": c.get("threshold_range_mg_kg")}
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    kb = json.loads(KB.read_text(encoding="utf-8"))
    names = json.loads(NAMES.read_text(encoding="utf-8"))["compounds"]
    labels = json.loads((ROOT / "odor-predictor" / "model" / "labels.json").read_text(encoding="utf-8"))
    ids = [l["id"] for l in labels]
    prevalence = pd.read_csv(ROOT / "training" / "data" / "clean.csv")[ids].mean().to_numpy()

    thr_by_cas = site_thresholds()
    thresholds, seen = {}, set()
    for kb_id, _, cas_list, _ in names:
        for cas in cas_list:
            if cas in thr_by_cas:
                thresholds[kb_id] = dict(thr_by_cas[cas], cas=cas)
                seen.add(cas)
    missing = sorted(set(thr_by_cas) - seen)
    print(f"thresholds: {len(thresholds)} KB compounds; not in KB: {missing}")

    sess = ort.InferenceSession(str(ROOT / "odor-predictor" / "model" / "odor_gnn.onnx"), providers=["CPUExecutionProvider"])
    compounds, no_gnn = {}, []
    for kb_id, c in kb.items():
        rec = {}
        if c.get("dunkel", {}).get("odor"):
            rec["d"] = c["dunkel"]["odor"]
        if c.get("flavor"):
            rec["f"] = c["flavor"]
        try:
            X, A, M = (a[None] for a in featurize(c["smiles"]))
            probs = sess.run(None, {"X": X, "A": A, "mask": M})[0][0]
            rec["p"] = [[i, round(float(p), 3)] for i, p in enumerate(probs) if p >= PROB_MIN]
        except Exception:   # too many atoms, unsupported structure: no prediction, said so on the page
            no_gnn.append(c["name"])
        compounds[kb_id] = rec
    print(f"GNN predictions: {len(kb) - len(no_gnn)} / {len(kb)}; none for e.g. {no_gnn[:5]}")

    out = {
        "source": {
            "thresholds": "L.J. van Gemert (2011). Odour Thresholds: Compilations of Odour Threshold Values in Air, "
                          "Water and Other Media, 2nd ed. Oliemans Punter & Partners BV, Utrecht. Part II (water). "
                          "Rule: Czerny et al. (2008) detection > Buttery et al. detection > Karagul-Yuceer et al. "
                          "(2003/2004) detection. Same values as flavor-improver on this site.",
            "dunkel": "Dunkel A, et al. Angew. Chem. Int. Ed. 2014, 53, 7124-7143. doi:10.1002/anie.201309508",
            "flavordb": "Garg N, et al. FlavorDB. Nucleic Acids Res. 2018, 46, D1210-D1216. doi:10.1093/nar/gkx957 (CC BY-NC-SA 3.0)",
            "gnn": "odor-predictor GNN of this site (odor_gnn.onnx), probabilities >= %.2f kept" % PROB_MIN,
            "prevalence": "label frequency in the GNN training data (training/data/clean.csv)",
        },
        "medium": "water",
        "labels": [{"id": l["id"], "en": l["en"], "zh": l["zh"]} for l in labels],
        "prevalence": [round(float(p), 5) for p in prevalence],
        "prob_min": PROB_MIN,
        "thresholds": thresholds,
        "compounds": compounds,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
