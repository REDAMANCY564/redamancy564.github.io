"""Shared helpers for the taste models: data loading, masked AUROC, metrics.json.

Labels are 1 / 0 / NaN (unknown). Unknown entries are excluded from both the loss and
the AUROC of that class.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

TRAINING = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TRAINING))

ROOT = TRAINING.parent
DATA_DIR = TRAINING / "data" / "taste"
METRICS_PATH = ROOT / "taste-predictor" / "data" / "metrics.json"
LABELS = ["sweet", "bitter", "umami", "tasteless"]
# Purine-nucleotide scaffold (IMP, GMP, ...): reported as its own umami subset
NUCLEOTIDE_SCAFFOLD = "O=c1[nH]cnc2c1ncn2C1CCCO1"


def load():
    """Return a dict with smiles, Y [N,L] (NaN = unknown), split, acyclic, drug, scaffold."""
    df = pd.read_csv(DATA_DIR / "clean.csv")
    sp = pd.read_csv(DATA_DIR / "split.csv", keep_default_na=False)
    dr = pd.read_csv(DATA_DIR / "drug_flags.csv")
    assert (df["smiles"] == sp["smiles"]).all() and (df["smiles"] == dr["smiles"]).all()
    return {
        "smiles": df["smiles"].tolist(),
        "Y": df[LABELS].to_numpy(np.float32),
        "split": sp["split"].to_numpy(),
        "scaffold": sp["scaffold"].to_numpy(),
        "acyclic": (sp["scaffold"] == "").to_numpy(),
        "drug": dr["max_phase"].notna().to_numpy(),
    }


def auroc(y, p):
    """AUROC over known entries of one class; None if fewer than 2 classes present."""
    k = ~np.isnan(y)
    y, p = y[k], p[k]
    if len(y) == 0 or y.min() == y.max():
        return None
    return float(roc_auc_score(y, p))


def per_label(Y, P):
    return [auroc(Y[:, j], P[:, j]) for j in range(Y.shape[1])]


def macro(Y, P):
    vals = [a for a in per_label(Y, P) if a is not None]
    return float(np.mean(vals))


def counts(Y, j):
    y = Y[:, j]
    return int((y == 1).sum()), int((y == 0).sum())


def test_report(d, P):
    """Per-class test AUROC, overall and on the subsets we promised to report."""
    te = d["split"] == "test"
    Y, P = d["Y"][te], P
    acy, drug, scaf = d["acyclic"][te], d["drug"][te], d["scaffold"][te]
    r4 = lambda x: None if x is None else round(x, 4)  # noqa: E731
    rep = {"macro_auroc": round(macro(Y, P), 4), "per_label": {}}
    for j, lab in enumerate(LABELS):
        pos, neg = counts(Y, j)
        rep["per_label"][lab] = {
            "auroc": r4(auroc(Y[:, j], P[:, j])), "test_pos": pos, "test_neg": neg,
            "auroc_cyclic": r4(auroc(Y[~acy, j], P[~acy, j])),
            "auroc_acyclic": r4(auroc(Y[acy, j], P[acy, j])),
        }
    b = LABELS.index("bitter")
    rep["bitter_by_drug"] = {
        "drug": {"auroc": r4(auroc(Y[drug, b], P[drug, b])), "pos_neg": counts(Y[drug], b)},
        "non_drug": {"auroc": r4(auroc(Y[~drug, b], P[~drug, b])), "pos_neg": counts(Y[~drug], b)},
    }
    u, nuc = LABELS.index("umami"), scaf == NUCLEOTIDE_SCAFFOLD
    rep["umami_nucleotides"] = {
        "excluding_nucleotides": {"auroc": r4(auroc(Y[~nuc, u], P[~nuc, u])), "pos_neg": counts(Y[~nuc], u)},
        "nucleotides_vs_all_negatives": {
            "auroc": r4(auroc(np.where(nuc | (Y[:, u] == 0), Y[:, u], np.nan),
                              P[:, u])), "n_nucleotides": int(nuc.sum())},
    }
    return rep


def update_metrics(key, value):
    METRICS_PATH.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(METRICS_PATH.read_text(encoding="utf-8")) if METRICS_PATH.exists() else {}
    data[key] = value
    METRICS_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def print_report(name, rep):
    print(f"{name}: test macro AUROC {rep['macro_auroc']:.4f}")
    for lab, r in rep["per_label"].items():
        f = lambda x: "  n/a " if x is None else f"{x:.4f}"  # noqa: E731
        print(f"  {lab:10s} {f(r['auroc'])}  (pos {r['test_pos']:3d}/neg {r['test_neg']:3d})"
              f"  cyclic {f(r['auroc_cyclic'])}  acyclic {f(r['auroc_acyclic'])}")
    bd = rep["bitter_by_drug"]
    print(f"  bitter drug {bd['drug']['auroc']} {bd['drug']['pos_neg']} | non-drug "
          f"{bd['non_drug']['auroc']} {bd['non_drug']['pos_neg']}")
    un = rep["umami_nucleotides"]
    print(f"  umami excl. nucleotides {un['excluding_nucleotides']['auroc']} "
          f"{un['excluding_nucleotides']['pos_neg']} | nucleotides vs negatives "
          f"{un['nucleotides_vs_all_negatives']['auroc']} (n={un['nucleotides_vs_all_negatives']['n_nucleotides']})")
