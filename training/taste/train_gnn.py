"""Train the taste GCN with a masked BCE loss (unknown labels ignored) and early stopping on
validation macro AUROC. Same protocol as the first version (2026-10-17): fixed
train/valid/test split, 3 seeds, test looked at once at the end.

Readout variants (case-fix-3, 2026-11-20; model_taste.TasteGNN, configs in CONFIGS):
whole-molecule descriptors (descriptors.py), sum pooling, depth/width/dropout, class weights.

  python train_gnn.py select            all CONFIGS on train/valid only (no test scores);
                                        writes checkpoints/taste_select.json
  python train_gnn.py final NAME [...]  for each config: 3 seeds -> test AUROC (mean +/- std),
                                        per-label judgement thresholds on valid, then the deployed
                                        model: the best-valid seed retrained on ALL molecules for
                                        the median best epoch (checkpoints/taste_<NAME>.pt).
                                        Writes checkpoints/taste_final_<NAME>.json
  python train_gnn.py final NAME --site also writes the result to taste-predictor/data/metrics.json
                                        ("gnn") and copies the checkpoints to taste_gnn.pt /
                                        taste_gnn_eval.pt (the files export_taste_onnx.py reads)

Deployment (user decision 2026-10-17, option A): the deployed model is trained on all
molecules; its test scores are not measurable, so the site reports the train-split models.
Judgement thresholds (2026-11-20): see judgement_thresholds() (sweet, bitter: Youden J; umami,
tasteless: best F1; no judgement shown when validation precision < 0.5), computed with the
evaluated (best-valid seed) model on the validation split.
  python train_gnn.py thresholds        recompute them for the deployed model (no retraining)
"""
import json
import shutil
import sys
import time

import numpy as np
import torch
from sklearn.metrics import precision_recall_curve, roc_curve

from common import LABELS, TRAINING, load, macro, per_label, print_report, test_report, update_metrics
from descriptors import NAMES as DESC_NAMES, describe_many
from featurize import NUM_FEATURES, featurize_many
from model_taste import TasteGNN

SEEDS = (0, 1, 2)
BASE = dict(hidden=128, num_layers=3, dropout=0.2, pools=("mean", "max"), desc=False, class_weight=False)
CONFIGS = {
    "base": {},
    "desc": dict(desc=True),
    "sum": dict(pools=("mean", "max", "sum")),
    "cw": dict(class_weight=True),
    "L4h256": dict(hidden=256, num_layers=4),
    "L5h256": dict(hidden=256, num_layers=5),
    "L5h256d1": dict(hidden=256, num_layers=5, dropout=0.1),
    "L3h128d1": dict(dropout=0.1),
    "desc_sum": dict(desc=True, pools=("mean", "max", "sum")),
    "desc_cw": dict(desc=True, class_weight=True),
    "desc_L4h256": dict(desc=True, hidden=256, num_layers=4),
    "desc_L5h256": dict(desc=True, hidden=256, num_layers=5),
    "desc_sum_L4h256": dict(desc=True, pools=("mean", "max", "sum"), hidden=256, num_layers=4),
    "desc_sum_L5h256": dict(desc=True, pools=("mean", "max", "sum"), hidden=256, num_layers=5),
    "desc_sum_L4h256_cw": dict(desc=True, pools=("mean", "max", "sum"), hidden=256, num_layers=4,
                               class_weight=True),
    "desc_sum_L5h256d1": dict(desc=True, pools=("mean", "max", "sum"), hidden=256, num_layers=5, dropout=0.1),
    # second round around the best of the first (desc_sum)
    "desc_sum_d1": dict(desc=True, pools=("mean", "max", "sum"), dropout=0.1),
    "desc_sum_d3": dict(desc=True, pools=("mean", "max", "sum"), dropout=0.3),
    "desc_sum_h256": dict(desc=True, pools=("mean", "max", "sum"), hidden=256),
    "desc_sum_L4": dict(desc=True, pools=("mean", "max", "sum"), num_layers=4),
    "desc_sum_L4d3": dict(desc=True, pools=("mean", "max", "sum"), num_layers=4, dropout=0.3),
}
LR, BATCH, MAX_EPOCHS, PATIENCE = 1e-3, 64, 200, 20
CKPT_DIR = TRAINING / "checkpoints"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def cfg_of(name):
    return {**BASE, **CONFIGS[name]}


def model_kwargs(cfg):
    return dict(hidden=cfg["hidden"], num_layers=cfg["num_layers"], dropout=cfg["dropout"],
                pools=tuple(cfg["pools"]), n_desc=len(DESC_NAMES) if cfg["desc"] else 0)


