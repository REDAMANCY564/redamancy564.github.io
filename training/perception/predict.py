"""Stage C of PLAN-perception.md: personalized prediction of odor ratings.

Target: pleasantness (main) and intensity, raw 0-100, first presentation, detected ratings only.
Molecule features: the odor model's 138 predicted probabilities (the embedding chosen for
ingredient-finder) + log10 dilution + high/low flag. For comparison, the population model is also
fitted on Morgan fingerprints (radius 2, 2048 bits).

Scenario A, new molecules (known subjects): 5-fold CV over molecules. Cyclic molecules are grouped
by Murcko scaffold, except the benzene scaffold (104 molecules, more than a fold) which is split
like acyclic molecules (one by one); stereo pairs stay together; both concentrations of a molecule
stay together. Hyperparameters by inner 4-fold CV on the training molecules only.
  baselines: global mean; personal mean (subject's mean on training molecules)
  population: ridge on the stimulus mean rating
  + offset: population + subject's mean residual
  + personal slopes: per-subject ridge of the residual on the first k principal components of
    the features (k and penalty chosen in the inner CV)
  reference (not a model): panel mean of the test stimulus from the other subjects + offset
    ("if the population model were perfect")

Scenario B, new consumers: 5-fold CV over subjects. From the training subjects: stimulus means and
k latent factors of the residuals (matrix factorization, ALS with ridge). A test subject gives n
known ratings (n = 5 main; curve 1..50), drawn at random 20 times, or a fixed probe set (the 5
stimuli with the largest between-subject spread of the residual among those most training subjects
detect); the rest of the subject's ratings are predicted.
  baselines: global mean; molecule mean (training subjects); personal mean (mean of the n ratings)
  + offset: molecule mean + subject offset (shrunk)
  + factors: molecule mean + offset + u_s . v_i (ridge from the n ratings)

Metrics: Pearson r over all predicted ratings (pooled), mean per-subject r, RMSE; for the scenario B curve,
the difference factors - molecule mean in pooled r with a subject-bootstrap CI for every n.
Ceilings: test-retest of single ratings (repeat pairs, pooled r and RMSE); for the population
model, reliability of the panel mean (split-half, Spearman-Brown).

Input:  training/data/perception/{ratings_long.csv.gz, odor_probs.npy, odor_probs_cids.csv},
        perception-diversity/data/mappings/molecules.csv
Output: perception-diversity/data/prediction.json (+ demo cases for the page)
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from rdkit import Chem
from rdkit.Chem import rdFingerprintGenerator
from rdkit.Chem.Scaffolds.MurckoScaffold import MurckoScaffoldSmiles

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "training" / "data" / "perception"
SITE = ROOT / "perception-diversity" / "data"
SEED = 2026
N_FOLDS = 5
ALPHAS = [10, 100, 300, 1000, 3000, 10000, 30000, 100000]           # population ridge
KS = [0, 2, 5, 10, 20, 40]                                  # personal slopes: PCA components (0 = offset only)
LAMS = [10, 30, 100, 300, 1000, 3000, 10000]                     # personal slopes / factor penalties
FACTORS = [0, 1, 2, 3, 5]                           # scenario B latent factors
N_KNOWN = [1, 3, 5, 10, 20, 50]
N_DRAWS = 20


# ---------- data ----------

def load():
    df = pd.read_csv(DATA / "ratings_long.csv.gz")
    mol = pd.read_csv(SITE / "mappings" / "molecules.csv", keep_default_na=False)
    probs = np.load(DATA / "odor_probs.npy")
    cids = pd.read_csv(DATA / "odor_probs_cids.csv")["cid"].values
    P = pd.DataFrame(probs, index=cids)
    gen = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)
    fp = pd.DataFrame([gen.GetFingerprintAsNumPy(Chem.MolFromSmiles(s)).astype(np.float32)
                       for s in mol["smiles_nonstereo"]], index=mol["cid"].values)
    return df, mol, P, fp


def stimulus_features(stims, P):
    """[n_stim, 140]: probabilities of the molecule + log10 dilution + high flag."""
    cid = stims["cid"].values
    return np.hstack([P.loc[cid].values, stims[["log10_dilution"]].values,
                      (stims["level"] == "high").values[:, None].astype(float)])


def molecule_folds(mol, rng, n_folds=N_FOLDS):
    """Fold id per molecule (cid): scaffold groups except acyclic / benzene (one by one);
    stereo pairs (structure_group) together."""
    sc = [MurckoScaffoldSmiles(mol=Chem.MolFromSmiles(s)) for s in mol["smiles_nonstereo"]]
    key = []
    for cid, s, g in zip(mol["cid"], sc, mol["structure_group"]):
        if g:
            key.append("stereo:" + g)
        elif s in ("", "c1ccccc1"):
            key.append(f"single:{cid}")
        else:
            key.append("scaffold:" + s)
    groups = pd.Series(mol["cid"].values).groupby(np.array(key)).apply(list).tolist()
    order = sorted(rng.permutation(len(groups)), key=lambda i: -len(groups[i]))
    fold_of, sizes = {}, np.zeros(n_folds)
    for i in order:                                  # largest groups first, into the smallest fold
        f = int(np.argmin(sizes + rng.random(n_folds) * 1e-3))
        for c in groups[i]:
            fold_of[c] = f
        sizes[f] += len(groups[i])
    kind = dict(zip(mol["cid"], ["acyclic" if s == "" else "benzene" if s == "c1ccccc1" else "cyclic" for s in sc]))
    return fold_of, kind


# ---------- paired cluster bootstrap of a difference in pooled r ----------

def _r_from_sums(S):
    n, sy, sa, syy, saa, sya = S
    cov = sya - sy * sa / n
    return cov / np.sqrt((syy - sy ** 2 / n) * (saa - sa ** 2 / n))


def boot_diff(y, p1, p2, cluster, rng, n_boot=2000):
    """Difference r(y, p1) - r(y, p2) with a 95% CI from resampling clusters (molecules or subjects)."""
    d = pd.DataFrame({"c": cluster, "y": y, "a": p1, "b": p2})
    g = d.assign(yy=d.y ** 2, aa=d.a ** 2, bb=d.b ** 2, ya=d.y * d.a, yb=d.y * d.b, n=1).groupby("c")[
        ["n", "y", "a", "b", "yy", "aa", "bb", "ya", "yb"]].sum().values
    def diff(G):
        n, sy, sa, sb, syy, saa, sbb, sya, syb = G.sum(0)
        return _r_from_sums((n, sy, sa, syy, saa, sya)) - _r_from_sums((n, sy, sb, syy, sbb, syb))
    est = diff(g)
    bs = [diff(g[rng.integers(0, len(g), len(g))]) for _ in range(n_boot)]
    return {"diff": round(float(est), 4), "ci95": [round(float(np.quantile(bs, 0.025)), 4), round(float(np.quantile(bs, 0.975)), 4)]}


# ---------- models ----------

def ridge_fit(X, y, alpha, w=None):
    mu, sd = X.mean(0), X.std(0) + 1e-8
    Z = (X - mu) / sd
    w = np.ones(len(y)) if w is None else w
    ym = np.average(y, weights=w)
    A = Z.T @ (Z * w[:, None]) + alpha * np.eye(Z.shape[1])
    beta = np.linalg.solve(A, Z.T @ (w * (y - ym)))
    return lambda Xn: ((Xn - mu) / sd) @ beta + ym


def stim_means(tr, var):
    g = tr.groupby("stimulus")[var].agg(["mean", "count"])
    return g


def metrics(y, p, subj):
    y, p = np.asarray(y, float), np.asarray(p, float)
    r = np.corrcoef(y, p)[0, 1] if np.std(p) > 0 else np.nan
    per = pd.DataFrame({"y": y, "p": p, "s": subj}).groupby("s").apply(
        lambda g: np.corrcoef(g["y"], g["p"])[0, 1] if len(g) > 2 and g["p"].std() > 0 else np.nan)
    return {"r": round(float(r), 4), "r_per_subject_mean": round(float(np.nanmean(per)), 4),
            "rmse": round(float(np.sqrt(np.mean((y - p) ** 2))), 3), "n": int(len(y))}


class PopModel:
    def __init__(self, stim_table, feats, alpha):
        self.f = ridge_fit(feats, stim_table["mean"].values, alpha, w=np.sqrt(stim_table["count"].values))

    def __call__(self, feats):
        return self.f(feats)


def personal_slopes(tr, var, pop_tr, F_tr_pca, k, lam):
    """Per-subject ridge of residual (y - pop) on k PCA components, intercept = offset (lightly shrunk)."""
    coef = {}
    for s, g in tr.groupby("subject"):
        res = g[var].values - pop_tr[g["sidx"].values]
        if k == 0:
            coef[s] = (res.mean(), np.zeros(0))
            continue
        Z = F_tr_pca[g["sidx"].values, :k]
        zc = Z - Z.mean(0)
        b = np.linalg.solve(zc.T @ zc + lam * np.eye(k), zc.T @ (res - res.mean()))
        coef[s] = (res.mean() - Z.mean(0) @ b, b)
    return coef


def scenario_a_fold(df, var, feats_all, stim_index, train_cids, test_cids, alpha, k, lam):
    """Fit on train molecules, predict test molecules. Returns dict of prediction arrays + test frame."""
    tr = df[df["cid"].isin(train_cids)]
    te = df[df["cid"].isin(test_cids)]
    st = stim_means(tr, var)
    Ftr = feats_all[stim_index.loc[st.index].values]
    pop = PopModel(st, Ftr, alpha)
    pop_all = pop(feats_all)
    # PCA of features on training stimuli
    mu, sd = Ftr.mean(0), Ftr.std(0) + 1e-8
    U, S, Vt = np.linalg.svd((Ftr - mu) / sd, full_matrices=False)
    pcs = ((feats_all - mu) / sd) @ Vt[:max(k, 1)].T
    pcs = pcs / (S[:max(k, 1)] / np.sqrt(len(Ftr)))
    coef = personal_slopes(tr, var, pop_all, pcs, k, lam)
    gm = tr[var].mean()
    pm = tr.groupby("subject")[var].mean()
    off = {s: c[0] for s, c in coef.items()}
    p_slope = np.array([pop_all[i] + coef[s][0] + (pcs[i, :k] @ coef[s][1] if k else 0)
                        for s, i in zip(te["subject"], te["sidx"])])
    off0 = (tr[var] - pop_all[tr["sidx"].values]).groupby(tr["subject"]).mean()
    return te, {
        "global_mean": np.full(len(te), gm),
        "personal_mean": te["subject"].map(pm).values,
        "population": pop_all[te["sidx"].values],
        "population_offset": pop_all[te["sidx"].values] + te["subject"].map(off0).values,
        "population_offset_slopes": p_slope,
    }, pop_all


def inner_select(df, var, feats_all, stim_index, cids, rng):
    """Inner 4-fold CV over training molecules: pick ridge alpha (population r on stimulus means),
    then k, lam (pooled r of the full model)."""
    cids = np.array(sorted(cids))
    folds = np.array_split(rng.permutation(cids), 4)
    best_alpha, best = None, -np.inf
    for a in ALPHAS:
        rs = []
        for f in folds:
            tr_c = np.setdiff1d(cids, f)
            tr = df[df["cid"].isin(tr_c)]
            te = df[df["cid"].isin(f)]
            st = stim_means(tr, var)
            pop = PopModel(st, feats_all[stim_index.loc[st.index].values], a)
            ste = stim_means(te, var)
            rs.append(np.corrcoef(ste["mean"].values, pop(feats_all[stim_index.loc[ste.index].values]))[0, 1])
        if np.mean(rs) > best:
            best, best_alpha = np.mean(rs), a
    best_kl, best = (0, LAMS[0]), -np.inf
    for k in KS:
        for lam in (LAMS if k else [LAMS[0]]):
            ys, ps = [], []
            for f in folds:
                te, pr, _ = scenario_a_fold(df, var, feats_all, stim_index, np.setdiff1d(cids, f), f, best_alpha, k, lam)
                ys.append(te[var].values)
                ps.append(pr["population_offset_slopes"])
            r = np.corrcoef(np.concatenate(ys), np.concatenate(ps))[0, 1]
            if r > best:
                best, best_kl = r, (k, lam)
    return best_alpha, best_kl


def run_scenario_a(df, mol, var, feats_all, stim_index, fold_of, kind, odor_split, rng, label):
    preds, tests, chosen = [], [], []
    pop_stim = []
    for f in range(N_FOLDS):
        test_c = [c for c, ff in fold_of.items() if ff == f]
        train_c = [c for c, ff in fold_of.items() if ff != f]
        alpha, (k, lam) = inner_select(df, var, feats_all, stim_index, train_c, rng)
        te, pr, pop_all = scenario_a_fold(df, var, feats_all, stim_index, train_c, test_c, alpha, k, lam)
        # reference: panel mean of the test stimulus from the other subjects + offset
        tot = te.groupby("stimulus")[var].agg(["sum", "count"])
        loo = (te["stimulus"].map(tot["sum"]) - te[var]) / (te["stimulus"].map(tot["count"]) - 1)
        tr = df[df["cid"].isin(train_c)]
        off = (tr[var] - tr["stimulus"].map(tr.groupby("stimulus")[var].mean())).groupby(tr["subject"]).mean()
        pr["reference_panel_mean_offset"] = loo.values + te["subject"].map(off).values
        preds.append(pd.DataFrame(pr, index=te.index))
        tests.append(te)
        chosen.append({"fold": f, "alpha": alpha, "k": k, "lam": lam, "n_test_molecules": len(test_c)})
        st = te.groupby("stimulus").agg(y=(var, "mean"), sidx=("sidx", "first"), cid=("cid", "first"))
        st["p"] = pop_all[st["sidx"].values]
        pop_stim.append(st)
    P = pd.concat(preds)
    T = pd.concat(tests).loc[P.index]
    S = pd.concat(pop_stim)
    out = {"chosen": chosen, "rating_level": {}, "subsets": {}, "population_level": {}}
    for m in P.columns:
        out["rating_level"][m] = metrics(T[var], P[m], T["subject"])
    T = T.assign(kind=T["cid"].map(kind), seen=T["cid"].map(lambda c: "train" if odor_split[c] == "train" else "unseen"))
    for col, vals in (("kind", ["acyclic", "benzene", "cyclic"]), ("seen", ["train", "unseen"])):
        for v in vals:
            msk = (T[col] == v).values
            out["subsets"][f"{col}={v}"] = {m: metrics(T.loc[msk, var], P.loc[msk, m], T.loc[msk, "subject"])
                                            for m in ("population", "population_offset_slopes")}
    out["population_level"] = {"r_stimulus_means": round(float(np.corrcoef(S["y"], S["p"])[0, 1]), 4),
                               "n_stimuli": int(len(S))}
    S["seen"] = S["cid"].map(lambda c: "train" if odor_split[c] == "train" else "unseen")
    for v in ("train", "unseen"):
        s = S[S["seen"] == v]
        out["population_level"][f"r_stimulus_means_{v}"] = round(float(np.corrcoef(s["y"], s["p"])[0, 1]), 4)
        out["population_level"][f"n_{v}"] = int(len(s))
    print(label, var, {m: out["rating_level"][m]["r"] for m in P.columns}, out["population_level"])
    return out, P, T


# ---------- scenario B ----------

def mf_fit(tr, var, n_stim, k, lam, iters=25, rng=None):
    """Residual matrix factorization on training subjects: y = mu + a_i + b_s + u_s . v_i."""
    mu = tr[var].mean()
    si = tr["sidx"].values
    a = (np.bincount(si, tr[var].values - mu, minlength=n_stim) / np.maximum(np.bincount(si, minlength=n_stim), 1))
    subs = tr["subject"].unique()
    smap = {s: j for j, s in enumerate(subs)}
    sj = tr["subject"].map(smap).values
    b = np.bincount(sj, tr[var].values - mu - a[si]) / np.bincount(sj)
    r = tr[var].values - mu - a[si] - b[sj]
    if k == 0:
        return mu, a, np.zeros((n_stim, 0))
    rng = rng or np.random.default_rng(SEED)
    U = rng.normal(0, 0.1, (len(subs), k))
    V = rng.normal(0, 0.1, (n_stim, k))
    by_s = [np.where(sj == j)[0] for j in range(len(subs))]
    by_i = [np.where(si == i)[0] for i in range(n_stim)]
    for _ in range(iters):
        for j, idx in enumerate(by_s):
            Vi = V[si[idx]]
            U[j] = np.linalg.solve(Vi.T @ Vi + lam * np.eye(k), Vi.T @ r[idx])
        for i, idx in enumerate(by_i):
            if len(idx):
                Uj = U[sj[idx]]
                V[i] = np.linalg.solve(Uj.T @ Uj + lam * np.eye(k), Uj.T @ r[idx])
    return mu, a, V


def predict_new(known_y, known_i, mu, a, V, lam_b, lam_u):
    """Fit offset b and factors u from the known ratings (ridge), return a function of stimulus index."""
    res = known_y - mu - a[known_i]
    k = V.shape[1]
    X = np.hstack([np.ones((len(res), 1)), V[known_i]])
    pen = np.diag([lam_b] + [lam_u] * k)
    w = np.linalg.solve(X.T @ X + pen, X.T @ res)
    return lambda idx: mu + a[idx] + w[0] + (V[idx] @ w[1:] if k else 0)


def probe_set(tr, var, mu, a, n, min_detect=0.9):
    """Fixed probe stimuli: detected by >= 90% of training subjects, largest spread of residual."""
    det = tr.groupby("stimulus").size() / tr["subject"].nunique()
    res = tr[var] - mu - a[tr["sidx"].values]
    res = res - res.groupby(tr["subject"]).transform("mean")
    spread = res.groupby(tr["stimulus"]).std()
    ok = spread[det.reindex(spread.index) >= min_detect]
    return ok.sort_values(ascending=False).index[:n].tolist()


def scenario_b_eval(model, tr, te, var, lam_b, lam_u, n_known, rng, draws=N_DRAWS, probes=None):
    mu, a, V = model
    rows = []
    for s, g in te.groupby("subject"):
        for d in range(1 if probes is not None else draws):
            if probes is not None:
                kn = g[g["stimulus"].isin(probes)]
            else:
                if len(g) <= n_known:
                    continue
                kn = g.iloc[rng.choice(len(g), n_known, replace=False)]
            rest = g.drop(kn.index)
            f = predict_new(kn[var].values, kn["sidx"].values, mu, a, V, lam_b, lam_u)
            f0 = predict_new(kn[var].values, kn["sidx"].values, mu, a, V[:, :0], lam_b, lam_u)
            rows.append(pd.DataFrame({
                "subject": s, "draw": d, "y": rest[var].values, "sidx": rest["sidx"].values,
                "global_mean": tr[var].mean(), "molecule_mean": mu + a[rest["sidx"].values],
                "personal_mean": kn[var].mean() if len(kn) else tr[var].mean(),
                "molecule_offset": f0(rest["sidx"].values), "molecule_offset_factors": f(rest["sidx"].values),
                "n_known": len(kn)}))
    return pd.concat(rows)


def b_metrics(R, cols):
    out = {}
    for c in cols:
        per_draw = [metrics(g["y"], g[c], g["subject"]) for _, g in R.groupby("draw")]
        out[c] = {m: round(float(np.mean([x[m] for x in per_draw])), 4) for m in ("r", "r_per_subject_mean", "rmse")}
    return out


def run_scenario_b(df, var, n_stim, rng):
    subs = np.array(sorted(df["subject"].unique()))
    folds = np.array_split(rng.permutation(subs), N_FOLDS)
    cols = ["global_mean", "molecule_mean", "personal_mean", "molecule_offset", "molecule_offset_factors"]
    chosen, curve, probe_rows = [], {n: [] for n in N_KNOWN}, []
    for f, test_s in enumerate(folds):
        tr = df[~df["subject"].isin(test_s)]
        te = df[df["subject"].isin(test_s)]
        # inner selection on training subjects (4 folds), n_known = 5
        inner = np.array_split(rng.permutation(tr["subject"].unique()), 4)
        best, best_p = -np.inf, None
        for k in FACTORS:
            for lam_v in (LAMS[:3] if k else [LAMS[0]]):
                models = [mf_fit(tr[~tr["subject"].isin(i_s)], var, n_stim, k, lam_v) for i_s in inner]
                for lam_b in (3, 10, 30):
                    for lam_u in (LAMS if k else [LAMS[0]]):
                        R = pd.concat([scenario_b_eval(mdl, tr[~tr["subject"].isin(i_s)], tr[tr["subject"].isin(i_s)], var,
                                                       lam_b, lam_u, 5, rng, draws=5) for mdl, i_s in zip(models, inner)])
                        r = np.corrcoef(R["y"], R["molecule_offset_factors"])[0, 1]
                        if r > best:
                            best, best_p = r, (k, lam_v, lam_b, lam_u)
        k, lam_v, lam_b, lam_u = best_p
        chosen.append({"fold": f, "k": k, "lam_v": lam_v, "lam_b": lam_b, "lam_u": lam_u, "inner_r": round(best, 4)})
        model = mf_fit(tr, var, n_stim, k, lam_v)
        for n in N_KNOWN:
            curve[n].append(scenario_b_eval(model, tr, te, var, lam_b, lam_u, n, rng))
        probes = probe_set(tr, var, model[0], model[1], 5)
        P = scenario_b_eval(model, tr, te, var, lam_b, lam_u, 5, rng, probes=probes)
        probe_rows.append(P.assign(probes=",".join(probes)))
    out = {"chosen": chosen, "n_known_5": b_metrics(pd.concat(curve[5]), cols),
           "curve": {n: b_metrics(pd.concat(curve[n]), ["molecule_mean", "personal_mean", "molecule_offset",
                                                         "molecule_offset_factors"]) for n in N_KNOWN},
           "probe_set_5": b_metrics(pd.concat(probe_rows), cols),
           "probe_sets": sorted({p for R in probe_rows for p in R["probes"].unique()})}
    print("B", var, {c: out["n_known_5"][c]["r"] for c in cols}, "probe:", {c: out["probe_set_5"][c]["r"] for c in cols})
    return out, pd.concat(curve[5]), {n: pd.concat(curve[n]) for n in N_KNOWN}


def ceilings(df_all, var):
    rep = df_all[df_all["stimulus"].isin(df_all.loc[df_all["presentation"] == 2, "stimulus"].unique())]
    w = rep.pivot_table(index=["subject", "stimulus"], columns="presentation", values=var, aggfunc="first").dropna()
    subj = w.index.get_level_values(0)
    m = metrics(w[1].values, w[2].values, subj)
    return {"test_retest_single_rating": m,
            "max_r_for_a_single_rating": round(float(np.sqrt(m["r"])), 4),
            "note": "test-retest r = how well one noisy rating predicts another; sqrt(r) = the highest r any "
                    "prediction can reach with a single noisy rating (prediction = the person's true score)"}


def main():
    rng = np.random.default_rng(SEED)
    df_all, mol, P, fp = load()
    odor_split = dict(zip(mol["cid"], mol["odor_dataset_split"]))
    fold_of, kind = molecule_folds(mol, rng)
    out = {"method": __doc__.split("Input:")[0].strip(), "folds": {
        "molecules_per_fold": pd.Series(fold_of).value_counts().sort_index().tolist(),
        "kinds": pd.Series(kind).value_counts().to_dict()}, "results": {}}
    for var in ("pleasantness", "intensity"):
        df = df_all[(df_all["presentation"] == 1) & df_all[var].notna()].copy()
        stims = df.drop_duplicates("stimulus")[["stimulus", "cid", "level", "log10_dilution"]].sort_values("stimulus").reset_index(drop=True)
        stim_index = pd.Series(stims.index, index=stims["stimulus"])
        df["sidx"] = df["stimulus"].map(stim_index).values
        feats = stimulus_features(stims, P)
        feats_fp = np.hstack([fp.loc[stims["cid"]].values, feats[:, -2:]])
        res = {"ceiling": ceilings(df_all[df_all[var].notna()], var)}
        rel = json.loads((SITE / "qc.json").read_text(encoding="utf-8"))["panel_reliability"][var]
        res["ceiling"]["panel_mean_reliability"] = rel
        res["new_molecules"], PA, TA = run_scenario_a(df, mol, var, feats, stim_index, fold_of, kind, odor_split, rng, "A-gnn")
        res["new_molecules_fingerprint"], PF, _ = run_scenario_a(df, mol, var, feats_fp, stim_index, fold_of, kind, odor_split, rng, "A-fp")
        res["new_consumers"], RB, RC = run_scenario_b(df, var, len(stims), rng)
        PF = PF.loc[PA.index]
        y, cl = TA[var].values, TA["cid"].values
        res["comparisons"] = {
            "A_gnn_vs_fingerprint_population": boot_diff(y, PA["population"], PF["population"], cl, rng),
            "A_gnn_vs_fingerprint_full": boot_diff(y, PA["population_offset_slopes"], PF["population_offset_slopes"], cl, rng),
            "A_slopes_vs_offset": boot_diff(y, PA["population_offset_slopes"], PA["population_offset"], cl, rng),
            "A_offset_vs_population": boot_diff(y, PA["population_offset"], PA["population"], cl, rng),
            "B5_factors_vs_offset": boot_diff(RB["y"], RB["molecule_offset_factors"], RB["molecule_offset"], RB["subject"], rng),
            "B5_offset_vs_molecule_mean": boot_diff(RB["y"], RB["molecule_offset"], RB["molecule_mean"], RB["subject"], rng),
            "clusters": "A: molecules; B: subjects (all 20 draws pooled)"}
        # added 2026-10-20: the curve with a CI per n. Own generator, so the shared rng (and every result
        # computed before this was added) is unchanged.
        rng_ci = np.random.default_rng([SEED, len(var)])
        res["comparisons"]["B_curve_factors_vs_molecule_mean"] = {
            n: boot_diff(R["y"], R["molecule_offset_factors"], R["molecule_mean"], R["subject"], rng_ci) for n, R in RC.items()}
        print(var, res["comparisons"])
        out["results"][var] = res
        if var == "pleasantness":
            pd.concat([TA[["subject", "cid", "stimulus", var]], PA], axis=1).to_csv(DATA / "pred_a_pleasantness.csv.gz", index=False)
            RB.assign(stimulus=stims["stimulus"].values[RB["sidx"].values]).to_csv(DATA / "pred_b_pleasantness.csv.gz", index=False)
    (SITE / "prediction.json").write_text(json.dumps(out, indent=1, default=float), encoding="utf-8")


if __name__ == "__main__":
    main()
