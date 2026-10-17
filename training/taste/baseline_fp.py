"""Baseline: Morgan fingerprint (r=2, 2048 bits) + logistic regression, one model per class
fit on the molecules whose label for that class is known. C is chosen on validation
macro AUROC; the test set is used once at the end.
"""
import numpy as np
from sklearn.linear_model import LogisticRegression

from common import LABELS, load, macro, print_report, test_report, update_metrics
from baseline import morgan  # training/baseline.py (same fingerprint as the odor baseline)


def fit_predict(X, Y, tr, C):
    models = []
    for j in range(len(LABELS)):
        k = tr & ~np.isnan(Y[:, j])
        models.append(LogisticRegression(C=C, max_iter=5000).fit(X[k], Y[k, j]))
    return lambda Z: np.stack([m.predict_proba(Z)[:, 1] for m in models], axis=1)


def main():
    d = load()
    X, Y = morgan(d["smiles"]), d["Y"]
    tr, va, te = (d["split"] == s for s in ("train", "valid", "test"))
    best = None
    for C in (0.01, 0.03, 0.1, 0.3, 1.0):
        pred = fit_predict(X, Y, tr, C)
        auc = macro(Y[va], pred(X[va]))
        print(f"LogReg C={C:<5} valid macro AUROC = {auc:.4f}")
        if best is None or auc > best[0]:
            best = (auc, C, pred)
    auc_va, C, pred = best
    rep = test_report(d, pred(X[te]))
    print_report(f"Morgan + LogReg (C={C})", rep)
    update_metrics("morgan_logreg", {"params": {"radius": 2, "bits": 2048, "C": C},
                                     "valid_macro_auroc": round(auc_va, 4), **rep})


if __name__ == "__main__":
    main()
