"""Export the deployed taste GNN (trained on all molecules) to ONNX, sigmoid included.

Same contract as the odor model: inputs X [B,64,F], A [B,64,64], mask [B,64] (float32,
dynamic batch), output probs [B,4]. Verified against PyTorch on every molecule.
Writes taste-predictor/model/taste_gnn.onnx and feature_spec.json (odor spec + taste
fields: standardization step and label order).
"""
import json

import numpy as np
import onnxruntime as ort
import torch

from common import LABELS, ROOT, TRAINING, load
from featurize import SPEC_PATH as ODOR_SPEC, featurize_many
from model import OdorGNN

SITE = ROOT / "taste-predictor"
ONNX_PATH = SITE / "model" / "taste_gnn.onnx"
SPEC_PATH = SITE / "model" / "feature_spec.json"


class WithSigmoid(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, X, A, mask):
        return torch.sigmoid(self.model(X, A, mask))


def load_model(name="taste_gnn.pt"):
    ckpt = torch.load(TRAINING / "checkpoints" / name, map_location="cpu")
    model = OdorGNN(ckpt["num_features"], len(ckpt["labels"]), **ckpt["config"])
    model.load_state_dict(ckpt["state_dict"])
    assert ckpt["labels"] == LABELS
    return WithSigmoid(model).eval(), ckpt


def main():
    model, ckpt = load_model()
    X, A, M = featurize_many(load()["smiles"])
    dummy = tuple(torch.from_numpy(a[:2]) for a in (X, A, M))
    ONNX_PATH.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model, dummy, str(ONNX_PATH), opset_version=17, dynamo=False,
        input_names=["X", "A", "mask"], output_names=["probs"],
        dynamic_axes={"X": {0: "batch"}, "A": {0: "batch"}, "mask": {0: "batch"}, "probs": {0: "batch"}},
    )
    print(f"Wrote {ONNX_PATH} ({ONNX_PATH.stat().st_size / 1e6:.2f} MB)")

    with torch.no_grad():
        ref = model(*(torch.from_numpy(a) for a in (X, A, M))).numpy()
    sess = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
    out = sess.run(None, {"X": X, "A": A, "mask": M})[0]
    single = sess.run(None, {"X": X[:1], "A": A[:1], "mask": M[:1]})[0]
    diff = float(np.abs(out - ref).max())
    print(f"All {len(X)} molecules | max |ONNX - PyTorch| = {diff:.2e} | batch-1 diff = "
          f"{float(np.abs(single - ref[:1]).max()):.2e}")
    assert diff < 1e-4, "ONNX output does not match PyTorch"

    spec = json.loads(ODOR_SPEC.read_text(encoding="utf-8"))
    spec["standardization"] = ("before featurizing: keep the largest fragment, neutralize charges "
                               "(RDKit Uncharger), drop stereo; training data went through the same steps")
    spec.update(model_file=ONNX_PATH.name, onnx_opset=17, num_labels=len(LABELS),
                model_output={"name": "probs", "shape": "[B, num_labels]", "sigmoid_applied": True,
                              "label_order": LABELS,
                              "multi_label": "each class is an independent probability"},
                trained_on=ckpt["trained_on"])
    SPEC_PATH.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    print(f"Wrote {SPEC_PATH}")


if __name__ == "__main__":
    main()
