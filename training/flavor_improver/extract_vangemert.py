"""Extract the text of the van Gemert (2011) odour threshold compilation for thresholds.py.

The PDF is copyrighted and not in the repo (see .gitignore). Each table row is rebuilt as one
line from word coordinates, and the running page header is split into "WATER" and
"detection (d) ..." lines, which thresholds.py skips. Checked on 2026-10-16: re-running
thresholds.py on this text reproduces all 49 stage-1 thresholds exactly.

Usage: python extract_vangemert.py <van Gemert PDF> <output .txt>     (needs: pip install pymupdf)
"""
import re
import sys

import pymupdf


def page_lines(page, same_line=2.5, gap=18):
    words = sorted(page.get_text("words"), key=lambda w: ((w[1] + w[3]) / 2, w[0]))
    rows = []
    for w in words:
        yc = (w[1] + w[3]) / 2
        if rows and abs(yc - rows[-1][0]) <= same_line:
            rows[-1][1].append(w)
        else:
            rows.append([yc, [w]])
    out, prev = [], None
    for yc, ws in rows:
        if prev is not None and yc - prev > gap:
            out.append("")      # keep paragraph breaks: thresholds.py uses blank lines to find entry ends
        out.append(" ".join(w[4] for w in sorted(ws, key=lambda w: w[0])))
        prev = yc
    return out


def main():
    pdf, out_path = sys.argv[1:3]
    lines = []
    for i, page in enumerate(pymupdf.open(pdf)):
        lines.append(f"=====PAGE {i + 1}=====")
        lines += page_lines(page)
    text = "\n".join(lines)
    text = re.sub(r"^PART (II|III)$", r"PART  \1", text, flags=re.M)
    text = re.sub(r"^WATER detection \(d\)", "WATER\ndetection (d)", text, flags=re.M)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(text)


if __name__ == "__main__":
    main()
