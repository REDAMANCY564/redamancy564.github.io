"""Build the flavor knowledge base (tier 1 data) for flavor-kb/.

Inputs
  training/data/flavordb_raw/entity_*.json   (fetch_flavordb.py; FlavorDB2, CC BY-NC-SA 3.0)
  training/knowledge/dunkel2014_main_text.json (KFO statements from the main text of Dunkel et al. 2014)
  odor-predictor/data/presets.json            (compounds already on the site)
  training/data/foodb/foodb_subset.json       (training/foodb/extract_foodb.py; FooDB 2020-04-07, CC BY-NC 4.0)
  training/knowledge/author_milk.json         (author's published data: human milk, Cui et al. Food Bioscience 2026)
  training/knowledge/extra_compounds.json     (compounds of the author's data not yet in the knowledge base)
Outputs (flavor-kb/data/)
  compounds.json  id -> compound record
  foods.json      id -> food record (FlavorDB ingredients, FooDB foods, Dunkel foods)
  refs.json       FooDB references (database names, article and textbook citations), indexed from compounds.json "ds"
  meta.json       sources, licenses, counts, update record, build date
  LICENSE.md      license notices (FlavorDB2 CC BY-NC-SA 3.0, FooDB CC BY-NC 4.0)

Food links (2026-11-20, user decisions):
  - FlavorDB2 links of "bulk" molecules are hidden: molecules whose FooDB record links them to >= 300 foods
    without any reference (FlavorDB2 took over these FooDB entries). Such a link stays only when a referenced
    FooDB entry (compound or nutrient) confirms the same food (FlavorDB and FooDB foods matched by exact name).
  - FooDB links with a reference are added (PREDICTED and unreferenced entries are not used).
  - Human milk: Table S1 volatiles (except the 4 migrants named in its footnote) and the defined fatty acids
    of Table S2 of Cui et al. 2026, source "author's published data". The 10 compounds of its Table 1 (ROAV >= 1
    and perceived in GC-O) are the key flavor compounds of human milk (foods.json "kfo", "kfo_src": "author"),
    the same tier as the Dunkel 2014 key food odorants.
  compounds.json "det" lists every shown food; "ds" {food id: [codes]} gives the sources of a link when it is
  not FlavorDB alone: "F" FlavorDB2, a number = refs.json index (FooDB), "S1"/"S2" = author's Table S1/S2.
  "fdbm": "sk14" when FooDB matched only the skeleton (first 14 InChIKey characters: stereo not distinguished),
  "cas" when matched by CAS number.

Compounds are merged across sources by standard InChI with stereo layers removed
(the browser computes the same key with RDKit.js, see flavor-kb/kb.js).
"""
import datetime
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "training" / "data" / "flavordb_raw"
CACHE = ROOT / "training" / "data" / "pubchem_cache.json"
DUNKEL = Path(__file__).parent / "dunkel2014_main_text.json"
PRESETS = ROOT / "odor-predictor" / "data" / "presets.json"
OUT = ROOT / "flavor-kb" / "data"

PUG = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound"
FLAVORDB_DOI = "10.1093/nar/gkx957"
STEREO_LAYERS = ("/b", "/t", "/m", "/s")


# ---------- structure keys ----------
def inchi_key_nostereo(smiles):
    """Standard InChI with stereo layers (/b /t /m /s) removed, or None."""
    mol = Chem.MolFromSmiles(smiles) if smiles else None
    if mol is None:
        return None
    inchi = Chem.MolToInchi(mol)
    if not inchi:
        return None
    parts = inchi.split("/")
    return "/".join([parts[0]] + [p for p in parts[1:] if "/" + p[:1] not in STEREO_LAYERS])


