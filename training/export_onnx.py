"""Export the trained OdorGNN to ONNX (opset 17) with sigmoid included in the graph.

Inputs: X [B,64,F], A [B,64,64], mask [B,64] (float32, dynamic batch).
Output: probs [B,L] in [0,1].
Verifies onnxruntime output against PyTorch on the test set (max abs diff < 1e-4).
"""
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from torch import nn

from evaluate import load_split
from featurize import SPEC_PATH, featurize_many
from model import OdorGNN

ROOT = Path(__file__).resolve().parent.parent
CKPT = Path(__file__).parent / "checkpoints" / "odor_gnn.pt"
ONNX_PATH = ROOT / "odor-predictor" / "model" / "odor_gnn.onnx"


class WithSigmoid(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, X, A, mask):
        return torch.sigmoid(self.model(X, A, mask))


def load_model():
    ckpt = torch.load(CKPT, map_location="cpu")
    model = OdorGNN(ckpt["num_features"], len(ckpt["labels"]), **ckpt["config"])
    model.load_state_dict(ckpt["state_dict"])
    return WithSigmoid(model).eval(), ckpt


def main():
    model, ckpt = load_model()
    smiles, _, _, split, _ = load_split()
    test_smiles = [s for s, sp in zip(smiles, split) if sp == "test"]
    X, A, M = featurize_many(test_smiles)
    dummy = tuple(torch.from_numpy(a[:2]) for a in (X, A, M))

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
    print(f"Test molecules: {len(X)} | max |ONNX - PyTorch| = {diff:.2e} | batch-1 run diff = "
          f"{float(np.abs(single - ref[:1]).max()):.2e}")
    assert diff < 1e-4, "ONNX output does not match PyTorch"

    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    spec["model_file"] = ONNX_PATH.name
    spec["onnx_opset"] = 17
    spec["model_output"] = {"name": "probs", "shape": "[B, num_labels]", "sigmoid_applied": True,
                            "label_order": "same as labels.json"}
    spec["num_labels"] = len(ckpt["labels"])
    SPEC_PATH.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    print(f"Updated {SPEC_PATH}")


if __name__ == "__main__":
    main()
