"""Place molecules added to the library after the maps were fitted (2026-11-20, user decision: the
existing layout must not change; the training animation and the "how it predicts" page rely on it).

The fitted UMAP models were not saved, so both maps are fitted again exactly as in build_maps.py on the
molecules of the original fit (the first n_fit library molecules, same parameters, random_state 42). The
refit must reproduce training/data/odormap/maps.npz exactly (checked: maximum difference 0); then the new
molecules are placed with UMAP.transform, which does not move the fitted points.

Input:  training/data/ingredient/library.json + features.npz (all molecules), training/data/odormap/maps.npz
Output: training/data/odormap/maps.npz with all molecules and n_fit (the number of fitted molecules);
        make_site_data.py scales the maps and computes regions and colours on the fitted molecules only.
Run: training/.venv/Scripts/python.exe training/odormap/extend_maps.py
"""
import json
import sys
from pathlib import Path

import numpy as np
import umap

sys.path.insert(0, str(Path(__file__).parent))
from build_maps import PARAMS, SEED  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "training" / "data"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    lib = json.loads((DATA / "ingredient" / "library.json").read_text(encoding="utf-8"))["molecules"]
    f = np.load(DATA / "ingredient" / "features.npz")
    old = np.load(DATA / "odormap" / "maps.npz")
    n_fit = int(old["n_fit"]) if "n_fit" in old.files else len(old["odor"])
    n = len(lib)
    assert len(f["probs"]) == n and n >= n_fit
    P = np.round(f["probs"] * 255) / 255
    F = np.unpackbits(f["fps"], axis=1).astype(bool)
    out = {"n_fit": np.array(n_fit)}
    for kind, X in (("odor", P), ("structure", F)):
        model = umap.UMAP(n_components=2, random_state=SEED, **PARAMS[kind])
        fit = model.fit_transform(X[:n_fit]).astype(np.float32)
        diff = float(np.abs(fit - old[kind][:n_fit]).max())
        assert diff == 0.0, f"{kind}: the refit differs from the published map (max {diff}); stop"
        new = model.transform(X[n_fit:]).astype(np.float32) if n > n_fit else np.zeros((0, 2), np.float32)
        assert not np.isnan(new).any(), kind
        out[kind] = np.concatenate([fit, new])
        lo, hi = fit.min(0), fit.max(0)
        outside = int(((new < lo) | (new > hi)).any(1).sum())
        print(f"{kind}: refit identical to the published map; {len(new)} new molecules placed, {outside} outside the fitted range")
    np.savez_compressed(DATA / "odormap" / "maps.npz", **out)
    print(f"wrote maps.npz: {n} molecules, fitted {n_fit}")


if __name__ == "__main__":
    main()
