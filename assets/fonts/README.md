# Fonts

`SiteSerif-Latin.woff2` is a Latin subset of **Source Serif 4** (variable, Roman), release
[4.005R](https://github.com/adobe-fonts/source-serif/releases/tag/4.005R) from Adobe's official repository
`adobe-fonts/source-serif`, file `source-serif-4.005_WOFF2/VAR/SourceSerif4Variable-Roman.otf.woff2`
(sha256 f146ee102dddcc5bc7a2cf4af5bcf129832195941b92bd0a512626f390688c1e).

It is licensed under the SIL Open Font License 1.1 (`OFL.txt`, copied from that release's `LICENSE.md`).
"Source" is a Reserved Font Name, and a subset counts as a Modified Version under the OFL, so the
subset's internal names were changed to "SiteSerif"; the copyright, trademark and license entries are
kept unchanged.

Subset (made with `python tools/make_font.py <the file above>`, fontTools; about 36 KB):
- characters: printable Basic Latin (U+0020-007E), no-break space, middle dot, en and em dash, curly
  quotes, ellipsis. Only headings, the site name and project titles use this font; Chinese text in
  them uses the system Song face.
- axes limited to weight 400-600 (the site uses 400, 500, 600) and optical size 16-36 (heading sizes).
- OpenType features kept: kern, liga, calt, locl, ccmp, rvrn.

`assets/style.css` declares it with a `unicode-range` that leaves out the space (so Chinese headings
do not download the font), and a "SiteSerif Fallback" face (Georgia with
size and line-metric overrides printed by the same script) that is shown until the font arrives, so
headings wrap the same before and after.
