"""Stage 2 of odor-map (PLAN-odor-map.md): final maps and the one-time test evaluation.

Library: training/data/ingredient/library.json after the exclusions of 2026-10-18 (5,072 molecules).
Parameters (chosen on validation in stage 1, each map at its best, user decision 2026-10-18):
  odor map       138-d predicted probabilities (uint8 as on the site), cosine, n_neighbors=30, min_dist=0.3
  structure map  Morgan r = 2, 2048 bits, Jaccard, n_neighbors=15, min_dist=0.1
  random_state 42 for both.
Metrics (k = 15 nearest neighbours on the 2-D map):
  main (results section): TEST molecules with true labels; neighbours = 15 nearest labelled molecules
        (train + valid + test, query excluded); share with >= 1 common label, mean Jaccard; the same in
        the original high-dimensional spaces as reference; paired bootstrap CI odor - structure;
        random reference: 15 labelled molecules drawn at random for each query (mean of 200 draws)
  supplementary (circular, favours the odor map): all molecules, share of the 15 nearest neighbours
        with the same top-1 predicted descriptor
Molecules whose labels come only from mixtures are unlabelled here.
Output: training/data/odormap/maps.npz, eval.json
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import umap
from sklearn.neighbors import NearestNeighbors

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "training" / "data"
OUT = DATA / "odormap"
SEED, K = 42, 15
PARAMS = {"odor": {"n_neighbors": 30, "min_dist": 0.3, "metric": "cosine"},
          "structure": {"n_neighbors": 15, "min_dist": 0.1, "metric": "jaccard"}}
RNG = np.random.default_rng(0)
RNG_RANDOM = np.random.default_rng(1)   # separate stream: the bootstrap CIs stay as first computed


def knn(X, q_idx, pool_idx, k, metric="euclidean"):
    nn = NearestNeighbors(n_neighbors=k + 1, metric=metric).fit(X[pool_idx])
    _, ind = nn.kneighbors(X[q_idx])
    pool = np.asarray(pool_idx)
    return np.array([[pool[j] for j in row if pool[j] != q][:k] for q, row in zip(q_idx, ind)])


def per_query(Y, q_idx, nb):
    Yq, Yn = Y[q_idx][:, None, :], Y[nb]
    inter, union = (Yq & Yn).sum(-1), (Yq | Yn).sum(-1)
    return (inter > 0).mean(1), np.where(union > 0, inter / np.maximum(union, 1), 0).mean(1)


def ci(d, n=5000):
    m = [RNG.choice(d, len(d)).mean() for _ in range(n)]
    return [round(float(np.percentile(m, 2.5)), 4), round(float(np.percentile(m, 97.5)), 4)]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    lib = json.loads((DATA / "ingredient" / "library.json").read_text(encoding="utf-8"))["molecules"]
    f = np.load(DATA / "ingredient" / "features.npz")
    assert len(lib) == len(f["probs"])
    P = np.round(f["probs"] * 255) / 255
    F = np.unpackbits(f["fps"], axis=1).astype(bool)
    clean = pd.read_csv(DATA / "clean.csv")
    labels = list(clean.columns[1:])
    lab = dict(zip(clean.smiles, clean[labels].to_numpy().astype(bool)))
    labelled = np.array([r["smiles"] in lab and not r.get("labels_from_mixture") for r in lib])
    Y = np.array([lab[r["smiles"]] if labelled[i] else np.zeros(len(labels), bool) for i, r in enumerate(lib)])
    split = np.array([r["split"] for r in lib])

    maps = {}
    for kind, X in (("odor", P), ("structure", F)):
        XY = umap.UMAP(n_components=2, random_state=SEED, **PARAMS[kind]).fit_transform(X)
        assert not np.isnan(XY).any(), kind
        maps[kind] = XY.astype(np.float32)
    np.savez_compressed(OUT / "maps.npz", **maps)

    rep = {"k": K, "seed": SEED, "params": PARAMS, "n_molecules": len(lib)}
    lab_all = np.where(labelled)[0]
    for name, q in (("valid", np.where((split == "valid") & labelled)[0]), ("test", np.where((split == "test") & labelled)[0])):
        pool = lab_all if name == "test" else np.where(labelled & np.isin(split, ["train", "valid"]))[0]
        r = {"n": int(len(q))}
        vals = {}
        for key, X, metric in (("odor_map", maps["odor"], "euclidean"), ("structure_map", maps["structure"], "euclidean"),
                               ("odor_highdim", P, "cosine"), ("structure_highdim", F, "jaccard")):
            share, jac = per_query(Y, q, knn(X, q, pool, K, metric))
            vals[key] = (share, jac)
            r[key] = {"share_common_label": round(float(share.mean()), 4), "mean_jaccard": round(float(jac.mean()), 4)}
        rs = [per_query(Y, q, np.array([RNG_RANDOM.choice(pool[pool != i], K, replace=False) for i in q])) for _ in range(200)]
        r["random"] = {"share_common_label": round(float(np.mean([a.mean() for a, _ in rs])), 4),
                       "mean_jaccard": round(float(np.mean([b.mean() for _, b in rs])), 4)}
        r["map_diff_ci95"] = {"share_common_label": ci(vals["odor_map"][0] - vals["structure_map"][0]),
                              "mean_jaccard": ci(vals["odor_map"][1] - vals["structure_map"][1])}
        rep[name] = r
        print(name, json.dumps(r))

    top1 = P.argmax(1)
    allq = np.arange(len(lib))
    rep["supplementary_top1_agreement"] = {
        kind: round(float((top1[knn(maps[kind], allq, allq, K)] == top1[:, None]).mean()), 4) for kind in maps}
    print("supplementary (circular):", rep["supplementary_top1_agreement"])
    (OUT / "eval.json").write_text(json.dumps(rep, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
