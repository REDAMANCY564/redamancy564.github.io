"""Export the odor MPNN with its intermediate results, for the "How it predicts" page.

Same checkpoint (checkpoints/odor_mpnn.pt) and the same operations as export_onnx_mpnn.py;
the graph only exposes values the forward pass already computes:
  probs [B,138]                       first output, unchanged name (the tool page reads only this)
  h0 h1 h2 h3 [B,64,256]              atom states after the input embedding and after layers 1-3
  m1 m2 m3 [B,64,256]                 sum of the messages each atom receives in layers 1-3
  pool_mean pool_max [B,256]          readout (mean over real atoms, max over real atoms)

  python export_process_onnx.py          -> training/data/mpnn/odor_mpnn_process.onnx (site untouched)
  python export_process_onnx.py --site   -> replaces odor-predictor/model/odor_mpnn.onnx

Gate before the site file may be replaced (plan step 0): probs of the new file equal the
current site file bit for bit on every molecule of tests/features_all.json and the test set.
Checks: every output vs PyTorch on the 488 test molecules, batch-1 run, padding rows are 0,
receptive field (one atom changed / one bond changed) on decane.
"""
from pathlib import Path

import json
import shutil
import sys

import numpy as np
import onnxruntime as ort
import torch
from torch import nn

from evaluate import load_split
from export_onnx_mpnn import SITE_ONNX, load_model
from featurize import SPEC_PATH
from featurize_mpnn import featurize, featurize_many

HERE = Path(__file__).parent
OUT = HERE / "data" / "mpnn" / "odor_mpnn_process.onnx"
FEATURES_ALL = HERE.parent / "odor-predictor" / "tests" / "features_all.json"
NAMES = ["probs", "h0", "h1", "h2", "h3", "m1", "m2", "m3", "pool_mean", "pool_max"]


