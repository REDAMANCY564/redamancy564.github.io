"""Stage A of PLAN-perception.md: label standardization + quality checks for Keller & Vosshall 2016.

Input (not committed, CC0 data of Keller A, Vosshall LB. BMC Neurosci 2016;17:55,
doi:10.1186/s12868-016-0287-2, Additional file 1):
    training/data/perception/raw/keller2016_S1.xlsx

What it does (every step is written to the processing log):
  1. Import: keep only the columns needed; demographics (gender, race, ethnicity, age), the
     DREAM subject number and the free-text descriptions are dropped at import.
  2. Subjects: recoded to random anonymous codes P01..P55 (key kept in training/data only).
  3. Molecules: CAS normalized + check digit (same rules as gcms-interpreter/cas.js); CAS numbers
     typed into the CID column repaired via PubChem; CID -> PubChem SMILES / InChIKey; three-way
     consistency check of CAS, CID and name against PubChem; canonical non-stereo SMILES as used
     by odor-predictor (clean_data.standardize) and the odor-dataset split of each molecule;
     molecules that collapse to the same non-stereo structure are grouped.
  4. Concentration: "1/1,000" -> dilution factor, log10, and high / low within the molecule.
  5. Scales: all 0-100 sliders; descriptor blanks = 0 when the odor was detected, missing otherwise.
  6. Descriptors: draft mapping of the 20 Keller descriptors to the 138 odor-model labels (for user
     review), with data evidence = Spearman correlation across molecules between the panel-mean
     descriptor rating and the odor model's predicted probability.
  7. Quality checks (flag only, nothing removed): missing / out-of-range / duplicates; per-subject
     test-retest on the 40 repeated stimuli, detection rate, scale use (mean, SD), concentration
     discrimination.

Outputs:
  training/data/perception/ratings_long.csv.gz   cleaned long table (private, not committed)
  training/data/perception/subject_key.csv       original subject number -> code (private)
  perception-diversity/data/mappings/*.csv       readable mapping tables (shown on the page)
  perception-diversity/data/qc.json              quality-check summary (anonymous codes only)
  perception-diversity/data/processing_log.json  processing log
"""
import hashlib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pandas as pd
from scipy.stats import pearsonr, spearmanr

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from clean_data import standardize  # noqa: E402
from featurize import featurize_many  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "training" / "data" / "perception"
RAW = DATA / "raw" / "keller2016_S1.xlsx"
SITE = ROOT / "perception-diversity" / "data"
MAPS = SITE / "mappings"
ONNX = ROOT / "odor-predictor" / "model" / "odor_gnn.onnx"
LABELS = ROOT / "odor-predictor" / "model" / "labels.json"
SPLIT = ROOT / "training" / "data" / "split.csv"
PUG = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
SEED = 2026

DESCRIPTORS = ["EDIBLE", "BAKERY", "SWEET", "FRUIT", "FISH", "GARLIC", "SPICES", "COLD", "SOUR", "BURNT",
               "ACID", "WARM", "MUSKY", "SWEATY", "AMMONIA/URINOUS", "DECAYED", "WOOD", "GRASS", "FLOWER",
               "CHEMICAL"]
RATINGS = {"HOW STRONG IS THE SMELL?": "intensity", "HOW PLEASANT IS THE SMELL?": "pleasantness",
           "HOW FAMILIAR IS THE SMELL?": "familiarity"}

