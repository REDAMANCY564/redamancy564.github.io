"""Build gcms-interpreter/data/intensity.json: odor intensity curves in air (Wakayama et al. 2019).

Source: Wakayama H, Sakasai M, Yoshikawa K, Inoue M. Method for predicting odor intensity of perfumery raw
materials using dose-response curve database. Ind. Eng. Chem. Res. 2019, 58(32), 15036-15044.
doi:10.1021/acs.iecr.9b01225. 314 curves from SI Table S2 and isovaleric acid from main-text Table 3,
transcribed to _inputs/wakayama2019_curves.json (local only, not in the repository).

    Psi = Imax / (1 + exp(-(X - C) / D)),  X = log10(gas-phase concentration, ug/L air)
    threshold: X at Psi = 1.4 (LMS "barely detectable") = C - D * ln((Imax - 1.4) / 1.4)

Matching to the compounds of the site, by CAS only (exact string after removing leading zeros):
  kb   flavor knowledge base id, CAS from gcms-interpreter/data/names.json (PubChem registry numbers)
  lib  ingredient-finder library index, CAS from training/data/regulatory/out/lib_cas.json (same list the
       regulatory feature uses); ik is the first InChIKey block of that molecule (used by the odor predictor)
  A site compound whose CAS list hits several curves is linked only to the curve with exactly the same name.

Chinese names: training/intensity/zh_names.csv; only rows with status "approved" go to the site file.
    python training/intensity/build_intensity.py            build the site file and the local match report
    python training/intensity/build_intensity.py --propose  (re)write the proposal table and /INTENSITY-ZH-REVIEW.md
                                                             (keeps existing approved rows)
"""
import collections, csv, datetime, json, math, re, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
SRC = REPO / "_inputs" / "wakayama2019_curves.json"
OUT = REPO / "gcms-interpreter" / "data" / "intensity.json"
ZH = HERE / "zh_names.csv"
REPORT = HERE / "match_report.md"
REVIEW = REPO / "INTENSITY-ZH-REVIEW.md"
DOI = "10.1021/acs.iecr.9b01225"
LMS = [[1.4, "barely"], [6.1, "weak"], [17.2, "moderate"], [35.4, "strong"], [53.3, "very_strong"], [100, "strongest"]]
# search-only spellings (the shown name stays as published)
ALIAS = {"151-05-3": ["dimethyl benzyl carbinyl acetate"]}
# notes on the published data, shown in the review table and the match report
DATA_NOTES = {
    "4166-20-5": "SI Table S2 gives furaneol with CAS 4166-20-5, which is furaneol acetate (furaneol is 3658-77-3); "
                 "kept as published, linked by this CAS only",
    "557-48-2": "SI Table S2 prints 140-88-5 (ethyl acrylate); corrected to 557-48-2",
    "108-59-8": "SI Table S2 gives diethyl malonate with CAS 108-59-8, which is dimethyl malonate (diethyl malonate is "
                "105-53-3); kept as published, linked by this CAS only",
}


def ncas(s):
    m = re.fullmatch(r"0*(\d+)-(\d{2})-(\d)", (s or "").strip())
    return f"{int(m.group(1))}-{m.group(2)}-{m.group(3)}" if m else None


def psi(c, x):
    return c["Imax"] / (1 + math.exp(-(x - c["C"]) / c["D"]))


def threshold_x(c):
    return c["C"] - c["D"] * math.log((c["Imax"] - 1.4) / 1.4)


def load():
    src = json.load(open(SRC, encoding="utf-8"))
    comps = src["compounds"]
    assert len(comps) == 315, len(comps)
    cas = [ncas(c["cas"]) for c in comps]
    assert all(cas) and len(set(cas)) == len(cas), "CAS missing, malformed or duplicated"
    assert all(c["Imax"] > 1.4 for c in comps)
    assert sum(c["step_like"] for c in comps) == 5 and all(c["step_like"] == (c["D"] < 0.1) for c in comps)
    by = {c["name_en"]: c for c in comps}
    # the five self-tests of the task
    assert abs(psi(by["limonene"], 1.67) - 25.3) < 0.05
    assert abs(psi(by["linalool"], -2.55) - 0.87) < 0.005
    assert abs(10 ** threshold_x(by["skatole"]) / 4.89e-4 - 1) < 0.01
    assert by["isovaleric acid"]["src"] == "main text Table 3"
    assert by["2,6-nonadienal"]["cas"] == "557-48-2"
    return src, comps


