"""Display parameters, precomputed molecules and layer parity fixtures for the "How it predicts" page
(odor-predictor/process.html). Run after `export_process_onnx.py --site`.

All model values come from odor-predictor/model/odor_mpnn.onnx (the same file the tool page uses).

odor-predictor/data/process_display.json (display only, no model values are changed):
  scale.h        darkest colour of the atom states h0-h3: 99th percentile of all real-atom values of
                 h3 over the training set (zeros included). One scale for all four layers because the
                 residual update never lowers a value (h_t >= h_(t-1) element by element).
  scale.m        same for the message sums m1-m3 (all three layers pooled)
  scale.pool_mean / pool_max   99th percentile of the pooled values over training molecules
  scale.bond     largest |value| of the bond terms (diverging colours, bond terms can be negative)
  mapping        "sqrt": colour depth = sqrt(min(v / scale, 1))
  order          column order of the 256 channels, shared by every layer (a channel is the same
                 channel in every layer because of the residual update): average-linkage clustering
                 on correlation distance (1 - r) of h3 over training atoms, optimal leaf ordering
  bond_terms     for each layer t and each bond class that occurs in the data, the bond part of the
                 message V_t e + b_t (before the ReLU), from the model weights
odor-predictor/data/process/<id>.json: the 10 tool presets + methanethiol: inputs (X rows, bonds,
  2D coordinates from RDKit CoordGen), h0-h3, m1-m3, pools, top 8 (4 decimals).
odor-predictor/tests/parity_layers.bin + parity_layers.json: Python (PyTorch) reference of every
  output for the same 50 test molecules as tests/parity_fixtures.json (seed 0), float32, real atoms only.

Checks (assertions): receptive field on decane (atom change and bond-only change), top 8 of every
preset file equal presets.json, the 50 molecules equal the first 50 of parity_fixtures.json.
"""
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from rdkit import Chem
from rdkit.Chem import rdDepictor
from scipy.cluster.hierarchy import leaves_list, linkage, optimal_leaf_ordering
from scipy.spatial.distance import squareform

from evaluate import load_split
from export_onnx_mpnn import load_model
from export_process_onnx import NAMES, WithLayers, receptive_field, run
from featurize_mpnn import featurize, featurize_many

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "odor-predictor"
TOP_K = 8          # as odor-predictor/app.js
N_PARITY, SEED = 50, 0   # as make_site_assets.py
STATES = ["h0", "h1", "h2", "h3"]
MSGS = ["m1", "m2", "m3"]
BOND_NAMES = ["single", "double", "triple", "aromatic", "other"]
EXTRA = [("methanethiol", "Methanethiol", "甲硫醇", "CS")]


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e3:.1f} kB)")


def column_order(V):
    """V [atoms, 256] -> display order of the channels (always-zero channels last)."""
    live = np.flatnonzero(V.max(axis=0) > 0)
    dead = np.flatnonzero(V.max(axis=0) == 0)
    D = np.clip(1.0 - np.corrcoef(V[:, live].T), 0.0, 2.0)
    np.fill_diagonal(D, 0.0)
    cond = squareform((D + D.T) / 2, checks=False)
    Z = optimal_leaf_ordering(linkage(cond, method="average"), cond)
    return [int(i) for i in live[leaves_list(Z)]] + [int(i) for i in dead]


def bond_class(v):
    t = int(np.argmax(v[:5]))
    return f"{BOND_NAMES[t]}_{'ring' if v[5] else 'chain'}"