# Draft descriptor mapping for user review: Keller term -> (odor-model labels, status, note).
# status: "same" = same meaning, different wording; "close" = related, judgement call;
#         "none" = no counterpart in the 138 labels (not mapped).
DESCRIPTOR_MAP = {
    "edible": ([], "none", "category, not an odor quality"),
    "bakery": ([], "close?", "no bakery label; candidates: caramellic, roasted, malty"),
    "sweet": (["sweet"], "same", ""),
    "fruit": (["fruity"], "same", ""),
    "fish": (["fishy"], "same", ""),
    "garlic": (["garlic"], "same", "alliaceous is broader (onion, garlic)"),
    "spices": (["spicy"], "same", ""),
    "cold": (["cooling"], "close?", "cooling (menthol-like); could also be fresh / mint"),
    "sour": (["sour"], "same", ""),
    "burnt": (["burnt"], "same", ""),
    "acid": (["sour"], "close?", "no acid label; sour is the nearest (acetic, butyric)"),
    "warm": (["warm"], "same", ""),
    "musky": (["musk"], "same", ""),
    "sweaty": (["sweaty"], "same", ""),
    "ammonia/urinous": ([], "close?", "no ammonia / urine label; candidates: animal, pungent"),
    "decayed": ([], "close?", "no decay label; candidates: sulfurous, cheesy, fermented"),
    "wood": (["woody"], "same", ""),
    "grass": (["grassy"], "same", "green is broader"),
    "flower": (["floral"], "same", ""),
    "chemical": ([], "close?", "no chemical label; candidates: solvent, medicinal, ethereal"),
}

# Manual decisions where the automatic identity rule is wrong (reason recorded in the log)
IDENTITY_OVERRIDE = {
    93375: "Trivertal = 2,4-dimethyl-3-cyclohexene-1-carboxaldehyde (sheet CID); CAS 27939-60-2 is the "
           "unspecified dimethyl isomer mixture, which PubChem files under another isomer; sheet CID kept",
}

MAP_MIN_RHO = 0.3   # user-approved 2026-10-18

log = []


def step(name, **info):
    log.append({"step": name, **info})
    print(f"[{name}]", json.dumps(info, ensure_ascii=False, default=str)[:400])


# ---------- CAS (Python port of gcms-interpreter/cas.js) ----------

def cas_check_digit_ok(cas):
    m = re.match(r"^(\d{2,7})-(\d{2})-(\d)$", cas)
    if not m:
        return False
    body = (m.group(1) + m.group(2))[::-1]
    return sum((i + 1) * int(d) for i, d in enumerate(body)) % 10 == int(m.group(3))


def normalize_cas(raw):
    """-> (cas or None, status) with status ok / suspicious / invalid / empty, as in cas.js."""
    s = "" if raw is None or (isinstance(raw, float) and np.isnan(raw)) else str(raw)
    s = re.sub(r"[‐-―−]", "-", s).strip().replace(" ", "")
    if not s:
        return None, "empty"
    m = re.search(r"(\d{2,10})-(\d{2})-(\d)", s)
    if m:
        cas = m.group(1).lstrip("0") + "-" + m.group(2) + "-" + m.group(3)
    elif re.fullmatch(r"\d{5,10}(\.0+)?", s):
        d = s.split(".")[0].lstrip("0")
        cas = d[:-3] + "-" + d[-3:-1] + "-" + d[-1]
    else:
        return None, "invalid"
    if not re.fullmatch(r"\d{2,7}-\d{2}-\d", cas):
        return None, "invalid"
    return cas, "ok" if cas_check_digit_ok(cas) else "suspicious"


def norm_name(name):
    """Loose name key (same idea as gcms-interpreter names.js normName)."""
    s = str(name).lower().strip()
    for g, r in {"α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta"}.items():
        s = s.replace(g, r)
    return re.sub(r"[^a-z0-9]", "", s)


# ---------- PubChem (free, no key; cached) ----------

def pug_json(url, cache_name, data=None):
    path = DATA / "pubchem" / cache_name
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode() if data else None)
                with urllib.request.urlopen(req, timeout=120) as r:
                    path.write_bytes(r.read())
                break
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    path.write_text("{}", encoding="utf-8")
                    break
                if attempt == 3:
                    raise
                time.sleep(3 * (attempt + 1))
            except Exception:  # noqa: BLE001  (network errors / throttling)
                if attempt == 3:
                    raise
                time.sleep(3 * (attempt + 1))
        time.sleep(0.25)
    return json.loads(path.read_text(encoding="utf-8"))


def _key(cids):
    return hashlib.md5(",".join(map(str, cids)).encode()).hexdigest()[:12]


def pubchem_properties(cids):
    out = []
    for i in range(0, len(cids), 150):
        chunk = cids[i:i + 150]
        d = pug_json(f"{PUG}/compound/cid/property/SMILES,InChIKey,Title/JSON", f"props_{_key(chunk)}.json",
                     {"cid": ",".join(map(str, chunk))})
        out += d["PropertyTable"]["Properties"]
    return pd.DataFrame(out).set_index("CID")