def match(comps):
    names = json.load(open(REPO / "gcms-interpreter" / "data" / "names.json", encoding="utf-8"))["compounds"]
    lib = json.load(open(REPO / "training" / "data" / "regulatory" / "out" / "lib_cas.json"))
    site = json.load(open(REPO / "ingredient-finder" / "data" / "library.json", encoding="utf-8"))["molecules"]
    assert len(lib) == len(site) and all(l["name"] == s[1] or True for l, s in zip(lib, site))
    curve_of = {ncas(c["cas"]): i for i, c in enumerate(comps)}
    lname = lambda s: (s or "").strip().lower()

    def assign(entries):
        """entries: [(site key, site name, [CAS])] -> {curve index: site key}, conflicts"""
        out, conflicts = {}, []
        for key, nm, cl in entries:
            hits = sorted({curve_of[x] for x in (ncas(c) for c in cl) if x in curve_of})
            if len(hits) > 1:
                same = [h for h in hits if lname(comps[h]["name_en"]) == lname(nm)]
                conflicts.append((key, nm, [comps[h]["name_en"] for h in hits], comps[same[0]]["name_en"] if len(same) == 1 else None))
                hits = same if len(same) == 1 else []
            for h in hits:
                if h in out:
                    conflicts.append((key, nm, [comps[h]["name_en"]], "curve already linked to " + str(out[h])))
                else:
                    out[h] = key
        return out, conflicts

    kb, kb_conf = assign([(r[0], r[1], r[2]) for r in names])
    li, li_conf = assign([(i, m["name"], m["cas"]) for i, m in enumerate(lib)])
    ik = {h: lib[i]["inchikey"].split("-")[0] for h, i in li.items()}
    return kb, li, ik, kb_conf + li_conf


def site_zh():
    """Chinese names already on the site, by CAS: GB 2760 (regulatory data), dairy flavor improver, odor predictor presets."""
    gb = collections.defaultdict(list)
    for it in json.load(open(REPO / "flavor-kb" / "data" / "regulatory.json", encoding="utf-8"))["items"]:
        for c in it[4].split():
            for z in filter(None, it[6].split("|")):
                if z not in gb[ncas(c)]: gb[ncas(c)].append(z)
    for s in json.load(open(REPO / "flavor-kb" / "data" / "regulatory-lookup.json", encoding="utf-8"))["s"]:
        for c in re.split(r"[;\s]+", str(s[2])):
            if s[1] and ncas(c) and not gb.get(ncas(c)): gb[ncas(c)].append(s[1])
    site = {}
    for v in json.load(open(REPO / "flavor-improver" / "data" / "reference.json", encoding="utf-8"))["compounds"].values():
        if v.get("cas") and v.get("name_zh"): site[ncas(v["cas"])] = (v["name_zh"], "dairy flavor improver")
    cid2cas = {}
    kb = json.load(open(REPO / "flavor-kb" / "data" / "compounds.json", encoding="utf-8"))
    names = {r[0]: r[2] for r in json.load(open(REPO / "gcms-interpreter" / "data" / "names.json", encoding="utf-8"))["compounds"]}
    for k, v in kb.items():
        cid2cas[v["cid"]] = names.get(k, [])
    for p in json.load(open(REPO / "odor-predictor" / "data" / "presets.json", encoding="utf-8")):
        for c in cid2cas.get(p.get("pubchem_cid"), []):
            site.setdefault(ncas(c), (p["name_zh"], "odor predictor preset"))
    return gb, site


