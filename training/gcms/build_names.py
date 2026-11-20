"""Offline build of the CAS + synonym table for gcms-interpreter (PLAN-gcms.md sections 5-6).

For every compound of the flavor knowledge base (flavor-kb/data/compounds.json, keyed by
PubChem CID) fetch from PubChem PUG REST (free, no key):
  - synonyms (include CAS index names such as "Butanoic acid, ethyl ester")
  - registry numbers (xrefs/RN)
CAS numbers = synonyms that look like a CAS number, pass the check digit and also appear in
the registry numbers (if none appears there, the valid synonym ones are kept). Synonyms are
filtered to chemical names (database codes, registry ids and very long strings dropped).

Extra spellings (2026-11-20): training/gcms/aliases.json, keyed by PubChem CID with its SMILES, is mapped
to the knowledge-base compound with the same structure (standard InChI without stereo layers, as the
knowledge base merges compounds) and adds Chinese names, NIST library spellings, the names used in
Cui et al. Food Bioscience 2026 and CAS numbers (also of other stereoisomers, e.g. (E,Z)-2,4-decadienal)
in front of the PubChem synonyms. Every alias CAS must pass the check digit and point to one compound.

Raw responses are cached in training/data/gcms/ (not committed).
Output: gcms-interpreter/data/names.json
  {"source": ..., "compounds": [[kb_id, display_name, [cas...], [synonyms...], {cas: name}?], ...]}
  The optional fifth element names the CAS numbers that belong to another stereoisomer than the
  display name (flavor-kb/data/cas-names.json, built by build_cas_names.py: run that first, then
  this script again when CAS numbers changed).
"""
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "training" / "knowledge"))
from build_kb import inchi_key_nostereo  # noqa: E402
KB = ROOT / "flavor-kb" / "data" / "compounds.json"
ALIASES = Path(__file__).parent / "aliases.json"
CACHE = ROOT / "training" / "data" / "gcms"
OUT = ROOT / "gcms-interpreter" / "data" / "names.json"
PUG = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/{}/JSON"
BATCH = 100
MAX_SYNONYMS = 40
_CN = ROOT / "flavor-kb" / "data" / "cas-names.json"
CAS_NAMES = json.loads(_CN.read_text(encoding="utf-8"))["names"] if _CN.exists() else {}

CAS_RE = re.compile(r"^(\d{2,7})-(\d{2})-(\d)$")
# Database identifiers and codes, not names
CODE_RE = re.compile(
    r"^(DTXSID|DTXCID|SCHEMBL|CHEMBL|CHEBI|UNII|NSC|FEMA|EINECS|EC |HSDB|BRN|AI3|CCRIS|WLN|ZINC|AKOS|MFCD|"
    r"InChI|BDBM|NCGC|Tox21|CAS-|LS-|SBI-|MLS|SMR|HMS|KBio|Spectrum|Prestwick|BSPBio|DivK|SpecPlus|DB\d|"
    r"HY-|CS-|BCP|AC-|AS-|EN300|STK|NS0|SY\d|W-\d|RefChem|DSSTox|NCI|CID|Caswell|Pesticide|EPA|UN\d|"
    r"Q\d+$|C\d{5}$|D\d{5}$|LMFA|HMDB|FDB\d|FL[A-Z]?\d|JECFA|NIOSH|RTECS|ACMC|ANW-|BBL|CCG-|F\d{4}-|"
    r"GTPL|J\d|MCULE|NA\d|NE\d|OR\d|PS-|STL|TRA|VS-|WR|ZB|BIDD|BRD|SR-|s\d|Lopac|NSC)", re.I)


def cas_ok(cas):
    m = CAS_RE.match(cas)
    if not m:
        return False
    digits = m.group(1) + m.group(2)
    return sum((i + 1) * int(d) for i, d in enumerate(reversed(digits))) % 10 == int(m.group(3))


def is_name(s):
    if len(s) < 2 or len(s) > 80 or not re.search(r"[A-Za-z]", s):
        return False
    if CODE_RE.match(s) or re.search(r"\d{5,}", s):
        return False
    if re.fullmatch(r"[A-Z0-9\-]{2,}", s) and re.search(r"\d", s):   # all-caps codes like AB-1234
        return False
    return True