def pubchem_rn(cids):
    """Registry numbers (CAS and others) per CID."""
    rn = {}
    for i in range(0, len(cids), 100):
        chunk = cids[i:i + 100]
        d = pug_json(f"{PUG}/compound/cid/xrefs/RN/JSON", f"rn_{_key(chunk)}.json", {"cid": ",".join(map(str, chunk))})
        for x in d.get("InformationList", {}).get("Information", []):
            rn.setdefault(x["CID"], set()).update(x.get("RN", []))
    return rn


def pubchem_name_cids(name):
    d = pug_json(f"{PUG}/compound/name/{urllib.parse.quote(name, safe='')}/cids/JSON", "name_" + norm_name(name)[:80] + ".json")
    return d.get("IdentifierList", {}).get("CID", [])


def pubchem_skeletons(query, by="name"):
    """{cid: InChIKey connectivity block} for a name / CAS lookup, or for one CID (by="cid")."""
    tag = norm_name(str(query))[:80]
    d = pug_json(f"{PUG}/compound/{by}/{urllib.parse.quote(str(query), safe='')}/property/InChIKey/JSON",
                 f"skel_{by}_{tag}.json")
    return {x["CID"]: x["InChIKey"][:14] for x in d.get("PropertyTable", {}).get("Properties", [])}


def resolve_cid(cid, name, cas):
    """Three-way check of CID, name and CAS at the level of the structure skeleton (first InChIKey
    block: connectivity, stereo ignored). Two sources against one decide; otherwise keep the CID.
    Returns (cid_used, status, detail)."""
    own = pubchem_skeletons(cid, "cid").get(cid)
    by_name = pubchem_skeletons(name)
    by_cas = pubchem_skeletons(cas) if cas else {}
    name_sk, cas_sk = set(by_name.values()), set(by_cas.values())
    detail = {"cid_skeleton": own, "name_cids": list(by_name)[:5], "cas_cids": list(by_cas)[:5]}
    agree_name, agree_cas = own in name_sk, own in cas_sk
    if (agree_name or not name_sk) and (agree_cas or not cas_sk):
        return cid, "consistent", detail
    common = name_sk & cas_sk
    if not agree_name and not agree_cas and common:
        sk = sorted(common)[0]
        new = next(c for c, s in by_name.items() if s == sk)
        return new, "cid_replaced", detail
    if agree_name and cas_sk and not agree_cas:
        return cid, "cas_points_elsewhere", detail
    if agree_cas and name_sk and not agree_name:
        return cid, "name_ambiguous", detail     # CID and CAS agree; the name means another isomer in PubChem
    return cid, "unresolved", detail


# ---------- main ----------