def main():
    sess = ort.InferenceSession(str(SITE / "model" / "odor_mpnn.onnx"), providers=["CPUExecutionProvider"])
    assert [o.name for o in sess.get_outputs()] == NAMES, "run export_process_onnx.py --site first"
    rf = receptive_field(sess)
    print("receptive field ok:", rf)
    labels = [l["id"] for l in json.loads((SITE / "model" / "labels.json").read_text(encoding="utf-8"))]
    r4 = lambda a: np.round(np.asarray(a, np.float64), 4).tolist()

    # ---- display parameters (training set) ----
    smiles, _, _, split, _ = load_split()
    train = [s for s, sp in zip(smiles, split) if sp == "train"]
    X, E, M = featurize_many(train)
    out = dict(zip(NAMES, run(sess, X, E, M)))
    real = M.astype(bool)
    h3 = out["h3"][real]
    mvals = np.concatenate([out[k][real].ravel() for k in MSGS])
    scale = {"h": float(np.percentile(h3, 99)), "m": float(np.percentile(mvals, 99)),
             "pool_mean": float(np.percentile(out["pool_mean"], 99)),
             "pool_max": float(np.percentile(out["pool_max"], 99))}
    per_layer = {k: round(float(np.percentile(out[k][real], 99)), 4) for k in STATES + MSGS}
    order = column_order(h3)
    zero_share = {k: round(float((out[k][real] == 0).mean()), 3) for k in STATES}
    monotone = all(float((out[STATES[t]][real] - out[STATES[t - 1]][real]).min()) >= 0 for t in range(1, 4))
    assert monotone

    classes = sorted({bond_class(E[b, i, j]) for b, i, j in zip(*np.nonzero(E.sum(-1) > 0))})
    model = load_model()[0].model
    bond_terms = {}
    with torch.no_grad():
        for t, lin in enumerate(model.msg_bond, start=1):
            bond_terms[f"layer{t}"] = {}
            for c in classes:
                typ, where = c.split("_")
                e = np.zeros(6, np.float32)
                e[BOND_NAMES.index(typ)] = 1
                e[5] = float(where == "ring")
                bond_terms[f"layer{t}"][c] = r4(lin(torch.from_numpy(e)).numpy())
    scale["bond"] = float(max(abs(v) for d in bond_terms.values() for vec in d.values() for v in vec))
    write_json(SITE / "data" / "process_display.json", {
        "note": "Display only (colour scale, column order); model values are unchanged. "
                "Written by training/process_site_data.py",
        "train_molecules": len(train), "train_atoms": int(real.sum()),
        "mapping": "sqrt", "scale": {k: round(v, 4) for k, v in scale.items()},
        "p99_per_layer": per_layer, "zero_share": zero_share, "order": order,
        "bond_classes": classes, "bond_terms": bond_terms, "receptive_field_check": rf})
    print("scale", scale, "\nper-layer p99", per_layer, "\nzero share", zero_share, "\nbond classes", classes)

    # ---- precomputed molecules: the tool presets + methanethiol ----
    presets = json.loads((SITE / "data" / "presets.json").read_text(encoding="utf-8"))
    mols = [(p["id"], p["name_en"], p["name_zh"], p["smiles"]) for p in presets] + EXTRA
    rdDepictor.SetPreferCoordGen(True)
    index = []
    for pid, en, zh, smi in mols:
        mol = Chem.MolFromSmiles(smi)
        rdDepictor.Compute2DCoords(mol)
        conf = mol.GetConformer()
        x, e, m = featurize(smi)
        o = dict(zip(NAMES, sess.run(None, {"X": x[None], "E": e[None], "mask": m[None]})))
        n = mol.GetNumAtoms()
        p = o["probs"][0]
        top = np.argsort(-p, kind="stable")[:TOP_K]
        rec = {
            "id": pid, "name_en": en, "name_zh": zh, "smiles": smi, "n": n,
            "X": x[:n].astype(int).tolist(),
            "bonds": [[b.GetBeginAtomIdx(), b.GetEndAtomIdx(),
                       e[b.GetBeginAtomIdx(), b.GetEndAtomIdx()].astype(int).tolist()] for b in mol.GetBonds()],
            "coords": [[round(conf.GetAtomPosition(i).x, 3), round(conf.GetAtomPosition(i).y, 3)] for i in range(n)],
            **{k: r4(o[k][0, :n]) for k in STATES + MSGS},
            "pool_mean": r4(o["pool_mean"][0]), "pool_max": r4(o["pool_max"][0]),
            "top": [{"label": labels[j], "prob": round(float(p[j]), 4)} for j in top],
        }
        write_json(SITE / "data" / "process" / f"{pid}.json", rec)
        index.append({"id": pid, "smiles": smi, "name_en": en, "name_zh": zh})
        q = next((q for q in presets if q["smiles"] == smi), None)
        if q is not None:
            same = [(a["label"], a["prob"]) for a in rec["top"]] == [(b["label"], b["prob"]) for b in q["top"]]
            print(f"  {pid:22s} {n:2d} atoms  top-8 vs presets.json: {'same' if same else 'DIFFERENT'}")
            assert same, (rec["top"], q["top"])
    write_json(SITE / "data" / "process" / "index.json", index)

    # ---- browser parity fixtures (PyTorch reference, same 50 molecules as parity_fixtures.json) ----
    test_idx = np.flatnonzero(split == "test")
    pick = [smiles[i] for i in np.random.default_rng(SEED).choice(test_idx, size=N_PARITY, replace=False)]
    old = json.loads((SITE / "tests" / "parity_fixtures.json").read_text(encoding="utf-8"))["molecules"]
    assert pick == [q["smiles"] for q in old[:N_PARITY]]
    Xp, Ep, Mp = featurize_many(pick)
    full = WithLayers(model).eval()
    with torch.no_grad():
        ref = dict(zip(NAMES, (t.numpy() for t in full(*(torch.from_numpy(a) for a in (Xp, Ep, Mp))))))
    chunks, entries = [], []
    for k, s in enumerate(pick):
        n = int(Mp[k].sum())
        entries.append({"smiles": s, "n": n})
        for name in STATES + MSGS:
            chunks.append(ref[name][k, :n].ravel())
        for name in ["pool_mean", "pool_max", "probs"]:
            chunks.append(ref[name][k].ravel())
    blob = np.concatenate(chunks).astype("<f4")
    (SITE / "tests" / "parity_layers.bin").write_bytes(blob.tobytes())
    print(f"Wrote odor-predictor/tests/parity_layers.bin ({blob.nbytes / 1e6:.2f} MB)")
    write_json(SITE / "tests" / "parity_layers.json", {
        "note": "PyTorch reference (training/process_site_data.py). Per molecule, in this order, float32 "
                "little-endian: h0 h1 h2 h3 m1 m2 m3 ([n,256] each, real atoms), pool_mean pool_max [256], probs [138]",
        "hidden": 256, "num_labels": len(labels),
        "tolerance": "abs diff <= 1e-4 * max(1, |reference|)", "molecules": entries})


if __name__ == "__main__":
    main()
