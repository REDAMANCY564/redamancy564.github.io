"""Ablation of two ideas from PharmaGNN (Liu et al., J Sci Food Agric 2026, 106:8114,
doi:10.1002/jsfa.70826) on the odor GNN, same scaffold split and seeds as train.py:

  A  BCE loss,              26 atom features   (current model)
  B  asymmetric loss (ASL), 26 atom features
  C  BCE loss,              29 atom features (+ donor / acceptor / hydrophobe flags)
  D  ASL,                   29 atom features

ASL (Ridnik et al., ICCV 2021): L+ = (1-p)^g+ log p,  L- = p_m^g- log(1-p_m),  p_m = max(p-clip, 0).
Its (g+, g-) is chosen per config on validation macro AUROC from ASL_GRID (clip 0.05);
PharmaGNN used g+ = 1, g- = 4. The test set is only reported for the chosen setting.

Also reported: cyclic / acyclic test AUROC, rare labels (lowest third by training
positives), Brier score raw and after per-label Platt scaling fitted on validation
(ASL is known to inflate probabilities; the website displays probabilities).
Decision rule (agreed with the user before running): pick the config with the best mean
validation AUROC; replace the deployed model only if its mean test AUROC beats A by
>= 0.005, all 3 of its seeds beat A's mean, and rare-label mean AUROC does not drop.

Output: ablation_results.json, checkpoints/ablation_<config>_seed<k>.pt
"""
import json
import time
from pathlib import Path

import numpy as np
import torch
from sklearn.linear_model import LogisticRegression

from evaluate import load_split, macro_auroc, per_label_auroc
from featurize import NUM_FEATURES, NUM_FEATURES_PHARMA, featurize_many
from model import OdorGNN
from train import BATCH, CONFIG, DEVICE, LR, MAX_EPOCHS, PATIENCE, SEEDS, predict

HERE = Path(__file__).parent
ASL_GRID = [(0, 2), (0, 4), (1, 2), (1, 4)]
ASL_CLIP = 0.05
CONFIGS = {"A": ("bce", False), "B": ("asl", False), "C": ("bce", True), "D": ("asl", True)}
EPS = 1e-8


def bce(logits, y):
    return torch.nn.functional.binary_cross_entropy_with_logits(logits, y)


def make_asl(gamma_pos, gamma_neg, clip=ASL_CLIP):
    def asl(logits, y):
        p = torch.sigmoid(logits)
        p_m = (p - clip).clamp(min=0)
        pos = y * (1 - p).pow(gamma_pos) * torch.log(p.clamp(min=EPS))
        neg = (1 - y) * p_m.pow(gamma_neg) * torch.log((1 - p_m).clamp(min=EPS))
        return -(pos + neg).mean()
    return asl


def train_one(seed, data, n_feat, n_lab, loss_fn):
    torch.manual_seed(seed)
    np.random.seed(seed)
    (Xtr, Atr, Mtr, Ytr), (Xva, Ava, Mva, Yva) = data["train"], data["valid"]
    model = OdorGNN(n_feat, n_lab, **CONFIG).to(DEVICE)
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    gen = torch.Generator(device="cpu").manual_seed(seed)
    best, best_state, best_epoch, wait = -1.0, None, 0, 0
    for epoch in range(1, MAX_EPOCHS + 1):
        model.train()
        perm = torch.randperm(len(Xtr), generator=gen).to(DEVICE)
        for i in range(0, len(perm), BATCH):
            idx = perm[i:i + BATCH]
            loss = loss_fn(model(Xtr[idx], Atr[idx], Mtr[idx]), Ytr[idx])
            opt.zero_grad()
            loss.backward()
            opt.step()
        auc = macro_auroc(Yva.cpu().numpy(), predict(model, Xva, Ava, Mva))
        if auc > best:
            best, best_epoch, wait = auc, epoch, 0
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        else:
            wait += 1
            if wait >= PATIENCE:
                break
    model.load_state_dict(best_state)
    return model, best, best_epoch


def platt(p_valid, y_valid, p_test):
    """Per-label logistic calibration on logit(p); labels with one class in valid use a pooled fit."""
    z = lambda p: np.log(np.clip(p, 1e-6, 1 - 1e-6) / np.clip(1 - p, 1e-6, 1))  # noqa: E731
    zv, zt = z(p_valid), z(p_test)
    pooled = LogisticRegression(C=1e6).fit(zv.reshape(-1, 1), y_valid.reshape(-1))
    out = np.empty_like(p_test)
    for j in range(p_test.shape[1]):
        m = pooled if y_valid[:, j].min() == y_valid[:, j].max() else \
            LogisticRegression(C=1e6).fit(zv[:, j:j + 1], y_valid[:, j])
        out[:, j] = m.predict_proba(zt[:, j:j + 1])[:, 1]
    return out


def brier(y, p):
    return float(np.mean((p - y) ** 2))


