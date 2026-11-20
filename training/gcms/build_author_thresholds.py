"""Author group threshold values for the GC-MS tool (option «作者课题组取值», 2026-11-20).

Input: training/gcms/author_thresholds.csv (committed), one row per CAS number:
  cas, mg_kg, source ("vg2011" or a journal key), page_or_doi (van Gemert page, or the DOI),
  original_reference (the study listed in van Gemert for this value), names (spellings, for review only).
Every vg2011 value was checked against the text of L.J. van Gemert (2011), Part II (water): the value
occurs in the entry of that CAS number on the given page (single value or one end of a range).
Values not in the compilation come only from published Food Chemistry articles (year and DOI), except
2,3-octanedione: 2.52 ug/kg from the author's published paper (Cui et al. Food Bioscience 2026, Table 1;
source "cui2026", user decision 2026-11-20).

Output: gcms-interpreter/data/thresholds-author.json
  {"source": {...}, "unit": "mg/kg", "items": {cas: {"mg_kg", "ref", "page" | "doi", "orig"}}}
The page matches the GC-MS peak by CAS number; without a CAS it uses the knowledge-base compound only
when exactly one CAS of that compound has a value (see flavor.js authorThreshold).
Run: training/.venv/Scripts/python.exe training/gcms/build_author_thresholds.py
"""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "training" / "gcms" / "author_thresholds.csv"
OUT = ROOT / "gcms-interpreter" / "data" / "thresholds-author.json"

SOURCE = {
    "zh": "作者课题组取值：水中觉察阈值，取自 L.J. van Gemert (2011) 汇编中的数值，由作者课题组选定并用于母乳风味研究"
          "（相关工作见 Cui 等，Food Bioscience，2026，doi:10.1016/j.fbio.2026.110162）。汇编中未收录的物质，"
          "取值出自已发表的 Food Chemistry 文献，逐条注明年份和 DOI；2,3-辛二酮取自上述 Cui 等 (2026) 的 Table 1。",
    "en": "Author group values: odour detection thresholds in water taken from the L.J. van Gemert (2011) compilation "
          "and selected by the author's group for its human milk flavour research (related work: Cui et al., Food "
          "Bioscience, 2026, doi:10.1016/j.fbio.2026.110162). For compounds not in the compilation, values come from "
          "published Food Chemistry articles; each is listed with year and DOI; 2,3-octanedione is taken from Table 1 of Cui et al. (2026).",
    "vg2011": "L.J. van Gemert (2011). Odour Thresholds: Compilations of Odour Threshold Values in Air, Water and "
              "Other Media, 2nd ed. Oliemans Punter & Partners BV, Utrecht. Part II (water).",
    "related_doi": "10.1016/j.fbio.2026.110162",
}


def main():
    items = {}
    with open(SRC, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            cas = r["cas"].strip()
            assert cas not in items, cas
            rec = {"mg_kg": float(r["mg_kg"]), "ref": r["source"].strip()}
            if rec["ref"] == "vg2011":
                rec["page"] = int(r["page_or_doi"])
            else:
                rec["doi"] = r["page_or_doi"].strip()
            if r["original_reference"].strip():
                rec["orig"] = r["original_reference"].strip()
            items[cas] = rec
    out = {"source": SOURCE, "unit": "mg/kg", "medium": "water", "items": dict(sorted(items.items()))}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(items)} values -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
