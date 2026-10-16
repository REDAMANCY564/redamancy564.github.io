"""Train the OdorGNN with early stopping on validation macro AUROC.

Trains one model per seed, reports test AUROC mean/std across seeds, and keeps the
seed with the best *validation* score as the deployed model (checkpoints/odor_gnn.pt).
No pos_weight: keeps output probabilities calibrated for display on the website.
"""
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from evaluate import load_split, macro_auroc, test_report, update_metrics
from featurize import NUM_FEATURES, featurize_many
from model import OdorGNN

SEEDS = (0, 1, 2)
CONFIG = dict(hidden=128, num_layers=3, dropout=0.2)
LR, BATCH, MAX_EPOCHS, PATIENCE = 1e-3, 64, 200, 20
CKPT = Path(__file__).parent / "checkpoints" / "odor_gnn.pt"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


@torch.no_grad()
def predict(model, X, A, M):
    model.eval()
    out = [torch.sigmoid(model(X[i:i + 512], A[i:i + 512], M[i:i + 512])) for i in range(0, len(X), 512)]
    return torch.cat(out).cpu().numpy()


def train_one(seed, data, num_labels):
    torch.manual_seed(seed)
    np.random.seed(seed)
    (Xtr, Atr, Mtr, Ytr), (Xva, Ava, Mva, Yva) = data["train"], data["valid"]
    model = OdorGNN(NUM_FEATURES, num_labels, **CONFIG).to(DEVICE)
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    loss_fn = nn.BCEWithLogitsLoss()
    gen = torch.Generator(device="cpu").manual_seed(seed)

    best_auc, best_state, best_epoch, wait = -1.0, None, 0, 0
    for epoch in range(1, MAX_EPOCHS + 1):
        model.train()
        perm = torch.randperm(len(Xtr), generator=gen).to(DEVICE)
        total = 0.0
        for i in range(0, len(perm), BATCH):
            idx = perm[i:i + BATCH]
            loss = loss_fn(model(Xtr[idx], Atr[idx], Mtr[idx]), Ytr[idx])
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
        auc = macro_auroc(Yva.cpu().numpy(), predict(model, Xva, Ava, Mva))
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
    model.load_state_dict(best_state)
    return model, best_auc, best_epoch


def main():
    print(f"Device: {DEVICE}" + (f" ({torch.cuda.get_device_name(0)})" if DEVICE == "cuda" else ""))
    smiles, labels, Y, split, acyclic = load_split()
    X, A, M = featurize_many(smiles)
    data = {}
    for s in ("train", "valid", "test"):
        idx = split == s
        data[s] = tuple(torch.from_numpy(a[idx]).to(DEVICE) for a in (X, A, M, Y))
    te = split == "test"

    runs = []
    for seed in SEEDS:
        t0 = time.time()
        model, auc_va, epoch = train_one(seed, data, len(labels))
        Xte, Ate, Mte, _ = data["test"]
        rep = test_report(Y[te], predict(model, Xte, Ate, Mte), acyclic[te], labels)
        print(f"seed {seed}: best epoch {epoch}, valid {auc_va:.4f}, test {rep['macro_auroc']:.4f} "
              f"({time.time() - t0:.0f}s)\n")
        runs.append(dict(seed=seed, model=model, valid=auc_va, epoch=epoch, report=rep))

    tests = np.array([r["report"]["macro_auroc"] for r in runs])
    best = max(runs, key=lambda r: r["valid"])
    print(f"Test macro AUROC over seeds: {tests.mean():.4f} +/- {tests.std():.4f}  {tests.round(4).tolist()}")
    print(f"Deployed model: seed {best['seed']} (best valid {best['valid']:.4f}), "
          f"test {best['report']['macro_auroc']:.4f}")

    CKPT.parent.mkdir(exist_ok=True)
    torch.save({"state_dict": best["model"].state_dict(), "config": CONFIG,
                "num_features": NUM_FEATURES, "labels": labels, "seed": best["seed"]}, CKPT)

    update_metrics("gnn", {
        "params": {**CONFIG, "lr": LR, "batch": BATCH, "patience": PATIENCE,
                   "n_parameters": sum(p.numel() for p in best["model"].parameters())},
        "seeds": [{"seed": r["seed"], "best_epoch": r["epoch"], "valid_macro_auroc": round(r["valid"], 4),
                   "test_macro_auroc": r["report"]["macro_auroc"]} for r in runs],
        "test_macro_auroc_mean": round(float(tests.mean()), 4),
        "test_macro_auroc_std": round(float(tests.std()), 4),
        "deployed_seed": best["seed"],
        "valid_macro_auroc": round(best["valid"], 4),
        **best["report"],
    })


if __name__ == "__main__":
    main()
