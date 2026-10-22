"""Build the site's regulatory data file (EU Union list + China GB 2760-2024 tables B.2/B.3), matched by CAS
to the ingredient-finder library. Run lib_cas.py, parse_eu_annex.py and parse_gb.py first.

China has no CAS column: FEMA no. -> CAS through the FDA "Substances Added to Food" list (US public domain;
used only as a crosswalk, no US status is published). Restriction summaries come from notes.json (reviewed text).
Outputs:
  flavor-kb/data/regulatory.json                    site data (one copy, shared by all pages)
  training/data/regulatory/out/build_report.json   counts and review lists for REG-REVIEW.md
  training/data/regulatory/out/cn_unmatched.csv    GB rows that could not be matched, with the reason
"""
import collections, csv, difflib, html, io, json, re
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


hits = collections.defaultdict(lambda: {"eu": [], "cn": [], "a3": [], "us": []})
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

# EU entries also by a CAS number supplemented above (molecule matched to a GB row by structure), so the tool
# pages agree with the lookup page (glycyrrhizic acid 16.012, cystine 17.006, methionine 17.027, limonene 01.046,
# cedryl acetate 09.171, citral propylene glycol acetal 06.035, allyl 1-propenyl disulfide 12.098; user 2026-10-21)
eu_extra = []
for i, cs in extra_cas.items():
    have = {e["fl"] for e in hits[i]["eu"]}
    for e in eu["table1"]:
        if e["fl"] not in have and set(e["cas"]) & set(cs):
            hits[i]["eu"].append({"fl": e["fl"], "name": e["name"], "r": ("eu:" + e["fl"]) if e["restriction"] else None,
                                  "fn": e["footnotes"], "st": stereo(e["name"])})
            eu_extra.append((e["fl"], lib[i]["name"]))
print("EU entries added via supplemented CAS:", eu_extra)

# ---- US: 21 CFR flavouring sections (eCFR, parse_us.py) and the FDA list (CAS -> section, FEMA columns as written)
# FDA list rows in scope: citing a kept section (172.510, 172.515, 182.10-182.60, flavour-related Part 184 sections,
# 189.110/113/130/180) or with a FEMA no. FDA numbers starting with 977 are not CAS numbers (not shown, not merged).
# Section citations are checked against the current eCFR entries by name (us_name_check, for review); a cited
# section missing from the eCFR is dropped (us_dropped). 189 substances the FDA list lacks: us_189_manual.json.
usp = json.load(open(D / "out" / "us_parsed.json", encoding="utf-8"))
US_LIST = list(usp["sections"])
US_SECS = set(US_LIST) | set(usp["p184"]) | set(usp["p189"])
# removed from 172.515 by the final rule of 2018-10-09 (83 FR 50490): six under the Delaney Clause, styrene as abandoned
US_DELETED = {"119-61-9": "BENZOPHENONE", "140-88-5": "ETHYL ACRYLATE", "93-15-2": "EUGENYL METHYL ETHER",
              "123-35-3": "BETA-MYRCENE", "89-82-7": "PULEGONE", "110-86-1": "PYRIDINE", "100-42-5": "STYRENE"}
# the eCFR prints the para prefix p- as Greek rho in several 172.515 names (ρ-isopropylacetophenone)
GREEK = {"α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ω": "omega", "ε": "epsilon", "ρ": "p"}
unorm = lambda s: re.sub(r"[^a-z0-9]", "", "".join(GREEK.get(ch, ch) for ch in s.lower()))
NITROGEN = re.compile(r"AMIN|AMID|ANIL|ANTHRANIL|PYR|INDOL|GLYCIN|ALANIN|IMID|AZOL|AZIN|ADENIN|GUANI|UREA|CARBAM|NITR|CYAN|"
                      r"THIAZ|OXAZ|LEUCIN|VALIN|SERIN|PROLIN|GLUTAM|ASPART|LYSIN|ARGIN|CYST|METHION|THREON|TYROS|TRYPTO|"
                      r"HISTID|PHENYLALAN|ISOLEUC|CAPSAIC|PIPER|MORPHOL|QUINOL|ACETAMID")