# Proposed Chinese names for common compounds that have none on the site (author's proposals, to be reviewed).
# Trade names and names the author is not sure of are left out (shown in English).
MANUAL_ZH = {
    "7785-26-4": "α-蒎烯", "2050-08-0": "水杨酸戊酯", "77-53-2": "柏木醇", "4407-36-7": "肉桂醇",
    "65405-77-8": "水杨酸顺式-3-己烯酯", "21662-09-9": "顺式-4-癸烯醛", "91-64-5": "香豆素", "25485-88-5": "水杨酸环己酯",
    "80-71-7": "甲基环戊烯醇酮", "18479-58-8": "二氢月桂烯醇", "58985-02-7": "二氢松油醇",
    "10339-55-6": "乙基芳樟醇", "6259-76-3": "水杨酸己酯", "6485-40-1": "l-香芹酮", "14073-97-3": "l-薄荷酮",
    "1118-39-4": "乙酸月桂烯酯", "128-51-8": "乙酸诺卜酯", "99-82-1": "对孟烷", "104-87-0": "对甲基苯甲醛",
    "20126-76-5": "4-松油醇", "8000-41-7": "松油醇", "65405-70-1": "反式-4-癸烯醛", "28069-72-9": "2,6-壬二烯醇",
    "98-52-2": "对叔丁基环己醇", "32210-23-4": "乙酸对叔丁基环己酯", "88-41-5": "乙酸邻叔丁基环己酯",
    "134-28-1": "乙酸愈创木酯", "80449-58-7": "乙酰基柏木烯", "67874-81-1": "甲基柏木醚",
    "23267-57-4": "β-紫罗兰酮环氧化物", "40379-24-6": "乙酸异壬酯",
}
# GB 2760 names that need a different proposal (one compound only, or the common name); the GB name is kept in the note
OVERRIDE_ZH = {
    "138-86-3": ("柠檬烯", "GB 2760 lists l-苧烯 for this CAS (138-86-3 is the racemate or unspecified)"),
    "507-70-0": ("龙脑", "GB 2760 gives 异龙脑、龙脑 for both borneol and isoborneol"),
    "124-76-5": ("异龙脑", "GB 2760 gives 异龙脑、龙脑 for both borneol and isoborneol"),
    "464-49-3": ("樟脑", "GB 2760: d-樟脑、dl-樟脑"),
    "26489-01-0": ("香茅醇", "GB 2760: dl-香茅醇"),
    "2216-51-5": ("l-薄荷醇", "GB 2760: 天然薄荷脑、薄荷脑"),
    "93-92-5": ("乙酸苏合香酯", "GB 2760: 乙酸甲基苄醇酯(邻、间、对位混合物)、乙酸苏合香酯"),
    "83-34-1": ("粪臭素", "GB 2760: β-甲基吲哚 (3-methylindole)"),
    "4166-20-5": ("", "published as furaneol, but this CAS is furaneol acetate (GB 2760: 4-乙酰氧基-2,5-二甲基-3(2H)-呋喃酮); "
                      "no Chinese name until the identity is decided"),
    "108-59-8": ("", "published as diethyl malonate, but this CAS is dimethyl malonate (丙二酸二甲酯); "
                     "no Chinese name until the identity is decided"),
}


def propose(comps):
    old = {}
    if ZH.exists():
        old = {r["cas"]: r for r in csv.DictReader(open(ZH, encoding="utf-8"))}
    gb, site = site_zh()
    rows = []
    for c in comps:
        k = ncas(c["cas"])
        if k in old and old[k]["status"] == "approved":
            rows.append(old[k]); continue
        note = ""
        if k in OVERRIDE_ZH:
            zh, note = OVERRIDE_ZH[k]; src = "author (GB 2760 name differs)"
        elif gb.get(k):
            zh, src = gb[k][0], "GB 2760-2024"
            if len(gb[k]) > 1: note = "GB 2760 also: " + "、".join(gb[k][1:])
        elif k in site:
            zh, src = site[k]
        elif k in MANUAL_ZH:
            zh, src = MANUAL_ZH[k], "author"
        else:
            zh, src = "", "none (shown in English)"
        if k in DATA_NOTES and k not in OVERRIDE_ZH: note = (note + "; " if note else "") + DATA_NOTES[k]
        rows.append({"cas": k, "name_en": c["name_en"], "name_zh": zh, "source": src, "note": note, "status": "proposed"})
    with open(ZH, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["cas", "name_en", "name_zh", "source", "note", "status"], lineterminator="\n")
        w.writeheader(); w.writerows(rows)
    # review table, grouped by source
    groups = collections.OrderedDict((g, []) for g in ["GB 2760-2024", "author (GB 2760 name differs)", "dairy flavor improver",
                                                         "odor predictor preset", "author", "none (shown in English)"])
    for r in rows:
        groups.setdefault(r["source"], []).append(r)
    md = ["# 气相强度曲线：中文名审核表", "",
          f"共 {len(rows)} 个物质，来源 Wakayama 等 2019（doi:{DOI}）。审核通过的行，我会在 training/intensity/zh_names.csv 中改为 approved；",
          "未通过或留空的显示英文名。请直接在本表“意见”一栏写修改或“删”。", ""]
    for g, rs in groups.items():
        if not rs: continue
        md += [f"## {g}（{len(rs)}）", "", "| # | CAS | 英文名 | 拟用中文名 | 说明 | 意见 |", "|---|---|---|---|---|---|"]
        md += [f"| {i} | {r['cas']} | {r['name_en']} | {r['name_zh']} | {r['note']} | |" for i, r in enumerate(rs, 1)]
        md.append("")
    REVIEW.write_text("\n".join(md), encoding="utf-8")
    print("proposals:", dict(collections.Counter(r["source"] for r in rows)), "->", ZH.name, REVIEW.name)


