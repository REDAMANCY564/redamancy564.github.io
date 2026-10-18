"""Site data of odor-map (PLAN-odor-map.md, stage 3).

Molecules, names, groups and predicted probabilities are not duplicated: the page reads
ingredient-finder/data/library.json and probs.bin (same library and order, checked here).

Writes odor-map/data/:
  coords.bin  uint16 [2 maps, n, 2]: odor map then structure map, each scaled into [0, 65535]
              with its aspect ratio kept (centred on the shorter axis)
  map.json    map parameters and the selection method, evaluation (from build_maps.py), region
              labels of both maps, colour categories (most frequent top-1 descriptors)
  foods.json  foods for highlighting, loaded when first used (flavor knowledge base: Dunkel key
              odorants and FlavorDB detected compounds), library indices

Region labels (descriptor enrichment, the same rule for both maps):
  k-means (k = 40, seed 0) on the 2-D coordinates; for each cluster with >= 30 molecules and each
  descriptor j: share = fraction of the cluster with predicted probability of j >= 0.5,
  lift = share / share in the whole library. The cluster is labelled with the descriptor of the
  highest share among those with share >= 0.5 and lift >= 1.5; clusters without one get no label.
  Neighbouring labelled clusters with the same descriptor (centroid distance < 0.12 of the map
  width) are merged into one label at their size-weighted centroid.
"""
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.cluster import KMeans

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "training" / "data"
SITE = ROOT / "odor-map" / "data"
FINDER = ROOT / "ingredient-finder" / "data"
K_CLUSTERS, MIN_SIZE, P_ON, MIN_SHARE, MIN_LIFT, MERGE_DIST = 40, 30, 0.5, 0.5, 1.5, 0.12
N_COLORS = 10   # most frequent top-1 descriptors with their own colour; the rest are "other"


def scale(xy):
    lo, hi = xy.min(0), xy.max(0)
    span = (hi - lo).max()
    out = (xy - lo) / span
    out += (1 - (hi - lo) / span) / 2          # centre the shorter axis
    return out