# ---------- PubChem (cached) ----------
class PubChem:
    def __init__(self, path):
        self.path = path
        self.cache = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def save(self):
        self.path.write_text(json.dumps(self.cache, indent=0, ensure_ascii=False), encoding="utf-8")

    def _get(self, url):
        if url in self.cache:
            return self.cache[url]
        time.sleep(0.25)  # PubChem asks for at most 5 requests per second
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = json.loads(r.read())
        except urllib.error.HTTPError as e:
            data = {"_error": e.code}
        self.cache[url] = data
        return data

    def by_name(self, name):
        url = f"{PUG}/name/{urllib.parse.quote(name)}/property/SMILES,Title/JSON"
        d = self._get(url)
        props = d.get("PropertyTable", {}).get("Properties", [])
        return props[0] if props else None

    def by_inchikey(self, key):
        d = self._get(f"{PUG}/inchikey/{key}/property/Title/JSON")
        props = d.get("PropertyTable", {}).get("Properties", [])
        return props[0] if props else None

    def synonyms(self, cid):
        d = self._get(f"{PUG}/cid/{cid}/synonyms/JSON")
        info = d.get("InformationList", {}).get("Information", [])
        return info[0].get("Synonym", []) if info else []


SYN_REJECT = re.compile(r"^(\d{2,7}-\d{2}-\d|UNII|EINECS|EC |FEMA|NSC|CHEBI|DTXSID|HSDB|BRN|AI3|CCRIS|MFCD|SCHEMBL|AKOS|DB\d|InChI|[A-Z0-9]{10,}$)", re.I)


def clean_synonyms(names, limit=12):
    out, seen = [], set()
    for s in names:
        s = s.strip()
        k = s.lower()
        if k in seen or not (4 <= len(s) <= 40) or SYN_REJECT.search(s) or s.isupper() and len(s) > 6:
            continue
        seen.add(k)
        out.append(s)
        if len(out) >= limit:
            break
    return out


def split_profile(s):
    if not s:
        return []
    items = [x.strip().lower() for x in re.split(r"[@,]", s) if x.strip()]
    return list(dict.fromkeys(items))


# ---------- FooDB and the author's published data (2026-11-20) ----------
FOODB = ROOT / "training" / "data" / "foodb" / "foodb_subset.json"
AUTHOR = Path(__file__).parent / "author_milk.json"
EXTRA = Path(__file__).parent / "extra_compounds.json"
HIDDEN_OUT = ROOT / "training" / "data" / "foodb" / "hidden_flavordb_links.json"
# Chinese names of dairy foods (user list 2026-11-20, rest proposed; review list _inputs/ZH-NAMES-REVIEW-2.md).
# 乳 for milk itself and its fractions (牛乳, 羊乳, 乳脂, 乳清), customary 奶 words kept (奶粉, 酸奶, 炼乳).
DAIRY_ZH = {
    "Milk": "牛乳", "Goat Milk": "山羊乳", "Sheep Milk": "绵羊乳", "Milk Fat": "乳脂", "Milk Powder": "奶粉",
    "Skimmed Milk": "脱脂乳", "Butter": "黄油", "Cream": "稀奶油", "Sour cream": "酸奶油", "Yogurt": "酸奶",
    "Whey": "乳清", "Buttermilk": "酪乳", "Condensed milk": "炼乳", "Evaporated milk": "淡炼乳", "Ice cream": "冰淇淋",
    "Processed cheese": "再制干酪", "Cheese": "干酪", "Cheddar Cheese": "切达干酪",
    # proposed
    "Blue Cheese": "蓝纹干酪", "Camembert Cheese": "卡门贝尔干酪", "Comte Cheese": "孔泰干酪", "Cottage Cheese": "农家干酪",
    "Cream Cheese": "奶油干酪", "Domiati Cheese": "多米亚蒂干酪", "Emmental Cheese": "埃门塔尔干酪", "Feta Cheese": "菲达干酪",
    "Goat Cheese": "山羊乳干酪", "Gruyere Cheese": "格吕耶尔干酪", "Limburger Cheese": "林堡干酪", "Mozzarella Cheese": "马苏里拉干酪",
    "Munster Cheese": "芒斯特干酪", "Other Cheeses": "其他干酪", "Parmesan Cheese": "帕玛森干酪", "Provolone Cheese": "波罗伏洛干酪",
    "Romano Cheese": "罗马诺干酪", "Roquefort Cheese": "洛克福干酪", "Russian Cheese": "俄罗斯干酪", "Sheep Cheese": "绵羊乳干酪",
    "Swiss Cheese": "瑞士干酪", "Tilsit Cheese": "提尔西特干酪", "Ricotta Cheese": "里科塔干酪", "Paneer": "帕尼尔干酪",
    "Dairy Products": "乳制品", "Ghee": "印度酥油", "Ymer": "伊默发酵乳", "Kefir": "开菲尔", "Other fermented milk": "其他发酵乳",
    "Dulce de leche": "牛奶焦糖酱", "Sweet custard": "甜蛋奶冻", "Junket": "凝乳甜点", "Milk and milk products": "乳及乳制品",
    "Milk (Other mammals)": "其他哺乳动物乳", "Salted butter": "含盐黄油", "Frozen yogurt": "冻酸奶", "Milkshake": "奶昔",
    "Casein": "酪蛋白", "cultured butter": "发酵黄油",
    "Cow milk, pasteurized, vitamin A + D added, 1% fat": "巴氏杀菌牛乳（添加维生素 A、D，脂肪 1%）",
    "Cow milk, pasteurized, vitamin A + D added, 2% fat": "巴氏杀菌牛乳（添加维生素 A、D，脂肪 2%）",
    "Cow milk, pasteurized, vitamin D added, 3.25% fat": "巴氏杀菌牛乳（添加维生素 D，脂肪 3.25%）",
}


