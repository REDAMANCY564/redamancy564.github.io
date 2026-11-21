"""Generic names for merged stereoisomers (case-fix-3, item 3; 2026-11-20).

The knowledge base and the molecule library merge stereoisomers (structures without stereo).
A merged record keeps the name of whichever isomer its first source used (e.g. "Dipentene",
"cis-Crotonaldehyde"). Where a page starts from a CAS number the CAS's own name is shown
(flavor-kb/data/cas-names.json); everywhere else (odor map lists, knowledge-base food and
compound cards, ingredient finder results) the record name is shown.

Rule: only when a merged record stands for several stereo CAS numbers
(stereo_candidates.py: different full InChIKeys, same skeleton, no isotope labels) does it get a
name without configuration, in English and Chinese, from stereo_names.json (curated by hand,
keyed by the first 14 InChIKey characters). Records with a single stereo CAS keep their
specific name.

Applied to the built site data (idempotent):
  flavor-kb/data/compounds.json         name -> generic English name (old name moved to the
                                        front of "alt", so it stays searchable), "zh" added
  ingredient-finder/data/library.json   molecules[i][1] -> generic English name; "names_zh"
                                        and "names_old" {index: name}
build_kb.py and ingredient/make_site_data.py call apply() after writing their outputs.

display_names.json (2026-11-21, same keys and fields) is applied on top: machine-format names
("CID 644104", "2-Azaniumyl-4-methylpentanoate", ...) replaced by common names, and the 10 key
flavor compounds of human milk named as on the case page (_inputs/NAMES-29-REVIEW.md). A machine
name is dropped, not kept as an alias, unless the entry has "keep_old": true.
"""
import json
from pathlib import Path

from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")
ROOT = Path(__file__).resolve().parents[2]
NAMES = Path(__file__).with_name("stereo_names.json")
DISPLAY = Path(__file__).with_name("display_names.json")
KB = ROOT / "flavor-kb" / "data" / "compounds.json"
LIB = ROOT / "ingredient-finder" / "data" / "library.json"
REG = ROOT / "flavor-kb" / "data" / "regulatory.json"
REG_LOOKUP = ROOT / "flavor-kb" / "data" / "regulatory-lookup.json"


def apply(verbose=True):
    names = json.loads(NAMES.read_text(encoding="utf-8"))["names"]
    disp = json.loads(DISPLAY.read_text(encoding="utf-8"))
    names = {**names, **disp["names"]}
    case = disp.get("case", {})   # capitalization only: old spelling -> new, the old one kept as an alias
    def keep(e, old):
        if old.lower() == e["en"].lower():
            return False
        return e.get("keep_old", True) if old not in e.get("old", []) else e.get("keep_old", False)
    changed = []

    kb = json.loads(KB.read_text(encoding="utf-8"))
    for cid, rec in kb.items():
        e = names.get(Chem.InchiToInchiKey(rec["inchi"])[:14])
        if not e:
            if rec["name"] in case:
                old = rec["name"]
                rec["alt"] = [old] + [a for a in rec.get("alt", []) if a != old]
                rec["name"] = case[old]
                changed.append(("kb", cid, old, rec["name"]))
            continue
        old = rec["name"]
        if old != e["en"]:
            rec["alt"] = ([old] if keep(e, old) else []) + [a for a in rec.get("alt", []) if a.lower() != old.lower() and a != e["en"]]
            rec["name"] = e["en"]
            changed.append(("kb", cid, old, e["en"]))
        rec["zh"] = e["zh"]
    KB.write_text(json.dumps(kb, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    lib = json.loads(LIB.read_text(encoding="utf-8"))
    zh, olds = lib.get("names_zh", {}), lib.get("names_old", {})
    for i, m in enumerate(lib["molecules"]):
        mol = Chem.MolFromSmiles(m[0])
        e = names.get(Chem.MolToInchiKey(mol)[:14]) if mol else None
        if not e:
            if m[1] in case:
                prev = olds.get(str(i))
                olds[str(i)] = m[1] + (" | " + prev if prev and prev != m[1] else "")
                changed.append(("lib", i, m[1], case[m[1]]))
                m[1] = case[m[1]]
            continue
        if m[1] != e["en"]:
            if m[1] and keep(e, m[1]):
                prev = olds.get(str(i))
                olds[str(i)] = m[1] + (" | " + prev if prev and prev != m[1] else "")
            changed.append(("lib", i, m[1], e["en"]))
            m[1] = e["en"]
        zh[str(i)] = e["zh"]
    lib["names_zh"], lib["names_old"] = zh, olds
    LIB.write_text(json.dumps(lib, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    changed += apply_regulatory(lib["molecules"])
    if verbose:
        print(f"stereo names: {len(changed)} names changed "
              f"(knowledge base {sum(c[0] == 'kb' for c in changed)}, library {sum(c[0] == 'lib' for c in changed)})")
    return changed


def apply_regulatory(molecules):
    """Copy the display_names.json names into the regulatory data (built from the library names by
    training/regulatory/build_regulatory.py; patched here so that no rebuild is needed). Only names
    listed as "old" in display_names.json are replaced; the Chinese names there are the official
    list names and stay."""
    d = json.loads(DISPLAY.read_text(encoding="utf-8"))
    new = {o: e["en"] for e in d["names"].values() for o in e.get("old", [])}
    new.update(d.get("case", {}))
    changed = []
    reg = json.loads(REG.read_text(encoding="utf-8"))
    for it in reg["items"]:
        if it[2] in new and it[2] != molecules[it[0]][1]:
            changed.append(("reg", it[0], it[2], molecules[it[0]][1])); it[2] = molecules[it[0]][1]
    REG.write_text(json.dumps(reg, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    lk = json.loads(REG_LOOKUP.read_text(encoding="utf-8"))
    for s in lk["s"]:
        if s[0] in new and s[0] != new[s[0]]:
            changed.append(("lookup", s[2], s[0], new[s[0]])); s[0] = new[s[0]]
        for m in s[6]:
            if m[1] in new:
                m[1] = molecules[m[0]][1]
    REG_LOOKUP.write_text(json.dumps(lk, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return changed


if __name__ == "__main__":
    apply()