def masked_bce(logits, y, pos_weight=None):
    known = ~torch.isnan(y)
    loss = torch.nn.functional.binary_cross_entropy_with_logits(
        logits, torch.nan_to_num(y), reduction="none", pos_weight=pos_weight)
    return (loss * known).sum() / known.sum().clamp(min=1)


def class_weights(Y):
    """sqrt(negatives / positives) per label over known entries (about 1 for sweet/bitter)."""
    pos = np.nansum(Y == 1, axis=0)
    neg = np.nansum(Y == 0, axis=0)
    return np.sqrt(neg / np.maximum(pos, 1)).astype(np.float32)


@torch.no_grad()
def predict(model, X, A, M, D):
    model.eval()
    out = [torch.sigmoid(model(X[i:i + 512], A[i:i + 512], M[i:i + 512], D[i:i + 512]))
           for i in range(0, len(X), 512)]
    return torch.cat(out).cpu().numpy()


def train_one(seed, cfg, train, valid=None, epochs=MAX_EPOCHS, verbose=True):
    torch.manual_seed(seed)
    np.random.seed(seed)
    Xtr, Atr, Mtr, Dtr, Ytr = train
    model = TasteGNN(NUM_FEATURES, len(LABELS), **model_kwargs(cfg)).to(DEVICE)
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    gen = torch.Generator(device="cpu").manual_seed(seed)
    pw = (torch.from_numpy(class_weights(Ytr.cpu().numpy())).to(DEVICE) if cfg["class_weight"] else None)

    best_auc, best_state, best_epoch, wait = -1.0, None, epochs, 0
    for epoch in range(1, epochs + 1):
        model.train()
        perm = torch.randperm(len(Xtr), generator=gen).to(DEVICE)
        total = 0.0
        for i in range(0, len(perm), BATCH):
            idx = perm[i:i + BATCH]
            loss = masked_bce(model(Xtr[idx], Atr[idx], Mtr[idx], Dtr[idx]), Ytr[idx], pw)
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
        if valid is None:
            continue
        auc = macro(valid[4].cpu().numpy(), predict(model, *valid[:4]))
        if auc > best_auc:
            best_auc, best_epoch, wait = auc, epoch, 0
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        else:
            wait += 1
        if verbose and (epoch % 20 == 0):
            print(f"  seed {seed} epoch {epoch:3d} loss {total / len(perm):.4f} valid AUROC {auc:.4f}", flush=True)
        if wait >= PATIENCE:
            break
    if best_state is not None:
        model.load_state_dict(best_state)
    return model, best_auc, best_epoch


def prepare():
    d = load()
    X, A, M = featurize_many(d["smiles"])
    raw = describe_many(d["smiles"])
    tr = d["split"] == "train"
    mu, sd = raw[tr].mean(0), raw[tr].std(0)
    sd[sd == 0] = 1.0
    Dz = ((raw - mu) / sd).astype(np.float32)
    d.update(X=X, A=A, M=M, D=Dz, desc_mean=mu, desc_std=sd)
    return d


def tensors(d, idx):
    return tuple(torch.from_numpy(a[idx]).to(DEVICE) for a in (d["X"], d["A"], d["M"], d["D"], d["Y"]))


def youden(y, p):
    k = ~np.isnan(y)
    fpr, tpr, thr = roc_curve(y[k], p[k])
    j = int(np.argmax(tpr - fpr))
    return float(min(thr[j], 1.0)), float(tpr[j]), float(1 - fpr[j])


def best_f1(y, p):
    """Threshold with the highest F1 -> (threshold, precision, recall, F1)."""
    k = ~np.isnan(y)
    pr, rc, thr = precision_recall_curve(y[k], p[k])
    f = 2 * pr * rc / np.maximum(pr + rc, 1e-12)
    j = int(np.argmax(f[:-1]))
    return float(thr[j]), float(pr[j]), float(rc[j]), float(f[j])


# Judgement thresholds (user decisions 2026-11-20): sweet and bitter by Youden J; the rare labels
# umami and tasteless by the best F1 (Youden J put them below 1% and flagged many non-umami /
# non-tasteless molecules). A label whose F1 threshold still has validation precision < 0.5 is
# shown on the page as a probability only ("show": false).
F1_LABELS = ("umami", "tasteless")
MIN_PRECISION = 0.5
THRESHOLDS_RULE = ("sweet, bitter: Youden J optimum (max sensitivity + specificity - 1); umami, tasteless: "
                   "threshold with the best F1. All on the validation split with the evaluated model (train split "
                   "only). A label whose validation precision at its threshold is below 0.5 shows no judgement on "
                   "the page (show: false).")


