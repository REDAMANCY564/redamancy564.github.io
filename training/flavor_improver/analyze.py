"""Summarize stage-2 results into flavor-improver/data/bo_metrics.json and bo_traces.json.

"Evaluations to reach the threshold": for each preset the threshold is
  score_no_addition + 0.9 * (best score found by any method/seed - score_no_addition),
i.e. 90% of the attainable improvement. Runs that never reach it are counted separately.
The trace shown on the website is bo_sparse_init seed 0 for every preset (fixed before the v2 runs, not the best run).
Website recipes omit additions below 1x threshold (added OAV < 1): they barely change the profile and are not
practical; the omitted count is stored as n_hidden. Scores and n_added are always those of the full recipe.
"""
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from mixture import MIXTURE_SPEC, Problem  # noqa: E402

DATA = HERE.parents[1] / "flavor-improver" / "data"
RESULTS = HERE.parent / "data" / "fi_results.json"
FRACTION = 0.9
TRACE_SEED = 0
TRACE_METHOD = "bo_sparse_init"
ARCHIVED = {"v1_lambda2_0.01": HERE.parent / "data" / "fi_bo_metrics_v1_lambda2_0.01.json",
            "v2_xmax3": HERE.parent / "data" / "fi_bo_metrics_v2_xmax3.json"}
DISPLAY_MIN_OAV = 1.0
METHODS = ("bo_sparse_init", "bo", "random_sparse", "random_uniform")


def ms(values):
    v = np.asarray(values, dtype=float)
    return {"mean": round(float(v.mean()), 4), "std": round(float(v.std()), 4)}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    res = json.loads(RESULTS.read_text(encoding="utf-8"))
    presets = json.loads((DATA / "presets.json").read_text(encoding="utf-8"))
    main_runs = [r for r in res if r["kind"] == "main"]
    metrics = {"spec": MIXTURE_SPEC, "threshold_fraction": FRACTION, "n_seeds": 10, "budget": 100, "presets": {}, "known_answer": {}}
    traces = {}

    for p in presets:
        prob = Problem(p["base"], p["direction"])
        s0 = prob.evaluate(np.full(prob.dim, prob.spec["x_bounds"][0]))
        runs = [r for r in main_runs if r["preset"] == p["id"]]
        s_best = max(r["best"]["score"] for r in runs)
        thr = s0["score"] + FRACTION * (s_best - s0["score"])
        entry = {"no_addition": {"score": round(s0["score"], 4), "cos": round(s0["cos"], 4)},
                 "best_any": round(s_best, 4), "threshold_score": round(thr, 4), "methods": {}}
        print(f"\n== {p['id']}  no-addition score {s0['score']:.4f}  best any {s_best:.4f}  threshold {thr:.4f}")
        for m in METHODS:
            rs = [r for r in runs if r["method"] == m]
            reach = [next((i + 1 for i, v in enumerate(r["best_curve"]) if v >= thr), None) for r in rs]
            reached = [x for x in reach if x is not None]
            entry["methods"][m] = {
                "best_score": ms([r["best"]["score"] for r in rs]),
                "best_cos": ms([r["best"]["cos"] for r in rs]),
                "n_added": ms([r["best"]["n_added"] for r in rs]),
                "evals_to_threshold": {"reached": len(reached), "of": len(rs),
                                       "median": float(np.median(reached)) if reached else None},
                "mean_best_curve": [round(float(x), 5) for x in np.mean([r["best_curve"] for r in rs], axis=0)],
                "at_max_bound_fraction": round(float(np.mean([
                    np.mean([v >= prob.spec["x_bounds"][1] - 1e-6 for v in r["best"]["x"] if v >= prob.spec["x_not_added_below"]] or [0])
                    for r in rs])), 3),
            }
            e = entry["methods"][m]
            print(f"  {m:15s} best {e['best_score']['mean']:.4f}±{e['best_score']['std']:.4f}  cos {e['best_cos']['mean']:.4f}"
                  f"  n_added {e['n_added']['mean']:.1f}  reach {e['evals_to_threshold']['reached']}/10"
                  f" median {e['evals_to_threshold']['median']}  at-upper-bound {e['at_max_bound_fraction']:.2f}")
        metrics["presets"][p["id"]] = entry

        bo0 = next(r for r in runs if r["method"] == TRACE_METHOD and r["seed"] == TRACE_SEED)
        steps = []
        for t in bo0["trace"]:
            ev = prob.evaluate(t["x"])
            full = prob.recipe(t["x"])
            shown = [r for r in full if r["added_oav"] >= DISPLAY_MIN_OAV]
            steps.append({"step": t["step"], "score": round(ev["score"], 5), "cos": round(ev["cos"], 5),
                          "n_added": ev["n_added"], "recipe": shown, "n_hidden": len(full) - len(shown),
                          "profile": [round(float(v), 5) for v in ev["profile"]]})
        traces[p["id"]] = {"method": TRACE_METHOD, "seed": TRACE_SEED, "base_profile": [round(float(v), 5) for v in prob.base_profile],
                           "target": [round(float(v), 5) for v in prob.target], "steps": steps,
                           "random_sparse_mean_curve": entry["methods"]["random_sparse"]["mean_best_curve"],
                           "random_uniform_mean_curve": entry["methods"]["random_uniform"]["mean_best_curve"]}

    print("\n== Known-answer test (recover added compounds) ==")
    known = [r for r in res if r["kind"] == "known"]
    for base in sorted({r["base"] for r in known}):
        metrics["known_answer"][base] = {}
        for k in (1, 2, 3):
            if not any(r["base"] == base and r["k"] == k for r in known):
                continue
            row = {}
            for m in ("bo_sparse_init", "bo", "random_sparse"):
                rs = [r for r in known if r["base"] == base and r["k"] == k and r["method"] == m]
                row[m] = {"cos": ms([r["best"]["cos"] for r in rs]), "jaccard": ms([r["known"]["jaccard"] for r in rs]),
                          "group_jaccard": ms([r["known"]["group_jaccard"] for r in rs]),
                          "exact_recovery": sum(r["known"]["jaccard"] == 1.0 for r in rs),
                          "group_recovery": sum(r["known"]["group_jaccard"] == 1.0 for r in rs), "of": len(rs),
                          "true": rs[0]["known"]["true"], "found_examples": [r["known"]["found"] for r in rs]}
            metrics["known_answer"][base][str(k)] = row
            print(f"  {base:17s} k={k} true={row['bo']['true']}")
            for m, e in row.items():
                print(f"     {m:15s} cos {e['cos']['mean']:.4f}  jaccard {e['jaccard']['mean']:.2f}  group {e['group_jaccard']['mean']:.2f}"
                      f"  exact {e['exact_recovery']}/{e['of']}  group-exact {e['group_recovery']}/{e['of']}  found {e['found_examples']}")

    for tag, path in ARCHIVED.items():
        if path.exists():
            old = json.loads(path.read_text(encoding="utf-8"))
            metrics[tag] = {pid: {"no_addition": e["no_addition"],
                                  "methods": {m: {k: e["methods"][m][k] for k in ("best_score", "best_cos", "n_added")}
                                              for m in e["methods"]}} for pid, e in old["presets"].items()}
    (DATA / "bo_metrics.json").write_text(json.dumps(metrics, indent=1, ensure_ascii=False), encoding="utf-8")
    (DATA / "bo_traces.json").write_text(json.dumps(traces, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("\nWrote bo_metrics.json and bo_traces.json")


if __name__ == "__main__":
    main()
