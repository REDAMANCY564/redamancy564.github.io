"""Site data of ingredient-finder (PLAN-ingredient-finder.md), from stages 1 to 3.

Writes ingredient-finder/data/:
  library.json   molecules [smiles, name, group, kb id, food indices], group 0 = used in training,
                 1 = validation, 2 = test, 3 = knowledge base only; food names; odor labels;
                 the odor-similarity threshold; sources
  probs.bin      uint8 [n, 138]: predicted probability x 255 (odor model of odor-predictor, the online
                 odor_gnn.onnx); the odor embedding of mode B is this vector (chosen on validation)
  fps.bin        Morgan fingerprints (radius 2, 2048 bits) as on-bit lists:
                 uint32 offsets [n + 1] then uint16 bit indices
  presets.json   mode A presets (user-approved descriptors and weights); mode B presets (library index)
  metrics.json   evaluation summary for the page's results section (stage 3, test split reported once)
tests/fixtures.json: Python references for the JS unit tests (same uint8 data as the page): mode A
scores, mode B neighbours of the presets, and 100 molecules for the RDKit.js fingerprint and the
browser model (odor-predictor engine) parity checks.
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "training" / "data" / "ingredient"
SITE = ROOT / "ingredient-finder"
GROUP = {"train": 0, "valid": 1, "test": 2, "kb": 3}
WEIGHTS = {"high": 1.0, "mid": 0.5, "low": 0.25}
PRESETS_A = [
    {"id": "creamy_buttery_sweet", "want": [["creamy", "high"], ["buttery", "high"], ["sweet", "high"]]},
    {"id": "coconut_creamy", "want": [["coconut", "high"], ["creamy", "high"]]},
    {"id": "caramellic_nutty", "want": [["caramellic", "high"], ["nutty", "high"]]},
    {"id": "milky_fatty", "want": [["milky", "high"], ["fatty", "high"]]},
    {"id": "fruity_green", "want": [["fruity", "high"], ["green", "high"]]},
]


# user-approved substitute examples (backgrounds and sources are in the page's i18n files)
PRESETS_B = [{"id": "diacetyl", "smiles": "CC(=O)C(C)=O"}, {"id": "coumarin", "smiles": "O=c1ccc2ccccc2o1"},
             {"id": "vanillin", "smiles": "COc1cc(C=O)ccc1O"}]


def canon(smi):
    from rdkit import Chem
    return Chem.MolToSmiles(Chem.MolFromSmiles(smi))


def neighbours(P, bits, q, thr, top_n=20, tan_max=0.3):
    """Mode B for library molecule q: top_n by cosine of probability vectors (q excluded)."""
    Pn = P / np.linalg.norm(P, axis=1, keepdims=True)
    sim = Pn @ Pn[q]
    sim[q] = -np.inf
    order = np.argsort(-sim, kind="stable")[:top_n]
    inter = bits[order] @ bits[q]
    tan = inter / (bits[order].sum(1) + bits[q].sum() - inter)
    return order, sim[order], tan, (sim[order] >= thr) & (tan < tan_max)


def score(P, labels, want, avoid=()):
    s = np.zeros(len(P))
    for lab, w in want:
        s += WEIGHTS[w] * P[:, labels.index(lab)]
    for lab, w in avoid:
        s -= WEIGHTS[w] * P[:, labels.index(lab)]
    return s


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    lib = json.loads((DATA / "library.json").read_text(encoding="utf-8"))["molecules"]
    f = np.load(DATA / "features.npz")
    ev = json.loads((DATA / "eval.json").read_text(encoding="utf-8"))
    labels_full = json.loads((ROOT / "odor-predictor" / "model" / "labels.json").read_text(encoding="utf-8"))
    labels = [l["id"] for l in labels_full]
    kb_foods = json.loads((ROOT / "flavor-kb" / "data" / "foods.json").read_text(encoding="utf-8"))
    (SITE / "data").mkdir(parents=True, exist_ok=True)
    (SITE / "tests").mkdir(parents=True, exist_ok=True)

    # foods actually referenced, by first appearance
    food_ids = []
    seen = {}
    for r in lib:
        for fid in r.get("foods", []):
            if fid not in seen and fid in kb_foods:
                seen[fid] = len(food_ids)
                food_ids.append(fid)
    mols = [[r["smiles"], r["name"] or "", GROUP[r["split"]], r["kb"] or "",
             [seen[x] for x in r.get("foods", []) if x in seen]] for r in lib]

    library = {
        "version": ev.get("built", ""),
        "n": len(mols),
        "fields": ["smiles", "name", "group", "kb", "foods"],
        "groups": ["train", "valid", "test", "kb"],
        "molecules": mols,
        "foods": [kb_foods[x]["name"] for x in food_ids],
        "labels": [{"id": l["id"], "en": l["en"], "zh": l["zh"]} for l in labels_full],
        "excluded": [{k: e[k] for k in ("name", "smiles", "category", "reason")} for e in
                     json.loads((DATA / "library.json").read_text(encoding="utf-8"))["excluded"]],
        "odor_threshold": ev["threshold"]["value"],
        "odor_threshold_rule": ev["threshold"]["rule"],
        "tanimoto_max_for_highlight": 0.3,
        "highlight_top_n": 20,
        "sources": {
            "molecules": "odor-predictor dataset (OpenPOM curated GoodScents + Leffingwell; labels not redistributed) "
                         "and the flavor knowledge base of this site",
            "names": "flavor knowledge base, else PubChem title (by InChIKey)",
            "foods": "FlavorDB2 via the flavor knowledge base (CC BY-NC-SA 3.0)",
            "predictions": "odor-predictor GNN (odor_gnn.onnx), training split only",
        },
    }
    (SITE / "data" / "library.json").write_text(json.dumps(library, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    q = np.round(f["probs"] * 255).astype(np.uint8)
    (SITE / "data" / "probs.bin").write_bytes(q.tobytes())
    bits = np.unpackbits(f["fps"], axis=1)
    on = [np.nonzero(b)[0].astype(np.uint16) for b in bits]
    offsets = np.concatenate([[0], np.cumsum([len(x) for x in on])]).astype(np.uint32)
    (SITE / "data" / "fps.bin").write_bytes(offsets.tobytes() + np.concatenate(on).tobytes())

    index_of = {r["smiles"]: i for i, r in enumerate(lib)}
    presets_b = [{"id": p["id"], "index": index_of[canon(p["smiles"])]} for p in PRESETS_B]
    (SITE / "data" / "presets.json").write_text(json.dumps({"weights": WEIGHTS, "mode_a": PRESETS_A, "mode_b": presets_b}, indent=1), encoding="utf-8")

    metrics = {k: ev[k] for k in ("k", "validation_selection", "chosen_embedding", "threshold", "mode_b_test",
                                  "mode_a_presets_test")}
    metrics["mode_a_test"] = {k: v for k, v in ev["mode_a_test"].items() if k != "per_label"}
    (SITE / "data" / "metrics.json").write_text(json.dumps(metrics, indent=1), encoding="utf-8")

    # JS unit test fixtures: scores on the page's uint8 data
    P = q.astype(np.float64) / 255
    fx = []
    for p in PRESETS_A:
        s = score(P, labels, p["want"])
        top = np.argsort(-s, kind="stable")[:20]
        fx.append({"preset": p["id"], "want": p["want"], "avoid": [], "top": top.tolist(), "scores": s[top].round(6).tolist()})
    s = score(P, labels, [["creamy", "high"], ["coconut", "mid"]], [["fruity", "low"]])
    top = np.argsort(-s, kind="stable")[:20]
    fx.append({"preset": "custom_with_avoid", "want": [["creamy", "high"], ["coconut", "mid"]], "avoid": [["fruity", "low"]],
               "top": top.tolist(), "scores": s[top].round(6).tolist()})
    fb = []
    bits_f = bits.astype(np.float64)
    for p in presets_b:
        order, sim, tan, hi = neighbours(P, bits_f, p["index"], library["odor_threshold"])
        fb.append({"preset": p["id"], "query": p["index"], "top": order.tolist(), "odor": sim.round(6).tolist(),
                   "tanimoto": tan.round(6).tolist(), "highlight": hi.tolist()})
    rng = np.random.default_rng(1)
    sample = sorted(rng.choice(len(lib), 100, replace=False).tolist())
    parity = [{"index": i, "smiles": lib[i]["smiles"], "on_bits": np.nonzero(bits[i])[0].tolist(),
               "probs": f["probs"][i].round(7).tolist()} for i in sample]
    (SITE / "tests" / "fixtures.json").write_text(json.dumps({"mode_a": fx, "mode_b": fb, "parity": parity}), encoding="utf-8")

    for fn in ("library.json", "probs.bin", "fps.bin", "presets.json", "metrics.json"):
        print(f"{fn:14s} {(SITE / 'data' / fn).stat().st_size / 1e6:.3f} MB")
    print("foods:", len(food_ids), "| threshold:", library["odor_threshold"])


if __name__ == "__main__":
    main()
