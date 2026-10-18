"""Stage 1 of ingredient-finder (PLAN-ingredient-finder.md): build the candidate molecule library.

Library = molecules of the odor-predictor dataset (training/data/split.csv, already cleaned)
+ flavor knowledge-base compounds that are not in it, deduplicated on the canonical SMILES
(largest fragment, neutralized, stereo removed; the same cleaning as clean_data.py).

Per molecule: canonical SMILES, heavy atoms, where it comes from
  split   "train" | "valid" | "test" (odor dataset) or "kb" (knowledge base only)
  kb      knowledge-base id (if the compound is in the knowledge base) and its foods (FlavorDB)
  name    knowledge-base name if any, else the PubChem title (looked up offline by InChIKey)
Only the model's training split was used to fit the deployed model, so "not used in training"
= valid + test + kb (the validation split did choose the early-stopping epoch).

Excluded molecules (user decisions 2026-10-18, PLAN-odor-map.md), listed with reasons in the output:
  inorganic      no carbon atom (metals, metal oxides, inorganic acids, water, He, H2S, NH3, SO2...),
                 plus carbonic acid (an inorganic carbonate although it contains carbon)
  organosilicon  contains Si, e.g. D6 siloxane, a common GC-MS column-bleed impurity
  non_volatile   POPC (a phospholipid) and the flavylium (anthocyanin) cation: not odorants
  mixture        every source entry is a mixture of two or more different organic compounds, so its
                 odor labels describe the mixture, not this molecule
Molecules kept although all their labelled dataset entries are mixtures (they also exist on their own in
the knowledge base) get "labels_from_mixture": true; evaluations treat them as unlabelled.

Raw PubChem responses are cached in training/data/ingredient/ (not committed).
Output: training/data/ingredient/library.json (input of stage 2).
Run with the training venv: training/.venv/Scripts/python.exe training/ingredient/build_library.py
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd
from rdkit import Chem, RDLogger
from rdkit.Chem.MolStandardize import rdMolStandardize

RDLogger.DisableLog("rdApp.*")
ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "training" / "data" / "ingredient"
CACHE = OUT_DIR / "pubchem_titles.json"
MAX_ATOMS = 64
PUG = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/inchikey/property/Title,InChIKey/JSON"
BATCH = 100
CAS_RE = re.compile(r"^\d{2,7}-\d{2}-\d$")

_lfc = rdMolStandardize.LargestFragmentChooser()
_unc = rdMolStandardize.Uncharger()


def canonical(smiles):
    """Same cleaning as clean_data.py: largest fragment, neutralize, drop stereo, canonical SMILES."""
    m = Chem.MolFromSmiles(smiles)
    if m is None:
        return None, None
    m = _unc.uncharge(_lfc.choose(m))
    Chem.RemoveStereochemistry(m)
    return Chem.MolToSmiles(m), m


def pubchem_titles(keys):
    """InChIKey -> PubChem title (first CID per key), cached; 100 keys per POST, about 3 requests/s."""
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    todo = [k for k in keys if k not in cache]
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        data = urllib.parse.urlencode({"inchikey": ",".join(chunk)}).encode()
        for attempt in range(4):
            try:
                with urllib.request.urlopen(urllib.request.Request(PUG, data=data), timeout=60) as r:
                    props = json.load(r)["PropertyTable"]["Properties"]
                break
            except urllib.error.HTTPError as e:
                if e.code == 404:          # none of the keys found
                    props = []
                    break
                time.sleep(2 + 3 * attempt)
            except Exception:
                time.sleep(2 + 3 * attempt)
        else:
            raise RuntimeError("PubChem lookup failed")
        got = {}   # several CIDs can share a key: keep the first (PubChem returns them in CID order)
        for p in props:
            got.setdefault(p.get("InChIKey"), p.get("Title"))
        for k in chunk:
            cache[k] = got.get(k)
        CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
        time.sleep(0.35)
        print(f"  PubChem {min(i + BATCH, len(todo))}/{len(todo)}", flush=True)
    return cache


EXCLUDE_EXPLICIT = {
    "O=C(O)O": ("inorganic", "carbonic acid (inorganic carbonate)"),
    "c1ccc(-c2ccc3ccccc3[o+]2)cc1": ("non_volatile", "flavylium (anthocyanin) cation: non-volatile, not an odorant"),
}


def organic_parts(smiles):
    """Distinct cleaned organic (carbon-containing) components of a SMILES."""
    m = Chem.MolFromSmiles(smiles)
    if m is None:
        return set()
    out = set()
    for frag in Chem.GetMolFrags(m, asMols=True):
        if any(a.GetSymbol() == "C" for a in frag.GetAtoms()):
            frag = _unc.uncharge(frag)
            Chem.RemoveStereochemistry(frag)
            out.add(Chem.MolToSmiles(frag))
    return out


def exclusion(rec, sources):
    """(category, reason) if the molecule is excluded, else None. sources: [(kind, smiles), ...]."""
    m = Chem.MolFromSmiles(rec["smiles"])
    elements = {a.GetSymbol() for a in m.GetAtoms()}
    if rec["smiles"] in EXCLUDE_EXPLICIT:
        return EXCLUDE_EXPLICIT[rec["smiles"]]
    if "C" not in elements:
        return ("inorganic", "no carbon atom")
    if "Si" in elements:
        return ("organosilicon", "organosilicon; e.g. D6 siloxane is a common GC-MS column-bleed impurity")
    if "P" in elements and any(a.GetFormalCharge() for a in m.GetAtoms()) and m.GetNumHeavyAtoms() > 40:
        return ("non_volatile", "phospholipid (POPC): non-volatile, not an odorant")
    if sources and all(len(organic_parts(s)) >= 2 for _, s in sources):
        return ("mixture", "every source entry is a mixture of different organic compounds")
    return None


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    split = pd.read_csv(ROOT / "training" / "data" / "split.csv")
    kb = json.loads((ROOT / "flavor-kb" / "data" / "compounds.json").read_text(encoding="utf-8"))

    # source entries per cleaned structure (raw dataset rows and KB compounds), for the mixture rule
    raw = pd.read_csv(ROOT / "training" / "data" / "curated_GS_LF_merged_4983.csv")
    sources = {}
    for s in raw.nonStereoSMILES:
        c, _ = canonical(s)
        sources.setdefault(c, []).append(("dataset", s))
    for comp in kb.values():
        c, _ = canonical(comp["smiles"])
        sources.setdefault(c, []).append(("kb", comp["smiles"]))

    lib = {}
    for smi, sp in zip(split.smiles, split.split):
        c, m = canonical(smi)
        lib[c] = {"smiles": c, "atoms": m.GetNumHeavyAtoms(), "split": sp, "kb": None}
    n_dataset = len(lib)
    skipped = []
    for kid, comp in kb.items():
        c, m = canonical(comp["smiles"])
        if c is None or m.GetNumHeavyAtoms() > MAX_ATOMS:
            skipped.append(comp["name"])
            continue
        rec = lib.setdefault(c, {"smiles": c, "atoms": m.GetNumHeavyAtoms(), "split": "kb", "kb": None})
        if rec["kb"] is None:      # two KB entries with the same cleaned structure: keep the first
            rec["kb"] = kid
            rec["kb_name"] = comp["name"]
            rec["foods"] = comp.get("det", [])

    # names: knowledge base first, else PubChem title by InChIKey
    for rec in lib.values():
        rec["inchikey"] = Chem.MolToInchiKey(Chem.MolFromSmiles(rec["smiles"]))
        if rec.get("kb_name") and CAS_RE.match(rec["kb_name"]):   # some KB names are CAS numbers
            rec["kb_cas_name"] = rec.pop("kb_name")
    need = sorted({r["inchikey"] for r in lib.values() if not r.get("kb_name")})
    print(f"looking up {len(need)} names in PubChem")
    titles = pubchem_titles(need)
    for rec in lib.values():
        rec["name"] = rec.get("kb_name") or titles.get(rec["inchikey"]) or rec.get("kb_cas_name")
        rec["name_src"] = "kb" if rec.get("kb_name") else ("pubchem" if titles.get(rec["inchikey"]) else ("cas" if rec["name"] else None))

    excluded = []
    for c in list(lib):
        why = exclusion(lib[c], sources.get(c, []))
        if why:
            r = lib.pop(c)
            excluded.append({"smiles": c, "name": r["name"], "split": r["split"], "category": why[0], "reason": why[1]})
            continue
        ds = [s for k, s in sources.get(c, []) if k == "dataset"]
        if ds and all(len(organic_parts(s)) >= 2 for s in ds):
            lib[c]["labels_from_mixture"] = True
    excluded.sort(key=lambda e: (e["category"], e["smiles"]))

    mols = sorted(lib.values(), key=lambda r: (r["split"] != "train", r["smiles"]))
    counts = pd.Series([r["split"] for r in mols]).value_counts().to_dict()
    out = {
        "built": time.strftime("%Y-%m-%d"),
        "counts": {"total": len(mols), "dataset": n_dataset, **counts,
                   "in_kb": sum(r["kb"] is not None for r in mols),
                   "with_foods": sum(bool(r.get("foods")) for r in mols),
                   "named_kb": sum(r["name_src"] == "kb" for r in mols),
                   "named_pubchem": sum(r["name_src"] == "pubchem" for r in mols),
                   "unnamed": sum(r["name_src"] is None for r in mols),
                   "kb_skipped": len(skipped), "excluded": len(excluded),
                   "labels_from_mixture": sum(bool(r.get("labels_from_mixture")) for r in mols)},
        "kb_skipped": skipped,
        "excluded": excluded,
        "molecules": mols,
    }
    (OUT_DIR / "library.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(out["counts"], indent=1))
    print("skipped KB compounds (>64 heavy atoms or unparsable):", skipped)
    for e in excluded:
        print(f"  excluded [{e['category']:13s}] {e['split']:5s} {e['name']} | {e['smiles']}")
    print("kept but labels only from mixtures:", [r["name"] for r in mols if r.get("labels_from_mixture")])


if __name__ == "__main__":
    main()
