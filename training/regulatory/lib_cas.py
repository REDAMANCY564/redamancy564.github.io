"""Add CAS candidates to the ingredient-finder library (regulatory feasibility, 2026-10-20).

KB molecules: CAS from gcms-interpreter/data/names.json (by KB id).
All molecules: PubChem PUG REST, InChIKey -> CID (one key per request), CID -> synonyms (batch),
keep synonyms that look like CAS numbers with a valid check digit.
PubChem responses are cached in training/data/regulatory/out/pubchem_cache.json (not committed).
Output: training/data/regulatory/out/lib_cas.json
"""
import json, re, sys, time, urllib.request, urllib.parse, os
from pathlib import Path

REPO = str(Path(__file__).resolve().parents[2])
OUT = os.path.join(REPO, "training", "data", "regulatory", "out")
CACHE = os.path.join(OUT, "pubchem_cache.json")
CAS_RE = re.compile(r"^(\d{2,7})-(\d{2})-(\d)$")


def cas_ok(s):
    m = CAS_RE.match(s)
    if not m:
        return False
    digits = (m.group(1) + m.group(2))[::-1]
    return sum((i + 1) * int(d) for i, d in enumerate(digits)) % 10 == int(m.group(3))


def post(path, data):
    url = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/" + path
    body = urllib.parse.urlencode(data).encode()
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, body), timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(3 * (attempt + 1))
        except Exception:
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("failed " + path)


lib = json.load(open(os.path.join(REPO, r"training\data\ingredient\library.json"), encoding="utf-8"))["molecules"]
names = json.load(open(os.path.join(REPO, r"gcms-interpreter\data\names.json"), encoding="utf-8"))["compounds"]
kb_cas = {c[0]: c[2] for c in names}

cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {"cid": {}, "syn": {}}
keys = [m["inchikey"] for m in lib if m["inchikey"] not in cache["cid"]]
for i in range(0, len(keys), 100):
    chunk = keys[i:i + 100]
    # PubChem inchikey POST accepts one key per request; 4 in parallel (limit is 5/s)
    from concurrent.futures import ThreadPoolExecutor
    def one(k):
        t0 = time.time()
        j = post("compound/inchikey/cids/JSON", {"inchikey": k})
        time.sleep(max(0, 0.85 - (time.time() - t0)))
        return k, (j or {}).get("IdentifierList", {}).get("CID", [])
    with ThreadPoolExecutor(4) as ex:
        for k, v in ex.map(one, chunk):
            cache["cid"][k] = v
    json.dump(cache, open(CACHE, "w"))
    print("cid", i + len(chunk), "/", len(keys), flush=True)

cids = sorted({c for v in cache["cid"].values() for c in v if str(c) not in cache["syn"]})
for i in range(0, len(cids), 100):
    chunk = cids[i:i + 100]
    j = post("compound/cid/synonyms/JSON", {"cid": ",".join(map(str, chunk))})
    for c in chunk:
        cache["syn"][str(c)] = []
    for info in (j or {}).get("InformationList", {}).get("Information", []):
        cache["syn"][str(info["CID"])] = [s for s in info.get("Synonym", []) if cas_ok(s)]
    json.dump(cache, open(CACHE, "w"))
    print("syn", i + len(chunk), "/", len(cids), flush=True)
    time.sleep(0.3)

out = []
for m in lib:
    pc = []
    for c in cache["cid"].get(m["inchikey"], []):
        for s in cache["syn"].get(str(c), []):
            if s not in pc:
                pc.append(s)
    kb = [s for s in kb_cas.get(m.get("kb"), []) if cas_ok(s)] if m.get("kb") else []
    out.append({"inchikey": m["inchikey"], "name": m.get("name"), "split": m["split"],
                "kb": m.get("kb"), "cas_kb": kb, "cas_pubchem": pc,
                "cas": list(dict.fromkeys(kb + pc))})
json.dump(out, open(os.path.join(OUT, "lib_cas.json"), "w"), indent=0)
n = len(out)
print("molecules", n, "with CAS", sum(1 for o in out if o["cas"]),
      "multi CAS", sum(1 for o in out if len(o["cas"]) > 1))