def main():
    MAPS.mkdir(parents=True, exist_ok=True)

    # 1. Import
    raw = pd.read_excel(RAW, header=2)
    raw.columns = [str(c).split("\n")[0].strip() for c in raw.columns]
    n_raw = len(raw)
    dropped = ["Gender", "Race", "Ethnicity", "Age", "Subject # (DREAM challenge)", "THE ODOR IS:", "Catalogue #*"]
    keep = ["C.A.S.", "CID", "Odor", "Odor dilution", "Subject # (this study)", "VIAL #", "CAN OR CAN'T SMELL",
            "KNOW OR DON'T KNOW THE SMELL", *RATINGS, *DESCRIPTORS]
    assert all(c in raw.columns for c in keep + dropped), set(keep + dropped) - set(raw.columns)
    df = raw[keep].copy()
    del raw
    step("import", file=RAW.name, rows=n_raw, columns_kept=len(keep), columns_dropped=dropped,
         reason="demographics, DREAM subject number and free-text descriptions are not used (PLAN 4.4)")

    # 2. Subjects -> anonymous codes
    orig = sorted(df["Subject # (this study)"].unique())
    perm = np.random.default_rng(SEED).permutation(len(orig))
    key = {s: f"P{perm[i] + 1:02d}" for i, s in enumerate(orig)}
    df["subject"] = df["Subject # (this study)"].map(key)
    pd.DataFrame({"original_subject": list(key), "code": list(key.values())}).to_csv(DATA / "subject_key.csv", index=False)
    step("subjects", n=len(orig), coding=f"random permutation (seed {SEED}) -> P01..P{len(orig):02d}; key kept private")

    # 3. Molecules
    df["name_raw"] = df["Odor"].astype(str)
    df["is_replicate_row"] = df["name_raw"].str.contains(r"\(replicate\)", regex=True)
    df["name_clean"] = df["name_raw"].str.replace(r"\s*\(replicate\)\s*$", "", regex=True).str.strip()
    cas_info = df["C.A.S."].map(normalize_cas)
    df["cas_norm"], df["cas_status"] = cas_info.str[0], cas_info.str[1]

    cid_numeric = df["CID"].map(lambda x: isinstance(x, (int, float, np.integer)) and not pd.isna(x))
    bad_cid = df.loc[~cid_numeric, ["CID", "name_clean", "C.A.S."]].drop_duplicates()
    repairs = []
    cid_fix = {}
    for _, r in bad_cid.iterrows():
        cas, st = normalize_cas(r["CID"])
        by_cas = pubchem_name_cids(cas) if cas else []
        by_name = pubchem_name_cids(r["name_clean"])
        chosen = by_cas[0] if by_cas else (by_name[0] if by_name else None)
        how = "PubChem lookup of the CAS" if by_cas else "PubChem lookup of the name (CAS not found)"
        cid_fix[str(r["CID"])] = chosen
        repairs.append({"name": r["name_clean"], "value_in_cid_column": str(r["CID"]), "cas_status": st,
                        "pubchem_cids_by_cas": by_cas, "pubchem_cids_by_name": by_name, "cid_used": chosen, "method": how})
    df["cid"] = [int(c) if ok else cid_fix[str(c)] for c, ok in zip(df["CID"], cid_numeric)]
    step("cid_repair", rows=int((~cid_numeric).sum()), molecules=repairs)

    # three-way identity check (only where the CID disagrees with the name or the CAS)
    rn = pubchem_rn(sorted(df["cid"].unique().tolist()))
    identity, cid_map = {}, {}
    for cid, g in df.groupby("cid"):
        name = sorted(g["name_clean"].unique(), key=str.lower)[0]
        cas = next((c for c, s in zip(g["cas_norm"], g["cas_status"]) if s == "ok"), None)
        if cid in pubchem_name_cids(name) and (cas is None or cas in rn.get(cid, set())):
            identity[cid] = ("consistent", {})
            continue
        new, status, detail = resolve_cid(cid, name, cas)
        if cid in IDENTITY_OVERRIDE:
            new, status, detail = cid, "manual_keep", {**detail, "reason": IDENTITY_OVERRIDE[cid]}
        identity[new] = (status, {**detail, "cid_in_sheet": cid})
        if new != cid:
            cid_map[cid] = new
    df["cid_sheet"] = df["cid"]
    df["cid"] = df["cid"].map(lambda c: cid_map.get(c, c))
    step("identity_check", rule="CID, name and CAS compared on the structure skeleton (InChIKey connectivity "
         "block); two sources against one decide, otherwise the sheet CID is kept and flagged",
         status=pd.Series([v[0] for v in identity.values()]).value_counts().to_dict(),
         cid_replaced={str(k): v for k, v in cid_map.items()})

    cids = sorted(df["cid"].unique().tolist())
    assert len(cids) == df["cid_sheet"].nunique(), "a corrected CID collides with another molecule"
    props = pubchem_properties(cids)
    rn = pubchem_rn(cids)
    split = pd.read_csv(SPLIT)
    split_of = dict(zip(split["smiles"], split["split"]))

    mol_rows = []
    for cid, g in df.groupby("cid"):
        names = sorted(g["name_clean"].unique(), key=str.lower)
        cas_raw = sorted(g["C.A.S."].astype(str).unique())
        cas_norm = sorted({c for c in g["cas_norm"] if c})
        cas_status = sorted(g["cas_status"].unique())
        p = props.loc[cid]
        can = standardize(p["SMILES"])
        regs = rn.get(cid, set())
        notes = []
        id_status, id_detail = identity.get(cid, ("consistent", {}))
        if id_status == "cid_replaced":
            notes.append(f"sheet CID {id_detail['cid_in_sheet']} is a different structure; name and CAS agree on CID {cid}")
        elif id_status == "manual_keep":
            notes.append("manual decision: " + id_detail["reason"])
        elif id_status == "name_ambiguous":
            notes.append(f"CID and CAS agree; the name points to another structure in PubChem (CID {id_detail.get('name_cids')}), "
                         "e.g. isomer or tautomer; sheet CID kept")
        elif id_status != "consistent":
            notes.append(f"identity check: {id_status} (name lookup CIDs {id_detail.get('name_cids')}, "
                         f"CAS lookup CIDs {id_detail.get('cas_cids')}); sheet CID kept, please review")
        cas_used = cas_norm[0] if len(cas_norm) == 1 else ""
        if "suspicious" in cas_status:
            valid_regs = sorted(x for x in regs if re.fullmatch(r"\d{2,7}-\d{2}-\d", x) and cas_check_digit_ok(x))
            notes.append(f"CAS {cas_used} fails the check digit; PubChem CAS for this CID: {', '.join(valid_regs[:3])}")
            cas_used = valid_regs[0] if len(valid_regs) == 1 else ""
            cas_check = "check_digit_failed"
        elif cas_used and cas_used in regs:
            cas_check = "matches_pubchem"
        elif cas_used:
            cas_check = "not_in_pubchem_rn"
            notes.append("CAS valid but not listed for this CID in PubChem")
        else:
            cas_check = "missing"
        if len(names) > 1:
            notes.append("name variants: " + " | ".join(names))
        mol_rows.append({
            "cid": cid, "cid_in_sheet": id_detail.get("cid_in_sheet", cid), "name": names[0],
            "name_variants": " | ".join(names), "pubchem_title": p["Title"],
            "cas_raw": " | ".join(cas_raw), "cas": cas_used, "cas_check": cas_check, "identity_check": id_status,
            "inchikey": p["InChIKey"], "smiles_pubchem": p["SMILES"], "smiles_nonstereo": can,
            "odor_dataset_split": split_of.get(can, "not_in_odor_dataset"),
            "has_stereo": bool(re.search(r"[@/\\]", p["SMILES"])),
            "note": "; ".join(notes)})
    mol = pd.DataFrame(mol_rows)
    # molecules that become identical without stereo information (one GNN input for both)
    grp = mol.groupby("smiles_nonstereo")["cid"].transform("min")
    dup = mol["smiles_nonstereo"].duplicated(keep=False)
    mol["structure_group"] = np.where(dup, "G" + grp.astype(str), "")
    for i in mol.index[dup]:
        others = mol.loc[dup & (mol["smiles_nonstereo"] == mol.at[i, "smiles_nonstereo"]) & (mol.index != i), "name"]
        mol.at[i, "note"] = "; ".join(x for x in [mol.at[i, "note"], "same non-stereo structure as " + ", ".join(others)] if x)
    step("molecules", n=len(mol), cas_check=mol["cas_check"].value_counts().to_dict(),
         identity_check=mol["identity_check"].value_counts().to_dict(),
         odor_dataset_split=mol["odor_dataset_split"].value_counts().to_dict(),
         stereo_groups=int(dup.sum()), name_variant_molecules=int((mol["name_variants"].str.contains(r"\|")).sum()),
         identifier="InChIKey (PubChem) + canonical non-stereo SMILES (odor-predictor standardization)")

    # 4. Concentration
    df["dilution_text"] = df["Odor dilution"].astype(str).str.strip()
    df["dilution_factor"] = df["dilution_text"].map(lambda s: int(s.split("/")[1].replace(",", "")))
    df["log10_dilution"] = -np.log10(df["dilution_factor"])
    lo_hi = df.groupby("cid")["dilution_factor"].agg(["min", "max"])
    df["level"] = np.where(df["dilution_factor"] == df["cid"].map(lo_hi["min"]), "high", "low")
    assert (lo_hi["min"] < lo_hi["max"]).all()
    conc = (df.groupby(["dilution_text", "dilution_factor", "log10_dilution", "level"]).size()
            .rename("rows").reset_index().sort_values(["dilution_factor", "level"]))
    pairs = df.groupby("cid")["dilution_text"].agg(lambda s: " & ".join(sorted(set(s), key=lambda t: int(t.split("/")[1].replace(",", "")))))
    conc.to_csv(MAPS / "concentrations.csv", index=False)
    step("concentration", labels=conc["dilution_text"].tolist(), pairs=pairs.value_counts().to_dict(),
         rule="dilution in paraffin oil; log10 of the dilution fraction; within each molecule the stronger one = high")

    # 5. Scales
    detected = df["CAN OR CAN'T SMELL"].eq("I smell something")
    df["detected"] = detected.astype(int)
    df["known"] = df["KNOW OR DON'T KNOW THE SMELL"].map({"I know what the odor is": 1, "I don't know what the odor is": 0})
    for src, dst in RATINGS.items():
        df[dst] = pd.to_numeric(df[src], errors="coerce")
    desc_cols = []
    blanks_filled = 0
    for d in DESCRIPTORS:
        c = "d_" + d.lower().replace("/", "_")
        desc_cols.append(c)
        v = pd.to_numeric(df[d], errors="coerce")
        blanks_filled += int((v.isna() & detected).sum())
        df[c] = np.where(detected, v.fillna(0), np.nan)
    scales = pd.DataFrame([
        {"variable": "intensity", "question": "How strong is the smell?", "range": "0-100", "slider_start": 50,
         "must_move": True, "when_missing": "not detected", "conversion": "none"},
        {"variable": "pleasantness", "question": "How pleasant is the smell?", "range": "0-100", "slider_start": 50,
         "must_move": True, "when_missing": "not detected", "conversion": "none"},
        {"variable": "familiarity", "question": "How familiar is the smell?", "range": "0-100", "slider_start": 50,
         "must_move": True, "when_missing": "not detected", "conversion": "none (sheet header says 1-100, data 0-100)"},
        {"variable": "20 descriptors", "question": "How well does <descriptor> apply?", "range": "0-100", "slider_start": 0,
         "must_move": False, "when_missing": "blank = 0 if detected; missing if not detected", "conversion": "blank -> 0"},
    ])
    scales.to_csv(MAPS / "scales.csv", index=False)
    step("scales", detected_rows=int(detected.sum()), not_detected_rows=int((~detected).sum()),
         descriptor_blanks_set_to_0=blanks_filled, conversion="none needed: every scale is a 0-100 slider")

    # stimulus id and presentation number (the vial named "(replicate)" is the 2nd presentation;
    # the sheet has no time order, so 1 / 2 are labels, not a known sequence)
    df["stimulus"] = df["cid"].astype(str) + "_" + df["level"]
    df["presentation"] = np.where(df["is_replicate_row"], 2, 1)

    # 7a. Row-level checks
    rating_cols = list(RATINGS.values())
    chk = {
        "rows": len(df),
        "rating_out_of_range": int(((df[rating_cols + desc_cols] < 0) | (df[rating_cols + desc_cols] > 100)).sum().sum()),
        "detected_but_rating_missing": int((detected & df[rating_cols].isna().any(axis=1)).sum()),
        "not_detected_but_rating_present": int((~detected & df[rating_cols].notna().any(axis=1)).sum()),
        "duplicate_subject_stimulus_presentation": int(df.duplicated(["subject", "stimulus", "presentation"]).sum()),
        "exact_duplicate_rows": int(df.duplicated(["subject", "stimulus", "presentation", *rating_cols, *desc_cols]).sum()),
        "stimuli_per_subject": df.groupby("subject").size().unique().tolist(),
        "repeated_stimuli_per_subject": df[df["presentation"] == 2].groupby("subject").size().unique().tolist(),
        "know_missing_when_detected": int((detected & df["known"].isna()).sum()),
    }
    step("row_checks", **chk)

    # 7b. Per-subject quality
    rep_stims = df.loc[df["presentation"] == 2, "stimulus"].unique()
    rep = df[df["stimulus"].isin(rep_stims)].pivot_table(index=["subject", "stimulus"], columns="presentation",
                                                        values=["intensity", "pleasantness", "detected"], aggfunc="first")
    subj = []
    for s, g in df.groupby("subject"):
        r = rep.loc[s]
        row = {"subject": s, "n_stimuli": len(g), "detect_rate": round(g["detected"].mean(), 3)}
        for v in ("intensity", "pleasantness"):
            both = r[v].dropna()
            row[f"retest_{v}_n"] = len(both)
            row[f"retest_{v}_r"] = round(pearsonr(both[1], both[2])[0], 3) if len(both) >= 3 else None
            row[f"{v}_mean"] = round(g[v].mean(), 1)
            row[f"{v}_sd"] = round(g[v].std(), 1)
        row["retest_detect_agree"] = round((r["detected"][1] == r["detected"][2]).mean(), 3)
        hl = g[g["presentation"] == 1].pivot_table(index="cid", columns="level", values="intensity").dropna()
        row["high_gt_low_frac"] = round((hl["high"] > hl["low"]).mean(), 3)
        row["high_low_pairs"] = len(hl)
        subj.append(row)
    subj = pd.DataFrame(subj).sort_values("subject")
    flags = {s: [] for s in subj["subject"]}
    rules = {
        "low_retest_intensity": "test-retest r of intensity < 0.2 (agreed rule for the sensitivity analysis)",
        "few_retest_pairs": "fewer than 10 repeated stimuli detected both times (r unreliable)",
        "narrow_scale": "SD of pleasantness < 10 (uses a narrow part of the scale)",
        "extreme_mean": "mean pleasantness or intensity more than 2 SD from the panel",
        "high_nondetect": "does not detect more than 50% of stimuli",
    }
    for v in ("pleasantness", "intensity"):
        z = (subj[f"{v}_mean"] - subj[f"{v}_mean"].mean()) / subj[f"{v}_mean"].std()
        for s in subj.loc[z.abs() > 2, "subject"]:
            if "extreme_mean" not in flags[s]:
                flags[s].append("extreme_mean")
    for _, r in subj.iterrows():
        if r["retest_intensity_r"] is not None and r["retest_intensity_r"] < 0.2:
            flags[r["subject"]].append("low_retest_intensity")
        if r["retest_intensity_n"] < 10:
            flags[r["subject"]].append("few_retest_pairs")
        if r["pleasantness_sd"] < 10:
            flags[r["subject"]].append("narrow_scale")
        if r["detect_rate"] < 0.5:
            flags[r["subject"]].append("high_nondetect")
    subj["flags"] = subj["subject"].map(lambda s: " ".join(flags[s]))
    flag_counts = {k: int(subj["flags"].str.contains(k).sum()) for k in rules}
    step("subject_checks", flag_rules=rules, flag_counts=flag_counts,
         retest_intensity_r=subj["retest_intensity_r"].describe().round(3).to_dict(),
         retest_pleasantness_r=subj["retest_pleasantness_r"].describe().round(3).to_dict(),
         action="flagged only, nothing removed; z-scoring per subject is applied in the analyses, raw values kept")

    # group-level reliability: split-half of panel means (random halves of subjects), Spearman-Brown
    first = df[df["presentation"] == 1]
    rng = np.random.default_rng(SEED)
    sh = {}
    for v in ("intensity", "pleasantness"):
        rs = []
        for _ in range(200):
            half = set(rng.permutation(subj["subject"].values)[: len(subj) // 2])
            m1 = first[first["subject"].isin(half)].groupby("stimulus")[v].mean()
            m2 = first[~first["subject"].isin(half)].groupby("stimulus")[v].mean()
            j = pd.concat([m1, m2], axis=1).dropna()
            r = pearsonr(j.iloc[:, 0], j.iloc[:, 1])[0]
            rs.append(2 * r / (1 + r))
        sh[v] = round(float(np.mean(rs)), 3)
    step("panel_reliability", split_half_spearman_brown=sh, halves=200)

    # 6. Descriptor mapping with data evidence (odor model probabilities)
    labels = [x["id"] for x in json.loads(LABELS.read_text(encoding="utf-8"))]
    ok = mol["smiles_nonstereo"].map(_featurizable)
    X, A, M = featurize_many(mol.loc[ok, "smiles_nonstereo"].tolist())
    probs = ort.InferenceSession(str(ONNX), providers=["CPUExecutionProvider"]).run(None, {"X": X, "A": A, "mask": M})[0]
    P = pd.DataFrame(probs, index=mol.loc[ok, "cid"].values, columns=labels)
    np.save(DATA / "odor_probs.npy", probs)
    mol.loc[ok, "cid"].to_csv(DATA / "odor_probs_cids.csv", index=False)
    panel = first[first["detected"] == 1].groupby("cid")[desc_cols].mean().loc[P.index]
    drows = []
    for d, c in zip(DESCRIPTORS, desc_cols):
        key = d.lower()
        mapped, status, note = DESCRIPTOR_MAP[key]
        rho = {lab: spearmanr(panel[c], P[lab])[0] for lab in labels}
        top = sorted(rho.items(), key=lambda kv: -kv[1])[:3]
        drows.append({
            "keller_descriptor": key, "odor_model_label": "; ".join(mapped), "status": status, "note": note,
            "rho_mapped": "; ".join(f"{rho[m]:.2f}" for m in mapped),
            "top3_labels_by_rho": "; ".join(f"{k} {v:.2f}" for k, v in top),
            "panel_mean_rating": round(float(first.loc[first["detected"] == 1, c].mean()), 1),
            "decision": ("mapped" if status == "same" and min(rho[m] for m in mapped) >= MAP_MIN_RHO else
                         "not mapped: same word, data disagree" if status == "same" else
                         "not mapped: no counterpart" if status == "none" else "not mapped: related only"),
        })
    dmap = pd.DataFrame(drows)
    dmap.to_csv(MAPS / "descriptors.csv", index=False)
    step("descriptor_mapping", same=int((dmap["status"] == "same").sum()), close=int(dmap["status"].str.startswith("close").sum()),
         none=int((dmap["status"] == "none").sum()), molecules_with_model_probs=int(ok.sum()),
         mapped=dmap.loc[dmap["decision"] == "mapped", "keller_descriptor"].tolist(),
         rule=f"mapped only if the meaning is the same AND rho >= {MAP_MIN_RHO}; analyses use the 20 Keller "
              "descriptors directly, the mapping is only for comparison with the odor model",
         evidence="Spearman rho across molecules: panel-mean descriptor rating (detected, 1st presentation, both "
                  "concentrations pooled) vs odor-model probability", status="approved by user 2026-10-18")

    mol.to_csv(MAPS / "molecules.csv", index=False)
    subj.to_csv(SITE / "qc_subjects.csv", index=False)

    # Output long table (private)
    out_cols = ["subject", "cid", "stimulus", "level", "dilution_factor", "log10_dilution", "presentation",
                "detected", "known", *rating_cols, *desc_cols]
    df[out_cols].sort_values(["subject", "cid", "level", "presentation"]).to_csv(DATA / "ratings_long.csv.gz", index=False)
    step("output", ratings_rows=len(df), file="training/data/perception/ratings_long.csv.gz (private)")

    qc = {"rows": chk, "subjects": subj.to_dict("records"), "flag_rules": rules, "flag_counts": flag_counts,
          "panel_reliability": sh,
          "retest_summary": {v: subj[f"retest_{v}_r"].describe().round(3).to_dict() for v in ("intensity", "pleasantness")}}
    (SITE / "qc.json").write_text(json.dumps(qc, indent=1, default=float), encoding="utf-8")
    (SITE / "processing_log.json").write_text(json.dumps({
        "source": "Keller A, Vosshall LB. Olfactory perception of chemically diverse molecules. BMC Neurosci 2016;17:55. "
                  "doi:10.1186/s12868-016-0287-2. Data: CC0 (Additional file 1).",
        "script": "training/perception/prepare.py", "steps": log}, indent=1, ensure_ascii=False, default=str), encoding="utf-8")


def _featurizable(s):
    try:
        featurize_many([s])
        return True
    except Exception:  # noqa: BLE001
        return False


if __name__ == "__main__":
    main()
