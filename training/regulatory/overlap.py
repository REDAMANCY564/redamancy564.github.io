"""Overlap of the ingredient-finder library (by CAS) with FDA / EU / GB 2760 flavour lists
(regulatory feasibility, 2026-10-20). Run lib_cas.py, parse_gb.py and parse_eu_annex.py first.

Inputs in training/data/regulatory/: fda/foodsubstances.txt, eu/ffl.json (portal JSON, comparison only),
eu/annex1_table1_20260216.json, out/lib_cas.json, out/gb_parsed.json.
Output: training/data/regulatory/out/overlap.json
"""
import csv, io, json, re, sys, collections
from pathlib import Path

S = str(Path(__file__).resolve().parents[1] / "data" / "regulatory")
lib = json.load(open(S + "/out/lib_cas.json"))
gb = json.load(open(S + "/out/gb_parsed.json", encoding="utf-8"))


def ncas(s):
    s = (s or "").strip()
    m = re.fullmatch(r"0*(\d+)-(\d{2})-(\d)", s)
    return f"{int(m.group(1))}-{m.group(2)}-{m.group(3)}" if m else None


def clean(v):
    v = (v or "").strip()
    m = re.fullmatch(r'=T\("(.*)"\)', v)
    return (m.group(1) if m else v).strip()


# ---- FDA
lines = open(S + "/fda/foodsubstances.txt", encoding="utf-8", errors="replace").read().splitlines()
hi = next(i for i, l in enumerate(lines) if l.startswith("CAS Reg No"))
rows = list(csv.reader(io.StringIO("\n".join(lines[hi:]))))
hdr, rows = rows[0], [r for r in rows[1:] if r]
H = {h.strip(): i for i, h in enumerate(hdr)}
reg_cols = [i for h, i in H.items() if h.startswith("Reg ")]
fda = []
for r in rows:
    r = r + [""] * (len(hdr) - len(r))
    regs = {clean(r[i]) for i in reg_cols if clean(r[i])}
    fda.append({"cas": ncas(clean(r[H["CAS Reg No (or other ID)"]])), "name": clean(r[H["Substance"]]),
                "effect": clean(r[H["Used for (Technical Effect)"]]), "fema": clean(r[H["FEMA No"]]),
                "status": clean(r[H["FEMA status"]]), "jecfa": clean(r[H["JECFA Flavor Number"]]),
                "regs": regs, "p189": clean(r[H["Reg prohibited189"]])})
flav = lambda f: f["fema"] or "FLAVOR" in f["effect"].upper() or f["regs"] & {"172.515", "172.510", "182.60", "182.20", "182.10", "182.40", "182.50"}
fda_fl = [f for f in fda if flav(f)]
fema2cas = collections.defaultdict(set)
for f in fda:
    if f["fema"] and f["cas"]:
        fema2cas[f["fema"]].add(f["cas"])

# ---- EU
eu = []
def walk(n, acc):
    if n.get("value") not in (None, ""):
        acc.setdefault(n["valueIdentifier"], []).append(n["value"])
    for c in n["childrenValues"]:
        walk(c, acc)
    return acc
for it in json.load(open(S + "/eu/ffl.json", encoding="utf-8")):
    a = walk(it, {})
    eu.append({"name": (a.get("identifyingName") or [""])[0], "fl": [e.replace("E ", "") for e in a.get("eNumber", [])],
               "cas": {ncas(c) for c in a.get("casNumber", []) if ncas(c)}})

# ---- EU consolidated Annex I Part A Table 1 (consolidated version 02008R1334-20260216, up to M39 = 2026/175)
annex = []
for r in json.load(open(S + "/eu/annex1_table1_20260216.json", encoding="utf-8")):
    annex.append({"fl": r[0], "name": r[1], "cas": {ncas(c) for c in re.findall(r"\d+-\d{2}-\d", r[2]) if ncas(c)},
                  "restr": r[6].strip(), "foot": r[7].strip()})

# ---- GB 2760 (FEMA -> CAS through the FDA list)
gbr = []
for tab in ("B2", "B3"):
    for r in gb[tab]:
        gbr.append({"tab": tab, "code": r["code"], "fema": r["fema"], "cas": set(fema2cas.get(r["fema"], ())) if r["fema"] else set()})

# ---- library
L = [m for m in lib]
cas2lib = collections.defaultdict(set)
for i, m in enumerate(L):
    for c in m["cas"]:
        if ncas(c):
            cas2lib[ncas(c)].add(i)

