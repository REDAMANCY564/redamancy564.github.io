"""Names that belong to a specific CAS number (2026-11-20, user request B5).

The knowledge base merges stereoisomers (standard InChI without stereo layers), so a compound
record keeps the name and PubChem CID of its first source while listing the CAS numbers of all
its stereoisomers (e.g. c5283349 "(2E,4E)-deca-2,4-dienal" also holds 25152-83-4, the (E,Z)
isomer). The molecule library behind the regulatory lookup does the same. Wherever a page
starts from a CAS number (GC-MS tables and exports, the regulatory lookup and the knowledge-base
card it opens), it should show the name of that CAS.

For every CAS of a knowledge-base compound (gcms-interpreter/data/names.json) and of a library
molecule (training/data/regulatory/out/lib_cas.json), PubChem resolves the CAS to a CID R
(name lookup, first CID). The CAS gets its own name when R is a different stereo form of the
same skeleton (same first 14 InChIKey characters, different full InChIKey) than the record whose
name is shown:
  - knowledge-base compound: its PubChem CID (the source of its name)
  - library molecule linked to the knowledge base: that compound's CID; otherwise the CID PubChem
    finds for the library name
Name of R, in this order: an English name of R in training/gcms/aliases.json (a stereo-prefixed
form such as "(E)-2-butenal" first, CAS index forms like "2-Butenal, (E)-" last), the first
PubChem synonym of R (with a stereo descriptor when R has stereo), the PubChem title.

Output: flavor-kb/data/cas-names.json {"source", "names": {cas: name}}
Cache: training/data/gcms/cas_pubchem.json (not committed).
"""
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAMES = ROOT / "gcms-interpreter" / "data" / "names.json"
KB = ROOT / "flavor-kb" / "data" / "compounds.json"
LIB = ROOT / "training" / "data" / "regulatory" / "out" / "lib_cas.json"
ALIASES = Path(__file__).parent / "aliases.json"
CACHE = ROOT / "training" / "data" / "gcms" / "cas_pubchem.json"
OUT = ROOT / "flavor-kb" / "data" / "cas-names.json"
PUG = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/"

STEREO_PREFIX = re.compile(r"^(\((?:[EZRS0-9,]+|[+\-]|±|cis|trans|r|s)\)-|cis-|trans-|[DL]-|\([+\-]\)-|[EZ]-)", re.I)
INVERTED = re.compile(r", *\(?[A-Za-z0-9,+\-]+\)?-?$")   # CAS index form "2-Butenal, (E)-"
MIXTURE = re.compile(r"\b(oil|oils|terpenes|extract|absolute|resin|essence)\b", re.I)
CODE = re.compile(r"(\d{5,}|^[A-Z0-9\-]{2,}$|^(UNII|EINECS|EC |CHEBI|CHEMBL|DTXSID|SCHEMBL|NSC|FEMA|HSDB|BRN|AI3|MFCD|ZINC|AKOS|CAS-|NCGC|Tox21|HY-|CS-|Q\d))", re.I)


class Pub:
    def __init__(self):
        self.c = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
        self.n = 0
        self.lock = threading.Lock()
        self.next_t = 0.0

    def wait_turn(self):
        """Request starts at most 4 per second over all threads (PubChem allows 5)."""
        with self.lock:
            now = time.time()
            t = max(now, self.next_t)
            self.next_t = t + 0.25
        time.sleep(max(0.0, t - now))

    def prefetch(self, names, workers=5):
        todo = [n for n in dict.fromkeys(names) if "name:" + n not in self.c]
        print(f"  prefetching {len(todo)} names with {workers} threads", flush=True)
        with ThreadPoolExecutor(workers) as ex:
            list(ex.map(self.by_name, todo))
        self.save()

    def get(self, key, path):
        if key not in self.c:
            self.wait_turn()
            url = PUG + path
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(url, timeout=60) as r:
                        self.c[key] = json.loads(r.read())
                    break
                except urllib.error.HTTPError as e:
                    if e.code in (400, 404):
                        self.c[key] = None
                        break
                    if attempt == 3:
                        raise
                    time.sleep(3 * (attempt + 1))
                except Exception:  # noqa: BLE001  throttling / network: retry
                    if attempt == 3:
                        raise
                    time.sleep(3 * (attempt + 1))
            with self.lock:
                self.n += 1
                if self.n % 500 == 0:
                    CACHE.write_text(json.dumps(dict(self.c)), encoding="utf-8")
                    print(f"  {self.n} PubChem requests", flush=True)
        return self.c[key]

    def by_name(self, name):
        """First CID for a name or CAS: {CID, InChIKey, Title} or None."""
        d = self.get("name:" + name, "name/" + urllib.parse.quote(name, safe="") + "/property/Title,InChIKey/JSON")
        return d["PropertyTable"]["Properties"][0] if d else None

    def by_cid(self, cid):
        d = self.get(f"cid:{cid}", f"cid/{cid}/property/Title,InChIKey/JSON")
        return d["PropertyTable"]["Properties"][0] if d else None

    def inchi(self, cid):
        d = self.get(f"inchi:{cid}", f"cid/{cid}/property/InChI/JSON")
        return d["PropertyTable"]["Properties"][0].get("InChI", "") if d else ""

    def synonyms(self, cid):
        d = self.get(f"syn:{cid}", f"cid/{cid}/synonyms/JSON")
        return d["InformationList"]["Information"][0].get("Synonym", []) if d else []

    def save(self):
        CACHE.write_text(json.dumps(self.c), encoding="utf-8")


