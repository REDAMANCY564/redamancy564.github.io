"""FooDB (2020-04-07 CSV export, CC BY-NC 4.0, www.foodb.ca) -> food sources with references for the
molecules of this site (user decisions 2026-11-20, plan case-fix-1 item 4).

Raw data (not in git): _inputs/foodb/foodb_2020_04_07_csv/{Compound,Food,Content}.csv
(content_compound.csv in the same folder is a truncated file and is not read).

Steps
1. Compound.csv: the header is shifted by one column (CAS sits under "description", the InChIKey under
   "moldb_smiles"), so InChIKey and CAS are recognised by their content (regular expressions), not by
   the header.
2. Molecules of the site = training/data/ingredient/library.json (+ extra molecules given with --extra,
   e.g. the human milk volatiles added to the knowledge base). Match: full InChIKey, else the first 14
   characters (skeleton, stereo ignored: "sk14"), else a CAS number of the knowledge-base compound
   (gcms-interpreter/data/names.json, FlavorDB cas_id).
3. Content.csv, source_type Compound: kept only with citation_type ARTICLE, EXPERIMENTAL, TEXTBOOK or
   DATABASE; PREDICTED (HMDB, PathBank) and UNKNOWN (citation MANUAL, no reference) are left out.
   Rows without a usable reference (ARTICLE with citation MANUAL, EXPERIMENTAL: all MANUAL) are kept
   only with --keep-unreferenced.
   source_type Nutrient (USDA, DTU, Duke): kept for the few nutrients with one defined structure (NUTRIENTS).
4. Bulk rule (R2): per molecule the largest number of foods one of its FooDB compounds (by our match or
   by FlavorDB's fooddb_id) has with UNKNOWN entries only; >= 300 marks a molecule whose FlavorDB food
   links were bulk-copied (build_kb.py hides them unless a referenced FooDB entry confirms the food).
5. FlavorDB foods -> FooDB foods by exact name (normalised; alias synonyms too).

Output: training/data/foodb/foodb_subset.json (not in git).
Run: training/.venv/Scripts/python.exe training/foodb/extract_foodb.py [--extra file.json] [--keep-unreferenced]
"""
import argparse
import collections
import csv
import glob
import json
import re
import sys
from pathlib import Path

