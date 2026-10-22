"""Extract the US flavouring provisions from the current eCFR text of 21 CFR Parts 172, 182, 184 and 189.

Input: training/data/regulatory/us/p<part>.xml, downloaded with
    curl --compressed -o p172.xml "https://www.ecfr.gov/api/versioner/v1/full/2026-10-20/title-21.xml?part=172"
(same for 182, 184, 189; the endpoint refuses requests without compression). Title 21 was up to date as of
2026-10-20 (checked 2026-10-22, https://www.ecfr.gov/api/versioner/v1/titles.json). The eCFR is an unofficial
editorial compilation, not an official legal edition of the CFR.
Sections kept (user, 2026-10-22):
  172.510, 172.515, 182.10, 182.20, 182.40, 182.50, 182.60: every entry (names only; the CFR gives no CAS numbers)
  Part 184: the sections whose text names flavoring agent / flavor enhancer (21 CFR 170.3(o)(11), (12)) as a use
  Part 189: only the flavour-related prohibitions 189.110, 189.113, 189.130, 189.180
Output: training/data/regulatory/out/us_parsed.json
"""
import html, json, re
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data" / "regulatory"
US = DATA / "us"
ECFR_DATE = "2026-10-20"
LIST_SECTIONS = ["172.510", "172.515", "182.10", "182.20", "182.40", "182.50", "182.60"]
P189 = ["189.110", "189.113", "189.130", "189.180"]


def text(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def section(part_xml, n):
    m = re.search(rf'<DIV8 N="{re.escape(n)}".*?</DIV8>', part_xml, re.S)
    assert m, n
    return m.group(0)


parts = {p: open(US / f"p{p}.xml", encoding="utf-8").read() for p in ("172", "182", "184", "189")}
out = {"ecfr_date": ECFR_DATE, "sections": {}, "p184": {}, "p189": {}}

for n in LIST_SECTIONS:
    s = section(parts[n.split(".")[0]], n)
    title = re.sub(r"^§\s*[\d.]+\s*", "", text(re.search(r"<HEAD>(.*?)</HEAD>", s, re.S).group(1))).rstrip(".")
    entries = []
    if "<TABLE" in s:
        # tables: common name | botanical (scientific) name or derivation [| limitations ("Do." = same as above)]
        last = ""
        for tr in re.findall(r"<TR>(.*?)</TR>", s, re.S):
            raw = re.findall(r"<TD[^>]*?(?:/>|>(.*?)</TD>)", tr, re.S)
            cells = [text(c) for c in raw]
            if len(cells) < 2 or not cells[0]:
                continue
            lim = cells[2] if len(cells) > 2 else ""
            if len(raw) > 2 and raw[2].lstrip().startswith('<E T="03">'):
                # Quebracho bark: the eCFR table puts the rest of the scientific name in the Limitations column
                cells[1], lim = cells[1] + " " + lim, ""
            lim = re.sub(r"\s*\d+$", "", lim).strip()          # footnote marks (<sup>1</sup>)
            if lim.rstrip(".") == "Do":
                lim = last
            last = lim
            entries.append({"name": cells[0], "sci": cells[1], "limit": lim})
    else:
        # one entry per <FP-1> line; 172.515 "name; synonym; synonym.", 182.60 "Name (synonym, synonym)."
        for fp in re.findall(r"<FP-1>(.*?)</FP-1>", s, re.S):
            line = text(fp).rstrip(".")
            if n == "182.60":
                m = re.match(r"(.*?)\s*\((.*)\)$", line)
                names = [m.group(1)] + [x.strip() for x in m.group(2).split(",")] if m else [line]
            else:
                names = [x.strip() for x in line.split(";")]
            entries.append({"name": names[0], "syn": names[1:], "limit": ""})
    out["sections"][n] = {"title": title, "entries": entries}

# 172.515(c): "Δ-Decalactone and Δ-dodecalactone" (the delta lactones) in oleomargarine, 10 and 20 ppm
t515 = text(section(parts["172"], "172.515"))
assert "Δ-Decalactone and Δ-dodecalactone" in t515 and "oleomargarine" in t515
# the limitation shown on the page is the paragraph as written (user E2, 2026-10-22)
para_c = re.search(r"\(c\) (Δ-Decalactone and Δ-dodecalactone.*?respectively)", t515).group(1)
# The eCFR prints delta-decalactone as "γ-Decalactone; 5-hydroxy-decanoic acid, γ-lactone" (a second
# "γ-Decalactone" line, 4-hydroxy, is the real gamma lactone): identified by the 5-hydroxy synonym.
for e in out["sections"]["172.515"]["entries"]:
    if e["name"] == "γ-Decalactone" and any(s.startswith("5-hydroxy") for s in e["syn"]):
        e["name"], e["printed"] = "δ-Decalactone", "γ-Decalactone"
    if re.fullmatch(r"(δ|delta)-(Decalactone|Dodecalactone)", e["name"]):
        e["limit"] = "172.515(c): " + para_c

for n, body in re.findall(r'<DIV8 N="(184\.\d+)"(.*?)</DIV8>', parts["184"], re.S):
    if re.search(r"flavoring agent|flavor enhancer|170\.3\(o\)\(1[12]\)", body):
        t = text(body)
        title = re.sub(r"^§\s*[\d.]+\s*", "", text(re.search(r"<HEAD>(.*?)</HEAD>", body, re.S).group(1))).rstrip(".")
        # specific maximum levels (not only "current good manufacturing practice"): flagged for review
        levels = re.findall(r"[^.]{0,80}(?:not to exceed|maximum level|percent|parts per million|ppm|mg/kg)[^.]{0,80}", t)
        out["p184"][n] = {"title": title, "levels": levels[:6]}

for n in P189:
    s = section(parts["189"], n)
    out["p189"][n] = {"title": re.sub(r"^§\s*[\d.]+\s*", "", text(re.search(r"<HEAD>(.*?)</HEAD>", s, re.S).group(1))).rstrip("."),
                      "text": text(s)[:900]}

(DATA / "out" / "us_parsed.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print({n: len(v["entries"]) for n, v in out["sections"].items()}, "184:", len(out["p184"]), "189:", list(out["p189"]))
print("172.515(c):", [e["name"] for e in out["sections"]["172.515"]["entries"] if e["limit"]])
print("172.510 with limitations:", sum(1 for e in out["sections"]["172.510"]["entries"] if e["limit"]))
