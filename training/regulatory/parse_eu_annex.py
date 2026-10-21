"""Extract Table 1 of Annex I Part A (Union list of flavouring substances) and the Annex III Part A list
from the consolidated text of Regulation (EC) No 1334/2008.

Input: training/data/regulatory/eu/cellar_02008R1334-20260216.html, downloaded with
    curl -L -H "Accept: application/xhtml+xml" -H "Accept-Language: eng" \
        https://publications.europa.eu/resource/celex/02008R1334-20260216
(EUR-Lex itself blocks scripts; the Publications Office cellar does not.)
Latest consolidated version checked 2026-10-21: no act amending 32008R1334 after (EU) 2026/172 and 2026/175.
Table 1 columns: FL No, Chemical Name, CAS No, JECFA No, CoE No, Purity, Restrictions of use, Footnote, Reference.
Output: training/data/regulatory/eu/annex1_table1_20260216.json (raw rows) and out/eu_parsed.json
"""
import html, json, re
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data" / "regulatory"
EU = DATA / "eu"
h = open(EU / "cellar_02008R1334-20260216.html", encoding="utf-8").read()
text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", h)))

rows = []
for tr in re.findall(r"(?s)<tr[^>]*>(.*?)</tr>", h):
    cells = [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", c))).strip()
             for c in re.findall(r"(?s)<td[^>]*>(.*?)</td>", tr)]
    if cells and re.fullmatch(r"\d{2}\.\d{3}", cells[0]):
        rows.append(cells)
json.dump(rows, open(EU / "annex1_table1_20260216.json", "w", encoding="utf-8"), ensure_ascii=False)
assert len(rows) == len({r[0] for r in rows}) == 2475, len(rows)


def ncas(s):
    m = re.fullmatch(r"0*(\d+)-(\d{2})-(\d)", s.strip())
    return f"{int(m.group(1))}-{m.group(2)}-{m.group(3)}" if m else None


table = [{"fl": r[0], "name": r[1], "cas": [c for c in (ncas(x) for x in re.findall(r"\d+-\d{2}-\d", r[2])) if c],
          "cas_raw": r[2], "jecfa": r[3], "coe": r[4], "purity": r[5], "restriction": r[6].strip(),
          "footnotes": re.findall(r"\d", r[7]), "reference": r[8]} for r in rows]

# Annex III Part A: substances which shall not be added as such to food. Names as in the consolidated text;
# CAS numbers added here (the annex gives none) and listed in REG-REVIEW.md for checking.
part_a = text[text.index("Part A: Substances which shall not be added as such to food"):text.index("Part B: Maximum levels")]
ANNEX3_CAS = {
    "Agaric acid": ["666-99-9"], "Aloin": ["1415-73-2", "8015-61-0"], "Capsaicin": ["404-86-4"],
    "1,2-Benzopyrone, coumarin": ["91-64-5"], "Hypericine": ["548-04-9"], "Beta-asarone": ["5273-86-9"],
    "1-Allyl-4-methoxybenzene, estragole": ["140-67-0"], "Hydrocyanic acid": ["74-90-8"], "Menthofuran": ["494-90-6"],
    "4-Allyl-1,2-dimethoxybenzene, methyleugenol": ["93-15-2"], "Pulegone": ["89-82-7", "15932-80-6"],
    "Quassin": ["76-78-8"], "1-Allyl-3,4-methylene dioxy benzene, safrole": ["94-59-7"], "Teucrin A": ["12798-51-6"],
    "Thujone (alpha and beta)": ["76-49-3", "546-80-5", "471-15-8", "1125-12-8"],
}
for name in ANNEX3_CAS:
    assert name in part_a, name   # every name must appear verbatim in Part A
part_b = text[text.index("Part B: Maximum levels"):text.index("Part B: Maximum levels") + 4000]
annex3 = [{"name": n, "cas": c, "part_b": n.split(",")[0].split(" (")[0].lower() in part_b.lower()
           or n.split(", ")[-1].lower() in part_b.lower()} for n, c in ANNEX3_CAS.items()]

json.dump({"source": "02008R1334-20260216", "table1": table, "annex3_part_a": annex3},
          open(DATA / "out" / "eu_parsed.json", "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print("rows", len(table), "with restrictions", sum(1 for r in table if r["restriction"]),
      "with footnote", sum(1 for r in table if r["footnotes"]), "without CAS", sum(1 for r in table if not r["cas"]),
      "annex III part A", len(annex3), "of which in part B", sum(a["part_b"] for a in annex3))
