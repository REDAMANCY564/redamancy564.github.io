"""Stage E of PLAN-perception.md: compact data file for the page /perception-diversity/.

Reads the stage A-D outputs and writes perception-diversity/data/site.json. Individual ratings are
published only as anonymous values (no subject codes) for the "how big are individual differences"
presets, and as P-codes for the new-consumer demo (codes are random, demographics were dropped at
import, so nothing links them to the public sheet). The data are CC0 (Keller & Vosshall 2016).

Input:  training/data/perception/{ratings_long.csv.gz, pred_b_pleasantness.csv.gz}
        perception-diversity/data/{qc.json, qc_subjects.csv, variance.json, prediction.json,
        segments.json, processing_log.json, mappings/*.csv}
Output: perception-diversity/data/site.json
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "training" / "data" / "perception"
SITE = ROOT / "perception-diversity" / "data"
PRESETS = [1183, 62444, 10430, 7762, 17898, 31260, 61204, 323, 6549, 92979]   # shown at high concentration
N_DEMO = 8


def r2(x):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), 3)


def load(name):
    return json.loads((SITE / name).read_text(encoding="utf-8"))


def main():
    df = pd.read_csv(DATA / "ratings_long.csv.gz")
    mol = pd.read_csv(SITE / "mappings" / "molecules.csv", keep_default_na=False).set_index("cid")
    qc, var, pred, seg, plog = (load(n) for n in ("qc.json", "variance.json", "prediction.json", "segments.json",
                                                  "processing_log.json"))
    qs = pd.read_csv(SITE / "qc_subjects.csv", keep_default_na=False)
    steps = {s["step"]: s for s in plog["steps"]}
    out = {"source": plog["source"]}

    # processing and quality
    issues = mol[(mol["identity_check"] != "consistent") | (mol["cas_check"] != "matches_pubchem")]
    out["processing"] = {
        "rows": steps["import"]["rows"], "subjects": steps["subjects"]["n"], "molecules": steps["molecules"]["n"],
        "stimuli": int(df["stimulus"].nunique()), "not_detected": steps["scales"]["not_detected_rows"],
        "detected": steps["scales"]["detected_rows"], "blanks_to_0": steps["scales"]["descriptor_blanks_set_to_0"],
        "cid_repaired": len(steps["cid_repair"]["molecules"]),
        "cid_repaired_names": [m["name"] for m in steps["cid_repair"]["molecules"]],
        "id_problem_molecules": len(set(issues["name"]) | {m["name"] for m in steps["cid_repair"]["molecules"]}),
        "identity": steps["molecules"]["identity_check"], "cas": steps["molecules"]["cas_check"],
        "odor_split": steps["molecules"]["odor_dataset_split"], "stereo_groups": steps["molecules"]["stereo_groups"] // 2,
        "row_checks": qc["rows"], "panel_reliability": qc["panel_reliability"], "flag_counts": qc["flag_counts"],
        "issues": [{"cid": int(c), "cid_in_sheet": int(r["cid_in_sheet"]), "name": r["name"], "cas_raw": r["cas_raw"],
                    "identity": r["identity_check"], "cas_check": r["cas_check"], "note": r["note"]}
                   for c, r in issues.iterrows()],
    }
    out["subjects_qc"] = [{"s": r["subject"], "ri": r2(r["retest_intensity_r"]), "rp": r2(r["retest_pleasantness_r"]),
                           "n": int(r["retest_intensity_n"]), "det": r2(r["detect_rate"]), "flags": r["flags"]}
                          for _, r in qs.iterrows()]
    out["descriptors"] = pd.read_csv(SITE / "mappings" / "descriptors.csv", keep_default_na=False).to_dict("records")

    # variance decomposition
    out["variance"] = {v: {k: {"shares": x["shares"], "ci95": x.get("ci95")} for k, x in res.items()}
                       for v, res in var["results"].items()}
    out["variance_noise"] = var["noise_diagnostics"]
    out["variance_sim"] = var["simulation_check"]

    # how big are individual differences: presets at high concentration
    first = df[(df["presentation"] == 1)]
    spread_all = first[first["pleasantness"].notna()].groupby("stimulus")["pleasantness"].agg(["std", "count"])
    spread_all = spread_all[spread_all["count"] >= 45]["std"]
    presets = []
    for cid in PRESETS:
        st = f"{cid}_high"
        g = first[first["stimulus"] == st]
        vals = g["pleasantness"].dropna()
        presets.append({"cid": cid, "name": mol.loc[cid, "name"], "dilution": "1/" + f"{int(g['dilution_factor'].iloc[0]):,}",
                        "values": sorted(int(round(v)) for v in vals), "n_detected": int(len(vals)), "n": int(len(g)),
                        "mean": round(float(vals.mean()), 1), "sd": round(float(vals.std()), 1),
                        "sd_rank": int((spread_all > vals.std()).sum() + 1) if len(vals) >= 45 else None})
    out["spread"] = {"presets": presets, "sd_median": round(float(spread_all.median()), 1),
                     "n_stimuli_ranked": int(len(spread_all))}

    # prediction
    P = {}
    for v, res in pred["results"].items():
        A, Af, B = res["new_molecules"], res["new_molecules_fingerprint"], res["new_consumers"]
        P[v] = {"ceiling": {"retest_r": res["ceiling"]["test_retest_single_rating"]["r"],
                            "max_r": res["ceiling"]["max_r_for_a_single_rating"],
                            "panel_reliability": res["ceiling"]["panel_mean_reliability"]},
                "A": {m: {"r": x["r"], "rs": x["r_per_subject_mean"], "rmse": x["rmse"]} for m, x in A["rating_level"].items()},
                "A_fp": {m: {"r": x["r"], "rmse": x["rmse"]} for m, x in Af["rating_level"].items()},
                "A_pop": A["population_level"], "A_pop_fp": Af["population_level"],
                "B": B["n_known_5"], "B_probe": B["probe_set_5"], "B_curve": B["curve"], "cmp": res["comparisons"]}
    out["prediction"] = P

    # new-consumer demo: N_DEMO test subjects spanning the range of per-subject r (draw 0)
    rb = pd.read_csv(DATA / "pred_b_pleasantness.csv.gz")
    rb = rb[rb["draw"] == 0]
    det = first[first["pleasantness"].notna()]
    per = rb.groupby("subject").apply(lambda g: np.corrcoef(g["y"], g["molecule_offset_factors"])[0, 1]).sort_values()
    pick = per.index[np.linspace(0, len(per) - 1, N_DEMO).round().astype(int)]
    demo = []
    for s in pick:
        g = rb[rb["subject"] == s]
        mine = det[det["subject"] == s]
        known = mine[~mine["stimulus"].isin(g["stimulus"])]
        name = lambda st: mol.loc[int(st.split("_")[0]), "name"] + (" (low)" if st.endswith("low") else "")
        demo.append({
            "s": s, "r_model": r2(per[s]), "r_panel": r2(np.corrcoef(g["y"], g["molecule_mean"])[0, 1]),
            "rmse_model": round(float(np.sqrt(np.mean((g["y"] - g["molecule_offset_factors"]) ** 2))), 1),
            "rmse_panel": round(float(np.sqrt(np.mean((g["y"] - g["molecule_mean"]) ** 2))), 1),
            "known": [{"name": name(st), "y": int(round(y))} for st, y in zip(known["stimulus"], known["pleasantness"])],
            "pts": [[int(round(y)), round(float(p), 1), round(float(q), 1)] for y, p, q in
                    zip(g["y"], g["molecule_offset_factors"], g["molecule_mean"])],
            "names": [name(st) for st in g["stimulus"]]})
    out["demo"] = {"subjects": demo, "rank_rule": f"{N_DEMO} test subjects evenly spaced from the lowest to the highest per-subject r"}

    # segments and the continuous axis
    res = seg["results"]
    out["segments"] = {
        "decision": seg["decision"],
        "table": {variant: {m: {k: {kk: r[kk] for kk in ("silhouette", "null_p95", "split_half_ari_mean", "sizes")}
                                for k, r in rows.items()} for m, rows in x["methods"].items()} for variant, x in res.items()},
        "pairwise_deviation_r": seg["pairwise_deviation_r"],
        "axes": [{k: a[k] for k in ("axis", "variance_share", "null_p95", "split_half_abs_r", "split_half_null_p95",
                                    "rho_with_panel_intensity", "descriptor_rho_intensity_partialled", "subject_score_rho_with_qc")}
                 | {"scores": sorted(round(v, 2) for v in a["subject_scores"].values())} for a in seg["axes"]],
    }
    def clean(o):   # NaN (e.g. a correlation of a constant prediction) is not valid JSON -> null
        if isinstance(o, float) and np.isnan(o):
            return None
        if isinstance(o, dict):
            return {k: clean(v) for k, v in o.items()}
        if isinstance(o, list):
            return [clean(v) for v in o]
        return o
    text = json.dumps(clean(json.loads(json.dumps(out, default=float))), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    (SITE / "site.json").write_text(text, encoding="utf-8")
    print("site.json", round(len(text.encode()) / 1024, 1), "KB; demo subjects", list(pick), "per-subject r", per[pick].round(2).tolist())


if __name__ == "__main__":
    main()
