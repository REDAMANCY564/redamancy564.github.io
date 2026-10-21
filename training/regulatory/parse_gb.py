"""Extract tables B.2 / B.3 of GB 2760-2024 (permitted natural / synthetic food flavourings).

Input: the official text downloaded from the 食品安全国家标准数据检索平台 (sppt.cfsa.net.cn), saved as
    training/data/regulatory/cn/GB 2760-2024 食品安全国家标准　食品添加剂使用标准.pdf
Needs PyMuPDF (pip install pymupdf). Table cells are located with find_tables(); the characters of each
cell are then re-assembled by position (the PDF text order scrambles some names, e.g. "2戊醇-").
Only code, Chinese name, FEMA no. and the English name (for cross-checking, not for publication) are kept.
Output: training/data/regulatory/out/gb_parsed.json  {"B2": [...], "B3": [...]}
"""
import json, re
from pathlib import Path
import pymupdf

DATA = Path(__file__).resolve().parents[1] / "data" / "regulatory"
PDF = DATA / "cn" / "GB 2760-2024 食品安全国家标准　食品添加剂使用标准.pdf"


def cell_text(chars, bbox):
    x0, y0, x1, y1 = bbox
    cs = [c for c in chars if x0 - 1 <= (c[1][0] + c[1][2]) / 2 <= x1 + 1 and y0 - 1 <= (c[1][1] + c[1][3]) / 2 <= y1 + 1]
    lines = []  # group characters whose vertical extents overlap, then read each line left to right
    for c in sorted(cs, key=lambda c: (c[1][1] + c[1][3]) / 2):
        cy0, cy1 = c[1][1], c[1][3]
        for ln in lines:
            ov = min(cy1, ln["y1"]) - max(cy0, ln["y0"])
            if ov > 0.4 * min(cy1 - cy0, ln["y1"] - ln["y0"]):
                ln["c"].append(c)
                ln["y0"], ln["y1"] = min(ln["y0"], cy0), max(ln["y1"], cy1)
                break
        else:
            lines.append({"y0": cy0, "y1": cy1, "c": [c]})
    lines.sort(key=lambda ln: ln["y0"])
    out = ""
    for k, ln in enumerate(lines):
        cs = sorted(ln["c"], key=lambda c: c[1][0])
        if k:
            # the previous line stopped well before the cell edge: a new name starts here, not a wrapped one
            prev = max(c[1][2] for c in lines[k - 1]["c"])
            out += " / " if x1 - prev > 2.5 * (cs[0][1][3] - cs[0][1][1]) else ""
        out += "".join(c[0] for c in cs)
    return out


def page_chars(page):
    out = []
    for b in page.get_text("rawdict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                for ch in s["chars"]:
                    if ch["c"].strip():
                        out.append((ch["c"], ch["bbox"]))
    # rare characters (e.g. 䓝) are drawn as small inline images, not text: keep them as placeholders
    for im in page.get_image_info(hashes=True):
        x0, y0, x1, y1 = im["bbox"]
        if x1 - x0 < 15 and y1 - y0 < 15:
            out.append(("{img:" + im["digest"].hex()[:12] + "}", im["bbox"]))
    return out


# Inline glyph images -> characters, read from the rendered rows (2026-10-21). An unknown image stops the run.
GLYPHS = {"9e78515e1ae7": "䓝",   # 䓝, as in 对-䓝烯 (p-menthene); 21 rows
          "4ee7694a1a51": "噁",   # 噁, as in 噁唑 (oxazole); 7 rows
          "d31b86c08ad0": "苧"}   # 苧, as in 4-苧醇 (4-thujanol); 1 row
# a cell holding several names without 又名: the first one is the display name
DISPLAY = {"S1023": "2,8-表硫-顺式-对-䓝烷",   # 2,8-表硫-顺式-对-䓝烷 (+ two more names)
           "S0697": "2,2'-(硫代二亚甲基)-二呋喃"}   # 2,2'-(硫代二亚甲基)-二呋喃 (+ 二糠基硫醚)


def main_name(code, zh):
    if code in DISPLAY:
        return DISPLAY[code]
    return re.split(r"[(（\[［{]又名| / ", zh)[0]


doc = pymupdf.open(PDF)
rows = {"B2": [], "B3": []}
unknown = {}
for pno in range(doc.page_count):
    page = doc[pno]
    chars = None
    for tb in page.find_tables().tables:
        for r in tb.rows:
            if len(r.cells) != 5 or any(c is None for c in r.cells):
                continue
            if chars is None:
                chars = page_chars(page)
            seq, code, zh, en, fema = (cell_text(chars, c) for c in r.cells)
            m = re.fullmatch(r"([NS])(\d{3,4})", code.replace(" ", ""))
            if not m:
                continue
            code = m.group(0)
            for key in re.findall(r"\{img:(\w+)\}", zh):
                if key not in GLYPHS:
                    unknown.setdefault(key, []).append(code)
                zh = zh.replace("{img:" + key + "}", GLYPHS.get(key, "□"))
            femas = re.findall(r"\d{4}", fema)   # N342 lists two FEMA numbers in one cell
            rows["B2" if m.group(1) == "N" else "B3"].append({
                "seq": int(seq) if seq.strip().isdigit() else None, "code": code, "zh": zh,
                "name": main_name(code, zh), "en": en, "femas": femas,
                "fema": femas[0] if len(femas) == 1 else None,
                "fema_raw": fema, "page_index": pno, "bbox": [round(v, 1) for v in r.bbox]})

if unknown:
    raise SystemExit("unmapped glyph images (render these rows, add to GLYPHS): " + json.dumps(unknown))
json.dump(rows, open(DATA / "out" / "gb_parsed.json", "w", encoding="utf-8"), ensure_ascii=False, indent=0)
for k, v in rows.items():
    print(k, len(v), "with FEMA", sum(1 for r in v if r["fema"]), "unique codes", len({r["code"] for r in v}))
