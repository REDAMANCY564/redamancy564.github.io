"""Clean and merge ChemTastesDB + VirtuousMultiTaste into one multi-label taste table.

Modelled classes: sweet, bitter, umami, tasteless. Sour and salty are parsed and kept
for reporting only (too few small molecules to model).

Each source record gives, per class, 1 (positive), 0 (negative) or unknown:
- A record with a basic taste (e.g. "Sweet") is positive for it and negative for the
  other basic tastes and for tasteless (multi-taste records are positive for each).
- "Tasteless"/"Neutral": tasteless = 1, every basic taste = 0.
- "Non-sweet", "Non-bitter", "Umamiless": only that class = 0, the rest unknown.
- VirtuousMultiTaste "Other" (sour, salty, tasteless, ... lumped together):
  sweet = bitter = umami = 0, tasteless unknown.
- Non-basic sensations (astringent, pungent, cooling, kokumi, ...) give no label.

Records are standardized like the odor data (largest fragment, neutralized, canonical
non-stereo SMILES; ChemTastesDB has no stereo anyway) and merged per structure.
Conflicts (one record 1, another 0 for the same class) resolve to positive; a molecule
that ends up with any positive basic taste gets tasteless = 0.

Filters: unparsable, no carbon (inorganic salts), peptides with >= 3 amino-acid
residues, heavy atoms > 64, no known label for any modelled class.

Output: data/taste/clean.csv
"""
import re
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
from rdkit import Chem, RDLogger

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from clean_data import MAX_ATOMS, standardize  # noqa: E402  (same rules as odor data)

RDLogger.DisableLog("rdApp.*")
sys.stdout.reconfigure(encoding="utf-8")

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "taste"
MODELLED = ["sweet", "bitter", "umami", "tasteless"]
BASIC = ["sweet", "bitter", "umami", "sour", "salty"]
ALL = BASIC + ["tasteless"]

NEG_TOKENS = {"non-sweet": "sweet", "not-sweet": "sweet", "lacking sweet": "sweet",
              "non-bitter": "bitter", "umamiless": "umami"}
UMAMI_WORDS = ("umami", "msg", "brothy", "savory")
UMAMI_SKIP = ("umami-enhancing", "umami increased")  # enhancer effect, not a taste
CLASS_FALLBACK = {"Sweetness": "sweet", "Bitterness": "bitter", "Umaminess": "umami",
                  "Sourness": "sour", "Saltiness": "salty", "Tastelessness": "tasteless",
                  "Non-sweetness": "-sweet", "Non-bitterness": "-bitter"}

# Alpha-amino-acid unit: N-C(alpha)-C(=O)-[N or O]; residues counted by alpha carbon
AA_UNIT = Chem.MolFromSmarts("[NX3;!$(N-[#6]=[!#6;!O])][CX4][CX3](=O)[#7,#8]")
PEPTIDE_BOND = Chem.MolFromSmarts("[CX4][CX3](=O)[NX3][CX4]")
MIN_RESIDUES = 3


def parse_tokens(text):
    """Return (positives, negatives) sets of class names from a free-text taste string."""
    pos, neg = set(), set()
    for tok in re.split(r"[;/,>]| and |=", text):
        t = re.sub(r"\(\d+(\.\d+)?\)", "", tok).strip().lower()
        if not t or any(s in t for s in UMAMI_SKIP):
            continue
        neg_hit = [c for k, c in NEG_TOKENS.items() if t.startswith(k)]
        if neg_hit:
            neg.update(neg_hit)
            inner = re.search(r"\((.*)\)", t)  # e.g. "non-sweet (sour)"
            t = inner.group(1) if inner else ""
        if any(w in t for w in UMAMI_WORDS):
            pos.add("umami")
            continue  # "umami (neutral)": neutral refers to pH
        if "bitter" in t:
            pos.add("bitter")
            continue  # "bitter with sweet aftertaste": count the main taste only
        if "sweet" in t:
            pos.add("sweet")
        elif "sour" in t or t == "acid":
            pos.add("sour")
        elif "salty" in t:
            pos.add("salty")
        elif t in ("tasteless", "neutral"):
            pos.add("tasteless")
    return pos, neg


def record_labels(pos, neg):
    """Per-record label vector (1 / 0 / NaN) over ALL classes."""
    lab = dict.fromkeys(ALL, np.nan)
    basic_pos = pos & set(BASIC)
    if basic_pos:
        for c in ALL:
            lab[c] = 1.0 if c in basic_pos else 0.0
    elif "tasteless" in pos:
        lab.update({c: 0.0 for c in BASIC}, tasteless=1.0)
    for c in neg:
        if lab[c] != 1.0:
            lab[c] = 0.0
    return lab


def load_ctdb():
    x = pd.read_excel(DATA_DIR / "ChemTastesDB_database.xlsx", dtype={"ID": str})
    rows = []
    for _, r in x.iterrows():
        text = "" if pd.isna(r["Taste"]) else str(r["Taste"])
        pos, neg = parse_tokens(text)
        if not pos and not neg:  # empty or non-basic text: fall back to the class column
            fb = CLASS_FALLBACK.get(r["Class taste"])
            if fb:
                (neg.add(fb[1:]) if fb.startswith("-") else pos.add(fb))
        rows.append({"source": "ChemTastesDB", "src_id": r["ID"], "name": r["Name"],
                     "raw_smiles": r["canonical SMILES"], "raw_label": text,
                     **record_labels(pos, neg)})
    return pd.DataFrame(rows)