def regions(xy, on, labels):
    km = KMeans(n_clusters=K_CLUSTERS, random_state=0, n_init=10).fit(xy)
    g = on.mean(0)
    found = []
    for c in range(K_CLUSTERS):
        idx = np.where(km.labels_ == c)[0]
        if len(idx) < MIN_SIZE:
            continue
        share = on[idx].mean(0)
        lift = share / np.maximum(g, 1e-9)
        ok = np.where((share >= MIN_SHARE) & (lift >= MIN_LIFT))[0]
        if not len(ok):
            continue
        j = ok[np.argmax(share[ok])]
        found.append({"label": labels[j]["id"], "x": xy[idx, 0].mean(), "y": xy[idx, 1].mean(), "n": len(idx),
                      "share": float(share[j]), "lift": float(lift[j])})
    # merge neighbouring clusters with the same descriptor (single linkage)
    merged, used = [], set()
    for a in range(len(found)):
        if a in used:
            continue
        group, stack = [a], [a]
        used.add(a)
        while stack:
            u = stack.pop()
            for b in range(len(found)):
                if b not in used and found[b]["label"] == found[u]["label"] and \
                        np.hypot(found[b]["x"] - found[u]["x"], found[b]["y"] - found[u]["y"]) < MERGE_DIST:
                    used.add(b)
                    group.append(b)
                    stack.append(b)
        n = sum(found[k]["n"] for k in group)
        merged.append({"label": found[a]["label"],
                       "x": round(sum(found[k]["x"] * found[k]["n"] for k in group) / n, 4),
                       "y": round(sum(found[k]["y"] * found[k]["n"] for k in group) / n, 4),
                       "n": n, "clusters": len(group),
                       "share": round(sum(found[k]["share"] * found[k]["n"] for k in group) / n, 3),
                       "lift": round(sum(found[k]["lift"] * found[k]["n"] for k in group) / n, 2)})
    return sorted(merged, key=lambda r: -r["n"])


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    SITE.mkdir(parents=True, exist_ok=True)
    lib_train = json.loads((DATA / "ingredient" / "library.json").read_text(encoding="utf-8"))["molecules"]
    site_lib = json.loads((FINDER / "library.json").read_text(encoding="utf-8"))
    assert [r["smiles"] for r in lib_train] == [m[0] for m in site_lib["molecules"]], "library order differs"
    n, labels = site_lib["n"], site_lib["labels"]
    P = np.frombuffer((FINDER / "probs.bin").read_bytes(), np.uint8).reshape(n, len(labels)) / 255
    maps = np.load(DATA / "odormap" / "maps.npz")
    ev = json.loads((DATA / "odormap" / "eval.json").read_text(encoding="utf-8"))

    xy = {k: scale(maps[k].astype(np.float64)) for k in ("odor", "structure")}
    q = np.stack([np.round(xy[k] * 65535) for k in ("odor", "structure")]).astype("<u2")
    (SITE / "coords.bin").write_bytes(q.tobytes())

    on = P >= P_ON
    reg = {k: regions(xy[k], on, labels) for k in xy}
    top1 = Counter(P.argmax(1).tolist())
    colours = [labels[j]["id"] for j, _ in top1.most_common() if labels[j]["id"] != "odorless"][:N_COLORS]

    # foods: knowledge-base foods with at least one library molecule
    kb_foods = json.loads((ROOT / "flavor-kb" / "data" / "foods.json").read_text(encoding="utf-8"))
    by_kb = {}
    for i, m in enumerate(site_lib["molecules"]):
        if m[3]:
            by_kb.setdefault(m[3], []).append(i)
    foods = []
    for fid, f in kb_foods.items():
        key = sorted({i for c in f.get("kfo", []) for i in by_kb.get(c, [])})
        det = sorted({i for c in f.get("det", []) for i in by_kb.get(c, [])} - set(key))
        n_kb = len(f.get("kfo", [])) if f["src"] == "dunkel" else len(f.get("det", []))
        if key or det:
            foods.append({"id": fid, "name": f["name"], "src": f["src"], "key": key, "det": det, "n_kb": n_kb})
    foods.sort(key=lambda f: (f["src"] != "dunkel", f["name"].lower()))

    out = {
        "n": n,
        "coords": "coords.bin: uint16 [2, n, 2], maps in the order of 'maps', scaled to [0, 65535]",
        "maps": ["odor", "structure"],
        "params": ev["params"],
        "seed": ev["seed"],
        "k": ev["k"],
        "eval": {"valid": ev["valid"], "test": ev["test"], "supplementary_top1_agreement": ev["supplementary_top1_agreement"]},
        "regions": reg,
        "region_rule": {"k_clusters": K_CLUSTERS, "min_size": MIN_SIZE, "p_on": P_ON, "min_share": MIN_SHARE,
                        "min_lift": MIN_LIFT, "merge_dist": MERGE_DIST},
        "colours": colours,
        "top1_counts": {labels[j]["id"]: c for j, c in top1.most_common()},
    }
    (SITE / "map.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (SITE / "foods.json").write_text(json.dumps(foods, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    zh = {l["id"]: l["zh"] for l in labels}
    for k in reg:
        print(f"{k}: {len(reg[k])} labels")
        for r in reg[k]:
            print(f"  {r['label']:12s} {zh[r['label']]:6s} n={r['n']:4d} clusters={r['clusters']} share={r['share']} lift={r['lift']}  ({r['x']:.2f}, {r['y']:.2f})")
    print("colours:", colours)
    print("foods:", len(foods), "dunkel:", sum(f["src"] == "dunkel" for f in foods),
          "dunkel key molecules in library:", {f["name"]: len(f["key"]) for f in foods if f["src"] == "dunkel"})
    for p in SITE.iterdir():
        print(p.name, p.stat().st_size)


if __name__ == "__main__":
    main()