CASE_PREFIX = {"cis", "trans", "sec", "tert", "alpha", "beta", "gamma", "delta", "omega", "epsilon", "dl", "d", "l", "n", "o", "m", "p", "s"}


# names of plant materials (the parenthesis then holds the botanical name even without an author abbreviation)
BOT_PART = re.compile(r"\b(OIL|EXTRACT|OLEORESIN|ABSOLUTE|LEAVES|LEAF|BARK|ROOT|SEED|FLOWERS?|HERB|BALSAM|RESIN|GUM|TINCTURE|"
                      r"JUICE|CONCRETE|BUDS?|PEEL|WOOD|BERRIES|FRUIT|RHIZOME|CHIPS|HULLS?)\b")
# place names in botanical and trade names (Balsam, Peru; Cassia bark, Saigon)
PLACES = ["peru", "tolu", "ceylon", "saigon", "padang", "batavia", "chinese", "roman", "english", "german", "indian",
          "java", "japanese", "spanish", "turkish", "egyptian", "bourbon", "mexican", "west indian", "east indian",
          "african", "american", "european", "canadian", "french", "italian", "moroccan", "zanzibar", "madagascar",
          "florida", "california", "greek", "dalmatian", "levant", "mysore", "brazilian", "jamaica", "siam", "tonka"]
BOT_LOWER = {"var.", "subsp.", "ssp.", "sp.", "spp.", "et", "ex", "or", "and", "f.", "spp", "sp", "of", "its", "hybrids",
             "other", "botanical", "sources", "the", "genus", "section", "species"}


def botanical(t):
    words, out_, epithet = t.split(" "), [], False
    for k, w in enumerate(words):
        if k == 0 or not w:
            out_.append(w[:1].upper() + w[1:]); epithet = True; continue
        if w.startswith("(") and w.endswith(")"):   # "(l.)": author in parentheses
            out_.append("(" + w[1:2].upper() + w[2:]); epithet = False; continue
        if w.startswith("(") and len(w) > 1:   # "(origanum majorana l.)": a second binomial
            out_.append("(" + w[1:2].upper() + w[2:]); epithet = True; continue
        if re.fullmatch(r"[a-z]\.", w) and out_ and (out_[-1] in ("and", "or") or out_[-1].endswith(",")):
            out_.append(w.upper()); epithet = True; continue   # "and T. zygis": abbreviated genus, then an epithet
        if w in BOT_LOWER:
            out_.append(w); epithet = w in ("var.", "subsp.", "ssp.", "f."); continue
        if epithet:     # species epithet (after the genus or a rank) stays lower case
            out_.append(w); epithet = False; continue
        out_.append(w[:1].upper() + w[1:])   # author abbreviation (L., Mill., Hook. f.)
    return " ".join(out_)


