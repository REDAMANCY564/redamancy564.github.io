"""Stage D of PLAN-perception.md: consumer segments from pleasantness ratings.

Input per subject: pleasantness of the first presentation, detected stimuli only, z-scored within
the subject, minus the panel mean of the stimulus (so what is left is how the subject differs from
everybody; without this step the clustering mostly separates noisy from consistent raters).

Clustering, k = 2..6, two methods as a cross-check:
  hierarchical: average linkage on 1 - r (r = correlation of two subjects' deviations over the
                stimuli both detected, at least MIN_OVERLAP)
  k-means:      on the deviation matrix (missing = 0, i.e. the panel mean)
Decision rule, fixed before looking at the results: segments are reported as real only if, for
some k, BOTH
  (a) the silhouette is above the 95th percentile of a no-structure null (each subject's deviations
      permuted across stimuli, NULL_RUNS times), and
  (b) split-half stability: stimuli split at random into halves, each half clustered, adjusted Rand
      index between the two solutions, mean over SPLITS splits >= 0.5.
Otherwise the page says individual differences look continuous, and they are described by the
first principal axes of the deviation matrix instead.
Description of a segment or axis: Spearman rho across stimuli between its mean deviation (or axis
loading) and the panel-mean rating of each of the 20 Keller descriptors.

Input:  training/data/perception/ratings_long.csv.gz, perception-diversity/data/qc_subjects.csv
Output: perception-diversity/data/segments.json
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import squareform
from scipy.stats import rankdata, spearmanr
from sklearn.cluster import KMeans
from sklearn.metrics import adjusted_rand_score, silhouette_score

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "training" / "data" / "perception"
SITE = ROOT / "perception-diversity" / "data"
SEED = 2026
KS = [2, 3, 4, 5, 6]
MIN_OVERLAP = 100
NULL_RUNS = 200
SPLITS = 100
DESC = ["d_edible", "d_bakery", "d_sweet", "d_fruit", "d_fish", "d_garlic", "d_spices", "d_cold", "d_sour",
        "d_burnt", "d_acid", "d_warm", "d_musky", "d_sweaty", "d_ammonia_urinous", "d_decayed", "d_wood",
        "d_grass", "d_flower", "d_chemical"]


def deviation_matrix(df, subjects=None):
    d = df[(df["presentation"] == 1) & df["pleasantness"].notna()]
    if subjects is not None:
        d = d[d["subject"].isin(subjects)]
    d = d.assign(z=d.groupby("subject")["pleasantness"].transform(lambda x: (x - x.mean()) / x.std()))
    d = d.assign(dev=d["z"] - d.groupby("stimulus")["z"].transform("mean"))
    return d.pivot(index="subject", columns="stimulus", values="dev")


def corr_distance(M):
    """1 - pairwise correlation over common non-missing columns (NaN where overlap < MIN_OVERLAP)."""
    X = M.values
    W = (~np.isnan(X)).astype(float)
    X0 = np.nan_to_num(X)
    n = W @ W.T                                  # common columns of each pair
    sx = X0 @ W.T                                # sum of x_i over columns shared with j
    sxx = (X0 ** 2) @ W.T
    sxy = X0 @ X0.T
    with np.errstate(invalid="ignore", divide="ignore"):
        cov = sxy - sx * sx.T / n
        r = cov / np.sqrt((sxx - sx ** 2 / n) * (sxx.T - sx.T ** 2 / n))
    r = np.where(n >= MIN_OVERLAP, r, 0.0)
    D = 1 - r
    np.fill_diagonal(D, 0.0)
    return D


def cluster(M, k, method, D=None, seed=SEED):
    if method == "hierarchical":
        D = corr_distance(M) if D is None else D
        return fcluster(linkage(squareform(D, checks=False), "average"), k, "maxclust") - 1
    X = M.fillna(0).values
    return KMeans(k, n_init=20, random_state=seed).fit_predict(X)


def silhouette(M, labels, method, D=None):
    if len(set(labels)) < 2:
        return np.nan
    if method == "hierarchical":
        return float(silhouette_score(corr_distance(M) if D is None else D, labels, metric="precomputed"))
    return float(silhouette_score(M.fillna(0).values, labels))


def permute_null(M, rng):
    """Each subject's observed deviations shuffled across its own observed stimuli."""
    X = M.values.copy()
    for i in range(len(X)):
        ok = ~np.isnan(X[i])
        X[i, ok] = rng.permutation(X[i, ok])
    return pd.DataFrame(X, index=M.index, columns=M.columns)