def main():
    print(f"Device: {DEVICE}")
    smiles, labels, Y, split, acyclic = load_split()
    tr, va, te = (split == s for s in ("train", "valid", "test"))
    train_pos = Y[tr].sum(axis=0)
    rare = train_pos <= np.quantile(train_pos, 1 / 3)
    print(f"Rare labels (lowest third by training positives, <= {int(np.quantile(train_pos, 1 / 3))}): {rare.sum()}")

    feats = {False: featurize_many(smiles), True: featurize_many(smiles, pharma=True)}
    results = {"rare_labels": [l for l, r in zip(labels, rare) if r], "configs": {}}

    for name, (loss_kind, pharma) in CONFIGS.items():
        X, A, M = feats[pharma]
        n_feat = NUM_FEATURES_PHARMA if pharma else NUM_FEATURES
        data = {s: tuple(torch.from_numpy(a[split == s]).to(DEVICE) for a in (X, A, M, Y))
                for s in ("train", "valid", "test")}
        grid = ASL_GRID if loss_kind == "asl" else [None]
        candidates = []
        for g in grid:
            loss_fn = bce if g is None else make_asl(*g)
            t0 = time.time()
            runs = [train_one(seed, data, n_feat, len(labels), loss_fn) for seed in SEEDS]
            v = float(np.mean([r[1] for r in runs]))
            print(f"{name} {loss_kind} pharma={pharma} gamma={g}: valid {v:.4f} "
                  f"{[round(r[1], 4) for r in runs]} epochs {[r[2] for r in runs]} ({time.time() - t0:.0f}s)")
            candidates.append((v, g, runs))
        v_mean, g, runs = max(candidates, key=lambda c: c[0])

        seeds = []
        per = []
        for seed, (model, v, epoch) in zip(SEEDS, runs):
            pv = predict(model, *data["valid"][:3])
            pt = predict(model, *data["test"][:3])
            pl = per_label_auroc(Y[te], pt)
            per.append(pl)
            seeds.append({
                "seed": seed, "best_epoch": epoch, "valid": round(v, 4),
                "test": round(macro_auroc(Y[te], pt), 4),
                "test_cyclic": round(macro_auroc(Y[te][~acyclic[te]], pt[~acyclic[te]]), 4),
                "test_acyclic": round(macro_auroc(Y[te][acyclic[te]], pt[acyclic[te]]), 4),
                "test_rare": round(float(np.nanmean(pl[rare])), 4),
                "brier_raw": round(brier(Y[te], pt), 5),
                "brier_platt": round(brier(Y[te], platt(pv, Y[va], pt)), 5),
                "mean_prob_test": round(float(pt.mean()), 4),
            })
            torch.save({"state_dict": model.state_dict(), "config": CONFIG, "num_features": n_feat,
                        "labels": labels, "seed": seed, "loss": loss_kind, "asl_gamma": g, "pharma": pharma},
                       HERE / "checkpoints" / f"ablation_{name}_seed{seed}.pt")
        agg = lambda k: (round(float(np.mean([s[k] for s in seeds])), 4), round(float(np.std([s[k] for s in seeds])), 4))  # noqa: E731
        results["configs"][name] = {
            "loss": loss_kind, "pharma": pharma, "asl_gamma_pos_neg": g,
            "asl_grid_valid": [{"gamma": c[1], "valid_mean": round(c[0], 4)} for c in candidates] if g else None,
            "valid_mean": round(v_mean, 4),
            **{k + "_mean_std": agg(k) for k in ("test", "test_cyclic", "test_acyclic", "test_rare", "brier_raw", "brier_platt")},
            "seeds": seeds,
            "per_label_test_mean": {l: (None if np.isnan(a) else round(float(a), 4))
                                    for l, a in zip(labels, np.nanmean(np.array(per), axis=0))},
        }
        r = results["configs"][name]
        print(f"  -> chosen gamma {g}: valid {r['valid_mean']}, test {r['test_mean_std']}, cyclic {r['test_cyclic_mean_std']}, "
              f"acyclic {r['test_acyclic_mean_std']}, rare {r['test_rare_mean_std']}, "
              f"Brier raw {r['brier_raw_mean_std'][0]} / Platt {r['brier_platt_mean_std'][0]}\n")

    # Rare-label win / loss counts against A (seed-mean per label)
    a = results["configs"]["A"]["per_label_test_mean"]
    for name, r in results["configs"].items():
        if name == "A":
            continue
        diffs = [r["per_label_test_mean"][l] - a[l] for l in results["rare_labels"]
                 if a[l] is not None and r["per_label_test_mean"][l] is not None]
        r["rare_vs_A"] = {"better": int(sum(d > 0 for d in diffs)), "worse": int(sum(d < 0 for d in diffs)),
                          "n": len(diffs), "mean_diff": round(float(np.mean(diffs)), 4)}

    # Pre-agreed decision rule
    best = max(results["configs"], key=lambda k: results["configs"][k]["valid_mean"])
    A_, B_ = results["configs"]["A"], results["configs"][best]
    gain = B_["test_mean_std"][0] - A_["test_mean_std"][0]
    checks = {
        "best_by_validation": best,
        "test_gain_vs_A": round(gain, 4),
        "gain_ge_0.005": gain >= 0.005,
        "all_seeds_beat_A_mean": all(s["test"] > A_["test_mean_std"][0] for s in B_["seeds"]),
        "rare_not_lower": B_["test_rare_mean_std"][0] >= A_["test_rare_mean_std"][0],
    }
    checks["replace"] = best != "A" and checks["gain_ge_0.005"] and checks["all_seeds_beat_A_mean"] and checks["rare_not_lower"]
    results["decision"] = checks
    print("Decision:", checks)
    (HERE / "ablation_results.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    print(f"Wrote {HERE / 'ablation_results.json'}")


if __name__ == "__main__":
    main()
