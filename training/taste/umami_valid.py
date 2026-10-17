"""Umami reference score on the validation set.

The test-set umami AUROC (1.0) is uninformative: 33 of its 35 positives are phosphate
nucleotides and there are no phosphorus-containing negatives. As a reference, report
validation AUROC on molecules without phosphorus (the validation set was used for early
stopping / choosing C, so this is optimistic). Writes metrics.json key "umami_valid_reference".
"""
import numpy as np
import torch

from common import LABELS, TRAINING, auroc, counts, load, update_metrics  # also puts training/ on sys.path
from baseline import morgan  # noqa: E402
from baseline_fp import fit_predict  # noqa: E402
from featurize import NUM_FEATURES, featurize_many
from model import OdorGNN


def main():
    d = load()
    va, tr = d["split"] == "valid", d["split"] == "train"
    u = LABELS.index("umami")
    Y = d["Y"][va]
    no_p = np.array(["P" not in s for s in np.array(d["smiles"])[va]])

    X, A, M = (torch.from_numpy(a) for a in featurize_many(np.array(d["smiles"])[va].tolist()))
    ck = torch.load(TRAINING / "checkpoints" / "taste_gnn_eval.pt")
    gnn = OdorGNN(NUM_FEATURES, len(LABELS), **ck["config"])
    gnn.load_state_dict(ck["state_dict"])
    gnn.eval()
    with torch.no_grad():
        pg = torch.sigmoid(gnn(X, A, M)).numpy()[:, u]
    F = morgan(d["smiles"])
    pl = fit_predict(F, d["Y"], tr, 0.1)(F[va])[:, u]

    pos, neg = counts(Y[no_p], u)
    res = {"subset": "validation molecules without phosphorus", "pos": pos, "neg": neg,
           "gnn": round(auroc(Y[no_p, u], pg[no_p]), 4), "morgan_logreg": round(auroc(Y[no_p, u], pl[no_p]), 4),
           "note": "validation set was used for early stopping and for choosing C: optimistic"}
    print(res)
    update_metrics("umami_valid_reference", res)


if __name__ == "__main__":
    main()
