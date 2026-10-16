"""Pick water odor thresholds from L.J. van Gemert (2011), Part II (water), for a list of compounds.

The compilation PDF is copyrighted and not in the repo; this script reads a text extraction
of it (path given on the command line) and writes only the selected values with their sources.

Rule (fixed in advance, no cherry-picking):
  1. detection threshold from Czerny et al. (2008)   (one lab, one method: ASTM 3-AFC)
  2. else detection threshold from Buttery et al.     (one lab, consistent method)
  3. else detection threshold from Karaguel-Yueceer et al. (2003/2004)  (dairy matrix study)
  4. else: no value -> compound flagged for review
A "range" over all listed values (detection, recognition, unspecified) is reported too.
Compounds are located by CAS number in the entry headings.
"""
import json
import re
import sys
from pathlib import Path

NUM = r"[0-9][0-9 ,]*(?:\.[0-9 ]*[0-9])?"
VALUE_RE = re.compile(rf"(?:^|\s)([dr])?\s*({NUM})(?:\s*[-–]\s*({NUM}))?\s*(?:\([^)]*\))?\s*$")


def to_float(s):
    return float(s.replace(" ", "").replace(",", ""))


def is_heading(line):
    """Entry headings start with an upper-case chemical name (lower-case prefixes such as tert- or
    stereo descriptors like (R)-(+)- allowed); author lines start with a capitalised surname."""
    if "⇒" in line:
        return True
    first = re.sub(r"^\s*(\([^)]*\)-?)+", "", line).split(" ")[0] if line.strip() else ""
    letters = re.findall(r"[A-Za-z]", first)
    return len(letters) >= 4 and sum(c.isupper() for c in letters) / len(letters) > 0.7


def parse_entries(lines, start):
    """Collect (author_text, kind, lo, hi) rows of one compound entry starting at heading index."""
    rows, author = [], ""
    j = start + 1
    while j < len(lines):
        t = lines[j].rstrip()
        if re.match(r"^=====PAGE|^WATER\s*$|^\s*detection \(d\)", t):
            j += 1
            continue
        if not t.strip():
            nxt = lines[j + 1] if j + 1 < len(lines) else ""
            if is_heading(nxt):
                break
            j += 1
            continue
        if is_heading(t) and rows:
            break
        m = VALUE_RE.search(t)
        if m and re.search(r"\(\d{4}", author + t):
            text = (author + " " + t[:m.start()]).strip()
            rows.append((text, m.group(1) or "", to_float(m.group(2)), to_float(m.group(3)) if m.group(3) else None))
            author = ""
        else:
            author += " " + t.strip()
        j += 1
    return rows


def pick(rows):
    def first(pred):
        # single detection values only; ranges are skipped (they are still part of "range")
        for text, kind, lo, hi in rows:
            if kind == "d" and hi is None and pred(text):
                return text, lo
        return None
    for label, pred in (("Czerny et al. (2008)", lambda s: "Czerny" in s and "2008" in s),
                        ("Buttery et al.", lambda s: "Buttery" in s),
                        ("Karagül-Yüceer et al. (2003/2004)", lambda s: "Karag" in s)):
        r = first(pred)
        if r and r[1] is not None:
            return {"value_mg_kg": r[1], "source": label, "entry": r[0]}
    return None


def main():
    text_path, compounds_path, out_path = sys.argv[1:4]
    lines = Path(text_path).read_text(encoding="utf-8").splitlines()
    water = lines[next(i for i, l in enumerate(lines) if "PART  II" in l):
                  next(i for i, l in enumerate(lines) if "PART  III" in l)]
    compounds = json.loads(Path(compounds_path).read_text(encoding="utf-8"))
    out = {}
    for name, cas in compounds.items():
        idx = [i for i, l in enumerate(water) if f"[{cas}]" in l or f"[{cas}," in l or f", {cas}]" in l]
        if not idx:
            out[name] = {"cas": cas, "status": "not_found"}
            continue
        rows = parse_entries(water, idx[0])
        vals = [v for _, _, lo, hi in rows for v in (lo, hi) if v is not None]
        rec = {"cas": cas, "heading": water[idx[0]].strip(), "n_values": len(rows),
               "range_mg_kg": [min(vals), max(vals)] if vals else None}
        p = pick(rows)
        rec.update(p if p else {"status": "no_rule_match"})
        out[name] = rec
    Path(out_path).write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    for n, r in out.items():
        print(f"{n:28s} {r.get('value_mg_kg', '-')!s:>10} mg/kg  {r.get('source', r.get('status')):32s} "
              f"range {r.get('range_mg_kg')}  n={r.get('n_values', 0)}")


if __name__ == "__main__":
    main()