def us_case(name, pseudo=False):
    """FDA names are upper case: sentence case with the conventional case of prefixes kept (user D6, 2026-10-22).
    D-/L-/DL- (as written), N- on nitrogen (N-, N,N-), O-/S- on oxygen or sulfur when the name has another
    heteroatom locant, (E)/(Z)/(R)/(S)/(+)/(-), 2H-/1H-; otherwise n- (normal), o-/m-/p- (positions) lower case."""
    s = re.sub(r"--(PROHIBITED|NLFG)$", "", name.strip())
    up = s
    s = s.lower()
    s = re.sub(r"(?<![a-z])dl-", "DL-", s)
    s = re.sub(r"(?<![a-z\d])([dl])-(?=[a-z\d(])", lambda m: m.group(1).upper() + "-", s)
    # N-: nitrogen substituent when the name has a nitrogen keyword, else n- (normal chain)
    s = re.sub(r"(?<![a-z])n(,n)?(['′]?)-", lambda m: ("N,N" if m.group(1) else "N") + m.group(2) + "-" if NITROGEN.search(up)
               else m.group(0), s)
    # O-/S- on a heteroatom when an S-/O- locant appears with it (O-ethyl S-methyl ...) or for thioesters; o- = ortho otherwise
    s = re.sub(r"(?<![a-z])s-(?=[a-z(])", "S-", s)
    if re.search(r"(^|[\s,(])S-", up) and re.search(r"(^|[\s,(])O-", up) or "THIO" in up and re.search(r"(^|[\s,(])O-", up):
        s = re.sub(r"(?<![a-z])o-(?=[a-z])", "O-", s)
    s = re.sub(r"\((\d*[rsez](?:,\s*\d*[rsez])*)\)", lambda m: "(" + m.group(1).upper() + ")", s)
    s = re.sub(r"(?<![a-z])(\d+)h-", lambda m: m.group(1) + "H-", s)
    s = re.sub(r"(?<![a-z])([ez])-(?=\d)", lambda m: m.group(1).upper() + "-", s)
    # botanical sources "(GENUS SPECIES AUTHOR)": Genus species Author., ranks and joiners lower case; a parenthesis
    # counts as botanical when it starts with two plain words and has an author abbreviation or spp.
    def bot(m):
        c = m.group(1)
        if re.match(r"(mixed|as|from|natural|ffpa|extractive|synthetic|principally)\b", c) or not (
                re.search(r"\.|\bspp?\b", c) or pseudo or BOT_PART.search(up)):
            return m.group(0)
        return "(" + botanical(c) + ")"
    s = re.sub(r"\(([a-z][a-z]+ [a-z][a-z]+(?:[^()]*(?:\([^()]*\))?)*)\)", bot, s)
    s = re.sub(r"\b(" + "|".join(PLACES) + r")\b", lambda m: m.group(1).title(), s)
    # capitalise the first word that is not a prefix (alpha-Ionone, p-Cresol, 2-Acetylpyridine)
    for m in re.finditer(r"[a-z]+", s):
        if m.group(0) not in CASE_PREFIX | {"and", "or"}:
            return s[:m.start()] + m.group(0)[0].upper() + s[m.start() + 1:]
    return s


fda_rows = []
for r in rows[1:]:
    if not r:
        continue
    r = r + [""] * (len(H) - len(r))
    raw = clean(r[H["CAS Reg No (or other ID)"]])
    regs = {x for h_, k in H.items() if h_.startswith("Reg ") for x in re.split(r"[,;\s]+", clean(r[k])) if x}
    fema_raw = clean(r[H["FEMA No"]])
    secs = sorted(regs & US_SECS, key=lambda x: [int(y) for y in x.split(".")])
    if not secs and not fema_raw:
        continue
    others = [clean(x) for x in re.split(r"<br\s*/?>", html.unescape(r[H["Other Names"]]).replace("♦", "")) if clean(x)]
    fda_rows.append({"cas": None if raw.startswith("977") else ncas(raw), "id": raw, "name": clean(r[H["Substance"]]),
                     "others": others, "secs": secs, "fema": re.sub(r"^NLFG-", "", fema_raw), "nlfg": fema_raw.startswith("NLFG-"),
                     "gras": clean(r[H["GRAS Pub No"]]), "status": clean(r[H["FEMA status"]])})
# name check: the FDA name or one of its other names must match an eCFR entry name or synonym of the cited section;
# table sections (botanicals) match on the common name contained in the FDA name
# (botanical tables also by the binomial of the scientific name: "Cardamom seed" / CARDAMOM (ELLETARIA CARDAMOMUM ...))
binom = lambda sci: unorm(" ".join(re.findall(r"[A-Z][a-z]+ [a-z]{3,}", sci)[:1])) if sci else ""
cfr_names = {n: [[unorm(e["name"]), binom(e.get("sci", ""))] + [unorm(x) for x in e.get("syn", [])] for e in v["entries"]]
             for n, v in usp["sections"].items()}
cfr_hit = {n: [False] * len(v["entries"]) for n, v in usp["sections"].items()}
usal = json.load(open(HERE / "us_cfr_alias.json", encoding="utf-8"))
# limitation texts as written in the eCFR (172.510 Limitations column, 172.515(c)), shown verbatim (user E2)
US_LIM = []
def lim_index(t):
    if t not in US_LIM:
        US_LIM.append(t)
    return US_LIM.index(t)
