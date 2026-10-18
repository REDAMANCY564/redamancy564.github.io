"""Stage 2 of PLAN-mixture.md: Snitz et al. 2013 mixture similarity data (CC BY 4.0).

Snitz K, Yablonka A, Weiss T, Frumin I, Khan RM, Sobel N. Predicting odor perceptual similarity from odor
structure. PLoS Comput Biol 2013, 9(9): e1003184. doi:10.1371/journal.pcbi.1003184

Inputs (downloaded from the article's Supporting Information, training/data/mixture/, not committed):
  snitz_s003   Table S2 (PDF): average similarity ratings (0-100) per comparison and mixture CIDs
  snitz_s002   Table S1 (CSV, CR line ends): 1,433 Dragon descriptors for 1,358 odorants
  pyrfume_experiment{1,2}_cids.csv  mixture number -> CIDs (Pyrfume's parse of Table S2, checked against it)
Structures: PubChem (CID -> SMILES, cached in pubchem.json). Odor vectors: the online odor-predictor
model (odor_gnn.onnx) on the standardized structure, 138 predicted probabilities, as in ingredient-finder.

Output: training/data/mixture/snitz.json
  molecules {cid: {smiles, probs[138]}}, mixtures {"d1:5": [cids]}, pairs [{dataset, a, b, similarity}]
  (dataset 3 compares single molecules: mixtures "d3:<cid>")
"""
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pymupdf

HERE = Path(__file__).resolve().parent
TRAINING = HERE.parent
ROOT = TRAINING.parent
DATA = TRAINING / "data" / "mixture"
sys.path.insert(0, str(TRAINING))
from clean_data import standardize  # noqa: E402
from featurize import featurize_many  # noqa: E402

# Dataset 1, mixture 11: Table S2 prints only the last line of its list (12 CIDs without the opening
# bracket, under mixture 10's 30-CID list); by the design (mixtures 9, 10, 11 = 20, 30, 40 components)
# it should have 40. Its composition is unknown, so the mixture and its comparisons are dropped.
TRUNCATED = {"1": {11}}

# page ranges of Table S2 (0-based): comparisons and mixture definitions
SECTIONS = {"d1": {"pairs": range(0, 4), "mix": range(4, 7)}, "d2": {"pairs": range(7, 9), "mix": range(9, 10)},
            "d3": {"pairs": range(10, 12)}}


def page_text(doc, pages):
    out = []
    for p in pages:
        t = doc[p].get_text()
        out.append(re.sub(r"^Dataset #\d\nPage \d+\n", "", t))
    return "\n".join(out)


def parse_pairs(text):
    """Rows of 4 numbers: comparison no., a, b, average similarity."""
    nums = re.findall(r"-?\d+(?:\.\d+)?", text[text.index("similarity") + len("similarity"):])
    assert len(nums) % 4 == 0, len(nums)
    rows = [nums[i:i + 4] for i in range(0, len(nums), 4)]
    for k, r in enumerate(rows, 1):
        assert int(r[0]) == k, (k, r)
    return [(int(r[1]), int(r[2]), float(r[3])) for r in rows]


def parse_mixtures(doc, pages, pyrfume_csv):
    """Mixture number -> CIDs. The PDF does not keep the table's reading order (long lists are emitted after
    the short ones), so the number -> list mapping comes from Pyrfume's parse of this same table
    (github.com/pyrfume/pyrfume-data, snitz_2013, MIT; the data themselves are CC BY from the article) and is
    checked here: the multiset of CID lists must equal the lists found in the PDF."""
    import csv
    with open(pyrfume_csv, encoding="utf-8") as f:
        rows = list(csv.reader(f))[1:]
    out = {int(r[0]): [int(x) for x in r[1].strip("[] ").split()] for r in rows}
    text = page_text(doc, pages)
    pdf_lists = sorted(tuple(sorted(int(x) for x in m[1:-1].split())) for m in re.findall(r"\[[^\]]*\]", text))
    bad = TRUNCATED.get(pyrfume_csv.name[len("pyrfume_experiment")], set())
    assert pdf_lists == sorted(tuple(sorted(v)) for k, v in out.items() if k not in bad), "Pyrfume mixture lists differ from the PDF"
    return {k: v for k, v in out.items() if k not in bad}


