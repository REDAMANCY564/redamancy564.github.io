"""Offline build of the CAS + synonym table for gcms-interpreter (PLAN-gcms.md sections 5-6).

For every compound of the flavor knowledge base (flavor-kb/data/compounds.json, keyed by
PubChem CID) fetch from PubChem PUG REST (free, no key):
  - synonyms (include CAS index names such as "Butanoic acid, ethyl ester")
  - registry numbers (xrefs/RN)
CAS numbers = synonyms that look like a CAS number, pass the check digit and also appear in
the registry numbers (if none appears there, the valid synonym ones are kept). Synonyms are
filtered to chemical names (database codes, registry ids and very long strings dropped).

Raw responses are cached in training/data/gcms/ (not committed).
Output: gcms-interpreter/data/names.json
  {"source": ..., "compounds": [[kb_id, display_name, [cas...], [synonyms...]], ...]}
"""
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KB = ROOT / "flavor-kb" / "data" / "compounds.json"
CACHE = ROOT / "training" / "data" / "gcms"
OUT = ROOT / "gcms-interpreter" / "data" / "names.json"
PUG = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/{}/JSON"
BATCH = 100
MAX_SYNONYMS = 40

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
    syn, rn = {}, {}
    for i in range(0, len(cids), BATCH):
        batch = cids[i:i + BATCH]
        syn.update(fetch("synonyms", batch))
        rn.update(fetch("xrefs/RN", batch))
        print(f"  {min(i + BATCH, len(cids))}/{len(cids)} CIDs")

    rows, n_cas, n_multi, no_syn = [], 0, 0, 0
    for kid, c in kb.items():
        s = syn.get(c["cid"], [])
        if not s:
            no_syn += 1
        reg = set(rn.get(c["cid"], []))
        cas_all = [x for x in s if cas_ok(x)]
        cas = [x for x in cas_all if x in reg] or cas_all
        cas = list(dict.fromkeys(cas))
        names = [c["name"]] + [x for x in c.get("alt", []) + c.get("syn", []) + s if is_name(x)]
        seen, keep = set(), []
        for x in names:
            k = x.strip().lower()
            if k and k not in seen:
                seen.add(k)
                keep.append(x.strip())
        rows.append([kid, c["name"], cas, keep[:MAX_SYNONYMS]])
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
