"""Stage 2 of PLAN-mixture.md: mixture odor similarity, baselines vs a small learned model (Snitz 2013 data).

Data: training/data/mixture/snitz.json (snitz_data.py). Target = dissimilarity = 100 - average rated similarity,
so every method should correlate positively. Identical-mixture comparisons are excluded everywhere.

Split (user-approved 2026-10-18), by mixture, never by pair:
  TEST   Dataset 1, non-overlapping comparisons (computed once, after the method and settings are fixed)
  TRAIN  Datasets 2 and 3; settings chosen by cross-validation that holds out whole mixtures:
         one fold per Dataset 2 mixture (all its comparisons) and one fold per connected group of
         Dataset 3 molecules; training pairs never contain a held-out mixture.

Methods
  (a) Snitz angle: Dragon descriptors (Table S1) rescaled to [0, 1] over its odorants, a mixture =
      sum of its components, distance = angle. a21 = the 21 descriptors of Snitz Table 1 (selected by Snitz
      on half of Dataset 2), a_all = all descriptors.
  (b) additive rule of flavor-improver: profile = sum of components' lift vectors on the 12 reference-mode
      dimensions (equal intensities, so equal weights), distance = 1 - cosine. b138 = the same with the
      138 predicted probabilities (the POM baseline of Satarifard et al. 2026).
  (c) new model (odor-predictor GNN probabilities, the embedding chosen in ingredient-finder):
      mixture = power mean of the components' probability vectors (exponent p, learned),
      distance = angle between w * m_a and w * m_b, w = exp(u) >= 0 per descriptor, penalty lam * |u|^2.
      Fitted by maximizing the Pearson correlation with dissimilarity on the training pairs.
      Variants: c_p (p only, w = 1) and c_pw (p and w); variant and lam chosen by the cross-validation.
Bootstrap: 95% CI of Pearson differences on the test set, resampling mixtures (all comparisons of a
mixture move together; pairs whose mixtures are both drawn are kept with multiplicity), 2,000 draws.
Usage: python evaluate.py (cross-validation only, cv.json), then python evaluate.py --test (once)
Output: training/data/mixture/eval.json, model.json (fitted parameters of the chosen model)
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from scipy.stats import pearsonr, spearmanr

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "training" / "data" / "mixture"
SNITZ21 = ["nCIR", "ZM1", "GNar", "S1K", "piPC08", "MATS1v", "MATS7v", "GATS1v", "EEig05x", "ESpm02x", "ESpm03d",
           "ESpm10d", "ESpm13d", "BELv3", "RDF035v", "G1m", "G1v", "G1e", "G3s", "R8u+", "nRCOSR"]
LAMS = [0.01, 0.1, 1.0, 10.0]
# Stereo-specific CIDs of the mixtures that Table S1 lists under other CIDs with the same connectivity
# (PubChem cids_type=same_connectivity, 2026-10-18); their descriptor rows are averaged.
DRAGON_ALIAS = {443158: [67179, 6549], 5281168: [10460], 5281515: [6887, 26318], 5283349: [16899], 6259976: [28500]}
RNG = np.random.default_rng(0)
torch.manual_seed(0)


def load():
    d = json.loads((DATA / "snitz.json").read_text(encoding="utf-8"))
    pairs = [p for p in d["pairs"] if p["a"] != p["b"]]
    for p in pairs:
        p["y"] = 100 - p["similarity"]
    return d, pairs


def angle(u, v):
    c = (u * v).sum(-1) / np.maximum(np.linalg.norm(u, axis=-1) * np.linalg.norm(v, axis=-1), 1e-12)
    return np.arccos(np.clip(c, -1, 1))


def sum_vectors(mix, vec):
    return {m: np.sum([vec[c] for c in cids], axis=0) for m, cids in mix.items()}


def dists_fixed(pairs, mv, kind):
    a = np.array([mv[p["a"]] for p in pairs])
    b = np.array([mv[p["b"]] for p in pairs])
    if kind == "angle":
        return angle(a, b)
    return 1 - np.cos(angle(a, b))


# ---------- learned model ----------
class Model:
    def __init__(self, mix, probs, use_w):
        self.mix, self.use_w = mix, use_w
        self.cids = sorted({c for m in mix.values() for c in m})
        self.P = torch.tensor(np.array([probs[c] for c in self.cids]), dtype=torch.float64).clamp_min(1e-4)
        self.idx = {m: torch.tensor([self.cids.index(c) for c in cids]) for m, cids in mix.items()}

    def mixvec(self, logp, m):
        p = torch.exp(logp)
        return (self.P[self.idx[m]] ** p).mean(0) ** (1 / p)

    def dist(self, params, pairs):
        logp, u = params
        w = torch.exp(u) if self.use_w else torch.ones_like(u)
        out = []
        for q in pairs:
            a, b = w * self.mixvec(logp, q["a"]), w * self.mixvec(logp, q["b"])
            c = (a * b).sum() / (a.norm() * b.norm())
            out.append(torch.arccos(c.clamp(-1 + 1e-9, 1 - 1e-9)))
        return torch.stack(out)

    def fit(self, pairs, lam):
        y = torch.tensor([p["y"] for p in pairs], dtype=torch.float64)
        logp = torch.zeros((), dtype=torch.float64, requires_grad=True)
        u = torch.zeros(self.P.shape[1], dtype=torch.float64, requires_grad=self.use_w)
        params = [logp, u] if self.use_w else [logp]
        opt = torch.optim.LBFGS(params, max_iter=200, line_search_fn="strong_wolfe")

        def closure():
            opt.zero_grad()
            d = self.dist((logp, u), pairs)
            dc, yc = d - d.mean(), y - y.mean()
            r = (dc * yc).sum() / (dc.norm() * yc.norm() + 1e-12)
            loss = -r + (lam * (u ** 2).mean() if self.use_w else 0) + 0.01 * logp ** 2
            loss.backward()
            return loss
        opt.step(closure)
        return logp.detach(), u.detach()

    def predict(self, params, pairs):
        with torch.no_grad():
            return self.dist(params, pairs).numpy()


def folds(train, mix):
    """Hold out whole mixtures: one fold per Dataset 2 mixture, one per connected group of Dataset 3."""
    out = []
    for m in sorted({x for p in train if p["dataset"] == "d2" for x in (p["a"], p["b"])}):
        out.append({m})
    d3 = [p for p in train if p["dataset"] == "d3"]
    parent = {}
    find = lambda x: x if parent.setdefault(x, x) == x else find(parent[x])
    for p in d3:
        parent[find(p["a"])] = find(p["b"])
    groups = {}
    for p in d3:
        for x in (p["a"], p["b"]):
            groups.setdefault(find(x), set()).add(x)
    out += list(groups.values())
    return out


def cv_score(train, mix, probs, use_w, lam):
    """Pooled Pearson of out-of-fold predictions (each held-out pair predicted once, by its first fold)."""
    pred = {}
    for held in folds(train, mix):
        test_p = [p for p in train if (p["a"] in held or p["b"] in held) and id(p) not in pred]
        fit_p = [p for p in train if p["a"] not in held and p["b"] not in held]
        if not test_p:
            continue
        model = Model(mix, probs, use_w)
        params = model.fit(fit_p, lam)
        for p, v in zip(test_p, model.predict(params, test_p)):
            pred[id(p)] = v
    ys = np.array([p["y"] for p in train if id(p) in pred])
    ps = np.array([pred[id(p)] for p in train if id(p) in pred])
    return float(pearsonr(ps, ys)[0]), len(ps)


def corr(x, y):
    return {"pearson": round(float(pearsonr(x, y)[0]), 4), "spearman": round(float(spearmanr(x, y)[0]), 4)}


def boot_diff(test, preds, a, b, n=2000):
    mixes = sorted({x for p in test for x in (p["a"], p["b"])})
    y = np.array([p["y"] for p in test])
    out = []
    for _ in range(n):
        cnt = {}
        for m in RNG.choice(mixes, len(mixes)):
            cnt[m] = cnt.get(m, 0) + 1
        wts = np.array([cnt.get(p["a"], 0) * cnt.get(p["b"], 0) for p in test])
        if (wts > 0).sum() < 10:
            continue
        idx = np.repeat(np.arange(len(test)), wts)
        out.append(pearsonr(preds[a][idx], y[idx])[0] - pearsonr(preds[b][idx], y[idx])[0])
    return [round(float(np.percentile(out, 2.5)), 4), round(float(np.percentile(out, 97.5)), 4)]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    d, pairs = load()
    mix = d["mixtures"]
    probs = {int(c): np.array(m["probs"]) for c, m in d["molecules"].items()}
    mix = {k: [int(c) for c in v] for k, v in mix.items()}
    train = [p for p in pairs if p["dataset"] in ("d2", "d3")]
    test = [p for p in pairs if p["dataset"] == "d1"]
    assert all(not set(mix[p["a"]]) & set(mix[p["b"]]) for p in test)

    # fixed baselines
    dragon = pd.read_csv(DATA / "snitz_dragon.csv").set_index("CID")
    dragon = dragon.apply(pd.to_numeric, errors="coerce")
    dragon = dragon.loc[:, dragon.notna().all()]
    rng = (dragon.max() - dragon.min()).replace(0, np.nan)
    dn = ((dragon - dragon.min()) / rng).dropna(axis=1)
    for c, alias in DRAGON_ALIAS.items():
        assert c not in dn.index
        dn.loc[c] = dn.loc[alias].mean()
    missing = sorted({c for m in mix.values() for c in m} - set(dn.index))
    ref = json.loads((ROOT / "flavor-improver" / "data" / "reference.json").read_text(encoding="utf-8"))
    labels = [l["id"] for l in json.loads((ROOT / "odor-predictor" / "model" / "labels.json").read_text(encoding="utf-8"))]
    dim_idx = [labels.index(x) for x in ref["profile_dims"]]
    prev = np.array(ref["label_prevalence"])
    lift12 = {c: v[dim_idx] / prev for c, v in probs.items()}
    vecs = {
        "a21": ({c: dn.loc[c, SNITZ21].to_numpy() for c in dn.index}, "angle"),
        "a_all": ({c: dn.loc[c].to_numpy() for c in dn.index}, "angle"),
        "b12": (lift12, "cosine"),
        "b138": (probs, "cosine"),
    }
    usable = lambda ps: [p for p in ps if all(c in dn.index for c in mix[p["a"]] + mix[p["b"]])]
    rep = {"n_train": len(train), "n_test": len(test), "dragon_missing_cids": missing,
           "n_test_with_dragon": len(usable(test)), "n_dragon_descriptors": dn.shape[1]}
    print(rep)

    # model selection by cross-validation on the training pairs only
    cv = {}
    for use_w, lams in ((False, [0.0]), (True, LAMS)):
        for lam in lams:
            key = f"c_pw_lam{lam}" if use_w else "c_p"
            cv[key] = cv_score(train, mix, probs, use_w, lam)
            print("CV", key, cv[key])
    for k, (vec, kind) in vecs.items():
        tp = usable(train) if k.startswith("a") else train
        dist = dists_fixed(tp, sum_vectors({m: mix[m] for m in {x for p in tp for x in (p["a"], p["b"])}}, vec), kind)
        cv[k] = (corr(dist, [p["y"] for p in tp])["pearson"], len(tp))
        print("train (no fitting)", k, cv[k])
    best = max((k for k in cv if k.startswith("c_")), key=lambda k: -np.inf if np.isnan(cv[k][0]) else cv[k][0])
    use_w = best != "c_p"
    lam = float(best.split("lam")[1]) if use_w else 0.0
    rep["cv_train"] = {k: {"pearson": round(v[0], 4), "n": v[1]} for k, v in cv.items()}
    rep["chosen"] = best
    print("chosen:", best)
    if "--test" not in sys.argv:   # the test set is computed only once, in a separate run
        (DATA / "cv.json").write_text(json.dumps(rep, indent=1), encoding="utf-8")
        return

    # final model on all training pairs, then the test set once
    model = Model(mix, probs, use_w)
    params = model.fit(train, lam)
    preds = {"c": model.predict(params, test)}
    yt = np.array([p["y"] for p in test])
    for k, (vec, kind) in vecs.items():
        preds[k] = dists_fixed(test, sum_vectors(mix, vec), kind) if not k.startswith("a") else None
    tu = usable(test)
    keep = np.array([p in tu for p in test])
    for k in ("a21", "a_all"):
        full = np.full(len(test), np.nan)
        full[keep] = dists_fixed(tu, sum_vectors(mix, vecs[k][0]), "angle")
        preds[k] = full
    rep["test"] = {k: corr(v[keep], yt[keep]) | {"n": int(keep.sum())} for k, v in preds.items()}
    rep["test_all_pairs"] = {k: corr(v, yt) | {"n": len(test)} for k, v in preds.items() if not np.isnan(v).any()}
    sub = [p for p in test]
    pk = {k: v[keep] for k, v in preds.items()}
    tk = [p for p, kk in zip(test, keep) if kk]
    rep["test_diff_ci95_pearson"] = {f"c-{b}": boot_diff(tk, pk, "c", b) for b in ("a21", "a_all", "b12", "b138")}
    rep["fitted"] = {"p": round(float(torch.exp(params[0])), 4),
                     "w_range": [round(float(torch.exp(params[1]).min()), 4), round(float(torch.exp(params[1]).max()), 4)]}
    print(json.dumps(rep["test"], indent=1))
    print(json.dumps(rep["test_diff_ci95_pearson"], indent=1), rep["fitted"])
    (DATA / "eval.json").write_text(json.dumps(rep, indent=1), encoding="utf-8")
    (DATA / "model.json").write_text(json.dumps({"variant": best, "lam": lam, "p": float(torch.exp(params[0])),
                                                 "w": [float(x) for x in torch.exp(params[1])] if use_w else None,
                                                 "labels": labels}), encoding="utf-8")


if __name__ == "__main__":
    main()