# FlavorDB and FooDB names of the same food that do not match exactly (user decision 2026-11-20, dairy only):
# FlavorDB entity id -> FooDB food id. The FlavorDB name is kept, the FooDB name becomes a synonym; the pair also
# counts as the same food when a referenced FooDB entry confirms a FlavorDB link of a bulk molecule.
# Kept apart on purpose: cow milk 1 %, 2 %, 3.25 % fat; salted butter; "Dairy Products" / "Milk and milk products";
# goat, sheep and "other mammals" milk; cheese varieties.
SAME_FOOD = {"88": "632",    # Milk (cattle)      = Milk (Cow)
             "91": "711",    # Milk Powder        = Dried milk
             "93": "921",    # Skimmed Milk       = Cow milk, pasteurized, vitamin A + D added, 0% fat
             "89": "785"}    # Milk Fat           = Butterfat


def code_order(c):
    return (0, 0) if c == "F" else (1, c) if isinstance(c, int) else (2, 0) if c == "S1" else (3, 0)


def add_foodb_and_author(compounds, foods, upsert, pc):
    """Adds FooDB and author links, hides FlavorDB bulk links; returns (links {key: {food id: [codes]}}, stats)."""
    fs = json.loads(FOODB.read_text(encoding="utf-8"))
    am = json.loads(AUTHOR.read_text(encoding="utf-8"))
    extra = json.loads(EXTRA.read_text(encoding="utf-8"))
    links = {}
    for fid, f in foods.items():
        if f["source"] == "flavordb":
            for key in f["detected"]:
                links.setdefault(key, {})[fid] = ["F"]
    n_fl_before = sum(len(v) for v in links.values())

    by_key = {}
    for ik, m in fs["molecules"].items():
        k = inchi_key_nostereo(m["smiles"])
        if k:
            by_key.setdefault(k, []).append((ik, m))
    fmap = dict(fs["flavordb_food_map"])                # FlavorDB entity id -> FooDB food id (exact name)
    fmap.update(SAME_FOOD)                              # + the same food under another name (user decision)
    fo2site = {}
    for eid in sorted(fmap, key=int):
        fo2site.setdefault(fmap[eid], f"fdb{eid}")

    def site_food(f):
        if f in fo2site:
            fid = fo2site[f]
            foods[fid]["foodb"] = f
            fo_name = fs["foods"][f]["name"]
            if fo_name.lower() != foods[fid]["name"].lower() and fo_name not in foods[fid]["synonyms"]:
                foods[fid]["synonyms"].append(fo_name)
            return fid
        fid = "fo" + f
        if fid not in foods:
            info = fs["foods"][f]
            foods[fid] = {"name": info["name"], "category": info["group"] or "FooDB", "synonyms": [],
                          "source": "foodb", "detected": [], "foodb": f}
        return fid

    # 1. hide FlavorDB links of bulk molecules unless a referenced FooDB entry confirms the food
    hidden = []
    for key, lk in links.items():
        ms = [m for _, m in by_key.get(key, [])]
        if not any(m["uncited_max"] >= fs["bulk_min"] for m in ms):
            continue
        cited = set().union(*(set(m["foods"]) for m in ms))
        for fid in list(lk):
            f = fmap.get(fid[3:])
            if not (f and f in cited):
                hidden.append([compounds[key]["names"][0], foods[fid]["name"]])
                del lk[fid]
    n_hidden_mols = len({h[0] for h in hidden})

    # 2. FooDB links with a reference (and the compounds they bring into the knowledge base)
    n_new_foodb = 0
    for key, pairs in by_key.items():
        with_foods = [(ik, m) for ik, m in pairs if m["foods"]]
        if not with_foods:
            continue
        if key not in compounds:
            ik, m = with_foods[0]
            p = pc.by_inchikey(ik)
            name = m["name"] or (p or {}).get("Title") or m["smiles"]
            upsert(key, name=name, cid=(p or {}).get("CID"), smiles=m["smiles"])
            compounds[key]["origin"] = "foodb"
            n_new_foodb += 1
        lk = links.setdefault(key, {})
        for ik, m in with_foods:
            for f, refs in m["foods"].items():
                if f not in fs["foods"]:      # food id missing from Food.csv
                    continue
                codes = lk.setdefault(site_food(f), [])
                codes.extend(r for r in refs if r not in codes)
            if m.get("nutrient_note"):
                compounds[key]["isomer_note"] = m["nutrient_note"]
        kinds = {m["match"] for _, m in with_foods}
        if "full" not in kinds:
            compounds[key]["fdbm"] = "sk14" if "sk14" in kinds else "cas"

    # 3. the author's published data: human milk (Table S1 volatiles, Table S2 fatty acids)
    n_new_author = 0
    for e in extra:
        key = inchi_key_nostereo(e["smiles"])
        if key not in compounds:
            n_new_author += 1
            upsert(key, name=e["name"], cid=e["cid"], smiles=e["smiles"])
            compounds[key]["origin"] = "author"
    milk = next(fid for fid, f in foods.items() if f["source"] == "flavordb" and f["name"] == "Milk Human")
    mf = foods[milk]
    mf["name"], mf["zh"] = "Human milk", "母乳"
    mf["synonyms"] = list(dict.fromkeys(["Milk Human", "Milk (Human)", "Breast milk"] + mf["synonyms"]))
    # Table 1: key flavor compounds of human milk (ROAV >= 1 and perceived in GC-O), same tier as Dunkel's
    mf["kfo"] = []
    for r in am["T1"]:
        key = inchi_key_nostereo(r["smiles"])
        assert key in compounds, r
        if key not in mf["kfo"]:
            mf["kfo"].append(key)
    mf["kfo_src"] = "author"
    n_author = {"S1": 0, "S2": 0}
    for table in ("S1", "S2"):
        for r in am[table]:
            if r.get("migrant"):
                continue
            key = inchi_key_nostereo(r["smiles"])
            assert key in compounds, r
            codes = links.setdefault(key, {}).setdefault(milk, [])
            if table not in codes:
                codes.append(table)
                n_author[table] += 1

    # 4. food records follow the links (FlavorDB order kept, new links appended)
    det = {}
    for fid, f in foods.items():
        for key in f.get("detected", []):
            if fid in links.get(key, {}):
                det.setdefault(fid, []).append(key)
    for key, lk in links.items():
        for fid, codes in lk.items():
            codes.sort(key=code_order)
            if key not in det.get(fid, []):
                det.setdefault(fid, []).append(key)
    for fid, f in foods.items():
        if f["source"] in ("flavordb", "foodb"):
            f["detected"] = det.get(fid, [])
        srcs = set()
        for key in f.get("detected", []):
            for c in links[key][fid]:
                srcs.add("flavordb" if c == "F" else "author" if isinstance(c, str) else "foodb")
        if srcs and srcs != {f["source"]}:
            f["sources"] = [x for x in ("flavordb", "foodb", "author") if x in srcs]
    for fid in [fid for fid, f in foods.items() if f["source"] == "foodb" and not f["detected"]]:
        del foods[fid]

    def count(pred):
        mols = {k for k, lk in links.items() for c in lk.values() if any(pred(x) for x in c)}
        n = sum(1 for lk in links.values() for c in lk.values() if any(pred(x) for x in c))
        return len(mols), n
    stats = {
        "refs": fs["refs"],
        "flavordb": dict(zip(("molecules", "links"), count(lambda c: c == "F")), links_before=n_fl_before,
                         hidden=len(hidden), hidden_molecules=n_hidden_mols),
        "foodb": dict(zip(("molecules", "links"), count(lambda c: isinstance(c, int))),
                      foods=sum(1 for f in foods.values() if f.get("foodb")), new_compounds=n_new_foodb,
                      molecules_sk14=sum(1 for c in compounds.values() if c.get("fdbm") == "sk14")),
        "author": dict(zip(("molecules", "links"), count(lambda c: c in ("S1", "S2"))), s1=n_author["S1"], s2=n_author["S2"],
                       new_compounds=n_new_author, kfo=len(mf["kfo"])),
    }
    HIDDEN_OUT.parent.mkdir(parents=True, exist_ok=True)
    HIDDEN_OUT.write_text(json.dumps(hidden, ensure_ascii=False, indent=0), encoding="utf-8")
    print("FooDB/author:", json.dumps({k: {a: b for a, b in v.items()} for k, v in stats.items() if k != "refs"}))
    return links, stats


