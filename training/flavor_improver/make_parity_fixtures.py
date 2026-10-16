"""Write flavor-improver/tests/parity_fixtures.json: Python reference values for the browser mixture rule.

For every preset: base profile, target, and the score/cos/n_added/profile of a set of recipes
(edge cases around the 'not added' cutoff and OAV = 1, plus random recipes), with the default
thresholds and with a set of user-modified thresholds. Also the profile of every sample of example 5
(data/reference.json, full compositions) computed with prepare_reference.profile. tests/parity.html
recomputes all of them with flavor-improver/mixture.js and requires agreement within the tolerance.
"""
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from mixture import DATA, Problem, normalize  # noqa: E402
from prepare_reference import profile as reference_profile  # noqa: E402

OUT = DATA.parent / "tests" / "parity_fixtures.json"


def recipes(dim, rng):
    lo, hi = -2.0, 2.0
    xs = [np.full(dim, lo), np.full(dim, hi), np.full(dim, -1.0), np.full(dim, -1.0 - 1e-9), np.zeros(dim)]
    for _ in range(15):
        xs.append(rng.uniform(lo, hi, dim))
    for _ in range(10):  # sparse recipes like the ones BO evaluates
        x = np.full(dim, lo)
        idx = rng.choice(dim, size=rng.integers(1, 6), replace=False)
        x[idx] = rng.uniform(-1.0, hi, len(idx))
        xs.append(x)
    return xs


def main():
    presets = json.loads((DATA / "presets.json").read_text(encoding="utf-8"))
    palette = json.loads((DATA / "palette.json").read_text(encoding="utf-8"))
    rng = np.random.default_rng(7)
    # A user-modified threshold set: every compound scaled by a random factor between 1/30 and 30.
    modified = {n: c["threshold_mg_kg"] * 1000.0 * float(10 ** rng.uniform(-1.5, 1.5))
                for n, c in palette["compounds"].items()}
    cases = []
    for p in presets:
        for label, thr in (("default", None), ("modified", modified)):
            prob = Problem(p["base"], p["direction"])
            if thr is not None:
                prob.thr_ug = np.array([thr[n] for n in prob.names])
                prob.base_profile = prob.profile(prob.base_conc)
                d = np.array([float(p["direction"].get(k, 0)) for k in prob.dims])
                prob.target = normalize(np.clip(prob.base_profile + prob.spec["alpha"] * d, 0, None))
            evals = []
            for x in recipes(prob.dim, rng):
                ev = prob.evaluate(x)
                evals.append({"x": x.tolist(), "score": ev["score"], "cos": ev["cos"], "n_added": ev["n_added"],
                              "profile": ev["profile"].tolist()})
            cases.append({"preset": p["id"], "thresholds": label, "base_profile": prob.base_profile.tolist(),
                          "target": prob.target.tolist(), "evals": evals})
    ref = json.loads((DATA / "reference.json").read_text(encoding="utf-8"))
    ref_cases = [{"side": side, "sample": s["id"], "conc": s["conc_ug_kg"],
                  "profile": reference_profile(s["conc_ug_kg"], ref["compounds"])[0].tolist()}
                 for side in ("human_milk", "infant_formula") for s in ref[side]["samples"]]
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"tolerance": 1e-9, "candidates": Problem(presets[0]["base"]).candidates,
                               "modified_thresholds_ug_kg": modified, "cases": cases,
                               "reference_cases": ref_cases}), encoding="utf-8")
    print(f"Wrote {OUT} ({sum(len(c['evals']) for c in cases)} recipes)")


if __name__ == "__main__":
    main()
