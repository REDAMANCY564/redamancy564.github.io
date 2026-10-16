"""Build the flavor knowledge base (tier 1 data) for flavor-kb/.

Inputs
  training/data/flavordb_raw/entity_*.json   (fetch_flavordb.py; FlavorDB2, CC BY-NC-SA 3.0)
  training/knowledge/dunkel2014_main_text.json (KFO statements from the main text of Dunkel et al. 2014)
  odor-predictor/data/presets.json            (compounds already on the site)
Outputs (flavor-kb/data/)
  compounds.json  id -> compound record
  foods.json      id -> food record (FlavorDB ingredients and Dunkel foods)
  meta.json       sources, licenses, counts, build date
  LICENSE.md      CC BY-NC-SA 3.0 notice for data derived from FlavorDB

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
        out_c[ids[key]] = rec
    out_f = {}
    for fid, f in foods.items():
        rec = {"name": f["name"], "cat": f["category"], "src": f["source"]}
        if f["synonyms"]: rec["syn"] = f["synonyms"]
        if f.get("kfo"): rec["kfo"] = [ids[k] for k in f["kfo"]]
        if f.get("statements"): rec["notes"] = f["statements"]
        if f.get("detected"): rec["det"] = [ids[k] for k in f["detected"]]
        out_f[fid] = rec

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "compounds.json").write_text(json.dumps(out_c, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "foods.json").write_text(json.dumps(out_f, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    meta = {
        "built": datetime.date.today().isoformat(),
        "counts": {"compounds": len(out_c), "foods": len(out_f),
                   "foods_flavordb": sum(1 for f in out_f.values() if f["src"] == "flavordb"),
                   "foods_dunkel": sum(1 for f in out_f.values() if f["src"] == "dunkel"),
                   "core_compounds": len(core)},
        "sources": {
            "dunkel": {"citation": dk["source"]["citation"], "doi": dk["source"]["doi"],
                       "scope": "Statements from the main text only; the full food x odorant matrix is in the article's Supporting Information."},
            "flavordb": {"citation": "Garg N, et al. FlavorDB: a database of flavor molecules. Nucleic Acids Res. 2018, 46, D1210-D1216.",
                         "doi": FLAVORDB_DOI, "url": "https://cosylab.iiitd.edu.in/flavordb2/",
                         "license": "CC BY-NC-SA 3.0"},
        },
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
        "Compound names, structures and synonyms were retrieved from PubChem (https://pubchem.ncbi.nlm.nih.gov/).\n",
        encoding="utf-8")
    for f in ("compounds.json", "foods.json"):
        print(f"Wrote {f}: {(OUT / f).stat().st_size / 1e6:.2f} MB")
    print(json.dumps(meta["counts"]))


if __name__ == "__main__":
    main()
