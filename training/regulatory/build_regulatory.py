"""Build the site's regulatory data file (EU Union list + China GB 2760-2024 tables B.2/B.3), matched by CAS
to the ingredient-finder library. Run lib_cas.py, parse_eu_annex.py and parse_gb.py first.

China has no CAS column: FEMA no. -> CAS through the FDA "Substances Added to Food" list (US public domain;
used only as a crosswalk, no US status is published). Restriction summaries come from notes.json (reviewed text).
Outputs:
  flavor-kb/data/regulatory.json                    site data (one copy, shared by all pages)
  training/data/regulatory/out/build_report.json   counts and review lists for REG-REVIEW.md
  training/data/regulatory/out/cn_unmatched.csv    GB rows that could not be matched, with the reason
"""
import collections, csv, difflib, io, json, re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
D = REPO / "training" / "data" / "regulatory"
HERE = Path(__file__).resolve().parent
CHECKED = "2026-10-21"   # date the sources were last checked for newer versions


def ncas(s):
    m = re.fullmatch(r"0*(\d+)-(\d{2})-(\d)", (s or "").strip())
    return f"{int(m.group(1))}-{m.group(2)}-{m.group(3)}" if m else None


def clean(v):
    v = (v or "").strip()
    m = re.fullmatch(r'=T\("(.*)"\)', v)
    return (m.group(1) if m else v).strip()


# ---- library (training order == ingredient-finder/data/library.json order, checked here)
lib = json.load(open(D / "out" / "lib_cas.json"))
site = json.load(open(REPO / "ingredient-finder" / "data" / "library.json", encoding="utf-8"))["molecules"]
train = json.load(open(REPO / "training" / "data" / "ingredient" / "library.json", encoding="utf-8"))["molecules"]
assert len(lib) == len(site) == len(train)
assert all(t["smiles"] == s[0] and t["inchikey"] == l["inchikey"] for t, s, l in zip(train, site, lib))
cas2lib = collections.defaultdict(set)
for i, m in enumerate(lib):
    for c in m["cas"]:
        if ncas(c):
            cas2lib[ncas(c)].add(i)

# ---- FDA list: FEMA no. -> CAS (and substance name, for the name cross-check)
lines = open(D / "fda" / "foodsubstances.txt", encoding="utf-8", errors="replace").read().splitlines()
hi = next(i for i, l in enumerate(lines) if l.startswith("CAS Reg No"))
rows = list(csv.reader(io.StringIO("\n".join(lines[hi:]))))
H = {h.strip(): i for i, h in enumerate(rows[0])}
fema2 = collections.defaultdict(list)
for r in rows[1:]:
    if not r:
        continue
    r = r + [""] * (len(H) - len(r))
    # "NLFG-3470" = FEMA no. 3470, no longer FEMA GRAS (the GB listing does not depend on FEMA status)
    fema, cas = re.sub(r"^NLFG-", "", clean(r[H["FEMA No"]])), ncas(clean(r[H["CAS Reg No (or other ID)"]]))
    if fema:
        fema2[fema].append({"cas": cas, "name": clean(r[H["Substance"]])})

# ---- EU
eu = json.load(open(D / "out" / "eu_parsed.json", encoding="utf-8"))
notes = json.load(open(HERE / "notes.json", encoding="utf-8"))

# stereo-specific entries: the library has no stereo information (R/S, E/Z removed)
# bare "S-" is left out: in thioesters (S-Methyl thioacetate) it names the sulfur atom, not a configuration
STEREO_EN = re.compile(r"(^|[\s(\[,-])(d|l|D|L)-|\((\d*[RSEZ](,\s*\d*[RSEZ])*|[+-])\)|\[[RS]-|(^|[\s(\[-])(E|Z)-|"
                       r"(^|[^-\w])(cis|trans)-|\b(alpha|beta)-[DL]-|^\(?[+-]\)?-")
RACEMIC = re.compile(r"\(\+/-\)|\(±\)|(^|[^a-z])dl-|DL-|d,l-|D,L-|racem|cis- ?and ?trans-|cis and trans|\(E,Z\)|\(Z,E\)|"
                     r"mixture of|E/Z|Z/E|R/S|S/R|\(R,S\)|\(RS\)", re.I)
STEREO_ZH = re.compile(r"顺式|反式|左旋|右旋|(^|[^a-zA-Z])[dlDL]-|\([RSEZ]\)")
RACEMIC_ZH = re.compile(r"顺式和反式|顺反|dl-|DL-|d,l-|D,L-|\(\+/-\)|消旋")


def stereo(name, zh=False):
    if zh:
        return bool(STEREO_ZH.search(name)) and not RACEMIC_ZH.search(name)
    return bool(STEREO_EN.search(name)) and not RACEMIC.search(name)


