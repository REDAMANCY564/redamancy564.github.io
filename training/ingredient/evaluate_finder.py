"""Stage 3 of ingredient-finder: evaluation (PLAN-ingredient-finder.md section 5).

Order fixed in advance (user decision 2026-10-18):
  1. choose the odor embedding on the VALIDATION split only
     (queries = validation molecules, neighbours searched in train + validation)
  2. odor-similarity threshold = 99.5th percentile of the similarity of random library pairs
     (99th proposed first; user chose 99.5 on 2026-10-18 after seeing the highlight counts)
  3. TEST split, reported once:
     Mode B: queries = test molecules, neighbours searched in all labelled molecules (query excluded);
             mean Jaccard of true labels between the query and its top-10 neighbours, for the chosen
             embedding vs Morgan-Tanimoto neighbours vs random neighbours (paired bootstrap CI)
     Mode A: within the test split, rank molecules by the predicted probability of each descriptor;
             precision@10 / @50 vs random ranking (expected = positive rate) and vs a Morgan + logistic
             regression baseline (C = 0.1, chosen on validation in baseline.py); the 5 page presets too.
All similarities are computed from the quantized values the page uses.
Output: training/data/ingredient/eval.json (+ printed report)
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from rdkit import Chem
from rdkit.Chem import rdFingerprintGenerator, rdMolDescriptors
from sklearn.linear_model import LogisticRegression
from sklearn.multiclass import OneVsRestClassifier

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "training" / "data"
OUT = DATA / "ingredient" / "eval.json"
K = 10
RNG = np.random.default_rng(0)
PRESETS = {"creamy+buttery+sweet": ["creamy", "buttery", "sweet"], "coconut+creamy": ["coconut", "creamy"],
           "caramellic+nutty": ["caramellic", "nutty"], "milky+fatty": ["milky", "fatty"], "fruity+green": ["fruity", "green"]}


def quantized(f):
    """The values the page will use: probs uint8, embeddings int8 per dimension."""
    out = {"probs": np.round(f["probs"] * 255) / 255}
    for k in ("readout", "hidden"):
        s = np.abs(f[k]).max(axis=0) / 127.0
        s[s == 0] = 1
        out[k] = np.clip(np.round(f[k] / s), -127, 127) * s
    return out


def cosine_matrix(Q, P):
    Qn = Q / np.maximum(np.linalg.norm(Q, axis=1, keepdims=True), 1e-12)
    Pn = P / np.maximum(np.linalg.norm(P, axis=1, keepdims=True), 1e-12)
    return Qn @ Pn.T


def tanimoto_matrix(Fq, Fp):
    inter = Fq @ Fp.T
    return inter / (Fq.sum(1)[:, None] + Fp.sum(1)[None, :] - inter)


def jaccard_rows(Yq, Yn):
    """Yq [n, L] query labels, Yn [n, k, L] neighbour labels -> mean Jaccard per query."""
    inter = (Yq[:, None, :] & Yn).sum(-1)
    union = (Yq[:, None, :] | Yn).sum(-1)
    return np.where(union > 0, inter / np.maximum(union, 1), 0).mean(1)


def neighbour_jaccard(S, q_idx, p_idx, Y):
    """S [len(q), len(p)] similarity; the query itself is excluded; top-K by S."""
    S = S.copy()
    pos = {p: j for j, p in enumerate(p_idx)}
    for i, q in enumerate(q_idx):
        if q in pos:
            S[i, pos[q]] = -np.inf
    top = np.argsort(-S, axis=1)[:, :K]
    return jaccard_rows(Y[q_idx], Y[np.asarray(p_idx)[top]])


def random_jaccard(q_idx, p_idx, Y, reps=20):
    vals = []
    for _ in range(reps):
        nb = np.stack([RNG.choice([p for p in p_idx if p != q], K, replace=False) for q in q_idx])
        vals.append(jaccard_rows(Y[q_idx], Y[nb]))
    return np.mean(vals, axis=0)


def boot_ci(d, n=5000):
    m = [RNG.choice(d, len(d)).mean() for _ in range(n)]
    return [round(float(np.percentile(m, 2.5)), 4), round(float(np.percentile(m, 97.5)), 4)]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    lib = json.loads((DATA / "ingredient" / "library.json").read_text(encoding="utf-8"))["molecules"]
    f = np.load(DATA / "ingredient" / "features.npz")
    E = quantized(f)
    fps = np.unpackbits(f["fps"], axis=1).astype(np.float32)
    clean = pd.read_csv(DATA / "clean.csv")
    labels = list(clean.columns[1:])
    lab_by_smiles = dict(zip(clean.smiles, clean[labels].to_numpy().astype(bool)))
    split = np.array([r["split"] for r in lib])
    # molecules whose only labelled entries are mixtures (build_library.py) count as unlabelled
    labelled = np.array([r["smiles"] in lab_by_smiles and not r.get("labels_from_mixture") for r in lib])
    assert not labelled[split == "kb"].any()
    Y = np.zeros((len(lib), len(labels)), dtype=bool)
    for i, r in enumerate(lib):
        if labelled[i]:
            Y[i] = lab_by_smiles[r["smiles"]]
    tr, va, te = (np.where((split == s) & labelled)[0] for s in ("train", "valid", "test"))
    report = {"k": K}

    # ---- 1. choose the embedding on validation ----
    pool = np.concatenate([tr, va])
    sel = {}
    for name in ("probs", "readout", "hidden"):
        sel[name] = float(neighbour_jaccard(cosine_matrix(E[name][va], E[name][pool]), va, pool, Y).mean())
    sel["tanimoto (reference)"] = float(neighbour_jaccard(tanimoto_matrix(fps[va], fps[pool]), va, pool, Y).mean())
    sel["random (reference)"] = float(random_jaccard(va, pool, Y, reps=5).mean())
    chosen = max(("probs", "readout", "hidden"), key=lambda k: sel[k])
    report["validation_selection"] = {k: round(v, 4) for k, v in sel.items()}
    report["chosen_embedding"] = chosen
    print("validation, mean Jaccard of top-10 neighbours:", report["validation_selection"], "-> chosen:", chosen)

    # ---- 2. odor-similarity threshold from random library pairs ----
    Ec = E[chosen]
    a, b = RNG.integers(0, len(lib), 1_000_000), RNG.integers(0, len(lib), 1_000_000)
    keep = a != b
    En = Ec / np.linalg.norm(Ec, axis=1, keepdims=True)
    rand_sim = np.einsum("ij,ij->i", En[a[keep]], En[b[keep]])
    pct = {p: round(float(np.percentile(rand_sim, p)), 4) for p in (50, 90, 95, 99, 99.5, 99.9)}
    thr = pct[99.5]
    S_all = En @ En.T
    np.fill_diagonal(S_all, -np.inf)
    T_all = tanimoto_matrix(fps, fps)
    top20 = np.argsort(-S_all, axis=1)[:, :20]
    n_hi = np.array([sum(1 for j in top20[i] if S_all[i, j] >= thr and T_all[i, j] < 0.3) for i in range(len(lib))])
    n_thr = np.array([sum(1 for j in top20[i] if S_all[i, j] >= thr) for i in range(len(lib))])
    hist, edges = np.histogram(rand_sim, bins=40, range=(float(rand_sim.min()), 1.0))
    report["threshold"] = {
        "rule": "99.5th percentile of cosine similarity of 1,000,000 random library pairs",
        "percentiles": pct, "value": thr,
        "per_query_top20": {"mean_above_threshold": round(float(n_thr.mean()), 2),
                            "mean_highlighted": round(float(n_hi.mean()), 2),
                            "median_highlighted": float(np.median(n_hi)),
                            "share_with_at_least_one_highlighted": round(float((n_hi > 0).mean()), 4)},
        "random_pair_histogram": {"counts": hist.tolist(), "edges": [round(float(x), 4) for x in edges]},
    }
    print("threshold:", json.dumps(report["threshold"]["percentiles"]), "->", thr, "|", report["threshold"]["per_query_top20"])

    # ---- 3a. Mode B on test (reported once) ----
    pool = np.concatenate([tr, va, te])
    jb_gnn = neighbour_jaccard(cosine_matrix(Ec[te], Ec[pool]), te, pool, Y)
    jb_tan = neighbour_jaccard(tanimoto_matrix(fps[te], fps[pool]), te, pool, Y)
    jb_rnd = random_jaccard(te, pool, Y)
    acyclic = np.array([rdMolDescriptors.CalcNumRings(Chem.MolFromSmiles(lib[i]["smiles"])) == 0 for i in te])
    def summary(mask):
        return {"n": int(mask.sum()), "gnn": round(float(jb_gnn[mask].mean()), 4),
                "tanimoto": round(float(jb_tan[mask].mean()), 4), "random": round(float(jb_rnd[mask].mean()), 4),
                "gnn_minus_tanimoto_ci95": boot_ci(jb_gnn[mask] - jb_tan[mask]),
                "gnn_better_share": round(float((jb_gnn[mask] > jb_tan[mask]).mean()), 4),
                "tanimoto_better_share": round(float((jb_gnn[mask] < jb_tan[mask]).mean()), 4)}
    report["mode_b_test"] = {"all": summary(np.ones(len(te), bool)), "cyclic": summary(~acyclic), "acyclic": summary(acyclic)}
    print("mode B test:", json.dumps(report["mode_b_test"]))

    # ---- 3b. Mode A on test (reported once) ----
    P = f["probs"]
    smiles_all = [r["smiles"] for r in lib]
    gen = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)
    Xfp = np.stack([gen.GetFingerprintAsNumPy(Chem.MolFromSmiles(smiles_all[i])) for i in range(len(lib))]).astype(np.float32)
    lr = OneVsRestClassifier(LogisticRegression(C=0.1, max_iter=2000), n_jobs=-1).fit(Xfp[tr], Y[tr])
    P_lr = lr.predict_proba(Xfp[te])
    Yt, Pt = Y[te], P[te]
    rows = []
    for j, lab in enumerate(labels):
        npos = int(Yt[:, j].sum())
        if npos == 0:
            continue
        r = {"label": lab, "n_pos": npos, "rate": npos / len(te)}
        for k in (10, 50):
            r[f"gnn@{k}"] = float(Yt[np.argsort(-Pt[:, j])[:k], j].mean())
            r[f"lr@{k}"] = float(Yt[np.argsort(-P_lr[:, j])[:k], j].mean())
        rows.append(r)
    df = pd.DataFrame(rows)
    def macro(d):
        return {"n_labels": len(d), "random_expected": round(float(d.rate.mean()), 4),
                **{c: round(float(d[c].mean()), 4) for c in ("gnn@10", "lr@10", "gnn@50", "lr@50")}}
    report["mode_a_test"] = {"all_labels_with_positives": macro(df), "labels_with_ge10_positives": macro(df[df.n_pos >= 10]),
                             "best5_gnn@10": df.sort_values("gnn@10", ascending=False).head(5)[["label", "n_pos", "gnn@10"]].to_dict("records"),
                             "per_label": df.round(4).to_dict("records")}
    pres = {}
    for name, labs in PRESETS.items():
        ids = [labels.index(l) for l in labs]
        score = Pt[:, ids].sum(1)
        top = np.argsort(-score)[:K]
        any_r, all_r = Yt[:, ids].any(1), Yt[:, ids].all(1)
        pres[name] = {"top10_has_any": float(any_r[top].mean()), "random_any": round(float(any_r.mean()), 4),
                      "top10_has_all": float(all_r[top].mean()), "random_all": round(float(all_r.mean()), 4)}
    report["mode_a_presets_test"] = pres
    print("mode A test:", json.dumps({k: report["mode_a_test"][k] for k in ("all_labels_with_positives", "labels_with_ge10_positives")}))
    print("mode A presets (test, top-10):", json.dumps(pres))
    OUT.write_text(json.dumps(report, indent=1), encoding="utf-8")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
