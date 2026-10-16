"""Virtual evaluation function for flavor-improver (mixture rule, target profile, objective).

All parameters live in MIXTURE_SPEC and are written to flavor-improver/data/mixture_spec.json
so the browser (bo.js, version 2) can reproduce the same numbers.

Mixture rule (PLAN-formulation.md 2.1, with the user-approved lift vectors):
  OAV_i = conc_i / threshold_i ;  I_i = log10(OAV_i) if OAV_i > 1 else 0
  profile = normalize( sum_i I_i * lift_i )            (L1 normalization, sums to 1)
Target: normalize( clip(base_profile + alpha * direction, 0) )
Objective (2.2):
  score = cos(profile, target) - lambda1 * max(0, n_added - K) - lambda2 * log10(1 + sum added OAV)
Search variable per candidate additive: x = log10(added OAV) in [-2, 2];
x < -1 (added amount below 10% of the threshold) counts as "not added".
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "flavor-improver" / "data"

# lambda2 history: first set to 0.01 before any data was seen; stage-2 diagnostics showed the amount
# penalty of the best recipes (~0.032) exceeded the achievable cosine gain (0.008-0.039), so "add
# nothing" was optimal. With user approval it was recalibrated to 0.002 (max-amount penalty ~1/4 of
# the achievable gain) before re-running every method. v1 results are kept in training/data/.
# x upper bound history: v2 used 3 (added OAV up to 1000); 45-88% of BO additions sat at that bound,
# e.g. four compounds at 1000x threshold, which is not a realistic recipe. With user approval v3 caps
# additions at 100x threshold (upper bound 2). v2 results are kept in training/data/*_v2_xmax3*.
MIXTURE_SPEC = {
    "x_bounds": [-2.0, 2.0],
    "x_not_added_below": -1.0,
    "K": 5,
    "lambda1": 0.05,
    "lambda2": 0.002,
    "alpha": 0.1,
    "normalization": "L1",
}


class Problem:
    """One optimization problem: a base food, a target profile and the candidate additives."""

    def __init__(self, base_id, direction=None, target=None, spec=MIXTURE_SPEC):
        palette = json.loads((DATA / "palette.json").read_text(encoding="utf-8"))
        bases = {b["id"]: b for b in json.loads((DATA / "bases.json").read_text(encoding="utf-8"))}
        self.spec = spec
        self.dims = palette["profile_dims"]
        comps = palette["compounds"]
        self.base = bases[base_id]
        self.candidates = [n for n, c in comps.items() if c["role"] == "palette"]
        # every compound that can appear: base compounds + candidates
        names = sorted(set(self.base["composition_ug_kg"]) | set(self.candidates))
        self.names = names
        self.thr_ug = np.array([comps[n]["threshold_mg_kg"] * 1000.0 for n in names])
        self.lift = np.array([comps[n]["lift"] for n in names])
        self.base_conc = np.array([self.base["composition_ug_kg"].get(n, 0.0) for n in names])
        self.cand_idx = np.array([names.index(n) for n in self.candidates])
        self.base_profile = self.profile(self.base_conc)
        if target is not None:
            self.target = np.asarray(target, dtype=float)
        else:
            d = np.array([float((direction or {}).get(k, 0)) for k in self.dims])
            self.target = normalize(np.clip(self.base_profile + spec["alpha"] * d, 0, None))
        self.dim = len(self.candidates)

    def added_oav(self, x):
        """Search vector x (log10 added OAV per candidate) -> added OAV (0 where 'not added')."""
        x = np.asarray(x, dtype=float)
        return np.where(x < self.spec["x_not_added_below"], 0.0, 10.0 ** x)

    def concentrations(self, x):
        conc = self.base_conc.copy()
        conc[self.cand_idx] += self.added_oav(x) * self.thr_ug[self.cand_idx]
        return conc

    def profile(self, conc):
        oav = conc / self.thr_ug
        intensity = np.where(oav > 1, np.log10(np.maximum(oav, 1e-12)), 0.0)
        return normalize(intensity @ self.lift)

    def evaluate(self, x):
        """Return dict with score and its parts for one candidate recipe."""
        add = self.added_oav(x)
        prof = self.profile(self.concentrations(x))
        cos = cosine(prof, self.target)
        n_added = int((add > 0).sum())
        pen1 = self.spec["lambda1"] * max(0, n_added - self.spec["K"])
        pen2 = self.spec["lambda2"] * np.log10(1.0 + add.sum())
        return {"score": cos - pen1 - pen2, "cos": cos, "n_added": n_added,
                "pen_count": pen1, "pen_amount": pen2, "profile": prof}

    def score(self, x):
        return self.evaluate(x)["score"]

    def recipe(self, x):
        """Human-readable additions: compound, added ug/kg, added OAV, OAV after mixing."""
        add = self.added_oav(x)
        conc = self.concentrations(x)
        out = []
        for j, n in enumerate(self.candidates):
            if add[j] > 0:
                i = self.cand_idx[j]
                out.append({"compound": n, "added_ug_kg": float(add[j] * self.thr_ug[i]),
                            "added_oav": float(add[j]), "oav_after": float(conc[i] / self.thr_ug[i])})
        return sorted(out, key=lambda r: -r["added_oav"])


def normalize(v):
    s = float(np.sum(v))
    return v / s if s > 0 else v


def cosine(a, b):
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    return float(a @ b / (na * nb)) if na > 0 and nb > 0 else 0.0


def write_spec():
    (DATA / "mixture_spec.json").write_text(json.dumps(MIXTURE_SPEC, indent=1), encoding="utf-8")


if __name__ == "__main__":
    write_spec()
    presets = json.loads((DATA / "presets.json").read_text(encoding="utf-8"))
    for p in presets:
        prob = Problem(p["base"], p["direction"])
        no_add = prob.evaluate(np.full(prob.dim, -2.0))
        print(f"{p['id']:13s} base vs target cos = {no_add['cos']:.4f} | score with no additions = {no_add['score']:.4f}")
