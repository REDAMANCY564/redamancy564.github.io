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
"""
import json
from pathlib import Path

from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")
ROOT = Path(__file__).resolve().parents[2]
NAMES = Path(__file__).with_name("stereo_names.json")
KB = ROOT / "flavor-kb" / "data" / "compounds.json"
LIB = ROOT / "ingredient-finder" / "data" / "library.json"


def apply(verbose=True):
    names = json.loads(NAMES.read_text(encoding="utf-8"))["names"]
    changed = []

    kb = json.loads(KB.read_text(encoding="utf-8"))
    for cid, rec in kb.items():
        e = names.get(Chem.InchiToInchiKey(rec["inchi"])[:14])
        if not e:
            continue
        old = rec["name"]
        if old != e["en"]:
            rec["alt"] = [old] + [a for a in rec.get("alt", []) if a.lower() != old.lower() and a != e["en"]]
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
            continue
        if m[1] != e["en"]:
            if m[1]:
                olds[str(i)] = m[1]
            changed.append(("lib", i, m[1], e["en"]))
            m[1] = e["en"]
        zh[str(i)] = e["zh"]
    lib["names_zh"], lib["names_old"] = zh, olds
    LIB.write_text(json.dumps(lib, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if verbose:
        print(f"stereo names: {len(changed)} names changed "
              f"(knowledge base {sum(c[0] == 'kb' for c in changed)}, library {sum(c[0] == 'lib' for c in changed)})")
    return changed


if __name__ == "__main__":
    apply()
