"""Shared evaluation helpers: macro AUROC and writing odor-predictor/data/metrics.json."""
import json
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parent.parent
METRICS_PATH = ROOT / "odor-predictor" / "data" / "metrics.json"


def per_label_auroc(y_true, y_score):
    """AUROC per label; NaN for labels with only one class present."""
    out = np.full(y_true.shape[1], np.nan)
    for j in range(y_true.shape[1]):
        if 0 < y_true[:, j].sum() < len(y_true):
            out[j] = roc_auc_score(y_true[:, j], y_score[:, j])
    return out


def macro_auroc(y_true, y_score):
    return float(np.nanmean(per_label_auroc(y_true, y_score)))


def test_report(y_true, y_score, acyclic, labels):
    """Overall / cyclic / acyclic macro AUROC plus per-label AUROC with positive counts."""
    per = per_label_auroc(y_true, y_score)
    pos = y_true.sum(axis=0).astype(int)
    return {
        "macro_auroc": round(float(np.nanmean(per)), 4),
        "macro_auroc_cyclic": round(macro_auroc(y_true[~acyclic], y_score[~acyclic]), 4),
        "macro_auroc_acyclic": round(macro_auroc(y_true[acyclic], y_score[acyclic]), 4),
        "per_label": {
            lab: {"auroc": None if np.isnan(a) else round(float(a), 4), "test_positives": int(p)}
            for lab, a, p in zip(labels, per, pos)
        },
    }


def update_metrics(key, value):
    """Read-modify-write one top-level key of metrics.json."""
    METRICS_PATH.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(METRICS_PATH.read_text(encoding="utf-8")) if METRICS_PATH.exists() else {}
    data[key] = value
    METRICS_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def load_split():
    """Return smiles, labels (list), Y [N,L], split (array of str), acyclic (bool array)."""
    import pandas as pd
    data_dir = Path(__file__).parent / "data"
    df = pd.read_csv(data_dir / "clean.csv")
    sp = pd.read_csv(data_dir / "split.csv", keep_default_na=False)
    assert (df["smiles"] == sp["smiles"]).all()
    labels = [c for c in df.columns if c != "smiles"]
    return (df["smiles"].tolist(), labels, df[labels].to_numpy(np.float32),
            sp["split"].to_numpy(), (sp["scaffold"] == "").to_numpy())