class WithLayers(nn.Module):
    """OdorMPNN forward written out (same ops as model_mpnn.OdorMPNN in eval mode), all values returned."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, X, E, mask):
        mdl = self.model
        m = mask.unsqueeze(-1)
        adj = (E.sum(dim=-1, keepdim=True) > 0).to(X.dtype)
        H = torch.relu(mdl.embed(X)) * m
        hs, ms = [H], []
        for node, bond, upd in zip(mdl.msg_node, mdl.msg_bond, mdl.updates):
            msg = torch.relu(node(H).unsqueeze(1) + bond(E)) * adj
            M = msg.sum(dim=2)
            H = upd(H, M) * m
            hs.append(H)
            ms.append(M)
        pooled = mdl.readout(H, mask)
        probs = torch.sigmoid(mdl.head(pooled))
        hidden = H.shape[-1]
        return (probs, *hs, *ms, pooled[:, :hidden], pooled[:, hidden:])


def run(sess, X, E, M, batch=64):
    outs = [sess.run(None, {"X": X[i:i + batch], "E": E[i:i + batch], "mask": M[i:i + batch]})
            for i in range(0, len(X), batch)]
    return [np.concatenate([o[k] for o in outs]) for k in range(len(outs[0]))]


def receptive_field(sess):
    """Decane: changing atom 0 (C -> N) changes, after layer t, only atoms within t bonds;
    changing only bond 4-5 (single -> double, atom features kept) changes after layer t only atoms
    within t - 1 bonds of atom 4 or 5. Exact zeros elsewhere."""
    X, E, M = featurize("CCCCCCCCCC")
    Xn, _, _ = featurize("NCCCCCCCCC")
    E2 = E.copy()
    E2[4, 5] = E2[5, 4] = np.array([0, 1, 0, 0, 0, 0], np.float32)
    base = sess.run(None, {"X": X[None], "E": E[None], "mask": M[None]})
    atom = sess.run(None, {"X": Xn[None], "E": E[None], "mask": M[None]})
    bond = sess.run(None, {"X": X[None], "E": E2[None], "mask": M[None]})
    res = {"atom": [], "bond": []}
    for t in range(4):
        k = NAMES.index(f"h{t}")
        res["atom"].append([i for i in range(10) if np.abs(atom[k][0, i] - base[k][0, i]).max() > 0])
        res["bond"].append([i for i in range(10) if np.abs(bond[k][0, i] - base[k][0, i]).max() > 0])
    assert res["atom"] == [list(range(t + 1)) for t in range(4)], res["atom"]
    assert res["bond"] == [[], [4, 5], [3, 4, 5, 6], [2, 3, 4, 5, 6, 7]], res["bond"]
    return res


def main(site=False):
    model, ck = load_model()
    full = WithLayers(model.model).eval()
    smiles, _, _, split, _ = load_split()
    test = [s for s, sp in zip(smiles, split) if sp == "test"]
    X, E, M = featurize_many(test)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        full, tuple(torch.from_numpy(a[:2]) for a in (X, E, M)), str(OUT), opset_version=17, dynamo=False,
        input_names=["X", "E", "mask"], output_names=NAMES,
        dynamic_axes={**{k: {0: "batch"} for k in ["X", "E", "mask"] + NAMES}},
    )
    size_new, size_old = OUT.stat().st_size, SITE_ONNX.stat().st_size
    print(f"Wrote {OUT} ({size_new} bytes; site file {size_old} bytes, +{size_new - size_old})")

    sess = ort.InferenceSession(str(OUT), providers=["CPUExecutionProvider"])
    old = ort.InferenceSession(str(SITE_ONNX), providers=["CPUExecutionProvider"])
    assert [o.name for o in sess.get_outputs()] == NAMES

    # 1. every output vs PyTorch, test set
    with torch.no_grad():
        ref = [t.numpy() for t in full(*(torch.from_numpy(a) for a in (X, E, M)))]
        ref_probs = model(*(torch.from_numpy(a) for a in (X, E, M))).numpy()
    assert np.array_equal(ref[0], ref_probs) or np.abs(ref[0] - ref_probs).max() < 1e-6
    out = run(sess, X, E, M)
    report = {"test_molecules": len(X)}
    for name, a, b in zip(NAMES, out, ref):
        d = np.abs(a - b)
        rel = float((d / np.maximum(1.0, np.abs(b))).max())
        report[name] = {"max_abs": float(d.max()), "max_rel_ge1": rel}
        assert rel < 1e-4, (name, rel)
    single = sess.run(None, {"X": X[:1], "E": E[:1], "mask": M[:1]})
    report["batch1_max_abs"] = max(float(np.abs(s - o[:1]).max()) for s, o in zip(single, out))
    n0 = int(M[0].sum())
    report["padding_rows_zero"] = all(float(np.abs(single[NAMES.index(k)][0, n0:]).max()) == 0.0
                                      for k in ["h0", "h1", "h2", "h3", "m1", "m2", "m3"])
    assert report["padding_rows_zero"]

    # 2. gate: probs equal to the current site file, bit for bit
    lib = [s for s, _, _ in json.loads(FEATURES_ALL.read_text(encoding="utf-8"))["molecules"]]
    ok, refused = [], 0
    for s in dict.fromkeys(lib + test):
        try:
            featurize(s)
            ok.append(s)
        except ValueError:
            refused += 1
    Xa, Ea, Ma = featurize_many(ok)
    p_new = run(sess, Xa, Ea, Ma)[0]
    p_old = np.concatenate([old.run(None, {"X": Xa[i:i + 64], "E": Ea[i:i + 64], "mask": Ma[i:i + 64]})[0]
                            for i in range(0, len(Xa), 64)])
    p1_new = np.concatenate([sess.run(["probs"], {"X": Xa[i:i + 1], "E": Ea[i:i + 1], "mask": Ma[i:i + 1]})[0]
                             for i in range(len(Xa))])
    p1_old = np.concatenate([old.run(None, {"X": Xa[i:i + 1], "E": Ea[i:i + 1], "mask": Ma[i:i + 1]})[0]
                             for i in range(len(Xa))])
    report["gate"] = {"molecules": len(ok), "not_featurizable": refused,
                      "batch64_identical": bool(np.array_equal(p_new, p_old)),
                      "batch64_max_abs": float(np.abs(p_new - p_old).max()),
                      "batch1_identical": bool(np.array_equal(p1_new, p1_old)),
                      "batch1_max_abs": float(np.abs(p1_new - p1_old).max())}

    # 3. receptive field
    report["receptive_field"] = receptive_field(sess)
    print(json.dumps(report, indent=1))

    if site:
        g = report["gate"]
        assert g["batch64_identical"] and g["batch1_identical"], "gate failed: site file not replaced"
        shutil.copyfile(OUT, SITE_ONNX)
        print(f"Replaced {SITE_ONNX}")
        spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
        spec["extra_outputs"] = {
            "names": NAMES[1:],
            "note": "for the How it predicts page (process.html); the tool page fetches only probs. "
                    "h0-h3 [B,64,H] atom states after embedding and layers 1-3, m1-m3 [B,64,H] message sums, "
                    "pool_mean/pool_max [B,H]. Written by training/export_process_onnx.py"}
        SPEC_PATH.write_text(json.dumps(spec, indent=2), encoding="utf-8")
        print(f"Updated {SPEC_PATH}")
    return report


if __name__ == "__main__":
    main(site="--site" in sys.argv)
