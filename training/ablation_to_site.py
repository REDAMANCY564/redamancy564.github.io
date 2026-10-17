"""Copy the ablation summary (ablation_results.json, from ablation.py) into
odor-predictor/data/metrics.json under "ablation_pharmagnn" for the results section."""
import json
from pathlib import Path

from evaluate import update_metrics

HERE = Path(__file__).parent


def main():
    r = json.loads((HERE / "ablation_results.json").read_text(encoding="utf-8"))
    rows = {}
    for name, c in r["configs"].items():
        rows[name] = {
            "loss": c["loss"], "pharmacophore": c["pharma"], "asl_gamma_pos_neg": c["asl_gamma_pos_neg"],
            "valid_mean": c["valid_mean"],
            "test_mean": c["test_mean_std"][0], "test_std": c["test_mean_std"][1],
            "test_rare_mean": c["test_rare_mean_std"][0],
            "rare_vs_A": c.get("rare_vs_A"),
            "brier_raw": c["brier_raw_mean_std"][0],
        }
    update_metrics("ablation_pharmagnn", {
        "reference": "Liu et al., J Sci Food Agric 106, 8114-8120 (2026), doi:10.1002/jsfa.70826",
        "n_rare_labels": len(r["rare_labels"]),
        "configs": rows,
        "decision": r["decision"],
    })
    print("Updated metrics.json:", {k: v["test_mean"] for k, v in rows.items()}, "replace =", r["decision"]["replace"])


if __name__ == "__main__":
    main()
