"""Write the adopted MPNN's results into odor-predictor/data/metrics.json (stage 2, 2026-11-18).

  "gnn"               the deployed model, same fields as train.py wrote for the GCN (the about page
                      reads it): seeds, mean +/- std, deployed seed's test report with per-label AUROC
  "gcn_previous"      the former "gnn" entry (GCN, seed 2 deployed until 2026-11), without per-label
  "model_comparison"  test macro AUROC mean +/- std over 3 seeds (all / cyclic / acyclic) for the
                      GCN, the MPNN and the MPNN without bond features (from mpnn_results.json)
"ablation_pharmagnn" stays as it is: those trials ran on the GCN (the page says so).
Run once after train_mpnn.py final; refuses to run twice (gcn_previous already present).
"""
import json
from pathlib import Path

import torch

from evaluate import METRICS_PATH, load_split, test_report
from export_onnx_mpnn import load_model
from featurize_mpnn import featurize_many

HERE = Path(__file__).parent


def main():
    metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))
    assert "gcn_previous" not in metrics, "already converted"
    res = json.loads((HERE / "mpnn_results.json").read_text(encoding="utf-8"))
    model, ck = load_model()
    smiles, labels, Y, split, acyclic = load_split()
    te = split == "test"
    X, E, M = featurize_many([s for s, t in zip(smiles, te) if t])
    with torch.no_grad():
        P = model(*(torch.from_numpy(a) for a in (X, E, M))).numpy()
    rep = test_report(Y[te], P, acyclic[te], labels)
    mp = res["mpnn"]
    dep = next(s for s in mp["seeds"] if s["seed"] == ck["seed"])
    assert abs(rep["macro_auroc"] - dep["test"]) < 1e-4, (rep["macro_auroc"], dep["test"])

    old = {k: v for k, v in metrics["gnn"].items() if k != "per_label"}
    metrics["gcn_previous"] = {"architecture": "GCN, 3 layers x 128, atom features only (training/model.py)", **old}
    metrics["gnn"] = {
        "architecture": "MPNN with bond features (training/model_mpnn.py), idea from Lee et al. 2023",
        "params": {**mp["config"], "dropout": res["protocol"]["dropout"], "lr": res["protocol"]["lr"],
                   "batch": res["protocol"]["batch"], "patience": res["protocol"]["patience"],
                   "n_parameters": mp["n_parameters"]},
        "seeds": [{"seed": s["seed"], "best_epoch": s["best_epoch"], "valid_macro_auroc": s["valid"],
                   "test_macro_auroc": s["test"]} for s in mp["seeds"]],
        "test_macro_auroc_mean": mp["test_mean_std"][0],
        "test_macro_auroc_std": mp["test_mean_std"][1],
        "deployed_seed": ck["seed"],
        "valid_macro_auroc": dep["valid"],
        **rep,
    }
    metrics["model_comparison"] = {
        "note": "test macro AUROC, mean and std over seeds 0 1 2; same split and training settings",
        "gcn": {"test": res["gcn"]["test_mean_std"], "test_cyclic": res["gcn"]["test_cyclic_mean_std"],
                "test_acyclic": res["gcn"]["test_acyclic_mean_std"]},
        "mpnn": {"test": mp["test_mean_std"], "test_cyclic": mp["test_cyclic_mean_std"],
                 "test_acyclic": mp["test_acyclic_mean_std"]},
        "mpnn_no_bond_features": {"test": res["mpnn_no_bond_features"]["test_mean_std"],
                                  "test_cyclic": res["mpnn_no_bond_features"]["test_cyclic_mean_std"],
                                  "test_acyclic": res["mpnn_no_bond_features"]["test_acyclic_mean_std"]},
    }
    METRICS_PATH.write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {METRICS_PATH}: deployed seed {ck['seed']} test {rep['macro_auroc']} "
          f"(cyclic {rep['macro_auroc_cyclic']}, acyclic {rep['macro_auroc_acyclic']})")


if __name__ == "__main__":
    main()