def judgement_thresholds(Yv, Pv):
    out = {}
    for j, lab in enumerate(LABELS):
        y, p = Yv[:, j], Pv[:, j]
        k = ~np.isnan(y)
        if lab in F1_LABELS:
            t, prec, rec, f1 = best_f1(y, p)
            rule = "f1"
        else:
            t = youden(y, p)[0]
            rule = "youden"
        pred = p[k] >= t
        yk = y[k] == 1
        tp = int((pred & yk).sum())
        prec = tp / max(int(pred.sum()), 1)
        rec = tp / max(int(yk.sum()), 1)
        spec = int((~pred & ~yk).sum()) / max(int((~yk).sum()), 1)
        out[lab] = {"threshold": round(t, 4), "rule": rule, "valid_precision": round(prec, 4),
                    "valid_recall": round(rec, 4), "valid_specificity": round(spec, 4),
                    "valid_f1": round(2 * prec * rec / max(prec + rec, 1e-12), 4),
                    "show": bool(prec >= MIN_PRECISION)}
    return out


def refresh_thresholds():
    """Recompute the judgement thresholds of the deployed configuration from checkpoints/taste_gnn_eval.pt
    (no retraining) and write them to metrics.json and checkpoints/taste_final_<config>.json."""
    from export_taste_onnx import load_model, predict_smiles
    d = load()
    va = d["split"] == "valid"
    model, ckpt = load_model("taste_gnn_eval.pt")
    Pv = predict_smiles(model, ckpt, [s for s, v in zip(d["smiles"], va) if v])
    thr = judgement_thresholds(d["Y"][va], Pv)
    import json as _json
    from common import METRICS_PATH
    m = _json.loads(METRICS_PATH.read_text(encoding="utf-8"))["gnn"]
    m["thresholds"], m["thresholds_rule"] = thr, THRESHOLDS_RULE
    update_metrics("gnn", m)
    fin = CKPT_DIR / f"taste_final_{m['config_name']}.json"
    if fin.exists():
        f = _json.loads(fin.read_text(encoding="utf-8"))
        f["thresholds"], f["thresholds_rule"] = thr, THRESHOLDS_RULE
        fin.write_text(_json.dumps(f, indent=1, ensure_ascii=False), encoding="utf-8")
    for lab, v in thr.items():
        print(f"  {lab:10s} {v}")


def run_seeds(d, name, verbose=True):
    cfg = cfg_of(name)
    data = {s: tensors(d, d["split"] == s) for s in ("train", "valid")}
    runs = []
    for seed in SEEDS:
        t0 = time.time()
        model, auc_va, epoch = train_one(seed, cfg, data["train"], data["valid"], verbose=verbose)
        pv = predict(model, *data["valid"][:4])
        runs.append(dict(seed=seed, model=model, valid=auc_va, epoch=epoch,
                         valid_per_label=per_label(d["Y"][d["split"] == "valid"], pv), pv=pv))
        print(f"[{name}] seed {seed}: best epoch {epoch}, valid {auc_va:.4f} ({time.time() - t0:.0f}s)", flush=True)
    return cfg, runs


def select(names):
    d = prepare()
    out_path = CKPT_DIR / "taste_select.json"
    res = json.loads(out_path.read_text()) if out_path.exists() else {}
    for name in names:
        cfg, runs = run_seeds(d, name, verbose=False)
        v = np.array([r["valid"] for r in runs])
        pl = np.array([r["valid_per_label"] for r in runs], dtype=float)
        res[name] = {"config": cfg, "valid_macro_mean": round(float(v.mean()), 4),
                     "valid_macro_std": round(float(v.std()), 4),
                     "valid_per_label_mean": dict(zip(LABELS, pl.mean(0).round(4).tolist())),
                     "epochs": [r["epoch"] for r in runs],
                     "n_parameters": sum(p.numel() for p in runs[0]["model"].parameters())}
        print(f"== {name}: valid {v.mean():.4f} +/- {v.std():.4f}", flush=True)
        CKPT_DIR.mkdir(exist_ok=True)
        out_path.write_text(json.dumps(res, indent=1))


def save(model, path, cfg, d, **extra):
    torch.save({"state_dict": model.state_dict(), "config": cfg, "model_kwargs": model_kwargs(cfg),
                "num_features": NUM_FEATURES, "labels": LABELS,
                "desc_names": DESC_NAMES if cfg["desc"] else [],
                "desc_mean": d["desc_mean"].tolist(), "desc_std": d["desc_std"].tolist(), **extra}, path)