us_name_check, us_dropped, us_not_found = [], [], []
for f in fda_rows:
    f["lim"], f["nf"] = {}, []
    for sec in list(f["secs"]):
        why = usal["drop"].get(f["id"] + "|" + sec)
        if why:
            f["secs"].remove(sec)
            us_dropped.append({"id": f["id"], "fda": f["name"], "sec": sec, "reason": why})
        # cited by the FDA list but not found under any name in the current section (user E5): the eCFR prevails,
        # the page shows the FEMA no. and a note
        why = usal["not_found"].get(f["id"] + "|" + sec)
        if why:
            f["secs"].remove(sec)
            f["nf"].append(sec)
            us_not_found.append({"id": f["id"], "fda": f["name"], "sec": sec, "reason": why})
    keys = {unorm(f["name"].replace("--PROHIBITED", "").replace("--NLFG", ""))} | {unorm(x) for x in f["others"]}
    for sec in f["secs"]:
        if sec not in usp["sections"]:
            continue
        table = "sci" in usp["sections"][sec]["entries"][0]
        found = [k for k, names in enumerate(cfr_names[sec]) if keys & set(names) or
                 (table and any(x and x in kk for x in names[:2] for kk in keys))]
        if not found:
            us_name_check.append({"sec": sec, "id": f["id"], "fda": f["name"]})
        for k in found:
            cfr_hit[sec][k] = True
            if usp["sections"][sec]["entries"][k]["limit"] and sec not in f["lim"]:
                f["lim"][sec] = lim_index(usp["sections"][sec]["entries"][k]["limit"])
fda_ids = {f["id"] for f in fda_rows}
for key, ids in usal["alias"].items():
    sec, name = key.split("|", 1)
    k = next(k for k, e in enumerate(usp["sections"][sec]["entries"]) if e["name"] == name)
    assert all(i in fda_ids for i in ids), key
    cfr_hit[sec][k] = True
us_cfr_only = [{"sec": n, "k": k, "name": usp["sections"][n]["entries"][k]["name"]} for n in cfr_hit
               for k, hit in enumerate(cfr_hit[n]) if not hit]
# Part 184 (user E4): only substances that are flavourings themselves - in the Union list or GB 2760, with a FEMA
# no. in the FDA list, or in the site library; other substances of these sections (calcium chloride, beeswax) left out
eu_cas_all = {c for e in eu["table1"] for c in e["cas"]}
cn_cas_all = {f["cas"] for r in cn_rows for fe in r["femas"] for f in fema2.get(fe, []) if f["cas"]} |              {c for m_ in manual.values() for c in (m_["cas"] or [])}
lib_cas_all = set(cas2lib) | {c for cs in extra_cas.values() for c in cs}
us_184_rows = collections.defaultdict(lambda: {"kept": [], "left_out": []})
for f in fda_rows:
    for sec in [x for x in f["secs"] if x.startswith("184.")]:
        ok = bool(f["fema"]) or (f["cas"] in eu_cas_all | cn_cas_all | lib_cas_all if f["cas"] else False)
        us_184_rows[sec]["kept" if ok else "left_out"].append(f["name"])
        if not ok:
            f["secs"].remove(sec)
us_184_excluded = sorted(s_ for s_ in usp["p184"] if not us_184_rows[s_]["kept"])
fda_rows = [f for f in fda_rows if f["secs"] or f["fema"]]
for c, nm in US_DELETED.items():
    f = next(f for f in fda_rows if f["cas"] == c)
    assert f["name"].replace("--NLFG", "") == nm and "172.515" not in f["secs"], (c, f)
# 189 substances named in the sections; those with an FDA --PROHIBITED row are already covered by it
us189 = json.load(open(HERE / "us_189_manual.json", encoding="utf-8"))["rows"]
fda_by_cas = {f["cas"]: f for f in fda_rows if f["cas"]}
for m_ in us189:
    if m_["fda"]:
        assert any(m_["fda"].split(" (")[0] == f["name"] and m_["sec"] in f["secs"] for f in fda_rows), m_
        continue
    fda_rows.append({"cas": m_["cas"][0] if m_["cas"] else None, "cas_all": m_["cas"], "id": "", "name": m_["name"].upper(), "others": [],
                     "secs": [m_["sec"]], "fema": "", "nlfg": False, "gras": "", "status": "", "lim": {}, "nf": [], "manual": True})