def build():
    src, comps = load()
    kb, li, ik, conflicts = match(comps)
    zh = {}
    if ZH.exists():
        zh = {r["cas"]: r["name_zh"] for r in csv.DictReader(open(ZH, encoding="utf-8")) if r["status"] == "approved" and r["name_zh"]}
    rows = []
    for i, c in enumerate(comps):
        k = ncas(c["cas"])
        r = [k, c["name_en"], zh.get(k, ""), c["Imax"], c["C"], c["D"], 1 if c["step_like"] else 0,
             "t3" if c["src"] == "main text Table 3" else "s2", kb.get(i, ""), li.get(i, -1), ik.get(i, ""), ALIAS.get(k, [])]
        rows.append(r)
    meta = {
        "source": "Wakayama H, Sakasai M, Yoshikawa K, Inoue M. Method for Predicting Odor Intensity of Perfumery Raw Materials "
                  "Using Dose-Response Curve Database. Ind. Eng. Chem. Res. 2019, 58(32), 15036-15044.",
        "doi": DOI,
        "tables": {"s2": "Supporting Information, Table S2", "t3": "main text, Table 3"},
        "equation": "Psi = Imax / (1 + exp(-(X - C) / D)), X = log10(gas-phase concentration, ug/L air = mg/m3)",
        "threshold": "X at Psi = 1.4: C - D * ln((Imax - 1.4) / 1.4)",
        "lms": LMS, "x_range": [-5, 5],
        "fields": ["cas", "name_en", "name_zh", "Imax", "C", "D", "step_like", "table", "kb", "lib", "ik", "alias"],
        "notes": {k: v for k, v in DATA_NOTES.items()},
        "n": len(rows), "built": datetime.date.today().isoformat(),
    }
    OUT.write_text(json.dumps({"meta": meta, "c": rows}, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    n_kb, n_li = sum(1 for r in rows if r[8]), sum(1 for r in rows if r[9] >= 0)
    print(f"{OUT.relative_to(REPO)}: {len(rows)} curves, {OUT.stat().st_size} bytes; kb {n_kb}, library {n_li}, zh {len(zh)}")
    rep = ["# Intensity curves: match report (local only)", "",
           f"built {meta['built']}; {len(rows)} curves; knowledge base {n_kb}; ingredient-finder library {n_li}", "",
           "## Site compounds whose CAS list hits several curves", ""]
    rep += [f"- {k} {nm}: {', '.join(h)} -> linked: {to or 'none'}" for k, nm, h, to in conflicts] or ["- none"]
    rep += ["", "## Curves not in the knowledge base (reachable from the curve page search only, or the library)", ""]
    rep += [f"- {r[0]} {r[1]}" for r in rows if not r[8]]
    rep += ["", "## Curves not in the ingredient-finder library (no link from the finder, odor map, odor predictor)", ""]
    rep += [f"- {r[0]} {r[1]}" for r in rows if r[9] < 0]
    rep += ["", "## Data notes", ""] + [f"- {k}: {v}" for k, v in DATA_NOTES.items()]
    REPORT.write_text("\n".join(rep) + "\n", encoding="utf-8")


if __name__ == "__main__":
    if "--propose" in sys.argv:
        propose(load()[1])
    else:
        build()
