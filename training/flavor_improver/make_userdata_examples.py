"""Example input pair for the "use my own data" mode (PLAN-userdata.md), in the format of the
gcms-interpreter ranking CSV, from the published data already on the page (data/reference.json,
Zhang et al. 2022, Food Chem 382, 132348): infant formula sample 1 (per kg reconstituted, Table 3 / 8)
as the sample, human milk sample A1 (Table 2) as the target. Thresholds = the page's reference values.
Compounds the paper reports as not detected in that sample are written as "not detected", as the
gcms-interpreter export does for targets that were not found.
No KB id column, so the page's name / CAS resolution is exercised too.
Output: flavor-improver/examples/userdata_sample_formula1.csv, userdata_target_humanmilk_A1.csv
"""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FI = ROOT / "flavor-improver"
HEADER = ["Rank", "Compound", "CAS", "Amount (ug/kg)", "Odor threshold in water (mg/kg)", "Threshold source", "OAV"]


def write(path, conc, comps, nd=()):
    rows = []
    conc = dict(conc, **{n: 0.0 for n in nd if n in comps})
    for n, v in conc.items():
        thr = comps[n]["threshold_mg_kg"]
        rows.append([n, comps[n]["cas"], float(f"{v:.4g}") if v else "not detected", thr if v else "", comps[n]["threshold_source"] if v else "", v / (thr * 1000)])
    rows.sort(key=lambda r: -r[-1])
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
        w.writerow(HEADER)
        for k, r in enumerate(rows, 1):
            w.writerow([k if r[-1] else ""] + r[:-1] + [float(f"{r[-1]:.4g}") if r[-1] else "not_detected"])
    print(path.relative_to(ROOT), len(rows))


def main():
    ref = json.loads((FI / "data" / "reference.json").read_text(encoding="utf-8"))
    comps = ref["compounds"]
    (FI / "examples").mkdir(exist_ok=True)
    s = next(x for x in ref["infant_formula"]["samples"] if x["id"] == "1")
    h = next(x for x in ref["human_milk"]["samples"] if x["id"] == "A1")
    write(FI / "examples" / "userdata_sample_formula1.csv", s["conc_ug_kg"], comps, s.get("not_detected", []))
    write(FI / "examples" / "userdata_target_humanmilk_A1.csv", h["conc_ug_kg"], comps, h.get("not_detected", []))


if __name__ == "__main__":
    main()
