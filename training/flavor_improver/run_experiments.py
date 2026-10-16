"""Run all stage-2 experiments in parallel and save raw results to training/data/fi_results.json.

1. Main comparison: 4 presets x {bo, bo_sparse_init, random_uniform, random_sparse} x 10 seeds,
   100 evaluations each.
2. Known-answer test (v3): for each base, synthetic targets made by adding 1, 2 or 3 random candidate
   additives with added OAV 10-100 (inside the search range); a target is kept only if cos(base profile, target) < 0.98 so the
   change is detectable (resampled otherwise, fixed RNG). bo, bo_sparse_init and random_sparse try to
   recover it (3 seeds each). Recovery is scored per compound and per group of near-identical compounds
   (lift-vector cosine > 0.95), because such compounds cannot be told apart by the profile.
"""
import os

# One math-library thread per worker. Without this, OpenBLAS/MKL reserve buffers for every CPU core
# (~1.7 GB per process on a 32-core machine), which exhausts the Windows page file with many workers.
for _v in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import json  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
OUT = HERE.parent / "data" / "fi_results.json"
SEEDS = range(10)
KNOWN_SEEDS = range(3)


def _init_worker():
    import torch
    torch.set_num_threads(1)


def _run(task):
    from bo import METHODS
    from mixture import Problem
    prob = Problem(task["base"], task.get("direction"), task.get("target"))
    res = METHODS[task["method"]](prob, task["seed"])
    res.update({k: v for k, v in task.items() if k not in ("target",)})
    if task.get("true_x") is not None:
        true_set = {prob.candidates[j] for j, v in enumerate(task["true_x"]) if v >= prob.spec["x_not_added_below"]}
        found = {r["compound"] for r in res["best"]["recipe"]}
        groups = compound_groups(prob)
        tg, fg = {groups[c] for c in true_set}, {groups[c] for c in found}
        jac = lambda a, b: len(a & b) / len(a | b) if a | b else 1.0
        res["known"] = {"true": sorted(true_set), "found": sorted(found), "jaccard": jac(true_set, found),
                        "group_jaccard": jac(tg, fg)}
    return res


def compound_groups(prob, cutoff=0.95):
    """Connected components of candidates whose lift vectors have cosine > cutoff."""
    from mixture import cosine
    names = prob.candidates
    lift = {n: prob.lift[prob.names.index(n)] for n in names}
    parent = {n: n for n in names}
    def find(n):
        while parent[n] != n:
            n = parent[n]
        return n
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if cosine(lift[a], lift[b]) > cutoff:
                parent[find(b)] = find(a)
    return {n: find(n) for n in names}


def known_answer_tasks():
    from mixture import Problem, cosine
    presets = json.loads((HERE.parents[1] / "flavor-improver" / "data" / "presets.json").read_text(encoding="utf-8"))
    tasks = []
    for b_i, base in enumerate(sorted({p["base"] for p in presets})):
        prob = Problem(base, {})
        rng = np.random.default_rng(2000 + b_i)
        for k in (1, 2, 3):
            for _attempt in range(1000):
                x = np.full(prob.dim, prob.spec["x_bounds"][0])
                idx = rng.choice(prob.dim, size=k, replace=False)
                x[idx] = rng.uniform(1.0, prob.spec["x_bounds"][1], size=k)  # added OAV between 10 and the upper bound (100)
                target = prob.profile(prob.concentrations(x))
                if cosine(prob.base_profile, target) < 0.98:
                    break
            else:
                print(f"no detectable target for {base} k={k}", flush=True)
                continue
            target = target.tolist()
            for method in ("bo", "bo_sparse_init", "random_sparse"):
                for s in KNOWN_SEEDS:
                    tasks.append({"kind": "known", "base": base, "k": k, "target": target, "true_x": x.tolist(),
                                  "method": method, "seed": s})
    return tasks


def task_key(t):
    return f"{t['kind']}|{t.get('preset', '')}|{t['base']}|{t.get('k', '')}|{t['method']}|{t['seed']}"


def main():
    presets = json.loads((HERE.parents[1] / "flavor-improver" / "data" / "presets.json").read_text(encoding="utf-8"))
    tasks = [{"kind": "main", "preset": p["id"], "base": p["base"], "direction": p["direction"], "method": m, "seed": s}
             for p in presets for m in ("bo", "bo_sparse_init", "random_uniform", "random_sparse") for s in SEEDS]
    tasks += known_answer_tasks()
    # Results are appended one per line as they finish, so an interrupted run can be resumed.
    partial = OUT.with_suffix(".partial.jsonl")
    done = {}
    if partial.exists():
        for line in partial.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            done[task_key(r)] = r
    todo = [t for t in tasks if task_key(t) not in done]
    print(f"{len(tasks)} runs ({sum(t['method'].startswith('bo') for t in tasks)} BO); "
          f"{len(done)} already done, {len(todo)} to run", flush=True)
    t0, failed = time.time(), 0
    with ProcessPoolExecutor(max_workers=12, initializer=_init_worker) as ex, partial.open("a", encoding="utf-8") as fh:
        futures = {ex.submit(_run, t): t for t in todo}
        for i, f in enumerate(as_completed(futures), 1):
            try:
                r = f.result()
            except Exception as e:  # keep going; a re-run picks up the missing task
                failed += 1
                print(f"FAILED {task_key(futures[f])}: {e}", flush=True)
                continue
            done[task_key(r)] = r
            fh.write(json.dumps(r) + "\n")
            fh.flush()
            if i % 10 == 0 or i == len(todo):
                print(f"{i}/{len(todo)} done, {time.time() - t0:.0f}s", flush=True)
    if failed:
        print(f"{failed} runs failed; run the script again to retry them.")
        return
    OUT.write_text(json.dumps([done[task_key(t)] for t in tasks]), encoding="utf-8")
    print(f"Saved {OUT}")


if __name__ == "__main__":
    main()
