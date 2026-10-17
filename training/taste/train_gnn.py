"""Train the taste GNN (same OdorGNN architecture and features as the odor model) with a
masked BCE loss (unknown labels ignored) and early stopping on validation macro AUROC.

1. Evaluation: 3 seeds on the train split; test AUROC reported per seed and as mean/std.
   The seed with the best validation score is the evaluated model (taste_gnn_eval.pt).
2. Deployment (user decision 2026-10-17, option A): retrain that seed on ALL molecules
   (train + valid + test) for the median best epoch of the evaluation runs
   (taste_gnn.pt). Its test scores are not measurable and are not reported.
"""
import time

import numpy as np
import torch

from common import LABELS, TRAINING, load, macro, print_report, test_report, update_metrics
from featurize import NUM_FEATURES, featurize_many
from model import OdorGNN

SEEDS = (0, 1, 2)
CONFIG = dict(hidden=128, num_layers=3, dropout=0.2)
LR, BATCH, MAX_EPOCHS, PATIENCE = 1e-3, 64, 200, 20
CKPT_DIR = TRAINING / "checkpoints"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def masked_bce(logits, y):
    known = ~torch.isnan(y)
    loss = torch.nn.functional.binary_cross_entropy_with_logits(
        logits, torch.nan_to_num(y), reduction="none")
    return (loss * known).sum() / known.sum().clamp(min=1)


@torch.no_grad()
def predict(model, X, A, M):
    model.eval()
    out = [torch.sigmoid(model(X[i:i + 512], A[i:i + 512], M[i:i + 512])) for i in range(0, len(X), 512)]
    return torch.cat(out).cpu().numpy()


def train_one(seed, train, valid=None, epochs=MAX_EPOCHS):
    torch.manual_seed(seed)
    np.random.seed(seed)
    Xtr, Atr, Mtr, Ytr = train
    model = OdorGNN(NUM_FEATURES, len(LABELS), **CONFIG).to(DEVICE)
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    gen = torch.Generator(device="cpu").manual_seed(seed)

    best_auc, best_state, best_epoch, wait = -1.0, None, epochs, 0
    for epoch in range(1, epochs + 1):
        model.train()
        perm = torch.randperm(len(Xtr), generator=gen).to(DEVICE)
        total = 0.0
        for i in range(0, len(perm), BATCH):
            idx = perm[i:i + BATCH]
            loss = masked_bce(model(Xtr[idx], Atr[idx], Mtr[idx]), Ytr[idx])
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
        if valid is None:
            continue
        Xva, Ava, Mva, Yva = valid
        auc = macro(Yva.cpu().numpy(), predict(model, Xva, Ava, Mva))
        if auc > best_auc:
            best_auc, best_epoch, wait = auc, epoch, 0
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        else:
            wait += 1
        if epoch % 10 == 0 or wait == 0:
            print(f"  seed {seed} epoch {epoch:3d} loss {total / len(perm):.4f} valid AUROC {auc:.4f}"
                  + (" *" if wait == 0 else ""))
        if wait >= PATIENCE:
            break
    if best_state is not None:
        model.load_state_dict(best_state)
    return model, best_auc, best_epoch


def save(model, path, **extra):
    CKPT_DIR.mkdir(exist_ok=True)
    torch.save({"state_dict": model.state_dict(), "config": CONFIG, "num_features": NUM_FEATURES,
                "labels": LABELS, **extra}, path)


def main():
    print(f"Device: {DEVICE}" + (f" ({torch.cuda.get_device_name(0)})" if DEVICE == "cuda" else ""))
    d = load()
    X, A, M = featurize_many(d["smiles"])
    tens = lambda idx: tuple(torch.from_numpy(a[idx]).to(DEVICE) for a in (X, A, M, d["Y"]))  # noqa: E731
    data = {s: tens(d["split"] == s) for s in ("train", "valid", "test")}

    runs = []
    for seed in SEEDS:
        t0 = time.time()
        model, auc_va, epoch = train_one(seed, data["train"], data["valid"])
        rep = test_report(d, predict(model, *data["test"][:3]))
        print(f"seed {seed}: best epoch {epoch}, valid {auc_va:.4f}, test {rep['macro_auroc']:.4f} "
              f"({time.time() - t0:.0f}s)\n")
        runs.append(dict(seed=seed, model=model, valid=auc_va, epoch=epoch, report=rep))

    tests = np.array([r["report"]["macro_auroc"] for r in runs])
    per = {lab: [r["report"]["per_label"][lab]["auroc"] for r in runs] for lab in LABELS}
    best = max(runs, key=lambda r: r["valid"])
    print(f"Test macro AUROC over seeds: {tests.mean():.4f} +/- {tests.std():.4f}  {tests.round(4).tolist()}")
    for lab, v in per.items():
        print(f"  {lab:10s} {np.mean(v):.4f} +/- {np.std(v):.4f}")
    print_report(f"Evaluated model (seed {best['seed']}, valid {best['valid']:.4f})", best["report"])
    save(best["model"], CKPT_DIR / "taste_gnn_eval.pt", seed=best["seed"], trained_on="train split")

    full_epochs = int(np.median([r["epoch"] for r in runs]))
    print(f"\nDeployment model: seed {best['seed']}, all {len(X)} molecules, {full_epochs} epochs")
    full, _, _ = train_one(best["seed"], tens(np.ones(len(X), bool)), epochs=full_epochs)
    save(full, CKPT_DIR / "taste_gnn.pt", seed=best["seed"], trained_on="all molecules",
         epochs=full_epochs)

    update_metrics("gnn", {
        "params": {**CONFIG, "lr": LR, "batch": BATCH, "patience": PATIENCE,
                   "n_parameters": sum(p.numel() for p in best["model"].parameters())},
        "seeds": [{"seed": r["seed"], "best_epoch": r["epoch"], "valid_macro_auroc": round(r["valid"], 4),
                   "test_macro_auroc": r["report"]["macro_auroc"],
                   "test_per_label": {lab: r["report"]["per_label"][lab]["auroc"] for lab in LABELS}}
                  for r in runs],
        "test_macro_auroc_mean": round(float(tests.mean()), 4),
        "test_macro_auroc_std": round(float(tests.std()), 4),
        "test_per_label_mean": {lab: round(float(np.mean(v)), 4) for lab, v in per.items()},
        "test_per_label_std": {lab: round(float(np.std(v)), 4) for lab, v in per.items()},
        "evaluated_seed": best["seed"],
        "valid_macro_auroc": round(best["valid"], 4),
        "deployed_model": {"trained_on": "all molecules (train+valid+test)", "epochs": full_epochs,
                           "note": "test metrics come from the evaluated model trained on the train split only"},
        **best["report"],
    })


if __name__ == "__main__":
    main()
