"""Make the heading font assets/fonts/SiteSerif-Latin.woff2 from Source Serif 4 (Adobe, OFL 1.1).

Usage: python tools/make_font.py SourceSerif4Variable-Roman.otf.woff2
The input is source-serif-4.005_WOFF2/VAR/SourceSerif4Variable-Roman.otf.woff2 from release 4.005R of
github.com/adobe-fonts/source-serif (sha256 f146ee102dddcc5bc7a2cf4af5bcf129832195941b92bd0a512626f390688c1e).

What it keeps (see assets/fonts/README.md):
  - characters: printable Basic Latin (U+0020-007E), no-break space and the typographic punctuation
    below; headings use only these (Chinese text falls back to the system Song face)
  - weight axis 400-600 (headings use 400, 500 and 600), optical size axis 16-36 (heading sizes)
  - OpenType features: kerning, standard and contextual ligatures, locale forms, glyph composition and
    the weight-dependent glyph swaps (rvrn); fractions, small caps and the like are dropped (not used)
It also prints the size-adjust / ascent / descent overrides of the "SiteSerif Fallback" faces in
assets/style.css (Georgia scaled to SiteSerif's average width, English letter frequencies, at the
heading sizes of each weight),
when Georgia is installed (Windows: C:/Windows/Fonts/georgia.ttf, georgiab.ttf).
Renaming: a subset is a Modified Version under the OFL and "Source" is a Reserved Font Name, so the
family and PostScript names become "SiteSerif"; copyright, trademark and license entries stay.
Needs fontTools and brotli (pip install fonttools brotli).
"""
import sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets/fonts/SiteSerif-Latin.woff2"
EXTRA = "\u00a0\u00b7\u2013\u2014\u2018\u2019\u201c\u201d\u2026"   # no-break space, middle dot, en and em dash, quotes, ellipsis
UNICODES = list(range(0x20, 0x7F)) + [ord(c) for c in EXTRA]
AXES = {"wght": (400, 600), "opsz": (16, 36)}
FEATURES = ["kern", "liga", "calt", "locl", "ccmp", "rvrn"]
RENAME_IDS = {1, 3, 4, 6, 16, 17, 25}


def main(src):
    font = TTFont(src)
    font = instancer.instantiateVariableFont(font, AXES)
    opts = subset.Options()
    opts.layout_features = FEATURES
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.flavor = "woff2"
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=UNICODES)
    sub.subset(font)
    for rec in font["name"].names:
        if rec.nameID in RENAME_IDS:
            s = str(rec).replace("Source Serif 4", "SiteSerif").replace("SourceSerif4", "SiteSerif")
            rec.string = s
    font.flavor = "woff2"
    font.save(OUT)
    print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size} bytes, {len(font.getBestCmap())} characters, "
          f"axes {[(a.axisTag, a.minValue, a.maxValue) for a in font['fvar'].axes]}")


# English letter frequencies (with space), for the average width of a heading
FREQ = {" ": 18.3, "e": 10.2, "t": 7.5, "a": 6.5, "o": 6.2, "n": 5.7, "i": 5.7, "s": 5.3, "r": 5.0, "h": 4.9,
        "l": 3.3, "d": 3.3, "u": 2.3, "c": 2.2, "m": 2.0, "f": 2.0, "w": 1.7, "g": 1.6, "p": 1.5, "y": 1.4,
        "b": 1.2, "v": 0.8, "k": 0.6, "x": 0.15, "j": 0.1, "q": 0.1, "z": 0.07, "A": 0.3, "C": 0.3, "G": 0.2,
        "M": 0.3, "S": 0.3, "D": 0.2, "P": 0.2, "R": 0.1, "T": 0.2, "F": 0.1, "I": 0.1, "B": 0.1, "E": 0.1,
        "L": 0.1, "N": 0.1, "O": 0.1}


def avg_width(font):
    cmap, hmtx, upm = font.getBestCmap(), font["hmtx"], font["head"].unitsPerEm
    return sum(hmtx[cmap[ord(c)]][0] * w for c, w in FREQ.items()) / sum(FREQ.values()) / upm


def fallback_overrides():
    fonts = Path("C:/Windows/Fonts")
    if not (fonts / "georgia.ttf").exists():
        print("Georgia not found: fallback overrides not computed"); return
    # optical size for each weight: 500 is h1 / h2 (h1 28 px on project pages); 600 (site name, project
    # titles) at 24, which gave the same line breaks with and without the font in the check of all pages
    for w, opsz in ((400, 24), (500, 28), (600, 24)):
        inst = instancer.instantiateVariableFont(TTFont(OUT), {"wght": w, "opsz": opsz})
        g = TTFont(fonts / ("georgiab.ttf" if w >= 600 else "georgia.ttf"))
        sa = avg_width(inst) / avg_width(g)
        upm, h = inst["head"].unitsPerEm, inst["hhea"]
        print(f"weight {w} ({'Georgia Bold' if w >= 600 else 'Georgia'}): size-adjust: {sa * 100:.2f}%; "
              f"ascent-override: {h.ascent / upm / sa * 100:.2f}%; descent-override: {-h.descent / upm / sa * 100:.2f}%; "
              f"line-gap-override: {h.lineGap / upm / sa * 100:.2f}%;")


if __name__ == "__main__":
    main(sys.argv[1])
    fallback_overrides()
