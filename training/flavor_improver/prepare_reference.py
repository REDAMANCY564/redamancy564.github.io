"""Data for example 5 (reference-food mode): infant formula vs human milk, Zhang et al. (2022).

Inputs : reference_source.json (Tables 2 and 3 of the paper, transcribed and checked against the PDF),
         training/data/ref_pubchem.json (structures), the van Gemert text from extract_vangemert.py.
Output : review tables on stdout and training/data/ref_draft.json; with --final also
         flavor-improver/data/reference.json (after user approval).

Rules (same as examples 1-4):
- Water detection thresholds from van Gemert (2011) by the fixed rule in thresholds.py
  (Czerny 2008 > Buttery > Karagul-Yuceer). For (E) and (E,E) isomers the stereo-specific entry is
  used when it exists, otherwise the entry for the unspecified isomer.
  Extension for this example only (user-approved, 2026-10-16): when the rule finds no single value but
  Buttery et al. give a detection range whose ends differ by at most 2x, the geometric mean is used
  (adds (E)-2-decenal, 1-octen-3-ol, 2-furanmethanol). Example 2 still excludes 1-octen-3-ol under the
  original rule. No value -> compound excluded.
- Odor vectors: project-1 GNN probability / label prevalence ("lift") on 12 user-approved dimensions.
- Infant formula concentrations (Table 3) are per kg powder and are divided by 8
  (about 4.3 g powder in 30 mL water) to compare with liquid human milk (user decision).
- No averaging across samples: every sample is kept; the page starts from one example per side
  (DEFAULTS) and visitors can edit it or enter their own values (e.g. means).
- Only key odorants are analyzed: compounds with OAV >= KEY_OAV (default 10, adjustable on the page).

Usage: python prepare_reference.py <van Gemert text> [--final]
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort

HERE = Path(__file__).resolve().parent
TRAINING = HERE.parent
ROOT = TRAINING.parent
sys.path.insert(0, str(TRAINING))
sys.path.insert(0, str(HERE))
from featurize import featurize  # noqa: E402
from thresholds import parse_entries, pick  # noqa: E402

PROFILE_DIMS = ["dairy", "creamy", "sweet", "sour", "fatty", "oily",
                "green", "mushroom", "metallic", "fishy", "floral", "cooked"]

# CAS used to find the van Gemert entry: stereo-specific first, unspecified isomer as fallback
CAS = {
    "(E)-2-decenal": ["3913-81-3"], "(E)-2-heptenal": ["18829-55-5", "2463-63-0"],
    "(E)-2-hexenal": ["6728-26-3", "505-57-7"], "(E)-2-nonenal": ["18829-56-6", "2463-53-8"],
    "(E)-2-octenal": ["2548-87-0", "2363-89-5"], "(E)-2-pentenal": ["1576-87-0", "764-39-6"],
    "(E,E)-2,4-decadienal": ["25152-84-5", "2363-88-4"], "(E,E)-2,4-heptadienal": ["4313-03-5", "5910-85-0"],
    "(E,E)-2,4-octadienal": ["30361-28-5", "5577-44-6"], "1-octen-3-ol": ["3391-86-4"],
    "1-octen-3-one": ["4312-99-6"], "2-furanmethanol": ["98-00-0"], "2-pentylfuran": ["3777-69-3"],
    "3-octanone": ["106-68-3"], "benzaldehyde": ["100-52-7"], "decanal": ["112-31-2"],
    "dimethyl disulfide": ["624-92-0"], "eucalyptol": ["470-82-6"], "furfural": ["98-01-1"],
    "heptanal": ["111-71-7"], "hexanal": ["66-25-1"], "linalool": ["78-70-6"],
    "nonanal": ["124-19-6"], "octanal": ["124-13-0"],
}
DEFAULTS = {"human_milk": "A2", "infant_formula": "2"}
KEY_OAV = 10
BUTTERY_RANGE_MAX_RATIO = 2.0

ZH = {
    "(E)-2-decenal": "(E)-2-癸烯醛", "(E)-2-heptenal": "(E)-2-庚烯醛", "(E)-2-hexenal": "(E)-2-己烯醛",
    "(E)-2-nonenal": "(E)-2-壬烯醛", "(E)-2-octenal": "(E)-2-辛烯醛", "(E)-2-pentenal": "(E)-2-戊烯醛",
    "(E,E)-2,4-decadienal": "(E,E)-2,4-癸二烯醛", "(E,E)-2,4-heptadienal": "(E,E)-2,4-庚二烯醛",
    "(E,E)-2,4-octadienal": "(E,E)-2,4-辛二烯醛", "1-octen-3-ol": "1-辛烯-3-醇", "1-octen-3-one": "1-辛烯-3-酮",
    "2-furanmethanol": "2-呋喃甲醇（糠醇）", "2-pentylfuran": "2-戊基呋喃", "3-octanone": "3-辛酮",
    "benzaldehyde": "苯甲醛", "decanal": "癸醛", "dimethyl disulfide": "二甲基二硫醚", "eucalyptol": "桉叶油素",
    "furfural": "糠醛", "heptanal": "庚醛", "hexanal": "己醛", "linalool": "芳樟醇", "nonanal": "壬醛", "octanal": "辛醛",
}


def water_section(text_path):
    lines = Path(text_path).read_text(encoding="utf-8").splitlines()
    return lines[next(i for i, l in enumerate(lines) if "PART  II" in l):
                 next(i for i, l in enumerate(lines) if "PART  III" in l)]


def threshold(water, cas_list):
    for cas in cas_list:
        idx = [i for i, l in enumerate(water) if f"[{cas}]" in l or f"[{cas}," in l or f", {cas}]" in l]
        if not idx:
            continue
        rows = parse_entries(water, idx[0])
        vals = [v for _, _, lo, hi in rows for v in (lo, hi) if v is not None]
        p = pick(rows) or buttery_range(rows)
        if p:
            return {**p, "cas_entry": cas, "heading": water[idx[0]].strip(),
                    "range_mg_kg": [min(vals), max(vals)] if vals else None}
    return None


def buttery_range(rows):
    """Example-5 extension: geometric mean of a narrow Buttery detection range."""
    for text, kind, lo, hi in rows:
        # the PDF text sometimes runs the "d" into the citation, e.g. "Buttery & Ling (1995,1998)d 0.001 - 0.0014"
        is_detection = kind == "d" or text.rstrip().endswith(")d")
        if is_detection and hi is not None and "Buttery" in text and hi / lo <= BUTTERY_RANGE_MAX_RATIO:
            return {"value_mg_kg": round(math.sqrt(lo * hi), 6), "source": f"Buttery et al. (geometric mean of {lo}-{hi} mg/kg)",
                    "entry": text, "rule": "buttery_range"}
    return None


def profile(conc, comps):
    """conc: {name: ug/kg} -> (normalized profile, {name: OAV})."""
    v, oavs = np.zeros(len(PROFILE_DIMS)), {}
    for n, c in conc.items():
        if c is None or n not in comps:
            continue
        oav = c / (comps[n]["threshold_mg_kg"] * 1000)
        oavs[n] = oav
        if oav > 1:
            v += math.log10(oav) * np.array(comps[n]["lift"])
    return (v / v.sum() if v.sum() > 0 else v), oavs


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    src = json.loads((HERE / "reference_source.json").read_text(encoding="utf-8"))
    pub = json.loads((TRAINING / "data" / "ref_pubchem.json").read_text(encoding="utf-8"))
    water = water_section(sys.argv[1])
    labels = [l["id"] for l in json.loads((ROOT / "odor-predictor" / "model" / "labels.json").read_text(encoding="utf-8"))]
    dim_idx = [labels.index(d) for d in PROFILE_DIMS]
    import pandas as pd
    prior = pd.read_csv(TRAINING / "data" / "clean.csv")[PROFILE_DIMS].mean().to_numpy()
    sess = ort.InferenceSession(str(ROOT / "odor-predictor" / "model" / "odor_gnn.onnx"), providers=["CPUExecutionProvider"])

    hm, inf = src["human_milk"], src["infant_formula"]
    names = sorted(set(hm["compounds"]) | set(inf["compounds"]))
    comps, excluded = {}, []
    print(f"{'compound':24s} {'in':6s} {'thr ug/kg':>10s} {'source':22s} {'van Gemert entry':42s} top-3 GNN labels")
    for n in names:
        t = threshold(water, CAS[n])
        where = ("HM" if n in hm["compounds"] else "") + ("+IF" if n in inf["compounds"] else "")
        if not t:
            excluded.append(n)
            print(f"{n:24s} {where:6s} {'-':>10s} EXCLUDED (no value by the rule)")
            continue
        X, A, M = (a[None] for a in featurize(pub[n]["smiles"]))
        probs = sess.run(None, {"X": X, "A": A, "mask": M})[0][0]
        comps[n] = {
            "name_en": n, "name_zh": ZH[n], "smiles": pub[n]["smiles"], "cid": pub[n]["cid"], "cas": t["cas_entry"],
            "threshold_mg_kg": t["value_mg_kg"], "threshold_source": t["source"], "threshold_range_mg_kg": t["range_mg_kg"],
            "probs": [round(float(probs[i]), 4) for i in dim_idx],
            "lift": [round(float(probs[i] / prior[k]), 4) for k, i in enumerate(dim_idx)],
            "in_human_milk_table": n in hm["compounds"], "in_formula_table": n in inf["compounds"],
        }
        top = [labels[i] for i in np.argsort(-probs)[:3]]
        print(f"{n:24s} {where:6s} {t['value_mg_kg'] * 1000:>10.4g} {t['source']:22s} {t['heading'][:42]:42s} {', '.join(top)}")
    print(f"\nexcluded: {excluded}")

    def samples(block, divisor=1):
        out = []
        for k, sid in enumerate(block["samples"]):
            conc = {n: round(v[k][0] / divisor, 6) for n, v in block["compounds"].items() if v[k] is not None and n in comps}
            sd = {n: round(v[k][1] / divisor, 6) for n, v in block["compounds"].items() if v[k] is not None and n in comps}
            not_detected = [n for n, v in block["compounds"].items() if v[k] is None and n in comps]
            out.append({"id": sid, "conc_ug_kg": conc, "sd_ug_kg": sd, "not_detected": not_detected})
        return out

    hm_s, if_s = samples(hm), samples(inf, inf["reconstitution_divisor"])
    shared = sorted(n for n in comps if comps[n]["in_human_milk_table"] and comps[n]["in_formula_table"])
    print(f"\nquantified in both tables ({len(shared)}): {shared}")
    print("\n== Profiles (" + ", ".join(PROFILE_DIMS) + ") ==")
    for label, ss in (("human milk", hm_s), ("formula /8", if_s)):
        for s in ss:
            p, oav = profile(s["conc_ug_kg"], comps)
            s["profile"] = [round(float(x), 4) for x in p]
            top = sorted(((o, n) for n, o in oav.items() if o > 1), reverse=True)[:4]
            print(f"{label:11s} {s['id']:3s} " + " ".join(f"{x:.2f}" for x in p) + "  | top OAV: " + ", ".join(f"{n} {o:.0f}" for o, n in top))

    out = {"profile_dims": PROFILE_DIMS, "label_prevalence": [round(float(p), 5) for p in prior],
           "compounds": comps, "excluded_no_threshold": excluded, "shared": shared,
           "defaults": DEFAULTS, "key_oav": KEY_OAV,
           "human_milk": {"description": hm["description"], "samples": hm_s},
           "infant_formula": {"description": inf["description"], "divisor": inf["reconstitution_divisor"], "samples": if_s},
           "source": src["source"]}
    (TRAINING / "data" / "ref_draft.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    if "--final" in sys.argv:
        (ROOT / "flavor-improver" / "data" / "reference.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
        print("Wrote flavor-improver/data/reference.json")


if __name__ == "__main__":
    main()