def final(name, site=False):
    d = prepare()
    cfg, runs = run_seeds(d, name)
    te = tensors(d, d["split"] == "test")
    for r in runs:
        r["report"] = test_report(d, predict(r["model"], *te[:4]))
    tests = np.array([r["report"]["macro_auroc"] for r in runs])
    per = {lab: [r["report"]["per_label"][lab]["auroc"] for r in runs] for lab in LABELS}
    best = max(runs, key=lambda r: r["valid"])
    print(f"[{name}] test macro AUROC over seeds: {tests.mean():.4f} +/- {tests.std():.4f}  {tests.round(4).tolist()}")
    for lab, v in per.items():
        print(f"  {lab:10s} {np.mean(v):.4f} +/- {np.std(v):.4f}")
    print_report(f"Evaluated model (seed {best['seed']}, valid {best['valid']:.4f})", best["report"])

    Yv = d["Y"][d["split"] == "valid"]
    thresholds = judgement_thresholds(Yv, best["pv"])
    print("Judgement thresholds (valid):", thresholds)

    full_epochs = int(np.median([r["epoch"] for r in runs]))
    print(f"Deployment model: seed {best['seed']}, all {len(d['X'])} molecules, {full_epochs} epochs")
    full, _, _ = train_one(best["seed"], cfg, tensors(d, np.ones(len(d["X"]), bool)), epochs=full_epochs)
    save(best["model"], CKPT_DIR / f"taste_{name}_eval.pt", cfg, d, seed=best["seed"], trained_on="train split")
    save(full, CKPT_DIR / f"taste_{name}.pt", cfg, d, seed=best["seed"], trained_on="all molecules",
         epochs=full_epochs)

    metrics = {
        "params": {**{k: (list(v) if isinstance(v, tuple) else v) for k, v in cfg.items()},
                   "lr": LR, "batch": BATCH, "patience": PATIENCE,
                   "global_descriptors": DESC_NAMES if cfg["desc"] else [],
                   "n_parameters": sum(p.numel() for p in best["model"].parameters())},
        "config_name": name,
        "seeds": [{"seed": r["seed"], "best_epoch": r["epoch"], "valid_macro_auroc": round(r["valid"], 4),
                   "test_macro_auroc": r["report"]["macro_auroc"],
                   "test_per_label": {lab: r["report"]["per_label"][lab]["auroc"] for lab in LABELS}}
                  for r in runs],
        "valid_macro_auroc_mean": round(float(np.mean([r["valid"] for r in runs])), 4),
        "valid_macro_auroc_std": round(float(np.std([r["valid"] for r in runs])), 4),
        "test_macro_auroc_mean": round(float(tests.mean()), 4),
        "test_macro_auroc_std": round(float(tests.std()), 4),
        "test_per_label_mean": {lab: round(float(np.mean(v)), 4) for lab, v in per.items()},
        "test_per_label_std": {lab: round(float(np.std(v)), 4) for lab, v in per.items()},
        "evaluated_seed": best["seed"],
        "valid_macro_auroc": round(best["valid"], 4),
        "thresholds": thresholds,
        "thresholds_rule": THRESHOLDS_RULE,
        "deployed_model": {"trained_on": "all molecules (train+valid+test)", "epochs": full_epochs,
                           "note": "test metrics come from the models trained on the train split only"},
        **best["report"],
    }
    (CKPT_DIR / f"taste_final_{name}.json").write_text(json.dumps(metrics, indent=1, ensure_ascii=False))
    if site:
        update_metrics("gnn", metrics)
        shutil.copy(CKPT_DIR / f"taste_{name}.pt", CKPT_DIR / "taste_gnn.pt")
        shutil.copy(CKPT_DIR / f"taste_{name}_eval.pt", CKPT_DIR / "taste_gnn_eval.pt")
        print("metrics.json and taste_gnn(.eval).pt updated")


def main():
    print(f"Device: {DEVICE}" + (f" ({torch.cuda.get_device_name(0)})" if DEVICE == "cuda" else ""), flush=True)
    args = sys.argv[1:]
    if not args or args[0] == "select":
        select(args[1:] or list(CONFIGS))
    elif args[0] == "final":
        site = "--site" in args
        for name in [a for a in args[1:] if not a.startswith("--")]:
            final(name, site=site)
    elif args[0] == "thresholds":
        refresh_thresholds()
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