from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")
csv.field_size_limit(10 ** 9)
ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "_inputs" / "foodb" / "foodb_2020_04_07_csv"
OUT = ROOT / "training" / "data" / "foodb" / "foodb_subset.json"
IK = re.compile(r"^[A-Z]{14}-[A-Z]{10}-[A-Z]$")
CAS = re.compile(r"^\d{2,7}-\d{2}-\d$")
BULK_MIN = 300
CITED = {"ARTICLE", "EXPERIMENTAL", "TEXTBOOK", "DATABASE"}
# nutrient id (Content.csv source_id with source_type Nutrient) -> (SMILES of the one structure, note)
NUTRIENTS = {
    "6": ("CCCCCCCCCCCCC(=O)O", None),                          # 13:0 tridecanoic acid
    "31": ("CCCCCCCCCCCCCCCCCCCCCC(=O)O", None),                # 22:0 behenic acid
    "36": ("CCC=CCC=CCC=CCC=CCC=CCCCCC(=O)O", None),            # 22:5 n-3 (DPA)
    "25": ("CCCCCC=CCC=CCCCCCCCCCC(=O)O", None),                # 20:2 n-6 c,c (11,14-eicosadienoic acid)
    "37": ("CCCCCCCCC=CCCCCCCCCCCCCCC(=O)O", None),             # 24:1 c (nervonic acid)
    "13": ("CCCCCCCCC=CCCCCCCCC(=O)O", "isomers_not_separated"),  # 18:1 c: oleic acid, may include cis-vaccenic acid
}
DB_NAMES = {"USDA": "USDA National Nutrient Database", "DTU": "DTU Food Data (Denmark)",
            "DUKE": "Dr. Duke's Phytochemical and Ethnobotanical Databases", "DFC CODES": "DFC codes",
            "PHENOL EXPLORER": "Phenol-Explorer", "KNAPSACK": "KNApSAcK", "PHYTOHUB": "PhytoHub"}


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def ik14(smiles):
    m = Chem.MolFromSmiles(smiles)
    return Chem.MolToInchiKey(m)[:14] if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extra", help="training/knowledge/extra_compounds.json: compounds added to the knowledge base")
    ap.add_argument("--keep-unreferenced", action="store_true")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    comp = {}
    for row in csv.reader(open(RAW / "Compound.csv", encoding="utf-8", newline="")):
        if row[0] == "id":
            continue
        ik = next((x for x in row if IK.match(x)), None)
        cas = next((x for x in row if CAS.match(x)), None)
        comp[row[0]] = {"pub": row[1], "name": row[2], "ik": ik, "cas": cas}
    pub2id = {c["pub"]: i for i, c in comp.items()}
    byik, by14, bycas = (collections.defaultdict(list) for _ in range(3))
    for i, c in comp.items():
        if c["ik"]:
            byik[c["ik"]].append(i)
            by14[c["ik"][:14]].append(i)
        if c["cas"]:
            bycas[c["cas"]].append(i)

    lib = json.loads((ROOT / "training" / "data" / "ingredient" / "library.json").read_text(encoding="utf-8"))["molecules"]
    mols = [{"inchikey": m["inchikey"], "smiles": m["smiles"], "name": m["name"], "kb": m["kb"]} for m in lib]
    if a.extra:   # compounds added to the knowledge base that are not in the library yet (cleaned like the library)
        sys.path.insert(0, str(ROOT / "training" / "ingredient"))
        from build_library import canonical
        have = {m["inchikey"] for m in mols}
        for e in json.loads(Path(a.extra).read_text(encoding="utf-8")):
            c, mol = canonical(e["smiles"])
            k = Chem.MolToInchiKey(mol)
            if k not in have:
                have.add(k)
                mols.append({"inchikey": k, "smiles": c, "name": e["name"], "kb": None, "cas": e.get("cas") or []})
    names = json.loads((ROOT / "gcms-interpreter" / "data" / "names.json").read_text(encoding="utf-8"))["compounds"]
    kbcas = {c[0]: set(c[2]) for c in names}
    ents = {}
    for p in glob.glob(str(ROOT / "training" / "data" / "flavordb_raw" / "entity_*.json")):
        e = json.loads(Path(p).read_text(encoding="utf-8"))
        ents[e["entity_id"]] = e
    fl_fdb, fl_cas = collections.defaultdict(set), collections.defaultdict(set)
    for e in ents.values():
        for m in e["molecules"]:
            k = "c%s" % m["pubchem_id"]
            if m.get("fooddb_id") in pub2id:
                fl_fdb[k].add(pub2id[m["fooddb_id"]])
            for c in (m.get("cas_id") or "").split("@"):
                if CAS.match(c):
                    fl_cas[k].add(c)

    match = {}
    for m in mols:
        k = m["inchikey"]
        if k in byik:
            match[k] = ("full", set(byik[k]))
        elif k[:14] in by14:
            match[k] = ("sk14", set(by14[k[:14]]))
        else:
            cas = set(m.get("cas") or []) | (kbcas.get(m["kb"], set()) | fl_cas.get(m["kb"], set()) if m["kb"] else set())
            ids = {i for c in cas for i in bycas.get(c, [])}
            if ids:
                match[k] = ("cas", ids)
    nutr_mol = {}
    sk = collections.defaultdict(list)
    for m in mols:
        sk[m["inchikey"][:14]].append(m["inchikey"])
    for nid, (smi, note) in NUTRIENTS.items():
        for k in sk.get(ik14(smi), []):
            nutr_mol.setdefault(nid, []).append(k)

    want = set().union(*(v[1] for v in match.values())) | set().union(*fl_fdb.values())
    U, CI = 1, 4
    pair = collections.defaultdict(int)
    cites = collections.defaultdict(set)
    nutr = collections.defaultdict(set)    # (nutrient id, food) -> refs
    counts = collections.Counter()
    r = csv.reader(open(RAW / "Content.csv", encoding="utf-8", newline=""))
    h = next(r)
    ix = {k: i for i, k in enumerate(h)}
    for row in r:
        st, t, s, f, c = row[ix["source_type"]], row[ix["citation_type"]], row[ix["source_id"]], row[ix["food_id"]], row[ix["citation"]]
        if st == "Nutrient":
            if s in NUTRIENTS and t in CITED:
                nutr[(s, f)].add(("DATABASE", c))
            continue
        counts[t] += 1
        if s not in want:
            continue
        if t == "UNKNOWN":
            pair[(s, f)] |= U
        elif t in CITED:
            unref = t == "EXPERIMENTAL" or (t == "ARTICLE" and c == "MANUAL")
            if unref and not a.keep_unreferenced:
                counts["skipped_unreferenced"] += 1
                continue
            pair[(s, f)] |= CI
            cites[(s, f)].add((t, "" if unref else c))

    refs, ref_ix = [], {}

    def ref_id(t, c):
        text = DB_NAMES.get(c, c) if t == "DATABASE" else (c or "FooDB, no reference given")
        key = (t if t == "DATABASE" else "TEXT", text)
        if key not in ref_ix:
            ref_ix[key] = len(refs)
            refs.append({"type": t.lower(), "text": text})
        return ref_ix[key]

    uncited = collections.Counter(s for (s, f), b in pair.items() if b == U)
    foods_used = set()
    out_m = {}
    for m in mols:
        k = m["inchikey"]
        kind, ids = match.get(k, (None, set()))
        out_m[k] = {"smiles": m["smiles"], "name": m["name"], "match": kind, "foodb": sorted(comp[i]["pub"] for i in ids),
                    "uncited_max": max([uncited[s] for s in ids | fl_fdb.get(m["kb"], set())] or [0]), "foods": {}}
    # foods per molecule (one pass over cited pairs)
    comp2mol = collections.defaultdict(list)
    for k, (kind, ids) in match.items():
        for s in ids:
            comp2mol[s].append(k)
    for (s, f), cs in cites.items():
        for k in comp2mol.get(s, []):
            out_m[k]["foods"].setdefault(f, set()).update(ref_id(t, c) for t, c in cs)
            foods_used.add(f)
    for (nid, f), cs in nutr.items():
        for k in nutr_mol.get(nid, []):
            out_m[k]["foods"].setdefault(f, set()).update(ref_id(t, c) for t, c in cs)
            if NUTRIENTS[nid][1]:
                out_m[k].setdefault("nutrient_note", NUTRIENTS[nid][1])
            foods_used.add(f)
    for k, v in out_m.items():
        v["foods"] = {f: sorted(rs) for f, rs in sorted(v["foods"].items(), key=lambda x: int(x[0]))}
    out_m = {k: v for k, v in out_m.items() if v["match"] or v["foods"] or v["uncited_max"]}

    food_rows = {f["id"]: f for f in csv.DictReader(open(RAW / "Food.csv", encoding="utf-8", newline=""))}
    foods = {f: {"name": food_rows[f]["name"], "sci": food_rows[f]["name_scientific"] or None,
                 "group": food_rows[f]["food_group"] or None, "subgroup": food_rows[f]["food_subgroup"] or None}
             for f in sorted(foods_used, key=int) if f in food_rows}
    byname = {}
    for f in food_rows.values():
        byname.setdefault(norm(f["name"]), f["id"])
    fmap = {}
    for eid, e in ents.items():
        for s in [e["entity_alias_readable"]] + [x.strip() for x in (e.get("entity_alias_synonyms") or "").split(",")]:
            if norm(s) in byname:
                fmap[str(eid)] = byname[norm(s)]
                break
    for f in set(fmap.values()) - set(foods):
        fr = food_rows[f]
        foods[f] = {"name": fr["name"], "sci": fr["name_scientific"] or None, "group": fr["food_group"] or None, "subgroup": fr["food_subgroup"] or None}

    # FooDB foods that FlavorDB confirms with referenced entries, for the bulk rule
    stats = {"content_compound_rows_by_type": dict(counts),
             "molecules": len(mols), "match": dict(collections.Counter(v["match"] for v in out_m.values() if v["match"])),
             "molecules_with_foods": sum(1 for v in out_m.values() if v["foods"]),
             "links": sum(len(v["foods"]) for v in out_m.values()),
             "bulk_molecules": sum(1 for v in out_m.values() if v["uncited_max"] >= BULK_MIN),
             "flavordb_foods_mapped": len(fmap), "refs": len(refs),
             "nutrient_molecules": {nid: nutr_mol.get(nid, []) for nid in NUTRIENTS}}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"version": "2020-04-07", "bulk_min": BULK_MIN, "keep_unreferenced": a.keep_unreferenced,
                               "stats": stats, "refs": refs, "foods": foods, "flavordb_food_map": fmap,
                               "molecules": out_m}, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
