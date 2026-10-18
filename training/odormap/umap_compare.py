"""Stage 1 of odor-map (PLAN-odor-map.md): UMAP parameter comparison.

Odor map: the ingredient-finder library (5,119 molecules), 138-d predicted probability vector
(uint8-quantized, as on the site), cosine metric. Structure map: Morgan fingerprints (r = 2,
2048 bits), Jaccard metric. Three (n_neighbors, min_dist) settings each, random_state fixed.

Selection aids (the test split is NOT used in this stage):
  top1      all molecules: share of the 15 nearest 2-D neighbours with the same top-1 predicted
            descriptor (favours the odor map by construction: it is built from the predictions)
  valid_*   validation molecules, true labels, neighbours = 15 nearest LABELLED molecules of
            train + validation on the 2-D map: share with >= 1 common label, mean Jaccard
  The same validation metrics in the original (high-dimensional) space are the reference.
Output: training/data/odormap/umap_runs.npz, compare.json, compare.png
"""
import json
import sys
import time
from pathlib import Path

import matplotlib
import numpy as np
import pandas as pd
from sklearn.neighbors import NearestNeighbors

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import umap  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "training" / "data"
OUT = DATA / "odormap"
SEED = 42
K = 15
SETTINGS = [(15, 0.1), (30, 0.3), (50, 0.5)]


def load():
    lib = json.loads((DATA / "ingredient" / "library.json").read_text(encoding="utf-8"))["molecules"]
    f = np.load(DATA / "ingredient" / "features.npz")
    P = np.round(f["probs"] * 255) / 255
    F = np.unpackbits(f["fps"], axis=1).astype(bool)
    clean = pd.read_csv(DATA / "clean.csv")
    labels = list(clean.columns[1:])
    lab = dict(zip(clean.smiles, clean[labels].to_numpy().astype(bool)))
    Y = np.array([lab.get(r["smiles"], np.zeros(len(labels), bool)) for r in lib])
    split = np.array([r["split"] for r in lib])
    return lib, P, F, Y, split, labels


def knn_idx(X, q_idx, pool_idx, k, metric="euclidean"):
    """k nearest pool members of each query (the query itself excluded)."""
    nn = NearestNeighbors(n_neighbors=k + 1, metric=metric).fit(X[pool_idx])
    _, ind = nn.kneighbors(X[q_idx])
    out = []
    pool = np.asarray(pool_idx)
    for q, row in zip(q_idx, ind):
        nb = [pool[j] for j in row if pool[j] != q][:k]
        out.append(nb)
    return np.array(out)


def key_of(kind, nnb, md):
    return f"{kind}_n{nnb}_d{md}"


def place_disconnected(XY, key, report):
    """Molecules UMAP could not place (no fingerprint bit shared with any other molecule, e.g. [Zn]):
    put them just outside the lower-left corner of the map and record them."""
    bad = np.isnan(XY).any(1)
    if bad.any():
        ok = XY[~bad]
        lo, span = ok.min(0), ok.max(0) - ok.min(0)
        XY[bad] = lo - 0.04 * span
        report.setdefault("disconnected", {})[key] = np.where(bad)[0].tolist()
    return XY


def label_metrics(Y, q_idx, nb):
    Yq, Yn = Y[q_idx][:, None, :], Y[nb]
    inter, union = (Yq & Yn).sum(-1), (Yq | Yn).sum(-1)
    return {"share_common_label": round(float((inter > 0).mean()), 4),
            "mean_jaccard": round(float(np.where(union > 0, inter / np.maximum(union, 1), 0).mean()), 4)}


def top1_agreement(XY, top1):
    nb = knn_idx(XY, np.arange(len(XY)), np.arange(len(XY)), K)
    return round(float((top1[nb] == top1[:, None]).mean()), 4)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    lib, P, F, Y, split, labels = load()
    top1 = P.argmax(1)
    va = np.where(split == "valid")[0]
    pool = np.where(np.isin(split, ["train", "valid"]))[0]
    report = {"k": K, "seed": SEED, "settings": SETTINGS, "runs": {}}

    # reference: original high-dimensional spaces
    report["reference_highdim"] = {
        "odor_cosine": label_metrics(Y, va, knn_idx(P, va, pool, K, "cosine")),
        "structure_jaccard": label_metrics(Y, va, knn_idx(F, va, pool, K, "jaccard")),
    }
    print("high-dim reference (validation):", report["reference_highdim"])

    runs = {}
    for kind, X, metric in (("odor", P, "cosine"), ("structure", F, "jaccard")):
        for nnb, md in SETTINGS:
            t = time.time()
            XY = umap.UMAP(n_components=2, n_neighbors=nnb, min_dist=md, metric=metric, random_state=SEED).fit_transform(X)
            XY = place_disconnected(XY, key_of(kind, nnb, md), report)
            key = key_of(kind, nnb, md)
            runs[key] = XY.astype(np.float32)
            rep = {"top1": top1_agreement(XY, top1), **{"valid_" + k: v for k, v in label_metrics(Y, va, knn_idx(XY, va, pool, K)).items()},
                   "seconds": round(time.time() - t, 1)}
            report["runs"][key] = rep
            print(key, rep, flush=True)
    np.savez_compressed(OUT / "umap_runs.npz", **runs)

    # top-1 descriptor distribution and colours for the comparison figure
    counts = pd.Series([labels[i] for i in top1]).value_counts()
    report["top1_distribution"] = counts.head(20).to_dict()
    top = list(counts.index[:12])
    cmap = plt.get_cmap("tab20")
    colour = {lab: cmap(2 * i % 20 + (i >= 10)) for i, lab in enumerate(top)}
    c = [colour.get(labels[i], (0.75, 0.75, 0.75, 1)) for i in top1]
    fig, axes = plt.subplots(2, 3, figsize=(18, 12))
    for r, kind in enumerate(("odor", "structure")):
        for col, (nnb, md) in enumerate(SETTINGS):
            key = f"{kind}_n{nnb}_d{md}"
            XY, rep = runs[key], report["runs"][key]
            ax = axes[r, col]
            ax.scatter(XY[:, 0], XY[:, 1], c=c, s=3, linewidths=0)
            ax.set_title(f"{kind} map  n_neighbors={nnb}, min_dist={md}\n"
                         f"top1 agree {rep['top1']:.3f} | valid common-label {rep['valid_share_common_label']:.3f}, "
                         f"Jaccard {rep['valid_mean_jaccard']:.3f}", fontsize=10)
            ax.set_xticks([]); ax.set_yticks([])
    handles = [plt.Line2D([], [], marker="o", ls="", color=colour[l], label=l) for l in top] + \
              [plt.Line2D([], [], marker="o", ls="", color=(0.75, 0.75, 0.75), label="other")]
    fig.legend(handles=handles, loc="lower center", ncol=13, fontsize=10, frameon=False)
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    fig.savefig(OUT / "compare.png", dpi=80)
    (OUT / "compare.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print("top-1 distribution:", counts.head(12).to_dict())
    print("wrote", OUT / "compare.png")


if __name__ == "__main__":
    main()
