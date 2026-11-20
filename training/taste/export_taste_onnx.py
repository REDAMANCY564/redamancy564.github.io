"""Export the deployed taste GCN (trained on all molecules) to ONNX, sigmoid included.

Inputs X [B,64,F], A [B,64,64], mask [B,64] (float32, dynamic batch), and, when the model uses
whole-molecule descriptors (case-fix-3), D [B,8]: the descriptors of descriptors.py already
z-scored with feature_spec.json global_descriptors.mean / std. Output probs [B,4].
Verified against PyTorch on every molecule.
Writes taste-predictor/model/taste_gnn.onnx and feature_spec.json (GCN feature spec + taste
fields: standardization step, descriptors, judgement thresholds, label order).
"""
import json

import numpy as np
import onnxruntime as ort
import torch

from common import LABELS, METRICS_PATH, ROOT, TRAINING, load
from descriptors import describe_many
from featurize import featurize_many, spec_dict
from model_taste import TasteGNN

SITE = ROOT / "taste-predictor"
ONNX_PATH = SITE / "model" / "taste_gnn.onnx"
SPEC_PATH = SITE / "model" / "feature_spec.json"


class WithSigmoid(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, X, A, mask, D=None):
        return torch.sigmoid(self.model(X, A, mask, D))


def load_model(name="taste_gnn.pt"):
    """Checkpoint (TasteGNN, or the first version's OdorGNN state, same keys) -> (model, ckpt)."""
    path = name if "/" in str(name) or "\\" in str(name) else TRAINING / "checkpoints" / name
    ckpt = torch.load(path, map_location="cpu")
    kw = ckpt.get("model_kwargs") or {**ckpt["config"], "pools": ("mean", "max"), "n_desc": 0}
    model = TasteGNN(ckpt["num_features"], len(ckpt["labels"]), **kw)
    model.load_state_dict(ckpt["state_dict"])
    assert ckpt["labels"] == LABELS
    return WithSigmoid(model).eval(), ckpt


def inputs(smiles, ckpt):
    """Model inputs (numpy float32) for standardized SMILES."""
    X, A, M = featurize_many(smiles)
    if ckpt.get("desc_names"):
        D = ((describe_many(smiles) - np.array(ckpt["desc_mean"])) / np.array(ckpt["desc_std"])).astype(np.float32)
    else:
        D = np.zeros((len(smiles), 0), np.float32)
    return X, A, M, D


@torch.no_grad()
def predict_smiles(model, ckpt, smiles, batch=512):
    out = []
    for s in range(0, len(smiles), batch):
        arrs = inputs(smiles[s:s + batch], ckpt)
        out.append(model(*(torch.from_numpy(a) for a in arrs)).numpy())
    return np.concatenate(out)


def main():
    model, ckpt = load_model()
    smiles = load()["smiles"]
    X, A, M, D = inputs(smiles, ckpt)
    use_d = bool(ckpt.get("desc_names"))
    names = ["X", "A", "mask"] + (["D"] if use_d else [])
    arrs = [X, A, M] + ([D] if use_d else [])
    dummy = tuple(torch.from_numpy(a[:2]) for a in arrs)
    ONNX_PATH.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model, dummy, str(ONNX_PATH), opset_version=17, dynamo=False,
        input_names=names, output_names=["probs"],
        dynamic_axes={**{n: {0: "batch"} for n in names}, "probs": {0: "batch"}},
    )
    print(f"Wrote {ONNX_PATH} ({ONNX_PATH.stat().st_size / 1e6:.2f} MB)")

    with torch.no_grad():
        ref = model(*(torch.from_numpy(a) for a in arrs)).numpy()
    sess = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
    out = sess.run(None, dict(zip(names, arrs)))[0]
    single = sess.run(None, dict(zip(names, [a[:1] for a in arrs])))[0]
    diff = float(np.abs(out - ref).max())
    print(f"All {len(X)} molecules | max |ONNX - PyTorch| = {diff:.2e} | batch-1 diff = "
          f"{float(np.abs(single - ref[:1]).max()):.2e}")
    assert diff < 1e-4, "ONNX output does not match PyTorch"

    spec = spec_dict()  # GCN featurizer spec (the odor model is now an MPNN with its own spec)
    spec["standardization"] = ("before featurizing: keep the largest fragment, neutralize charges "
                               "(RDKit Uncharger), drop stereo; training data went through the same steps")
    kw = ckpt.get("model_kwargs") or {}
    spec["readout"] = {"pools": list(kw.get("pools", ("mean", "max"))),
                       "hidden": kw.get("hidden", ckpt["config"]["hidden"]),
                       "num_layers": kw.get("num_layers", ckpt["config"]["num_layers"])}
    if use_d:
        spec["global_descriptors"] = {
            "input": "D", "names": ckpt["desc_names"],
            "mean": [round(float(v), 6) for v in ckpt["desc_mean"]],
            "std": [round(float(v), 6) for v in ckpt["desc_std"]],
            "rule": "computed on the standardized structure (training/taste/descriptors.py), then "
                    "(value - mean) / std with the train-split mean and std",
        }
    metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))["gnn"]
    if "thresholds" in metrics:
        spec["thresholds"] = {lab: metrics["thresholds"][lab]["threshold"] for lab in LABELS}
        # labels whose judgement is shown on the page (validation precision >= 0.5 at the threshold)
        spec["thresholds_show"] = {lab: metrics["thresholds"][lab].get("show", True) for lab in LABELS}
        spec["thresholds_rule"] = metrics["thresholds_rule"]
    spec.update(model_file=ONNX_PATH.name, onnx_opset=17, num_labels=len(LABELS),
                model_output={"name": "probs", "shape": "[B, num_labels]", "sigmoid_applied": True,
                              "label_order": LABELS,
                              "multi_label": "each class is an independent probability"},
                trained_on=ckpt["trained_on"])
    SPEC_PATH.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    print(f"Wrote {SPEC_PATH}")


if __name__ == "__main__":
    main()
