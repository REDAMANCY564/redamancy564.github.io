"""Export checkpoints/odor_mpnn.pt to ONNX (opset 17, sigmoid included) and verify it.

Stage 1 (before the user decides on adoption) writes only to training/data/mpnn/, never into
the website: this measures the file size and checks ONNX against PyTorch.
  python export_onnx_mpnn.py            -> training/data/mpnn/odor_mpnn.onnx
Stage 2 (adopted 2026-11-18):
  python export_onnx_mpnn.py --site     -> odor-predictor/model/odor_mpnn.onnx + feature_spec.json
Since 2026-11-19 the site file also carries the intermediate outputs read by the How it predicts page
(odor-predictor/process.html): --site exports through export_process_onnx.main (same graph plus h0-h3,
m1-m3 and the pools; probs output unchanged), never the probs-only graph. After it run
process_site_data.py and open tests/parity.html and tests/parity-layers.html.

Inputs: X [B,64,26], E [B,64,64,6], mask [B,64] (float32, dynamic batch). Output: probs [B,138].
Checks: test set |ONNX - PyTorch| < 1e-4; batch-1 run; extra padding atoms do not change output;
occlusion batch (n+1 inputs) equals running each input alone.
"""
from pathlib import Path

import json
import sys

import numpy as np
import onnxruntime as ort
import torch
from torch import nn

from evaluate import load_split
from featurize import SPEC_PATH
from featurize_mpnn import featurize_many, write_spec
from model_mpnn import OdorMPNN
from occlusion import occlusion_batch_mpnn

HERE = Path(__file__).parent
CKPT = HERE / "checkpoints" / "odor_mpnn.pt"
ONNX_PATH = HERE / "data" / "mpnn" / "odor_mpnn.onnx"
SITE_ONNX = HERE.parent / "odor-predictor" / "model" / "odor_mpnn.onnx"


class WithSigmoid(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, X, E, mask):
        return torch.sigmoid(self.model(X, E, mask))


def load_model(path=CKPT):
    ck = torch.load(path, map_location="cpu")
    model = OdorMPNN(ck["num_features"], ck["num_bond_features"], len(ck["labels"]), **ck["config"])
    model.load_state_dict(ck["state_dict"])
    return WithSigmoid(model).eval(), ck


def main(onnx_path=ONNX_PATH):
    model, ck = load_model()
    smiles, _, _, split, _ = load_split()
    test = [s for s, sp in zip(smiles, split) if sp == "test"]
    X, E, M = featurize_many(test)
    onnx_path.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model, tuple(torch.from_numpy(a[:2]) for a in (X, E, M)), str(onnx_path), opset_version=17, dynamo=False,
        input_names=["X", "E", "mask"], output_names=["probs"],
        dynamic_axes={"X": {0: "batch"}, "E": {0: "batch"}, "mask": {0: "batch"}, "probs": {0: "batch"}},
    )
    print(f"Wrote {onnx_path} ({onnx_path.stat().st_size / 1e6:.2f} MB), seed {ck['seed']}, config {ck['config']}")

    with torch.no_grad():
        ref = model(*(torch.from_numpy(a) for a in (X, E, M))).numpy()
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    out = np.concatenate([sess.run(None, {"X": X[i:i + 64], "E": E[i:i + 64], "mask": M[i:i + 64]})[0]
                          for i in range(0, len(X), 64)])
    single = sess.run(None, {"X": X[:1], "E": E[:1], "mask": M[:1]})[0]
    diff = float(np.abs(out - ref).max())
    print(f"Test molecules: {len(X)} | max |ONNX - PyTorch| = {diff:.2e} | "
          f"batch-1 diff = {float(np.abs(single - ref[:1]).max()):.2e}")
    assert diff < 1e-4

    # padding invariance: zeroed atom rows beyond n never change the output
    Xp, Ep, Mp = X[:1].copy(), E[:1].copy(), M[:1].copy()
    Xp[0, int(Mp.sum()):] = 0.0
    pad = float(np.abs(sess.run(None, {"X": Xp, "E": Ep, "mask": Mp})[0] - single).max())
    # occlusion batch vs one-by-one
    Xo, Eo, Mo = occlusion_batch_mpnn(X[0], E[0], M[0])
    ob = sess.run(None, {"X": Xo, "E": Eo, "mask": Mo})[0]
    oi = np.concatenate([sess.run(None, {"X": Xo[i:i + 1], "E": Eo[i:i + 1], "mask": Mo[i:i + 1]})[0]
                         for i in range(len(Xo))])
    print(f"padding diff {pad:.2e} | occlusion batch vs single {float(np.abs(ob - oi).max()):.2e}")


def site():
    # the site file must keep the intermediate outputs of the How it predicts page: export through
    # export_process_onnx (all its checks against PyTorch; the bit-for-bit gate against the previous
    # site file is reported only, since retrained weights differ)
    from export_process_onnx import add_extra_outputs, main as export_with_layers
    export_with_layers(site=True, same_model=False)
    _, ck = load_model()
    write_spec()
    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    spec.update(model_file=SITE_ONNX.name, onnx_opset=17, num_labels=len(ck["labels"]),
                model_output={"name": "probs", "shape": "[B, num_labels]", "sigmoid_applied": True,
                              "label_order": "same as labels.json"},
                model_config={**ck["config"], "seed": ck["seed"]})
    add_extra_outputs(spec)
    SPEC_PATH.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    print(f"Updated {SPEC_PATH}")


if __name__ == "__main__":
    site() if "--site" in sys.argv else main()