def us_entries(f, linked=True):
    """us entry strings of one FDA row: "<section>[;l<limitation index>]", "P<189 section>", "U<section>" (cited by the
    FDA list, name not in the current section), "F<FEMA>;<GRAS pubs>[;n<NLFG text>]", "D" (removed from 172.515 in
    2018), each with ;s when the row names one stereoisomer"""
    st = ";s" if linked and stereo(us_case(f["name"])) else ""
    out_ = []
    for sec in f["secs"]:
        k = "usx:%s:%s" % (ncas(f["id"]), sec)   # reviewed note on this citation (notes.json), e.g. a name difference
        out_.append(("P" + sec) if sec.startswith("189.") else sec + (";l%d" % f["lim"][sec] if sec in f["lim"] else "") +
                    (";k" + k if k in notes else ""))
    out_ += ["U" + sec for sec in f["nf"]]
    if f["fema"]:
        n = re.search(r"\((GRAS Pub\.[^)]*)\)", f["status"]) if f["nlfg"] else None
        out_.append("F" + f["fema"] + ";" + f["gras"] + (";n" + (n.group(1) if n else "") if f["nlfg"] else ""))
    if ncas(f["id"]) in US_DELETED:
        out_.append("D")
    return [e + st for e in out_]


us_cas = collections.defaultdict(list)
for f in fda_rows:
    for c in f.get("cas_all") or ([f["cas"]] if f["cas"] else []):
        us_cas[c].append(f)
for i in range(len(lib)):
    cs = {ncas(c) for c in lib[i]["cas"] if ncas(c)} | set(extra_cas.get(i, []))
    us_e = [e for c in sorted(cs) for f in us_cas.get(c, []) for e in us_entries(f)]
    if us_e:
        hits[i]["us"] += us_e
print("US rows in scope", len(fda_rows), "name check", len(us_name_check), "eCFR entries without FDA row", len(us_cfr_only))

# ---- site file, compact (decoded by assets/regulatory.js):
# item = [library index, InChIKey first block, name, SMILES, "CAS CAS", KB id, "中文名|中文名", eu, cn, annex III]
# eu entry = "FL[;r][;f<footnotes>][;s]"   r: restriction (note "eu:<FL>"), s: entry is one stereoisomer
# cn entry = "B2|B3;code;FEMA[;r][;s][;m][;c]" r: note "cn:<code>", m: CAS supplemented by this site (no usable FEMA no.),
#            c: configuration note "cnc:<code>"
# annex III = 0 none, 1 Annex III Part A with Part B maximum levels, 2 Part A only
# us entry = "<21 CFR section>[;l]" | "P<189 section>" | "F<FEMA no.>;<GRAS pub. nos>[;n<NLFG text>]" | "D", each [;s]
#            l: the eCFR entry has a limitation, n: no longer FEMA GRAS, D: removed from 172.515 in 2018
us_key = lambda e: ({"P": 0, "D": 1, "F": 3}.get(e[0], 2), [int(x) if x.isdigit() else 0 for x in re.split(r"[.;]", e.lstrip("PF"))[:2]], e)
# an entry also present without the stereo flag (malic acid and L-malic acid, both 184.1069) is shown once, without it
us_sorted = lambda es: sorted({e for e in es if not (e.endswith(";s") and e[:-2] in es)}, key=us_key)
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
                  site[i][3], "|".join(dict.fromkeys(c["zh"] for c in h["cn"])), eu_e, cn_e, (1 if any(a["part_b"] for a in h["a3"]) else 2) if h["a3"] else 0,
                  us_sorted(h["us"])])
    used.update(e.split(";k")[1].split(";")[0] for e in h["us"] if ";k" in e)
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
    "us": {"source": "21 CFR Parts 172, 182, 184 and 189 (eCFR) and the FDA list Substances Added to Food",
           "ecfr_date": usp["ecfr_date"], "ecfr_url": "https://www.ecfr.gov/current/title-21",
           "fda_updated": "2026-09-08", "fda_url": "https://www.hfpappexternal.fda.gov/scripts/fdcc/?set=FoodSubstances",
           "deleted_url": "https://www.federalregister.gov/d/2018-21807", "licence": "public domain (US government work)",
           "sections": {n: v["title"] for n, v in list(usp["sections"].items()) + list(usp["p184"].items()) + list(usp["p189"].items())}},
    "library": len(lib), "nocas": [i for i, m in enumerate(lib) if not m["cas"]],
}
out = {"meta": meta, "notes": {k: notes[k] for k in sorted(used) if k in notes}, "uslim": US_LIM, "items": items}
p = REPO / "flavor-kb" / "data" / "regulatory.json"
p.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