def pubchem_smiles(cids, cache_path):
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    todo = [c for c in cids if str(c) not in cache]
    for k in range(0, len(todo), 100):
        chunk = todo[k:k + 100]
        url = ("https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/" + ",".join(map(str, chunk)) +
               "/property/SMILES,Title/JSON")
        with urllib.request.urlopen(url, timeout=60) as r:
            for p in json.load(r)["PropertyTable"]["Properties"]:
                cache[str(p["CID"])] = {"smiles": p.get("SMILES"), "name": p.get("Title")}
        time.sleep(0.3)
    cache_path.write_text(json.dumps(cache, indent=0), encoding="utf-8")
    return cache


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    doc = pymupdf.open(DATA / "snitz_s003")
    mixtures, pairs = {}, []
    for ds, sec in SECTIONS.items():
        rows = parse_pairs(page_text(doc, sec["pairs"]))
        if "mix" in sec:
            for k, cids in parse_mixtures(doc, sec["mix"], DATA / f"pyrfume_experiment{ds[1]}_cids.csv").items():
                mixtures[f"{ds}:{k}"] = cids
            pairs += [{"dataset": ds, "a": f"{ds}:{a}", "b": f"{ds}:{b}", "similarity": s} for a, b, s in rows]
        else:   # single molecules
            for a, b, s in rows:
                mixtures[f"{ds}:{a}"] = [a]
                mixtures[f"{ds}:{b}"] = [b]
                pairs.append({"dataset": ds, "a": f"{ds}:{a}", "b": f"{ds}:{b}", "similarity": s})
    dropped = [p for p in pairs if p["a"] not in mixtures or p["b"] not in mixtures]
    pairs = [p for p in pairs if p["a"] in mixtures and p["b"] in mixtures]
    print("dropped comparisons with an incomplete mixture:", [(p["a"], p["b"]) for p in dropped])

    cids = sorted({c for m in mixtures.values() for c in m})
    pc = pubchem_smiles(cids, DATA / "pubchem.json")
    smiles = {c: standardize(pc[str(c)]["smiles"]) for c in cids}
    bad = [c for c in cids if not smiles[c]]
    assert not bad, bad
    sess = ort.InferenceSession(str(ROOT / "odor-predictor" / "model" / "odor_gnn.onnx"), providers=["CPUExecutionProvider"])
    X, A, M = featurize_many([smiles[c] for c in cids])
    probs = sess.run(None, {"X": X, "A": A, "mask": M})[0]

    out = {"source": "Snitz et al. 2013, PLoS Comput Biol 9(9): e1003184, Table S2 (CC BY 4.0)",
           "molecules": {str(c): {"smiles": smiles[c], "name": pc[str(c)]["name"], "probs": [round(float(v), 5) for v in probs[i]]}
                         for i, c in enumerate(cids)},
           "mixtures": mixtures, "pairs": pairs}
    (DATA / "snitz.json").write_text(json.dumps(out), encoding="utf-8")

    # summary
    for ds in SECTIONS:
        ps = [p for p in pairs if p["dataset"] == ds]
        same = [p for p in ps if p["a"] == p["b"]]
        ms = {m for p in ps for m in (p["a"], p["b"])}
        sizes = sorted({len(mixtures[m]) for m in ms})
        ov = [len(set(mixtures[p["a"]]) & set(mixtures[p["b"]])) for p in ps if p["a"] != p["b"]]
        print(f"{ds}: {len(ps)} comparisons ({len(same)} identical), {len(ms)} mixtures, sizes {sizes}, "
              f"pairs with shared components {sum(o > 0 for o in ov)}")
    print("molecules:", len(cids))


if __name__ == "__main__":
    main()