def split_half_ari(M, k, method, rng):
    aris = []
    cols = M.columns.values
    for _ in range(SPLITS):
        perm = rng.permutation(cols)
        h1, h2 = perm[: len(cols) // 2], perm[len(cols) // 2:]
        aris.append(adjusted_rand_score(cluster(M[h1], k, method), cluster(M[h2], k, method)))
    return float(np.mean(aris)), float(np.quantile(aris, 0.1)), float(np.quantile(aris, 0.9))


def axis_split_half(M, rng, n_axes=3, splits=SPLITS):
    """Reproducibility of the principal axes: SVD on two random halves of the stimuli, |r| between the
    subject scores of axis a in the two halves (axes matched by rank)."""
    out = np.zeros((splits, n_axes))
    cols = M.columns.values
    for t in range(splits):
        perm = rng.permutation(cols)
        sc = []
        for h in (perm[: len(cols) // 2], perm[len(cols) // 2:]):
            X = M[h].fillna(0).values
            U, S, _ = np.linalg.svd(X - X.mean(0), full_matrices=False)
            sc.append(U[:, :n_axes] * S[:n_axes])
        out[t] = [abs(np.corrcoef(sc[0][:, a], sc[1][:, a])[0, 1]) for a in range(n_axes)]
    return out.mean(0)


def partial_rho(a, b, z):
    """Spearman correlation of a and b with z (rank) partialled out."""
    def res(v):
        Z = np.c_[np.ones(len(z)), rankdata(z)]
        v = rankdata(v)
        return v - Z @ np.linalg.lstsq(Z, v, rcond=None)[0]
    return float(np.corrcoef(res(a), res(b))[0, 1])


def describe(profile, desc_panel):
    """Spearman rho across stimuli between a per-stimulus profile and each descriptor's panel mean."""
    j = desc_panel.loc[profile.index]
    return {c[2:]: round(float(spearmanr(profile.values, j[c].values)[0]), 3) for c in DESC}


def analyse(df, subjects, rng, label, full=True):
    M = deviation_matrix(df, subjects)
    D = corr_distance(M)
    res = {"n_subjects": len(M), "n_stimuli": M.shape[1], "methods": {}}
    for method in ("hierarchical", "kmeans"):
        rows = {}
        for k in KS:
            lab = cluster(M, k, method, D)
            sil = silhouette(M, lab, method, D)
            null = []
            for _ in range(NULL_RUNS if full else NULL_RUNS // 4):
                Mn = permute_null(M, rng)
                Dn = corr_distance(Mn) if method == "hierarchical" else None
                null.append(silhouette(Mn, cluster(Mn, k, method, Dn), method, Dn))
            ari = split_half_ari(M, k, method, rng) if full else (np.nan, np.nan, np.nan)
            sizes = sorted(np.bincount(lab).tolist(), reverse=True)
            rows[k] = {"silhouette": round(sil, 4), "null_p95": round(float(np.nanquantile(null, 0.95)), 4),
                       "null_mean": round(float(np.nanmean(null)), 4),
                       "split_half_ari_mean": round(ari[0], 3), "split_half_ari_p10_p90": [round(ari[1], 3), round(ari[2], 3)],
                       "sizes": sizes,
                       "passes": bool(sil > np.nanquantile(null, 0.95) and ari[0] >= 0.5) if full else None}
            print(label, method, k, rows[k])
        res["methods"][method] = rows
    return res, M, D


def main():
    rng = np.random.default_rng(SEED)
    df = pd.read_csv(DATA / "ratings_long.csv.gz")
    qc = pd.read_csv(SITE / "qc_subjects.csv", keep_default_na=False)
    desc_panel = df[(df["presentation"] == 1) & (df["detected"] == 1)].groupby("stimulus")[DESC].mean()

    out = {"method": __doc__.split("Input:")[0].strip(), "results": {}}
    res, M, D = analyse(df, None, rng, "all")
    out["results"]["all"] = res
    passing = [(m, k) for m, rows in res["methods"].items() for k, r in rows.items() if r["passes"]]
    out["decision"] = {"segments_supported": bool(passing), "passing": passing}

    # mean pairwise similarity of deviations (how much do people share their departures from the panel?)
    iu = np.triu_indices(len(D), 1)
    out["pairwise_deviation_r"] = {"mean": round(float(np.mean(1 - D[iu])), 4),
                                   "p05_p95": [round(float(np.quantile(1 - D[iu], 0.05)), 4), round(float(np.quantile(1 - D[iu], 0.95)), 4)]}

    # continuous description: principal axes of the deviation matrix (missing = 0)
    X = M.fillna(0).values
    Xc = X - X.mean(0)
    U, S, Vt = np.linalg.svd(Xc, full_matrices=False)
    var = S ** 2 / (S ** 2).sum()
    nullv = []
    for _ in range(NULL_RUNS):
        Xn = permute_null(M, rng).fillna(0).values
        Sn = np.linalg.svd(Xn - Xn.mean(0), compute_uv=False)
        nullv.append((Sn ** 2 / (Sn ** 2).sum())[:5])
    nullv = np.array(nullv)
    first = df[(df["presentation"] == 1) & (df["detected"] == 1)]
    panel_int = first.groupby("stimulus")["intensity"].mean().loc[M.columns]
    panel_det = df[df["presentation"] == 1].groupby("stimulus")["detected"].mean().loc[M.columns]
    qc_s = qc.set_index("subject").loc[M.index]
    axes = []
    for a in range(3):
        load = pd.Series(Vt[a], index=M.columns)
        if spearmanr(load, panel_int)[0] > 0:        # orient: positive end = weaker odors
            load, U[:, a] = -load, -U[:, a]
        # orient: positive end = what high scorers like more than the panel
        axes.append({"axis": a + 1, "variance_share": round(float(var[a]), 4),
                     "null_p95": round(float(np.quantile(nullv[:, a], 0.95)), 4),
                     "descriptor_rho": describe(load, desc_panel),
                     "rho_with_panel_intensity": round(float(spearmanr(load, panel_int)[0]), 3),
                     "rho_with_detection_rate": round(float(spearmanr(load, panel_det)[0]), 3),
                     "descriptor_rho_intensity_partialled": {c[2:]: round(partial_rho(load.values, desc_panel.loc[M.columns, c].values,
                                                                                       panel_int.values), 3) for c in DESC},
                     "subject_score_rho_with_qc": {c: round(float(spearmanr(U[:, a] * S[a], qc_s[c])[0]), 3) for c in
                                                   ("detect_rate", "intensity_mean", "pleasantness_mean", "pleasantness_sd",
                                                    "retest_pleasantness_r", "high_gt_low_frac")},
                     "subject_scores": {s: round(float(v), 3) for s, v in zip(M.index, U[:, a] * S[a])},
                     "top_stimuli_positive": load.sort_values(ascending=False).index[:8].tolist(),
                     "top_stimuli_negative": load.sort_values().index[:8].tolist()})
        print("axis", a + 1, axes[-1]["variance_share"], "null p95", axes[-1]["null_p95"])
    real = axis_split_half(M, rng)
    null = np.array([axis_split_half(permute_null(M, rng), rng, splits=20) for _ in range(20)])
    for a, ax in enumerate(axes):
        ax["split_half_abs_r"] = round(float(real[a]), 3)
        ax["split_half_null_p95"] = round(float(np.quantile(null[:, a], 0.95)), 3)
        print("axis", a + 1, "split-half |r|", ax["split_half_abs_r"], "null p95", ax["split_half_null_p95"])
    out["axes"] = axes

    # segment descriptions for the best k of each method (by silhouette minus null), whether or not they pass
    out["segments"] = {}
    for method, rows in res["methods"].items():
        k = max(rows, key=lambda kk: rows[kk]["silhouette"] - rows[kk]["null_p95"])
        lab = cluster(M, k, method, D)
        segs = []
        for c in range(k):
            members = M.index[lab == c].tolist()
            prof = M.loc[members].mean()
            prof = prof[M.loc[members].notna().sum() >= max(2, len(members) // 3)]
            fl = qc.set_index("subject").loc[members]
            segs.append({"segment": c, "n": len(members), "members": members,
                         "descriptor_rho": describe(prof, desc_panel) if len(members) >= 3 else None,
                         "mean_detect_rate": round(float(fl["detect_rate"].mean()), 3),
                         "flagged_low_retest": int(fl["flags"].str.contains("low_retest_intensity").sum())})
        out["segments"][method] = {"k": k, "segments": segs}

    # sensitivity: without low-retest subjects / without P55 (silhouette vs null only; no split-half)
    low = qc.loc[qc["flags"].str.contains("low_retest_intensity"), "subject"].tolist()
    for name, subs in (("excl_low_retest", [s for s in qc["subject"] if s not in low]),
                       ("excl_P55", [s for s in qc["subject"] if s != "P55"])):
        out["results"][name] = analyse(df, subs, rng, name, full=True)[0]
        p = [(m, k) for m, rows in out["results"][name]["methods"].items() for k, r in rows.items() if r["passes"]]
        out["decision"][name] = p
    print("decision", out["decision"])
    (SITE / "segments.json").write_text(json.dumps(out, indent=1, default=float), encoding="utf-8")


if __name__ == "__main__":
    main()