def fetch(kind, cids):
    """kind: 'synonyms' or 'xrefs/RN'. Returns {cid: [str]} for a batch, cached on disk."""
    tag = kind.replace("/", "_")
    path = CACHE / f"{tag}_{cids[0]}_{len(cids)}.json"
    if not path.exists():
        url = PUG.format("{}/" + kind).format(",".join(map(str, cids)))
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=120) as r:
                    path.write_bytes(r.read())
                break
            except urllib.error.HTTPError as e:
                if e.code == 404:   # none of these CIDs has such data
                    path.write_text("{}", encoding="utf-8")
                    break
                if attempt == 3:
                    raise
                time.sleep(3 * (attempt + 1))
            except Exception as e:  # noqa: BLE001  (retry on throttling / network errors)
                if attempt == 3:
                    raise
                time.sleep(3 * (attempt + 1))
        time.sleep(0.4)   # stay well under PubChem's 5 requests per second
    d = json.loads(path.read_text(encoding="utf-8"))
    info = d.get("InformationList", {}).get("Information", [])
    key = "Synonym" if kind == "synonyms" else "RN"
    return {x["CID"]: x.get(key, []) for x in info}


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    kb = json.loads(KB.read_text(encoding="utf-8"))
    by_cid = {}
    for kid, c in kb.items():
        by_cid.setdefault(c["cid"], []).append(kid)
    cids = sorted(by_cid)
    # Cached responses first, oldest file first: compounds already on the site keep the data they were
    # published with (PubChem changes over time); only compounds without cached data are fetched (2026-11-20).
    syn, rn = {}, {}
    for kind, store, key in (("synonyms", syn, "Synonym"), ("xrefs_RN", rn, "RN")):
        for path in sorted(CACHE.glob(f"{kind}_*.json"), key=lambda q: q.stat().st_mtime):
            for x in json.loads(path.read_text(encoding="utf-8")).get("InformationList", {}).get("Information", []):
                if x.get(key):
                    store.setdefault(x["CID"], x[key])
    todo = [c for c in cids if c not in syn and c not in rn]
    for i in range(0, len(todo), BATCH):
        batch = todo[i:i + BATCH]
        for k, v in fetch("synonyms", batch).items():
            syn.setdefault(k, v)
        for k, v in fetch("xrefs/RN", batch).items():
            rn.setdefault(k, v)
        print(f"  fetched {min(i + BATCH, len(todo))}/{len(todo)} new CIDs")

    # extra spellings by structure
    by_key = {}
    for kid, c in kb.items():
        by_key.setdefault(c["inchi"], kid)
    extra = {}
    for cid, a in json.loads(ALIASES.read_text(encoding="utf-8"))["compounds"].items():
        kid = by_key.get(inchi_key_nostereo(a["smiles"]))
        assert kid, f"alias CID {cid} has no knowledge-base compound"
        e = extra.setdefault(kid, {"names": [], "cas": []})
        e["names"] += a["zh"] + a["names"]
        for c in a["cas"]:
            assert cas_ok(c), (cid, c)
            e["cas"].append(c)
    owner = {}
    for kid, e in extra.items():
        for c in e["cas"]:
            assert owner.setdefault(c, kid) == kid, f"alias CAS {c} on two compounds"

    rows, n_cas, n_multi, no_syn = [], 0, 0, 0
    for kid, c in kb.items():
        s = syn.get(c["cid"], [])
        if not s:
            no_syn += 1
        reg = set(rn.get(c["cid"], []))
        cas_all = [x for x in s if cas_ok(x)]
        cas = [x for x in cas_all if x in reg] or cas_all
        cas = list(dict.fromkeys(cas + extra.get(kid, {}).get("cas", [])))
        names = [c["name"]] + extra.get(kid, {}).get("names", []) + [x for x in c.get("alt", []) + c.get("syn", []) + s if is_name(x)]
        seen, keep = set(), []
        for x in names:
            k = x.strip().lower()
            if k and k not in seen:
                seen.add(k)
                keep.append(x.strip())
        row = [kid, c["name"], cas, keep[:MAX_SYNONYMS + len(extra.get(kid, {}).get("names", []))]]
        own = {x: CAS_NAMES[x] for x in cas if x in CAS_NAMES}
        if own:
            row.append(own)
        rows.append(row)   # aliases do not push PubChem names out
        n_cas += bool(cas)
        n_multi += len(cas) > 1

    OUT.write_text(json.dumps({
        "source": "PubChem (NCBI) PUG REST synonyms and registry numbers, fetched "
                  + time.strftime("%Y-%m-%d") + " for the flavor knowledge base compounds",
        "compounds": rows,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Compounds {len(rows)} | with CAS {n_cas} | with >1 CAS {n_multi} | no PubChem synonyms {no_syn}")
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
