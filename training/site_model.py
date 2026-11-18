"""The online odor model, as the website runs it: odor-predictor/model/feature_spec.json names the
ONNX file and the model type. Downstream data (GC-MS flavor.json, flavor-improver, mixture model)
use this, so they always match the odor predictor page.

  predict(smiles_list) -> probs [n, 138] float32   (in the order of odor-predictor/model/labels.json)
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SPEC = json.loads((ROOT / "odor-predictor" / "model" / "feature_spec.json").read_text(encoding="utf-8"))
MODEL_FILE = SPEC["model_file"]
_sess = None


def _session():
    global _sess
    if _sess is None:
        import onnxruntime as ort   # imported here so scripts that only import helpers run without it (.venv-bo)
        _sess = ort.InferenceSession(str(ROOT / "odor-predictor" / "model" / MODEL_FILE),
                                     providers=["CPUExecutionProvider"])
    return _sess


def predict(smiles_list, batch=64):
    if SPEC.get("model_type") == "mpnn":
        from featurize_mpnn import featurize_many
        name = "E"
    else:
        from featurize import featurize_many
        name = "A"
    out = []
    for i in range(0, len(smiles_list), batch):
        X, B, M = featurize_many(smiles_list[i:i + batch])
        out.append(_session().run(None, {"X": X, name: B, "mask": M})[0])
    return np.concatenate(out) if out else np.zeros((0, SPEC["num_labels"]), np.float32)