hits = collections.defaultdict(lambda: {"eu": [], "cn": [], "a3": []})
eu_multi, eu_restricted = [], []
for e in eu["table1"]:
    got = set().union(*[cas2lib.get(c, set()) for c in e["cas"]]) if e["cas"] else set()
    if len(got) > 1:
        eu_multi.append({"fl": e["fl"], "name": e["name"], "cas": e["cas"], "library": sorted(lib[i]["name"] or "" for i in got)})
    if e["restriction"] and got:
        eu_restricted.append({"fl": e["fl"], "name": e["name"], "restriction": e["restriction"],
                              "library": sorted(lib[i]["name"] or "" for i in got), "note": "eu:" + e["fl"] in notes})
    for i in got:
        hits[i]["eu"].append({"fl": e["fl"], "name": e["name"], "r": ("eu:" + e["fl"]) if e["restriction"] else None,
                              "fn": e["footnotes"], "st": stereo(e["name"])})
a3_hits = []
for a in eu["annex3_part_a"]:
    got = set().union(*[cas2lib.get(c, set()) for c in a["cas"]])
    a3_hits.append({"name": a["name"], "cas": a["cas"], "library": sorted(lib[i]["name"] or "" for i in got)})
    for i in got:
        hits[i]["a3"].append(a)

# ---- China
gb = json.load(open(D / "out" / "gb_parsed.json", encoding="utf-8"))
norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
cn_unmatched, name_check, cn_multi = [], [], []
cn_rows = [dict(r, tab=t) for t in ("B2", "B3") for r in gb[t]]
# rows without a usable FEMA no.: CAS checked by this site in PubChem (cn_cas_manual.json, user-reviewed);
# matched by CAS or by structure (InChIKey first block), shown with 「CAS 为本站核实补充」
manual = json.load(open(HERE / "cn_cas_manual.json", encoding="utf-8"))["rows"]
ik2lib = collections.defaultdict(set)
for i, m in enumerate(lib):
    ik2lib[m["inchikey"][:14]].add(i)
manual_hits, extra_cas = [], collections.defaultdict(list)
for r in cn_rows:
    mrow = manual.get(r["code"])
    if mrow and mrow["cas"] and not any(fema2.get(fe) for fe in r["femas"]):
        got = set().union(*[cas2lib.get(c, set()) for c in mrow["cas"]]) | ik2lib.get(mrow["inchikey"][:14], set())
        manual_hits.append({"code": r["code"], "zh": r["name"], "cas": mrow["cas"], "pubchem": mrow["pubchem_title"],
                            "cid": mrow["pubchem_cid"], "library": sorted(lib[i]["name"] or "" for i in got)})
        if not got:
            cn_unmatched.append([r["tab"], r["code"], r["zh"], "+".join(r["femas"]), " ".join(mrow["cas"]), "CAS (supplemented) not in the site library"]); continue
        for i in got:
            extra_cas[i] += mrow["cas"]
            # stereo note also when the PubChem record has stereo layers (the library has none); a configuration
            # note (cnc:<code>) replaces it where the GB name gives no configuration
            cfg = bool(mrow.get("config"))
            st = not cfg and (stereo(r["zh"], True) or mrow["inchikey"].split("-")[1] != "UHFFFAOYSA")
            hits[i]["cn"].append({"t": r["tab"], "code": r["code"], "fema": "+".join(r["femas"]), "zh": r["name"], "m": True, "c": cfg,
                                  "r": ("cn:" + r["code"]) if "cn:" + r["code"] in notes else None, "st": st})
        continue
    if not r["femas"]:
        cn_unmatched.append([r["tab"], r["code"], r["zh"], "", "", "no FEMA no. in GB 2760"]); continue
    cands = [f for fe in r["femas"] for f in fema2.get(fe, [])]
    if not cands:
        cn_unmatched.append([r["tab"], r["code"], r["zh"], "+".join(r["femas"]), "", "FEMA no. not in the FDA list"]); continue
    cas = sorted({f["cas"] for f in cands if f["cas"]})
    if not cas:
        cn_unmatched.append([r["tab"], r["code"], r["zh"], "+".join(r["femas"]), "", "FDA entry has no CAS"]); continue
    got = set().union(*[cas2lib.get(c, set()) for c in cas])
    if not got:
        cn_unmatched.append([r["tab"], r["code"], r["zh"], "+".join(r["femas"]), " ".join(cas), "CAS not in the site library"]); continue
    best = max(difflib.SequenceMatcher(None, norm(r["en"]), norm(f["name"])).ratio() for f in cands)
    if best < 0.6:
        name_check.append({"code": r["code"], "zh": r["zh"], "gb_en": r["en"], "fema": r["femas"],
                           "fda": [f["name"] for f in cands], "ratio": round(best, 2), "library": sorted(lib[i]["name"] or "" for i in got)})
    if len(got) > 1:
        cn_multi.append({"code": r["code"], "zh": r["zh"], "cas": cas, "library": sorted(lib[i]["name"] or "" for i in got)})
    for i in got:
        hits[i]["cn"].append({"t": r["tab"], "code": r["code"], "fema": "+".join(r["femas"]), "zh": r["name"], "m": False, "c": False,
                              "r": ("cn:" + r["code"]) if "cn:" + r["code"] in notes else None, "st": stereo(r["zh"], True)})

