"""Bayesian optimization (GP + LogEI) and random-search baselines for flavor-improver.

Search space: x in [-2, 2]^D (log10 added OAV per candidate additive), D = 18.
BO: 10 uniform random initial recipes, then 90 steps of a SingleTaskGP (Matern-5/2, ARD)
with Log Expected Improvement, inputs scaled to the unit cube, outputs standardized.
Baselines (same budget of 100 evaluations):
  random_uniform: every coordinate uniform in [-2, 3] (as specified in the plan)
  random_sparse : pick 1-5 additives at random, amounts uniform in [-1, 2], others not added
"""
import time
import warnings

import numpy as np
import torch
from botorch.acquisition import LogExpectedImprovement
from botorch.fit import fit_gpytorch_mll
from botorch.models import SingleTaskGP
from botorch.models.transforms import Normalize, Standardize
from botorch.optim import optimize_acqf
from gpytorch.mlls import ExactMarginalLogLikelihood

torch.set_default_dtype(torch.float64)
N_INIT, N_TOTAL = 10, 100


def _trace_entry(problem, x, step):
    ev = problem.evaluate(x)
    return {"step": step, "x": [round(float(v), 4) for v in x], "score": round(ev["score"], 6),
            "cos": round(ev["cos"], 6), "n_added": ev["n_added"]}


def _finish(problem, trace, method, seed, t0):
    best = max(trace, key=lambda e: e["score"])
    running, curve = -np.inf, []
    for e in trace:
        running = max(running, e["score"])
        curve.append(round(running, 6))
    return {"method": method, "seed": seed, "trace": trace, "best_curve": curve,
            "best": {**best, "recipe": problem.recipe(best["x"])}, "seconds": round(time.time() - t0, 1)}


def sparse_recipe(problem, rng):
    """1 to K additives chosen at random, amounts uniform in [not-added cutoff, upper bound]."""
    lo, hi = problem.spec["x_bounds"]
    x = np.full(problem.dim, lo)
    k = rng.integers(1, problem.spec["K"] + 1)
    idx = rng.choice(problem.dim, size=k, replace=False)
    x[idx] = rng.uniform(problem.spec["x_not_added_below"], hi, size=k)
    return x


def run_bo(problem, seed, n_init=N_INIT, n_total=N_TOTAL, sparse_init=False):
    t0 = time.time()
    rng = np.random.default_rng(seed)
    torch.manual_seed(seed)
    lo, hi = problem.spec["x_bounds"]
    D = problem.dim
    if sparse_init:
        X = np.array([sparse_recipe(problem, rng) for _ in range(n_init)])
    else:
        X = rng.uniform(lo, hi, size=(n_init, D))
    trace = [_trace_entry(problem, x, i + 1) for i, x in enumerate(X)]
    bounds = torch.tensor([[lo] * D, [hi] * D])
    for step in range(n_init + 1, n_total + 1):
        train_X = torch.tensor(np.array([e["x"] for e in trace]))
        train_Y = torch.tensor([[e["score"]] for e in trace])
        model = SingleTaskGP(train_X, train_Y, input_transform=Normalize(d=D, bounds=bounds),
                             outcome_transform=Standardize(m=1))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fit_gpytorch_mll(ExactMarginalLogLikelihood(model.likelihood, model))
            acq = LogExpectedImprovement(model, best_f=train_Y.max())
            cand, _ = optimize_acqf(acq, bounds=bounds, q=1, num_restarts=8, raw_samples=256)
        trace.append(_trace_entry(problem, cand[0].numpy(), step))
    return _finish(problem, trace, "bo_sparse_init" if sparse_init else "bo", seed, t0)


def run_bo_sparse_init(problem, seed):
    return run_bo(problem, seed, sparse_init=True)


def run_random_uniform(problem, seed, n_total=N_TOTAL):
    t0 = time.time()
    rng = np.random.default_rng(10_000 + seed)
    lo, hi = problem.spec["x_bounds"]
    X = rng.uniform(lo, hi, size=(n_total, problem.dim))
    return _finish(problem, [_trace_entry(problem, x, i + 1) for i, x in enumerate(X)], "random_uniform", seed, t0)


def run_random_sparse(problem, seed, n_total=N_TOTAL):
    t0 = time.time()
    rng = np.random.default_rng(20_000 + seed)
    trace = [_trace_entry(problem, sparse_recipe(problem, rng), i + 1) for i in range(n_total)]
    return _finish(problem, trace, "random_sparse", seed, t0)


METHODS = {"bo": run_bo, "bo_sparse_init": run_bo_sparse_init,
           "random_uniform": run_random_uniform, "random_sparse": run_random_sparse}