# ---------- build ----------
def main():
    pc = PubChem(CACHE)
    compounds = {}       # inchi key -> record
    foods = {}

    def upsert(key, **fields):
        rec = compounds.setdefault(key, {"names": [], "synonyms": [], "flavor": [], "fema": "",
                                         "dunkel": None, "foods_kfo": [], "foods_detected": []})
        for k, v in fields.items():
            if k == "name" and v and v.lower() not in (n.lower() for n in rec["names"]):
                rec["names"].append(v)
            elif k == "flavor":
                rec["flavor"] = list(dict.fromkeys(rec["flavor"] + v))
            elif v and not rec.get(k):
                rec[k] = v
        return rec

    # FlavorDB ingredients and detected molecules
    raw_files = sorted(RAW_DIR.glob("entity_*.json"), key=lambda p: int(p.stem.split("_")[1]))
    n_links = 0
    for f in raw_files:
        e = json.loads(f.read_text(encoding="utf-8"))
        fid = f"fdb{e['entity_id']}"
        mols = []
        for m in e.get("molecules", []):
            key = inchi_key_nostereo(m.get("smile"))
            if not key:
                continue
            upsert(key, name=m.get("common_name"), cid=m.get("pubchem_id"), smiles=m.get("smile"),
                   flavor=split_profile(m.get("flavor_profile")), fema=m.get("fema_flavor_profile") or "")
            mols.append(key)
        mols = list(dict.fromkeys(mols))
        n_links += len(mols)
        foods[fid] = {"name": e.get("entity_alias_readable"), "category": e.get("category_readable"),
                      "synonyms": [s for s in (e.get("entity_alias_synonyms") or "").split(", ") if s][:8],
                      "source": "flavordb", "detected": mols}
    print(f"FlavorDB: {len(raw_files)} ingredients, {n_links} ingredient-molecule links")

    # Dunkel 2014 main text
    dk = json.loads(DUNKEL.read_text(encoding="utf-8"))
    unresolved = []

    def resolve(name):
        p = pc.by_name(dk.get("pubchem_query", {}).get(name, name))
        if not p:
            unresolved.append(name)
            return None
        key = inchi_key_nostereo(p["SMILES"])
        return key, p

    for c in dk["generalists"]["compounds"]:
        r = resolve(c["name"])
        if r:
            key, p = r
            upsert(key, name=c["name"], cid=p["CID"], smiles=p["SMILES"])
            compounds[key]["dunkel"] = {"generalist": True, "odor": c["odor"], "page": dk["generalists"]["page"]}
    for i, fd in enumerate(dk["foods"]):
        fid = "dk" + re.sub(r"[^a-z0-9]+", "-", fd["food"].lower()).strip("-")
        food = foods.setdefault(fid, {"name": fd["food"], "category": "Dunkel et al. 2014", "synonyms": [],
                                      "source": "dunkel", "kfo": [], "statements": []})
        food["statements"].append({"text": fd["statement"], "page": fd["page"], "complete": fd.get("complete", False)})
        for name in fd["compounds"]:
            r = resolve(name)
            if not r:
                continue
            key, p = r
            upsert(key, name=name, cid=p["CID"], smiles=p["SMILES"])
            if key not in food["kfo"]:
                food["kfo"].append(key)
    print(f"Dunkel: {sum(1 for f in foods.values() if f['source'] == 'dunkel')} foods; unresolved names: {unresolved}")

    # Compounds already on the site (odor-predictor presets)
    presets = json.loads(PRESETS.read_text(encoding="utf-8"))
    for p in presets:
        key = inchi_key_nostereo(p["smiles"])
        rec = upsert(key, cid=p["pubchem_cid"], smiles=p["smiles"])
        rec["names"] = [p["name_en"]] + [n for n in rec["names"] if n.lower() != p["name_en"].lower()]
        rec["preset"] = p["id"]

    links, hist = add_foodb_and_author(compounds, foods, upsert, pc)
    am_src = json.loads(AUTHOR.read_text(encoding="utf-8"))["source"]

    # Reverse links and core-compound synonyms
    for fid, f in foods.items():
        for key in f.get("kfo", []):
            compounds[key]["foods_kfo"].append(fid)
        for key in f.get("detected", []):
            compounds[key]["foods_detected"].append(fid)
    core = [k for k, c in compounds.items() if c["dunkel"] or c["foods_kfo"] or c.get("preset")]
    for key in core:
        c = compounds[key]
        if c.get("cid"):
            c["synonyms"] = [s for s in clean_synonyms(pc.synonyms(c["cid"])) if s.lower() not in (n.lower() for n in c["names"])]
    pc.save()

    # Assign short ids (PubChem CID when known) and write compact output
    ids = {}
    for key, c in compounds.items():
        base = f"c{c['cid']}" if c.get("cid") else "x" + hashlib.sha1(key.encode()).hexdigest()[:8]
        cid_ = base
        n = 2
        while cid_ in ids.values():
            cid_ = f"{base}-{n}"
            n += 1
        ids[key] = cid_
    out_c = {}
    for key, c in compounds.items():
        rec = {"name": c["names"][0], "smiles": c["smiles"], "inchi": key}
        if c.get("cid"): rec["cid"] = c["cid"]
        if len(c["names"]) > 1: rec["alt"] = c["names"][1:]
        if c["synonyms"]: rec["syn"] = c["synonyms"]
        if c["flavor"]: rec["flavor"] = c["flavor"]
        if c["fema"]: rec["fema"] = c["fema"]
        if c["dunkel"]: rec["dunkel"] = c["dunkel"]
        if c.get("preset"): rec["preset"] = c["preset"]
        if c["foods_kfo"]: rec["kfo"] = c["foods_kfo"]
        if c["foods_detected"]: rec["det"] = c["foods_detected"]
        ds = {fid: codes for fid, codes in links.get(key, {}).items() if codes != ["F"]}
        if ds: rec["ds"] = ds
        if c.get("fdbm"): rec["fdbm"] = c["fdbm"]
        if c.get("isomer_note"): rec["isomer_note"] = c["isomer_note"]
        if c.get("origin"): rec["origin"] = c["origin"]
        out_c[ids[key]] = rec
    out_f = {}
    for fid, f in foods.items():
        rec = {"name": f["name"], "cat": f["category"], "src": f["source"]}
        if f.get("sources"): rec["srcs"] = f["sources"]
        zh = f.get("zh") or DAIRY_ZH.get(f["name"])
        if zh: rec["zh"] = zh
        if f.get("kfo_src"): rec["kfo_src"] = f["kfo_src"]
        if f.get("foodb"): rec["fo"] = f["foodb"]
        if f["synonyms"]: rec["syn"] = f["synonyms"]
        if f.get("kfo"): rec["kfo"] = [ids[k] for k in f["kfo"]]
        if f.get("statements"): rec["notes"] = f["statements"]
        if f.get("detected"): rec["det"] = [ids[k] for k in f["detected"]]
        out_f[fid] = rec

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "refs.json").write_text(json.dumps(hist["refs"], ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "compounds.json").write_text(json.dumps(out_c, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "foods.json").write_text(json.dumps(out_f, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    meta = {
        "built": datetime.date.today().isoformat(),
        "counts": {"compounds": len(out_c), "foods": len(out_f),
                   "foods_flavordb": sum(1 for f in out_f.values() if f["src"] == "flavordb"),
                   "foods_foodb_only": sum(1 for f in out_f.values() if f["src"] == "foodb"),
                   "foods_dunkel": sum(1 for f in out_f.values() if f["src"] == "dunkel"),
                   "compounds_with_foods": sum(1 for c in out_c.values() if c.get("det")),
                   "core_compounds": len(core),
                   "links": {k: {a: b for a, b in v.items()} for k, v in hist.items() if k != "refs"}},
        "sources": {
            "dunkel": {"citation": dk["source"]["citation"], "doi": dk["source"]["doi"],
                       "scope": "Statements from the main text only; the full food x odorant matrix is in the article's Supporting Information."},
            "flavordb": {"citation": "Garg N, et al. FlavorDB: a database of flavor molecules. Nucleic Acids Res. 2018, 46, D1210-D1216.",
                         "doi": FLAVORDB_DOI, "url": "https://cosylab.iiitd.edu.in/flavordb2/",
                         "license": "CC BY-NC-SA 3.0", "version": "FlavorDB2, downloaded 2026-10-16"},
            "foodb": {"citation": "FooDB, version 1.0 (data export 2020-04-07). www.foodb.ca",
                      "url": "https://foodb.ca/", "license": "CC BY-NC 4.0", "version": "2020-04-07 CSV export",
                      "scope": "Compound entries with a reference (database, article, textbook) and nutrient entries of one defined structure; predicted (HMDB, PathBank) and unreferenced entries are not used."},
            "author": {"citation": am_src["citation"], "doi": am_src["doi"], "tables": {"S1": am_src["S1"], "S2": am_src["S2"], "T1": am_src["T1"]},
                       "note": am_src["migrants_note"]},
        },
        "updates": [
            {"date": "2026-10-16", "what": "initial", "sources": ["flavordb", "dunkel"], "compounds": 1648, "foods": 952},
            {"date": "2026-11-20", "what": "foodb_author", "sources": ["foodb", "author"],
             "compounds_added_foodb": hist["foodb"]["new_compounds"], "compounds_added_author": hist["author"]["new_compounds"],
             "flavordb_links_hidden": hist["flavordb"]["hidden"], "flavordb_molecules_hidden": hist["flavordb"]["hidden_molecules"],
             "foodb_links": hist["foodb"]["links"], "author_links": hist["author"]["links"]},
            {"date": "2026-11-20", "what": "author_kfo", "sources": ["author"], "food": "fdb796",
             "kfo": hist["author"]["kfo"], "dairy_zh": sum(1 for f in out_f.values() if f.get("zh")) - 1},
        ],
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    (OUT / "LICENSE.md").write_text(
        "# Data license\n\n"
        "`compounds.json` and `foods.json` contain data derived from FlavorDB2 "
        "(Garg N, et al., Nucleic Acids Res. 2018, 46, D1210-D1216, https://cosylab.iiitd.edu.in/flavordb2/), "
        "licensed under Creative Commons Attribution-NonCommercial-ShareAlike 3.0 "
        "(https://creativecommons.org/licenses/by-nc-sa/3.0/). These derived data are shared under the same license.\n\n"
        "Key food odorant statements are short citations from the main text of Dunkel et al., "
        "Angew. Chem. Int. Ed. 2014, 53, 7124-7143 (doi:10.1002/anie.201309508), each with its page number.\n\n"
        "Food links with a FooDB source (compounds.json field \"ds\", references in refs.json) are derived from FooDB "
        "(www.foodb.ca, data export of 2020-04-07), licensed under Creative Commons Attribution-NonCommercial 4.0 "
        "(https://creativecommons.org/licenses/by-nc/4.0/).\n\n"
        "Human milk links with the source S1 or S2 are the author's published data: Cui J, et al., Food Bioscience 2026 "
        "(doi:10.1016/j.fbio.2026.110162), Tables S1 and S2. The key flavor compounds of human milk (foods.json field "
        "kfo with kfo_src author) are the compounds of Table 1 of the same article (ROAV >= 1 and perceived in GC-O).\n\n"
        "Compound names, structures and synonyms were retrieved from PubChem (https://pubchem.ncbi.nlm.nih.gov/).\n",
        encoding="utf-8")
    for f in ("compounds.json", "foods.json"):
        print(f"Wrote {f}: {(OUT / f).stat().st_size / 1e6:.2f} MB")
    print(json.dumps(meta["counts"]))


if __name__ == "__main__":
    main()
