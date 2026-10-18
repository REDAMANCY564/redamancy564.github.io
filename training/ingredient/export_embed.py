"""Stage 2 of ingredient-finder: ONNX with embedding outputs + per-molecule features of the library.

The deployed odor model (checkpoints/odor_gnn.pt, same weights as odor-predictor/model/odor_gnn.onnx)
is exported again with three outputs, without touching the online file:
  probs    [B, 138]  sigmoid probabilities (as the online model)
  readout  [B, 256]  mean + max pooled atom states (graph readout)
  hidden   [B, 256]  first head layer after ReLU (the layer before the output)
The third embedding candidate is the probability vector itself. Stage 3 picks one on the
validation split.

Checks: new ONNX vs PyTorch, and new ONNX probs vs the online ONNX probs on all library molecules.
Also computes Morgan fingerprints (radius 2, 2048 bits) for structure similarity, and measures how
much int8 quantization of each embedding changes the nearest-neighbour lists.

Output: training/data/ingredient/features.npz (+ the check-only ONNX next to it).
Stage 3 chose the probability vector as the odor embedding (user decision 2026-10-18), so the page
uses the online odor_gnn.onnx and this embedding ONNX is not published.
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from rdkit import Chem
from rdkit.Chem import rdFingerprintGenerator
from torch import nn

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "training"))
from featurize import featurize_many  # noqa: E402
from model import OdorGNN  # noqa: E402

CKPT = ROOT / "training" / "checkpoints" / "odor_gnn.pt"
ONLINE = ROOT / "odor-predictor" / "model" / "odor_gnn.onnx"
OUT_ONNX = ROOT / "training" / "data" / "ingredient" / "odor_gnn_embed.onnx"   # check only, not published
DATA = ROOT / "training" / "data" / "ingredient"


class WithEmbeddings(nn.Module):
    """Same computation as OdorGNN.forward + sigmoid, also returning the two intermediate vectors."""

    def __init__(self, model):
        super().__init__()
        self.m = model

    def forward(self, X, A, mask):
        m = mask.unsqueeze(-1)
        H = X
        for conv in self.m.convs:
            H = torch.relu(A @ conv(H)) * m
        n_atoms = m.sum(dim=1).clamp(min=1.0)
        readout = torch.cat([H.sum(dim=1) / n_atoms, H.max(dim=1).values], dim=-1)
        hidden = self.m.head[1](self.m.head[0](readout))          # Linear + ReLU (dropout is off in eval)
        probs = torch.sigmoid(self.m.head[3](hidden))
        return probs, readout, hidden


def quantize(v):
    """Symmetric int8 per dimension: q = round(v / s), s = max|v| / 127."""
    s = np.abs(v).max(axis=0) / 127.0
    s[s == 0] = 1.0
    return np.clip(np.round(v / s), -127, 127).astype(np.int8), s.astype(np.float32)


def top_k(E, k=10):
    En = E / np.maximum(np.linalg.norm(E, axis=1, keepdims=True), 1e-12)
    S = En @ En.T
    np.fill_diagonal(S, -np.inf)
    return np.argsort(-S, axis=1)[:, :k]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    lib = json.loads((DATA / "library.json").read_text(encoding="utf-8"))["molecules"]
    smiles = [r["smiles"] for r in lib]

    ckpt = torch.load(CKPT, map_location="cpu")
    model = OdorGNN(ckpt["num_features"], len(ckpt["labels"]), **ckpt["config"])
    model.load_state_dict(ckpt["state_dict"])
    net = WithEmbeddings(model).eval()

    X, A, M = featurize_many(smiles)
    OUT_ONNX.parent.mkdir(parents=True, exist_ok=True)
    dummy = tuple(torch.from_numpy(a[:2]) for a in (X, A, M))
    torch.onnx.export(
        net, dummy, str(OUT_ONNX), opset_version=17, dynamo=False,
        input_names=["X", "A", "mask"], output_names=["probs", "readout", "hidden"],
        dynamic_axes={k: {0: "batch"} for k in ("X", "A", "mask", "probs", "readout", "hidden")},
    )
    print(f"wrote {OUT_ONNX} ({OUT_ONNX.stat().st_size / 1e6:.2f} MB)")

    with torch.no_grad():
        ref = [t.numpy() for t in net(*(torch.from_numpy(a) for a in (X, A, M)))]
    new = ort.InferenceSession(str(OUT_ONNX), providers=["CPUExecutionProvider"]).run(None, {"X": X, "A": A, "mask": M})
    online = ort.InferenceSession(str(ONLINE), providers=["CPUExecutionProvider"]).run(None, {"X": X, "A": A, "mask": M})[0]
    d_torch = max(float(np.abs(a - b).max()) for a, b in zip(new, ref))
    d_online = float(np.abs(new[0] - online).max())
    print(f"molecules {len(smiles)} | max |new ONNX - PyTorch| (all outputs) = {d_torch:.2e} | "
          f"max |new probs - online odor_gnn.onnx probs| = {d_online:.2e}")
    assert d_torch < 1e-4 and d_online < 1e-6

    gen = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)
    fps = np.stack([gen.GetFingerprintAsNumPy(Chem.MolFromSmiles(s)) for s in smiles]).astype(np.uint8)
    on_bits = fps.sum(axis=1)
    print(f"Morgan r=2, 2048 bits: on-bits per molecule mean {on_bits.mean():.1f}, max {on_bits.max()}")

    probs, readout, hidden = new
    report = {}
    for name, E in (("probs", probs), ("readout", readout), ("hidden", hidden)):
        if name == "probs":
            q = np.round(E * 255).astype(np.uint8)
            Eq = q.astype(np.float32) / 255
        else:
            q, s = quantize(E)
            Eq = q.astype(np.float32) * s
        a, b = top_k(E), top_k(Eq)
        overlap = float(np.mean([len(set(x) & set(y)) / 10 for x, y in zip(a, b)]))
        report[name] = round(overlap, 4)
    print("top-10 neighbour overlap, float32 vs quantized (int8 embeddings, uint8 probs):", report)

    np.savez_compressed(DATA / "features.npz", probs=probs, readout=readout, hidden=hidden,
                        fps=np.packbits(fps, axis=1))
    n = len(smiles)
    print("size estimates for the site (binary files):")
    print(f"  embedding 256-d int8: {n * 256 / 1e6:.2f} MB | probability vector 138 uint8: {n * 138 / 1e6:.2f} MB | "
          f"fingerprints 2048 bits: {n * 256 / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