# ---- site file, compact (decoded by assets/regulatory.js):
# item = [library index, InChIKey first block, name, SMILES, "CAS CAS", KB id, "中文名|中文名", eu, cn, annex III]
# eu entry = "FL[;r][;f<footnotes>][;s]"   r: restriction (note "eu:<FL>"), s: entry is one stereoisomer
# cn entry = "B2|B3;code;FEMA[;r][;s][;m][;c]" r: note "cn:<code>", m: CAS supplemented by this site (no usable FEMA no.),
#            c: configuration note "cnc:<code>"
# annex III = 0 none, 1 Annex III Part A with Part B maximum levels, 2 Part A only
items, used = [], set()
for i in sorted(hits):
    h, m = hits[i], lib[i]
    eu_e = []
    for e in sorted(h["eu"], key=lambda e: e["fl"]):
        eu_e.append(e["fl"] + (";r" if e["r"] else "") + (";f" + "".join(e["fn"]) if e["fn"] else "") + (";s" if e["st"] else ""))
        if e["r"]: used.add(e["r"])
    cn_e = []
    for c in sorted(h["cn"], key=lambda c: c["code"]):
        cn_e.append(";".join([c["t"], c["code"], c["fema"]]) + (";r" if c["r"] else "") + (";s" if c["st"] else "") + (";m" if c["m"] else "") + (";c" if c["c"] else ""))
        if c["r"]: used.add(c["r"])
        if c["c"]: used.add("cnc:" + c["code"])
    items.append([i, m["inchikey"][:14], site[i][1], site[i][0], " ".join(dict.fromkeys([ncas(c) for c in m["cas"] if ncas(c)] + extra_cas[i])),
                  site[i][3], "|".join(dict.fromkeys(c["zh"] for c in h["cn"])), eu_e, cn_e, (1 if any(a["part_b"] for a in h["a3"]) else 2) if h["a3"] else 0])
missing = sorted(used - set(notes))
meta = {
    "checked": CHECKED,
    "eu": {"source": "Regulation (EC) No 1334/2008, Annex I Part A (Union list), consolidated version 2026-02-16",
           "celex": "02008R1334-20260216", "last_amendment": "Commission Regulation (EU) 2026/175",
           "url": "https://eur-lex.europa.eu/eli/reg/2008/1334/2026-02-16", "licence": "CC BY 4.0",
           "licence_url": "https://commission.europa.eu/legal-notice_en", "rows": len(eu["table1"])},
    "cn": {"source": "GB 2760-2024, tables B.2 and B.3", "published": "2024-02-08", "in_force": "2025-02-08",
           "amendments": "none included", "url": "https://sppt.cfsa.net.cn:8086/db",
           "rows": {"B2": len(gb["B2"]), "B3": len(gb["B3"])}},
    "library": len(lib), "nocas": [i for i, m in enumerate(lib) if not m["cas"]],
}
out = {"meta": meta, "notes": {k: notes[k] for k in sorted(used) if k in notes}, "items": items}
p = REPO / "flavor-kb" / "data" / "regulatory.json"
p.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

with open(D / "out" / "cn_unmatched.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f); w.writerow(["table", "code", "zh", "fema", "cas", "reason"]); w.writerows(cn_unmatched)
flag = lambda col, f: sum(1 for it in items if any(f in e.split(";")[1:] or (f == "f" and ";f" in e) for e in it[col]))
report = {
    "molecules": {"any": len(items), "eu": sum(1 for it in items if it[7]), "cn": sum(1 for it in items if it[8]),
                  "both": sum(1 for it in items if it[7] and it[8]), "eu_restricted": flag(7, "r"),
                  "eu_footnote": flag(7, "f"), "eu_stereo": flag(7, "s"), "cn_restricted": flag(8, "r"), "cn_stereo": flag(8, "s"),
                  "annex3": sum(1 for it in items if it[9]), "cn_B2": sum(1 for it in items if any(e.startswith("B2") for e in it[8])),
                  "kb": sum(1 for it in items if it[5]), "no_cas_in_library": len(meta["nocas"])},
    "cn_unmatched_by_reason": collections.Counter(r[5] for r in cn_unmatched),
    "cn_rows_matched": len(cn_rows) - len(cn_unmatched),
    "eu_rows_matched": sum(1 for e in eu["table1"] if any(cas2lib.get(c) for c in e["cas"])),
    "eu_restricted": eu_restricted, "annex3": a3_hits, "eu_multi": eu_multi, "cn_multi": cn_multi,
    "cn_name_check": name_check, "cn_manual": manual_hits, "notes_missing": missing,
    "size_bytes": p.stat().st_size,
}
json.dump(report, open(D / "out" / "build_report.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps({k: v for k, v in report.items() if k in ("molecules", "cn_unmatched_by_reason", "cn_rows_matched",
                                                          "eu_rows_matched", "size_bytes")}, ensure_ascii=False))
print("eu restricted", len(eu_restricted), "eu multi", len(eu_multi), "cn multi", len(cn_multi),
      "name check", len(name_check), "notes missing", len(missing))
