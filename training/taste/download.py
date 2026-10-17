"""Download the raw taste datasets and the ChEMBL clinical-phase list.

Sources (verified 2026-10-17):
- ChemTastesDB v2.1, Zenodo record 15051366, CC BY 4.0.
  Cite: Rojas C. et al., Food Chemistry: Molecular Sciences 4 (2022) 100090.
- VirtuousMultiTaste, github.com/lorenzopallante/VirtuousMultiTaste (MIT), pinned commit.
  Cite: Androutsos L., Pallante L. et al., npj Science of Food 8 (2024) 47.
- ChEMBL REST API (keyless): molecules with max_phase >= 1, used only to flag drug-like
  molecules for the bitter-bias analysis.

Raw files stay in training/data/taste/ (gitignored) and are NOT committed.
"""
import csv
import hashlib
import json
import time
import urllib.request
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "taste"

CTDB_URL = "https://zenodo.org/records/15051366/files/ChemTastesDB_database.xlsx?download=1"
CTDB = DATA_DIR / "ChemTastesDB_database.xlsx"

VMT_COMMIT = "2c1a30ecd1196b627edcbb6f13ac19a7c0d3e6e8"
VMT_URL = ("https://raw.githubusercontent.com/lorenzopallante/VirtuousMultiTaste/"
           f"{VMT_COMMIT}/data/Full_dataset_fourtaste.csv")
VMT = DATA_DIR / "VirtuousMultiTaste_fourtaste.csv"

CHEMBL_URL = ("https://www.ebi.ac.uk/chembl/api/data/molecule.json?max_phase__gte=1"
              "&molecule_structures__isnull=false&limit=1000&offset={}"
              "&only=molecule_chembl_id,pref_name,max_phase,molecule_structures")
CHEMBL = DATA_DIR / "chembl_clinical.csv"


def fetch(url, out):
    if not out.exists():
        print(f"Downloading {url}")
        urllib.request.urlretrieve(url, out)
    sha = hashlib.sha256(out.read_bytes()).hexdigest()
    print(f"  {out.name}: {out.stat().st_size:,} bytes, sha256={sha[:16]}...")


def fetch_chembl():
    if CHEMBL.exists():
        print(f"  {CHEMBL.name}: cached")
        return
    rows, offset, total = [], 0, None
    while total is None or offset < total:
        with urllib.request.urlopen(CHEMBL_URL.format(offset), timeout=120) as r:
            page = json.load(r)
        total = page["page_meta"]["total_count"]
        for m in page["molecules"]:
            s = m.get("molecule_structures") or {}
            if s.get("standard_inchi_key"):
                rows.append((m["molecule_chembl_id"], m.get("pref_name") or "",
                             m["max_phase"], s["standard_inchi_key"]))
        offset += 1000
        print(f"  ChEMBL {min(offset, total)}/{total}")
        time.sleep(1)  # be polite to the public API
    with CHEMBL.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["chembl_id", "pref_name", "max_phase", "inchikey"])
        w.writerows(rows)
    print(f"  {CHEMBL.name}: {len(rows)} molecules")


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fetch(CTDB_URL, CTDB)
    fetch(VMT_URL, VMT)
    fetch_chembl()


if __name__ == "__main__":
    main()
