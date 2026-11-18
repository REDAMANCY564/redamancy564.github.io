"""Train the bond-aware OdorMPNN and compare it with the current GCN (same split, same seeds).

Stages (run in this order; each one is resumable):
  python train_mpnn.py pilot   timing of one config x one seed (valid only)
  python train_mpnn.py grid    12 configs x 3 seeds, valid macro AUROC only -> data/mpnn/grid.jsonl
  python train_mpnn.py final   best config by mean valid (tie < 0.001 -> fewer parameters):
                               3 seeds again, saving frame checkpoints for the odor-map animation;
                               control without bond features (3 seeds); GCN reference re-evaluated
                               from checkpoints/ablation_A_seed*.pt; test set reported here only
                               -> mpnn_results.json, checkpoints/odor_mpnn.pt

Same as train.py / ablation.py: data/split.csv, seeds 0 1 2, Adam lr 1e-3, batch 64,
max 200 epochs, early stopping on valid macro AUROC with patience 20, BCE without pos_weight.

Adoption rule agreed with the user before training (2026-11-18): switch only if the 3-seed
valid mean > GCN valid mean (0.8497) AND the 3-seed test mean >= GCN test mean (0.8600).
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from ablation import brier, platt
from evaluate import load_split, macro_auroc, per_label_auroc
from featurize import NUM_FEATURES
from featurize import featurize_many as featurize_gcn
from featurize_mpnn import NUM_BOND_FEATURES, check_bonds, featurize_many
from model import OdorGNN
from model_mpnn import OdorMPNN

HERE = Path(__file__).parent
OUT = HERE / "data" / "mpnn"
GRID_LOG = OUT / "grid.jsonl"
FRAMES = HERE / "checkpoints" / "mpnn_frames"
CKPT = HERE / "checkpoints" / "odor_mpnn.pt"
RESULTS = HERE / "mpnn_results.json"

SEEDS = (0, 1, 2)
LR, BATCH, MAX_EPOCHS, PATIENCE, DROPOUT = 1e-3, 64, 200, 20, 0.2
GRID = [dict(num_layers=t, hidden=h, update=u) for t in (3, 4, 5) for h in (128, 256) for u in ("res", "gru")]
GCN_VALID_MEAN, GCN_TEST_MEAN = 0.8497, 0.8600   # metrics.json "gnn" seeds (re-checked in final)
TIE = 0.001
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def cfg_key(c):
    return f"T{c['num_layers']}_H{c['hidden']}_{c['update']}"


def frame_epoch(epoch):
    """Epochs whose weights are kept for the training animation: 0..10, then every 2."""
    return epoch <= 10 or epoch % 2 == 0


@torch.no_grad()
def predict(model, X, E, M, bs=128):
    model.eval()
    out = [torch.sigmoid(model(X[i:i + bs], E[i:i + bs], M[i:i + bs])) for i in range(0, len(X), bs)]
    return torch.cat(out).cpu().numpy()


def n_params(model):
    return sum(p.numel() for p in model.parameters())


def train_one(cfg, seed, data, n_labels, frames_dir=None, log=print):
    torch.manual_seed(seed)
    np.random.seed(seed)
    (Xtr, Etr, Mtr, Ytr), (Xva, Eva, Mva, Yva) = data["train"], data["valid"]
    model = OdorMPNN(NUM_FEATURES, NUM_BOND_FEATURES, n_labels, dropout=DROPOUT, **cfg).to(DEVICE)
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    loss_fn = nn.BCEWithLogitsLoss()
    gen = torch.Generator(device="cpu").manual_seed(seed)
    yva = Yva.cpu().numpy()
    if frames_dir is not None:
        frames_dir.mkdir(parents=True, exist_ok=True)
        torch.save({k: v.detach().cpu() for k, v in model.state_dict().items()}, frames_dir / "epoch000.pt")
    if DEVICE == "cuda":
        torch.cuda.reset_peak_memory_stats()

    best_auc, best_state, best_epoch, wait, history, t0 = -1.0, None, 0, 0, [], time.time()
    for epoch in range(1, MAX_EPOCHS + 1):
        model.train()
        perm = torch.randperm(len(Xtr), generator=gen).to(DEVICE)
        total = 0.0
        for i in range(0, len(perm), BATCH):
            idx = perm[i:i + BATCH]
            loss = loss_fn(model(Xtr[idx], Etr[idx], Mtr[idx]), Ytr[idx])
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
        auc = macro_auroc(yva, predict(model, Xva, Eva, Mva))
        history.append([epoch, round(total / len(perm), 5), round(auc, 5)])
        state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        if frames_dir is not None and frame_epoch(epoch):
            torch.save(state, frames_dir / f"epoch{epoch:03d}.pt")
        if auc > best_auc:
            best_auc, best_epoch, wait, best_state = auc, epoch, 0, state
        else:
            wait += 1
        if epoch % 10 == 0 or wait == 0:
            log(f"  {cfg_key(cfg)} seed {seed} epoch {epoch:3d} loss {total / len(perm):.4f} valid {auc:.4f}"
                + (" *" if wait == 0 else ""))
        if wait >= PATIENCE:
            break
    seconds = time.time() - t0
    if frames_dir is not None:
        torch.save(best_state, frames_dir / f"best_epoch{best_epoch:03d}.pt")
    model.load_state_dict(best_state)
    info = dict(seed=seed, valid=round(best_auc, 4), best_epoch=best_epoch, epochs_run=epoch,
                seconds=round(seconds, 1), seconds_per_epoch=round(seconds / epoch, 2),
                peak_gpu_mb=round(torch.cuda.max_memory_allocated() / 2**20) if DEVICE == "cuda" else None,
                n_parameters=n_params(model))
    return model, info, history


def load_data(use_bond_features=True):
    smiles, labels, Y, split, acyclic = load_split()
    X, E, M = featurize_many(smiles, use_bond_features)
    data = {s: tuple(torch.from_numpy(a[split == s]).to(DEVICE) for a in (X, E, M, Y))
            for s in ("train", "valid", "test")}
    return smiles, labels, Y, split, acyclic, data


def read_grid():
    if not GRID_LOG.exists():
        return {}
    rows = [json.loads(l) for l in GRID_LOG.read_text(encoding="utf-8").splitlines() if l.strip()]
    return {(r["config"], r["seed"]): r for r in rows}


def pilot():
    smiles, labels, *_, data = load_data()
    print(f"Device: {DEVICE}; bond check: {check_bonds(smiles)}")
    for cfg in (dict(num_layers=4, hidden=128, update="res"), dict(num_layers=5, hidden=256, update="gru")):
        model, info, _ = train_one(cfg, 0, data, len(labels))
        print(f"PILOT {cfg_key(cfg)}: {info}")


def grid():
    OUT.mkdir(parents=True, exist_ok=True)
    smiles, labels, *_, data = load_data()
    done = read_grid()
    print(f"Device: {DEVICE}; {len(done)} runs already in {GRID_LOG}")
    for cfg in GRID:
        for seed in SEEDS:
            if (cfg_key(cfg), seed) in done:
                continue
            _, info, history = train_one(cfg, seed, data, len(labels))
            row = {"config": cfg_key(cfg), **cfg, **info, "history": history}
            with GRID_LOG.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
            print(f"GRID {cfg_key(cfg)} seed {seed}: valid {info['valid']} epoch {info['best_epoch']} "
                  f"({info['seconds']:.0f}s)", flush=True)


def grid_summary():
    rows = read_grid()
    out = []
    for cfg in GRID:
        runs = [rows.get((cfg_key(cfg), s)) for s in SEEDS]
        if None in runs:
            raise SystemExit(f"grid incomplete: {cfg_key(cfg)}")
        out.append({"config": cfg_key(cfg), **cfg, "n_parameters": runs[0]["n_parameters"],
                    "valid_seeds": [r["valid"] for r in runs],
                    "valid_mean": round(float(np.mean([r["valid"] for r in runs])), 4),
                    "best_epochs": [r["best_epoch"] for r in runs],
                    "minutes_per_run": round(float(np.mean([r["seconds"] for r in runs])) / 60, 1)})
    top = max(r["valid_mean"] for r in out)
    near = [r for r in out if top - r["valid_mean"] < TIE]
    chosen = min(near, key=lambda r: (r["n_parameters"], -r["valid_mean"]))
    return out, chosen


def test_metrics(Y, P, te, acyclic, rare, pv=None, yv=None):
    pl = per_label_auroc(Y[te], P)
    d = {"test": round(macro_auroc(Y[te], P), 4),
         "test_cyclic": round(macro_auroc(Y[te][~acyclic[te]], P[~acyclic[te]]), 4),
         "test_acyclic": round(macro_auroc(Y[te][acyclic[te]], P[acyclic[te]]), 4),
         "test_rare": round(float(np.nanmean(pl[rare])), 4),
         "brier_raw": round(brier(Y[te], P), 5),
         "mean_prob_test": round(float(P.mean()), 4)}
    if pv is not None:
        d["brier_platt"] = round(brier(Y[te], platt(pv, yv, P)), 5)
    return d, pl


def agg(seeds, k):
    v = [s[k] for s in seeds]
    return [round(float(np.mean(v)), 4), round(float(np.std(v)), 4)]


def final():
    table, chosen = grid_summary()
    cfg = {k: chosen[k] for k in ("num_layers", "hidden", "update")}
    print(f"Chosen by valid: {chosen['config']} valid mean {chosen['valid_mean']}")
    smiles, labels, Y, split, acyclic, data = load_data()
    tr, va, te = (split == s for s in ("train", "valid", "test"))
    train_pos = Y[tr].sum(axis=0)
    rare = train_pos <= np.quantile(train_pos, 1 / 3)
    grid_rows = read_grid()

    # --- GCN reference: the three seeds of the current architecture (ablation config A)
    Xg, Ag, Mg = featurize_gcn(smiles)
    gcn = {"seeds": [], "per_label": []}
    for seed in SEEDS:
        ck = torch.load(HERE / "checkpoints" / f"ablation_A_seed{seed}.pt", map_location="cpu")
        m = OdorGNN(ck["num_features"], len(labels), **ck["config"]).eval()
        m.load_state_dict(ck["state_dict"])
        with torch.no_grad():
            run = lambda idx: torch.sigmoid(m(*(torch.from_numpy(a[idx]) for a in (Xg, Ag, Mg)))).numpy()  # noqa: E731
            pv, pt = run(va), run(te)
        d, pl = test_metrics(Y, pt, te, acyclic, rare, pv, Y[va])
        gcn["seeds"].append({"seed": seed, "valid": round(macro_auroc(Y[va], pv), 4), **d})
        gcn["per_label"].append(pl)

    # --- chosen MPNN, 3 seeds with frame checkpoints; control without bond features
    def run_seeds(dat, frames, tag):
        seeds, per, models = [], [], []
        for seed in SEEDS:
            model, info, history = train_one(cfg, seed, dat, len(labels),
                                             frames_dir=(FRAMES / f"seed{seed}") if frames else None)
            pv = predict(model, *dat["valid"][:3])
            pt = predict(model, *dat["test"][:3])
            d, pl = test_metrics(Y, pt, te, acyclic, rare, pv, Y[va])
            seeds.append({**info, **d, "history": history})
            per.append(pl)
            models.append(model)
            print(f"{tag} seed {seed}: valid {info['valid']} test {d['test']} ({info['seconds']:.0f}s)", flush=True)
        return seeds, per, models

    mp_seeds, mp_per, mp_models = run_seeds(data, True, "MPNN")
    for s in mp_seeds:
        g = grid_rows[(chosen["config"], s["seed"])]
        s["valid_in_grid"] = g["valid"]
        s["best_epoch_in_grid"] = g["best_epoch"]
    _, _, _, _, _, data_nb = load_data(use_bond_features=False)
    nb_seeds, nb_per, _ = run_seeds(data_nb, False, "CONTROL no bond features")

    # --- deploy best-valid seed
    best = int(np.argmax([s["valid"] for s in mp_seeds]))
    CKPT.parent.mkdir(exist_ok=True)
    torch.save({"state_dict": {k: v.cpu() for k, v in mp_models[best].state_dict().items()},
                "config": {**cfg, "dropout": DROPOUT}, "num_features": NUM_FEATURES,
                "num_bond_features": NUM_BOND_FEATURES, "labels": labels, "seed": SEEDS[best]}, CKPT)

    # --- per-label comparison (seed means)
    gl = np.nanmean(np.array(gcn["per_label"]), axis=0)
    ml = np.nanmean(np.array(mp_per), axis=0)
    diff = ml - gl
    ok = ~np.isnan(diff)
    order = np.argsort(diff[ok])
    names = np.array(labels)[ok]
    pos = Y[te].sum(axis=0)[ok].astype(int)
    item = lambda i: {"label": str(names[i]), "gcn": round(float(gl[ok][i]), 4), "mpnn": round(float(ml[ok][i]), 4),  # noqa: E731
                      "diff": round(float(diff[ok][i]), 4), "test_positives": int(pos[i])}
    rare_d = diff[ok & rare]

    strip = lambda seeds: [{k: v for k, v in s.items() if k != "history"} for s in seeds]  # noqa: E731
    summary = lambda seeds: {k + "_mean_std": agg(seeds, k) for k in  # noqa: E731
                             ("valid", "test", "test_cyclic", "test_acyclic", "test_rare", "brier_raw", "brier_platt")}
    mp_valid, mp_test = agg(mp_seeds, "valid")[0], agg(mp_seeds, "test")[0]
    decision = {
        "rule": "adopt iff 3-seed valid mean > GCN valid mean (0.8497) and 3-seed test mean >= GCN test mean (0.8600)",
        "gcn_valid_mean_recomputed": agg(gcn["seeds"], "valid")[0],
        "gcn_test_mean_recomputed": agg(gcn["seeds"], "test")[0],
        "mpnn_valid_mean": mp_valid, "mpnn_test_mean": mp_test,
        "valid_check": mp_valid > GCN_VALID_MEAN, "test_check": mp_test >= GCN_TEST_MEAN,
    }
    decision["adopt"] = decision["valid_check"] and decision["test_check"]
    results = {
        "reference": "Lee et al., Science 381, 999-1006 (2023), doi:10.1126/science.ade4401 (idea only)",
        "protocol": {"split": "training/data/split.csv (same as train.py)", "seeds": list(SEEDS), "lr": LR,
                     "batch": BATCH, "max_epochs": MAX_EPOCHS, "patience": PATIENCE, "dropout": DROPOUT,
                     "selection": "mean valid macro AUROC over 3 seeds; tie < 0.001 -> fewer parameters",
                     "bond_features": ["single", "double", "triple", "aromatic", "other", "in_ring"],
                     "atom_features": "26, same as featurize.py"},
        "bond_check": check_bonds(smiles),
        "grid": table, "chosen": chosen["config"],
        "gcn": {**summary(gcn["seeds"]), "seeds": gcn["seeds"]},
        "mpnn": {**summary(mp_seeds), "config": cfg, "n_parameters": mp_seeds[0]["n_parameters"],
                 "deployed_seed": SEEDS[best], "seeds": strip(mp_seeds)},
        "mpnn_no_bond_features": {**summary(nb_seeds), "seeds": strip(nb_seeds)},
        "per_label_vs_gcn": {"better": int((diff[ok] > 0).sum()), "worse": int((diff[ok] < 0).sum()),
                             "n": int(ok.sum()), "mean_diff": round(float(diff[ok].mean()), 4),
                             "rare": {"better": int((rare_d > 0).sum()), "worse": int((rare_d < 0).sum()),
                                      "n": int(len(rare_d)), "mean_diff": round(float(rare_d.mean()), 4)},
                             "largest_gains": [item(i) for i in order[::-1][:10]],
                             "largest_losses": [item(i) for i in order[:10]]},
        "histories": {f"seed{s['seed']}": s["history"] for s in mp_seeds},
        "decision": decision,
    }
    RESULTS.write_text(json.dumps(results, indent=1), encoding="utf-8")
    print(json.dumps({k: results[k] for k in ("chosen", "decision")}, indent=1))
    print(f"Wrote {RESULTS} and {CKPT}")


if __name__ == "__main__":
    {"pilot": pilot, "grid": grid, "final": final}[sys.argv[1]]()