def load_vmt():
    x = pd.read_csv(DATA_DIR / "VirtuousMultiTaste_fourtaste.csv",
                    usecols=["Std_SMILES", "Taste"])
    rows = []
    for i, r in x.iterrows():
        t = r["Taste"].lower()
        if t == "other":
            lab = dict.fromkeys(ALL, np.nan)
            lab.update(sweet=0.0, bitter=0.0, umami=0.0)
        else:
            lab = record_labels({t}, set())
            lab["sour"] = lab["salty"] = np.nan  # VMT never labels sour/salty as such
        rows.append({"source": "VirtuousMultiTaste", "src_id": str(i), "name": "",
                     "raw_smiles": r["Std_SMILES"], "raw_label": r["Taste"], **lab})
    return pd.DataFrame(rows)


def n_residues(mol):
    alpha = {m[1] for m in mol.GetSubstructMatches(AA_UNIT)}
    return len(alpha) if mol.HasSubstructMatch(PEPTIDE_BOND) else 0


def main():
    rec = pd.concat([load_ctdb(), load_vmt()], ignore_index=True)
    print(f"Records: {len(rec)}  " + str(rec["source"].value_counts().to_dict()))
    no_info = rec[ALL].isna().all(axis=1)
    print(f"Records without any basic-taste information (astringent, cooling, ...): {no_info.sum()}")
    rec = rec[~no_info].copy()

    rec["smiles"] = rec["raw_smiles"].fillna("").astype(str).map(lambda s: standardize(s) or None if s.strip() else None)
    drops = Counter()
    drops["unparsable"] = rec["smiles"].isna().sum()
    rec = rec.dropna(subset=["smiles"]).copy()

    mols = {s: Chem.MolFromSmiles(s) for s in rec["smiles"].unique()}
    inorganic = {s for s, m in mols.items() if not any(a.GetSymbol() == "C" for a in m.GetAtoms())}
    peptide = {s for s, m in mols.items() if n_residues(m) >= MIN_RESIDUES}
    big = {s for s, m in mols.items() if m.GetNumHeavyAtoms() > MAX_ATOMS}
    for tag, bad in [("no carbon (inorganic)", inorganic), (f"peptide (>= {MIN_RESIDUES} residues)", peptide),
                     (f"heavy atoms > {MAX_ATOMS}", big)]:
        m = rec["smiles"].isin(bad)
        drops[tag] = m.sum()
        if tag.startswith("peptide"):
            ex = rec.loc[m & (rec["name"] != ""), "name"].drop_duplicates().head(8).tolist()
            print(f"  peptide examples: {ex}")
        rec = rec[~m]
    print("Records dropped: " + ", ".join(f"{k} {v}" for k, v in drops.items()))
    rec.to_csv(DATA_DIR / "records.csv", index=False)

    # --- merge per structure, count conflicts -------------------------------------
    out, conflicts = [], Counter()
    for smi, g in rec.groupby("smiles", sort=False):
        row = {"smiles": smi, "n_records": len(g),
               "sources": "+".join(sorted(g["source"].unique())),
               "name": next((n for n in g["name"] if n), ""),
               "raw_labels": " | ".join(sorted(set(f"{s[:4]}:{l}" for s, l in zip(g["source"], g["raw_label"]))))}
        for c in ALL:
            v = g[c].dropna()
            if len(v) and v.max() == 1 and v.min() == 0:
                cross = g.loc[g[c].notna(), "source"].nunique() > 1
                conflicts[(c, "cross-source" if cross else "within-source")] += 1
            row[c] = v.max() if len(v) else np.nan
        if any(row[c] == 1 for c in BASIC) and row["tasteless"] == 1:
            conflicts[("tasteless vs a basic taste", "-> tasteless set to 0")] += 1
        if any(row[c] == 1 for c in BASIC):
            row["tasteless"] = 0.0
        out.append(row)
    df = pd.DataFrame(out)
    print(f"\nRecords merged into {len(df)} structures "
          f"({(df['n_records'] > 1).sum()} with more than one record)")
    print(f"By source: {df['sources'].value_counts().to_dict()}")

    print("\nLabel conflicts (structures; resolved to positive):")
    for (c, kind), n in sorted(conflicts.items()):
        print(f"  {c:10s} {kind:22s} {n}")
    n_multi = (df[["sweet", "bitter", "umami"]].sum(axis=1) >= 2).sum()
    print(f"Structures positive for >= 2 of sweet/bitter/umami after merge: {n_multi}")

    known = df[MODELLED].notna().any(axis=1)
    print(f"\nStructures without any known modelled label dropped: {(~known).sum()}")
    df = df[known].reset_index(drop=True)

    print(f"\nClean: {len(df)} molecules")
    print(f"{'class':10s} {'pos':>6s} {'neg':>6s} {'unknown':>8s}")
    for c in ALL:
        print(f"{c:10s} {int((df[c] == 1).sum()):6d} {int((df[c] == 0).sum()):6d} {int(df[c].isna().sum()):8d}")
    df.to_csv(DATA_DIR / "clean.csv", index=False)
    print(f"-> {DATA_DIR / 'clean.csv'}")


if __name__ == "__main__":
    main()
