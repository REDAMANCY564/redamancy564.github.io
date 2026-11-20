"""Find merged records that stand for several stereoisomers (case-fix-3, item 3).

A knowledge-base compound (names.json CAS list) or a molecule-library entry (lib_cas.json)
counts as "several stereo CAS" when at least two of its CAS numbers resolve (PubChem, cache
training/data/gcms/cas_pubchem.json) to different full InChIKeys with the record's first 14
characters, counting only CIDs without isotope labels (IsotopeAtomCount 0: deuterated or 13C
forms share the skeleton but are not stereoisomers).

Writes training/data/gcms/stereo_candidates.json (not committed) with, per skeleton (first 14
InChIKey characters): current names, the stereo CAS grouped by InChIKey with PubChem titles,
and the PubChem title of the stereo-free parent (skeleton-UHFFFAOYSA-N) as a naming hint.
The curated names live in training/knowledge/stereo_names.json (see apply_stereo_names.py).
"""
import json
import sys
from pathlib import Path

from rdkit import Chem, RDLogger

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "gcms"))
from build_cas_names import Pub  # noqa: E402

RDLogger.DisableLog("rdApp.*")
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "training" / "data" / "gcms" / "stereo_candidates.json"


def prefetch_props(pub, cids):
    """Title / InChIKey / IsotopeAtomCount for many CIDs, 100 per request (cached per CID)."""
    todo = sorted({c for c in cids if f"iso:{c}" not in pub.c})
    for k in range(0, len(todo), 100):
        chunk = todo[k:k + 100]
        d = pub.get("isobatch:" + ",".join(map(str, chunk)),
                    "cid/" + ",".join(map(str, chunk)) + "/property/Title,InChIKey,IsotopeAtomCount/JSON")
        got = {r["CID"]: r for r in (d or {}).get("PropertyTable", {}).get("Properties", [])}
        for c in chunk:
            pub.c[f"iso:{c}"] = {"PropertyTable": {"Properties": [got[c]]}} if c in got else None
    print(f"  isotope check: {len(todo)} CIDs fetched", flush=True)


def props(pub, cid):
    d = pub.c.get(f"iso:{cid}")
    return d["PropertyTable"]["Properties"][0] if d else None


def same_skeleton(pub, k14, cas_list):
    """{full InChIKey: [(cas, CID)]} over CAS numbers that resolve to this skeleton."""
    out = {}
    for cas in cas_list:
        r = pub.by_name(cas)
        if r and r["InChIKey"][:14] == k14:
            out.setdefault(r["InChIKey"], []).append((cas, r["CID"]))
    return out


def parent_title(pub, k14):
    d = pub.get(f"ik:{k14}-UHFFFAOYSA-N", f"inchikey/{k14}-UHFFFAOYSA-N/property/Title/JSON")
    return d["PropertyTable"]["Properties"][0].get("Title") if d else None


def stereo_groups(pub, k14, cas_list):
    groups = {}
    for key, items in same_skeleton(pub, k14, cas_list).items():
        for cas, cid in items:
            p = props(pub, cid)
            if not p or p.get("IsotopeAtomCount", 0):
                continue
            g = groups.setdefault(key, {"cid": cid, "title": p["Title"], "cas": []})
            g["cas"].append(cas)
    return groups


def main():
    pub = Pub()
    names = json.loads((ROOT / "gcms-interpreter" / "data" / "names.json").read_text(encoding="utf-8"))["compounds"]
    kb = json.loads((ROOT / "flavor-kb" / "data" / "compounds.json").read_text(encoding="utf-8"))
    lib = json.loads((ROOT / "training" / "data" / "regulatory" / "out" / "lib_cas.json").read_text(encoding="utf-8"))
    # only records with 2+ full InChIKeys on their skeleton need the isotope check
    recs = [(Chem.InchiToInchiKey(kb[row[0]]["inchi"])[:14], row[2]) for row in names] + [
        (r["inchikey"][:14], r["cas"]) for r in lib]
    cids = set()
    for k14, cas in recs:
        sk = same_skeleton(pub, k14, cas)
        if len(sk) > 1:
            cids |= {cid for items in sk.values() for _, cid in items}
    prefetch_props(pub, cids)
    out = {}
    for row in names:
        cid, cas = row[0], row[2]
        k14 = Chem.InchiToInchiKey(kb[cid]["inchi"])[:14]
        g = stereo_groups(pub, k14, cas)
        if len(g) > 1:
            e = out.setdefault(k14, {"kb": [], "lib": [], "groups": {}})
            e["kb"].append([cid, kb[cid]["name"]])
            e["groups"].update(g)
    for i, r in enumerate(lib):
        k14 = r["inchikey"][:14]
        g = stereo_groups(pub, k14, r["cas"])
        if len(g) > 1:
            e = out.setdefault(k14, {"kb": [], "lib": [], "groups": {}})
            e["lib"].append([i, r["name"], r["kb"]])
            e["groups"].update(g)
    for k14, e in out.items():
        e["parent_title"] = parent_title(pub, k14)
    pub.save()
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{len(out)} skeletons; KB compounds {sum(len(e['kb']) for e in out.values())}, "
          f"library molecules {sum(len(e['lib']) for e in out.values())}")


if __name__ == "__main__":
    main()