def hits(entries):
    """library indices matched, entries matched, entries matching >1 molecule"""
    li, em, amb = set(), 0, 0
    for e in entries:
        cs = e["cas"] if isinstance(e["cas"], set) else ({e["cas"]} if e["cas"] else set())
        got = set().union(*[cas2lib.get(c, set()) for c in cs]) if cs else set()
        if got:
            em += 1
            li |= got
            amb += len(got) > 1
    return li, em, amb

def split(li):
    c = collections.Counter("kb-only" if L[i]["split"] == "kb" else L[i]["split"] for i in li)
    c["in_kb"] = sum(1 for i in li if L[i]["kb"])
    c["unseen(valid+test+kb-only)"] = sum(1 for i in li if L[i]["split"] != "train")
    return dict(c)

rep = {}
rep["library"] = {"n": len(L), "with_cas": sum(1 for m in L if m["cas"]),
                  "with_cas_kb": sum(1 for m in L if m["cas_kb"]), "with_cas_pubchem": sum(1 for m in L if m["cas_pubchem"]),
                  "multi_cas": sum(1 for m in L if len(m["cas"]) > 1), "in_kb": sum(1 for m in L if m["kb"]),
                  "in_kb_with_cas": sum(1 for m in L if m["kb"] and m["cas"])}
rep["cas_shared_by_>1_molecules"] = sum(1 for v in cas2lib.values() if len(v) > 1)

def block(name, entries, total):
    li, em, amb = hits(entries)
    rep[name] = {"list_entries": total, "entries_with_cas": sum(1 for e in entries if e["cas"]),
                 "entries_matched": em, "entries_matching_>1_molecule": amb, "library_molecules": len(li), "by_split": split(li)}
    return li

fda_all = block("FDA_flavour_subset", fda_fl, len(fda_fl))
block("FDA_with_FEMA_no", [f for f in fda if f["fema"]], sum(1 for f in fda if f["fema"]))
block("FDA_no_longer_FEMA_GRAS", [f for f in fda if "no longer" in f["status"].lower()], sum(1 for f in fda if "no longer" in f["status"].lower()))
block("FDA_21CFR_172.515", [f for f in fda if "172.515" in f["regs"]], sum(1 for f in fda if "172.515" in f["regs"]))
block("FDA_21CFR_182.60", [f for f in fda if "182.60" in f["regs"]], sum(1 for f in fda if "182.60" in f["regs"]))
block("FDA_21CFR_189", [f for f in fda if f["p189"]], sum(1 for f in fda if f["p189"]))
block("EU_portal_json", eu, len(eu))
eu_li = block("EU_annexI_20260216", annex, len(annex))
block("EU_annexI_with_restrictions", [a for a in annex if a["restr"]], sum(1 for a in annex if a["restr"]))
block("EU_annexI_with_footnote", [a for a in annex if a["foot"]], sum(1 for a in annex if a["foot"]))
rep["EU_annex_rows_without_cas"] = sum(1 for a in annex if not a["cas"])
gb_li = block("GB2760_B2+B3", gbr, len(gbr))
block("GB2760_B3", [g for g in gbr if g["tab"] == "B3"], sum(1 for g in gbr if g["tab"] == "B3"))
block("GB2760_B2", [g for g in gbr if g["tab"] == "B2"], sum(1 for g in gbr if g["tab"] == "B2"))
rep["GB_rows_with_FEMA"] = sum(1 for g in gbr if g["fema"])
rep["GB_FEMA_not_in_FDA_list"] = sum(1 for g in gbr if g["fema"] and not g["cas"])
rep["union_any"] = len(fda_all | eu_li | gb_li)
rep["EU_and_GB"] = len(eu_li & gb_li)
rep["all_three"] = len(fda_all & eu_li & gb_li)
rep["EU_or_GB"] = len(eu_li | gb_li)
rep["fda_rows"] = len(fda)
rep["fda_header"] = hdr

# spot checks
for cas in ("431-03-8", "121-33-5", "91-64-5"):
    rep["check_" + cas] = {
        "library": [L[i]["name"] for i in cas2lib.get(cas, [])],
        "fda": [(f["name"], f["fema"], f["status"], sorted(f["regs"]), f["p189"]) for f in fda if f["cas"] == cas],
        "eu": [(e["name"], e["fl"]) for e in eu if cas in e["cas"]],
        "eu_annex": [(a["fl"], a["name"], a["restr"][:80]) for a in annex if cas in a["cas"]],
        "gb": [(g["code"], g["fema"]) for g in gbr if cas in g["cas"]]}
json.dump(rep, open(S + "/out/overlap.json", "w"), indent=1, ensure_ascii=False)
print(json.dumps(rep, indent=1, ensure_ascii=False))
