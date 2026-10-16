"""Baselines: Morgan fingerprint (r=2, 2048 bits) + logistic regression / random forest.

Hyperparameters are chosen on the validation set; the test set is used once at the end.
"""
import numpy as np
from rdkit import Chem
from rdkit.Chem import rdFingerprintGenerator
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.multiclass import OneVsRestClassifier

from evaluate import load_split, macro_auroc, test_report, update_metrics

SEED = 42


def morgan(smiles_list):
    gen = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)
    return np.stack([gen.GetFingerprintAsNumPy(Chem.MolFromSmiles(s)) for s in smiles_list]).astype(np.float32)


def rf_proba(model, X):
    # Multi-output RF returns one [N, 2] array per label
    return np.stack([p[:, 1] for p in model.predict_proba(X)], axis=1)


def main():
    smiles, labels, Y, split, acyclic = load_split()
    X = morgan(smiles)
    tr, va, te = (split == s for s in ("train", "valid", "test"))

    results = {}

    best = None
    for C in (0.01, 0.03, 0.1, 0.3, 1.0):
        lr = OneVsRestClassifier(LogisticRegression(C=C, max_iter=2000), n_jobs=-1).fit(X[tr], Y[tr])
        auc = macro_auroc(Y[va], lr.predict_proba(X[va]))
        print(f"LogReg C={C:<5} valid macro AUROC = {auc:.4f}")
        if best is None or auc > best[0]:
            best = (auc, C, lr)
    auc_va, C, lr = best
    rep = test_report(Y[te], lr.predict_proba(X[te]), acyclic[te], labels)
    results["morgan_logreg"] = {"params": {"C": C}, "valid_macro_auroc": round(auc_va, 4), **rep}
    print(f"LogReg best C={C}: test macro AUROC = {rep['macro_auroc']:.4f}\n")

    best = None
    for leaf in (1, 3):
        rf = RandomForestClassifier(n_estimators=500, min_samples_leaf=leaf, n_jobs=-1,
                                    random_state=SEED).fit(X[tr], Y[tr])
        auc = macro_auroc(Y[va], rf_proba(rf, X[va]))
        print(f"RF min_samples_leaf={leaf} valid macro AUROC = {auc:.4f}")
        if best is None or auc > best[0]:
            best = (auc, leaf, rf)
    auc_va, leaf, rf = best
    rep = test_report(Y[te], rf_proba(rf, X[te]), acyclic[te], labels)
    results["morgan_rf"] = {"params": {"n_estimators": 500, "min_samples_leaf": leaf},
                            "valid_macro_auroc": round(auc_va, 4), **rep}
    print(f"RF best leaf={leaf}: test macro AUROC = {rep['macro_auroc']:.4f}")

    for name, res in results.items():
        update_metrics(name, res)
        print(f"{name:14s} test overall {res['macro_auroc']:.4f} | cyclic {res['macro_auroc_cyclic']:.4f}"
              f" | acyclic {res['macro_auroc_acyclic']:.4f}")


if __name__ == "__main__":
    main()