def pick_name(pub, r, aliases):
    stereo = r["InChIKey"].split("-")[1] != "UHFFFAOYSA"
    names = [n for n in aliases.get(str(r["CID"]), {}).get("names", []) if n]
    ordered = ([n for n in names if STEREO_PREFIX.match(n)] + [n for n in names if not INVERTED.search(n) and not STEREO_PREFIX.match(n)]
               if stereo else [n for n in names if not INVERTED.search(n)])
    if ordered:
        return ordered[0], "alias"
    # the PubChem title when it names the stereo form (or there is none to name)
    index_form = ", " in r["Title"]   # CAS index title such as "2-Butenoic acid, ethyl ester"
    if (not stereo or STEREO_PREFIX.match(r["Title"])) and not index_form:
        return r["Title"], "title"
    for s in pub.synonyms(r["CID"])[:30]:
        if len(s) > 60 or CODE.search(s) or INVERTED.search(s) or not re.search(r"[a-z]", s):
            continue
        if stereo and not STEREO_PREFIX.match(s) or ", " in s:
            continue
        return s, "synonym"
    return r["Title"], "title"


def main():
    pub = Pub()
    aliases = json.loads(ALIASES.read_text(encoding="utf-8"))["compounds"]
    kb = json.loads(KB.read_text(encoding="utf-8"))
    names = json.loads(NAMES.read_text(encoding="utf-8"))["compounds"]
    lib = json.loads(LIB.read_text(encoding="utf-8"))

    # (cas, shown name, CID of the shown name) for every record that starts from a CAS
    records = []
    for kid, display, cas, _ in (row[:4] for row in names):
        cid = kb[kid].get("cid")
        records += [(c, display, cid, "kb:" + kid) for c in cas]
    for i, m in enumerate(lib):
        cid = kb[m["kb"]].get("cid") if m.get("kb") and m["kb"] in kb else None
        records += [(c, m["name"], cid, f"lib:{i}", m["inchikey"]) if cid is None else (c, m["name"], cid, f"lib:{i}")
                    for c in m["cas"]]
    print(f"{len(records)} (record, CAS) pairs, {len({r[0] for r in records})} distinct CAS")

    pub.prefetch([r[0] for r in records])
    out, why, affected = {}, {}, {}
    for rec in records:
        cas, shown, cid, who = rec[:4]
        r = pub.by_name(cas)
        if not r or r["CID"] == cid:
            continue
        if cid is None:
            # library molecule outside the knowledge base: the CID of its name decides
            if r["InChIKey"][:14] != rec[4][:14] or r["InChIKey"] == rec[4]:
                continue
            own = pub.by_name(shown)
            if not own or own["CID"] == r["CID"]:
                continue
            own_key = own["InChIKey"]
        else:
            own = pub.by_cid(cid)
            if not own:
                continue
            own_key = own["InChIKey"]
        if r["InChIKey"][:14] != own_key[:14] or r["InChIKey"] == own_key:
            continue   # another structure (salt, mixture, wrong CAS) or the same molecule: keep the shown name
        if MIXTURE.search(r["Title"]) or "/i" in pub.inchi(r["CID"]):
            continue   # essential oils / extracts, and isotope-labelled forms (deuterated, 13C): not an isomer
        if cas not in out:
            nm, how = pick_name(pub, r, aliases)
            if nm.lower() == shown.lower():
                continue
            out[cas] = nm
            why[cas] = {"cid": r["CID"], "how": how, "title": r["Title"]}
        affected.setdefault(who, []).append(cas)
        why[cas].setdefault("was", [])
        if shown not in why[cas]["was"]:
            why[cas]["was"].append(shown)
    pub.save()
    OUT.write_text(json.dumps({"source": "PubChem (CAS -> CID by name lookup; names from training/gcms/aliases.json, "
                                         "PubChem synonyms or title), built " + time.strftime("%Y-%m-%d"),
                               "names": dict(sorted(out.items(), key=lambda kv: [int(x) for x in kv[0].split("-")]))},
                              ensure_ascii=False, indent=0), encoding="utf-8")
    kb_aff = sorted({w for w in affected if w.startswith("kb:")})
    lib_aff = sorted({w for w in affected if w.startswith("lib:")})
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e3:.1f} kB): {len(out)} CAS numbers with their own name; "
          f"knowledge-base compounds affected {len(kb_aff)}, library molecules affected {len(lib_aff)}")
    report = ROOT / "training" / "data" / "gcms" / "cas_names_report.json"
    report.write_text(json.dumps({"why": why, "kb": kb_aff, "lib": lib_aff}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("report:", report)


if __name__ == "__main__":
    main()