with open(D / "out" / "cn_unmatched.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f); w.writerow(["table", "code", "zh", "fema", "cas", "reason"]); w.writerows(cn_unmatched)
# US "permitted" for the filter (user D1): never with a Part 189 prohibition or when removed from 172.515 in
# 2018; otherwise a 21 CFR flavouring section, or a FEMA no. in the FDA list without the NLFG note
# (same rule in assets/regulatory.js)
def us_ok(es):
    k = [e.split(";")[0] for e in es]
    if any(x[0] == "P" for x in k) or "D" in k:
        return False
    return any(x[0].isdigit() for x in k) or any(e[0] == "F" and ";n" not in e for e in es)
flag = lambda col, f: sum(1 for it in items if any(f in e.split(";")[1:] or (f == "f" and ";f" in e) for e in it[col]))
report = {
    "molecules": {"any": len(items), "eu": sum(1 for it in items if it[7]), "cn": sum(1 for it in items if it[8]),
                  "both": sum(1 for it in items if it[7] and it[8]), "eu_restricted": flag(7, "r"),
                  "eu_footnote": flag(7, "f"), "eu_stereo": flag(7, "s"), "cn_restricted": flag(8, "r"), "cn_stereo": flag(8, "s"),
                  "annex3": sum(1 for it in items if it[9]), "cn_B2": sum(1 for it in items if any(e.startswith("B2") for e in it[8])),
                  "kb": sum(1 for it in items if it[5]), "no_cas_in_library": len(meta["nocas"]),
                  "us": sum(1 for it in items if it[10]), "us_permitted": sum(1 for it in items if us_ok(it[10])),
                  "us_cfr": sum(1 for it in items if any(e[0].isdigit() for e in it[10])),
                  "us_fema_only": sum(1 for it in items if it[10] and all(e[0] == "F" for e in it[10])),
                  "us_189": sum(1 for it in items if any(e[0] == "P" for e in it[10])),
                  "us_deleted": sum(1 for it in items if "D" in [e.split(";")[0] for e in it[10]]),
                  "us_nlfg": sum(1 for it in items if any(e[0] == "F" and ";n" in e for e in it[10])),
                  "us_limited": sum(1 for it in items if any(";l" in e for e in it[10])),
                  "all3": sum(1 for it in items if it[7] and it[8] and us_ok(it[10]))},
    "us_name_check": us_name_check, "us_cfr_only": us_cfr_only, "us_dropped": us_dropped, "us_not_found": us_not_found,
    "us_184": {k: {"kept": len(v["kept"]), "left_out": v["left_out"]} for k, v in sorted(us_184_rows.items())},
    "us_184_excluded": [[s_, usp["p184"][s_]["title"]] for s_ in us_184_excluded],
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

# ======== Lookup page: every Union list row, Annex III Part A and every GB 2760 B.2/B.3 row ========
# flavor-kb/data/regulatory-lookup.json, loaded only by flavor-kb/regulatory.html (the tool pages keep the file
# above). Rows sharing a CAS number form one substance; rows without CAS stay on their own ("本条无 CAS").
# substance = [display name, "中文名|…", "CAS CAS", eu[], cn[], annex III, library links, hidden search keys, us[]]
#   eu / cn entries as above, plus cn flag x (row without CAS: no "CAS matched via FEMA" line); stereo notes
#   only for substances linked to a library molecule (the note is about the site's molecules)
#   library links = [[library index, name, SMILES, KB id], …]
#   search keys (not shown): GB 2760 English names and FDA names (rows matched via FEMA no.), normalized
#   us entries as on the tool pages; display name: library, else Union list, else FDA list / eCFR name (us_case)
skey = lambda s: re.sub(r"[^0-9a-z㐀-鿿]", "", s.lower().replace("α", "alpha").replace("β", "beta")
                       .replace("γ", "gamma").replace("δ", "delta"))
# FDA list numbers starting with 977 are FDA's own identifiers, not CAS numbers (GB 2760 rows matched via FEMA to such
# a row carried them as CAS before 2026-10-22): used to group entries, not shown and not counted as a CAS number
fda_no = lambda c: c.startswith("977")
nodes = [("eu", e) for e in eu["table1"]] + [("a3", a) for a in eu["annex3_part_a"]]
for r in cn_rows:
    mrow = manual.get(r["code"])
    fda = [f for fe in r["femas"] for f in fema2.get(fe, [])]
    via = "fema" if any(f["cas"] for f in fda) else None
    cas = sorted({f["cas"] for f in fda if f["cas"]})
    if not cas and mrow and mrow["cas"]:
        cas, via = list(mrow["cas"]), "manual"
    nodes.append(("cn", dict(r, cas=cas, via=via, fda=[f["name"] for f in fda])))
# US: FDA list rows in scope (FDA 977 numbers: no CAS, own card) and eCFR entries without an FDA row (name only;
# "(see balm)" lines are cross-references inside the section, not entries of their own)
for f in fda_rows:
    # FDA numbers (977…) group the US row with GB 2760 rows matched to the same FDA row via FEMA; never shown as CAS
    nodes.append(("us", dict(f, cas=list(f.get("cas_all") or ([f["cas"]] if f["cas"] else [f["id"]] if f["id"].startswith("977") else [])))))
for x in us_cfr_only:
    if "(see " not in x["name"]:
        e_ = usp["sections"][x["sec"]]["entries"][x["k"]]
        nodes.append(("usn", {"cas": [], "sec": x["sec"], "lim": lim_index(e_["limit"]) if e_["limit"] else None,
                              "name": re.sub(r"\s+", " ", e_["name"].replace("ρ-", "p-").replace("- ", "-"))}))
# Grouping. Entries with one CAS number join others with the same CAS. An entry with several CAS numbers (a
# mixture, "x or y", isomers) joins them only if it touches at most one such group and at most one library
# molecule; otherwise it gets its own card, so it cannot chain different substances together (e.g. 14.025 and
# 14.077 methoxypyrazines, S1431, N277, S0342). It still links to every library molecule it covers, as on the
# tool pages; check_consistency.py verifies that both files agree for every molecule.
parent = list(range(len(nodes)))
def root(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]; x = parent[x]
    return x
def node_mols(n):
    li_ = set().union(*[cas2lib.get(c, set()) for c in n["cas"]]) if n["cas"] else set()
    if n.get("via") == "manual":
        li_ |= ik2lib.get(manual[n["code"]]["inchikey"][:14], set())
    return li_
first = {}
for k, (_, n) in enumerate(nodes):
    if len(n["cas"]) == 1:
        c = n["cas"][0] if isinstance(n["cas"], list) else next(iter(n["cas"]))
        if c in first: parent[root(k)] = root(first[c])
        else: first[c] = k
multi_key, standalone = {}, 0
for k, (_, n) in enumerate(nodes):
    if len(n["cas"]) < 2:
        continue
    comps = {root(first[c]) for c in n["cas"] if c in first}
    if len(comps) > 1 or len(node_mols(n)) > 1:
        standalone += 1
        continue
    if comps:
        parent[root(k)] = comps.pop()
    else:   # several entries with the same CAS set and nothing else: one card
        key = frozenset(n["cas"])
        if key in multi_key: parent[root(k)] = root(multi_key[key])
        else: multi_key[key] = k
groups = collections.defaultdict(list)
for k in range(len(nodes)):
    groups[root(k)].append(k)

subs, lused = [], set()
for g in sorted(groups.values(), key=lambda g: min(g)):
    rows_ = [nodes[k] for k in g]
    cas = sorted({c for _, n in rows_ for c in n["cas"]}, key=lambda c: [int(x) for x in c.split("-")])
    li = set().union(*[cas2lib.get(c, set()) for c in cas]) if cas else set()
    for kind, n in rows_:   # supplemented CAS rows were also matched by structure
        if kind == "cn" and n["via"] == "manual":
            li |= ik2lib.get(manual[n["code"]]["inchikey"][:14], set())
    linked = bool(li)
    eu_e, cn_e, a3, keys, zh, us_e, us_names = [], [], [], [], [], [], []
    for kind, n in rows_:
        if kind == "us":
            us_e += us_entries(n, linked)
            us_names.append(us_case(n["name"], pseudo=n["id"].startswith("977")))
            keys.append(skey(n["name"].replace("--PROHIBITED", "").replace("--NLFG", "")))
            continue
        if kind == "usn":
            us_e.append(n["sec"] + (";l%d" % n["lim"] if n["lim"] is not None else ""))
            us_names.append(n["name"])
            keys.append(skey(n["name"]))
            continue
        if kind == "eu":
            r_ = ("eu:" + n["fl"]) if n["restriction"] else None
            eu_e.append(n["fl"] + (";r" if r_ else "") + (";f" + "".join(n["footnotes"]) if n["footnotes"] else "") +
                        (";s" if linked and stereo(n["name"]) else ""))
            if r_ and r_ in notes: lused.add(r_)
            keys.append(skey(n["name"]))
        elif kind == "a3":
            a3.append(n)
            keys.append(skey(n["name"]))
        else:
            mrow = manual.get(n["code"]) if n["via"] == "manual" else None
            cfg = bool(mrow and mrow.get("config"))
            st = linked and not cfg and (stereo(n["zh"], True) or bool(mrow and mrow["inchikey"].split("-")[1] != "UHFFFAOYSA"))
            r_ = ("cn:" + n["code"]) if "cn:" + n["code"] in notes else None
            cn_e.append(";".join([n["tab"], n["code"], "+".join(n["femas"])]) + (";r" if r_ else "") + (";s" if st else "") +
                        (";m" if n["via"] == "manual" else "") + (";c" if cfg else "") + (";x" if not [c for c in n["cas"] if not fda_no(c)] else ""))
            if r_: lused.add(r_)
            if cfg: lused.add("cnc:" + n["code"])
            zh.append(n["name"])
            keys += [skey(n["en"])] + [skey(x) for x in n["fda"]]
    links = [[i, site[i][1], site[i][0], site[i][3]] for i in sorted(li)]
    eu_names = [n["name"] for kind, n in rows_ if kind in ("eu", "a3")]
    name = links[0][1] if links else (eu_names[0] if eu_names else (us_names[0] if us_names else ""))
    keys += [skey(x[1] or "") for x in links]
    shown = {skey(name)} | {skey(x) for x in zh}
    subs.append([name, "|".join(dict.fromkeys(zh)), " ".join(c for c in cas if not fda_no(c)), sorted(eu_e), sorted(cn_e, key=lambda e: e.split(";")[1]),
                 (1 if any(a["part_b"] for a in a3) else 2) if a3 else 0, links,
                 "|".join(k for k in dict.fromkeys(keys) if k and k not in shown), us_sorted(us_e)])
    lused.update(e.split(";k")[1].split(";")[0] for e in us_e if ";k" in e)
lmeta = dict(meta, nocas=None, counts={
    "eu_rows": len(eu["table1"]), "annex3": len(eu["annex3_part_a"]), "cn_rows": {"B2": len(gb["B2"]), "B3": len(gb["B3"])},
    "us_rows": len(fda_rows), "us_cfr_only": sum(1 for k, n in nodes if k == "usn"),
    "us_substances": sum(1 for s_ in subs if s_[8]), "us_only": sum(1 for s_ in subs if s_[8] and not s_[3] and not s_[4] and not s_[5]),
    "substances": len(subs), "linked": sum(1 for s in subs if s[6]), "linked_molecules": len({l[0] for s in subs for l in s[6]})})
del lmeta["nocas"]
lp = REPO / "flavor-kb" / "data" / "regulatory-lookup.json"
lp.write_text(json.dumps({"meta": lmeta, "notes": {k: notes[k] for k in sorted(lused)}, "uslim": US_LIM, "s": subs},
                         ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
restricted_all = [e["fl"] for e in eu["table1"] if e["restriction"]]
print("standalone multi-CAS entries:", standalone)
print("lookup:", json.dumps(lmeta["counts"]), "bytes", lp.stat().st_size,
      "restricted rows", len(restricted_all), "without summary", [f for f in restricted_all if "eu:" + f not in notes])
