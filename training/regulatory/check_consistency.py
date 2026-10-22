"""Check that the tool-page file and the lookup-page file agree for every library molecule (run after
build_regulatory.py). For each molecule: the EU FL numbers, GB 2760 codes, Annex III flag and US entries
(21 CFR sections, Part 189, FEMA notes, 2018 removal) in
flavor-kb/data/regulatory.json must equal those of the lookup substances linked to it in
flavor-kb/data/regulatory-lookup.json. Prints the number of molecules checked and every difference; exit 1 if any.
"""
import collections, json, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
small = json.load(open(REPO / "flavor-kb" / "data" / "regulatory.json", encoding="utf-8"))
look = json.load(open(REPO / "flavor-kb" / "data" / "regulatory-lookup.json", encoding="utf-8"))

# US entries compared without the stereo flag (a display note, like the EU/China comparison by code)
us_set = lambda es: {e[:-2] if e.endswith(";s") else e for e in es}
tool = {it[0]: ({e.split(";")[0] for e in it[7]}, {e.split(";")[1] for e in it[8]}, bool(it[9]), us_set(it[10])) for it in small["items"]}
EMPTY = (set(), set(), False, set())
lk = collections.defaultdict(lambda: EMPTY)
for s in look["s"]:
    for li, *_ in s[6]:
        eu, cn, a3, us = lk[li]
        lk[li] = (eu | {e.split(";")[0] for e in s[3]}, cn | {e.split(";")[1] for e in s[4]}, a3 or bool(s[5]), us | us_set(s[8]))

diff = []
for li in sorted(set(tool) | set(lk)):
    t, l = tool.get(li, EMPTY), lk.get(li, EMPTY)
    if t != l:
        diff.append({"li": li, "eu_tool_only": sorted(t[0] - l[0]), "eu_lookup_only": sorted(l[0] - t[0]),
                     "cn_tool_only": sorted(t[1] - l[1]), "cn_lookup_only": sorted(l[1] - t[1]), "a3": [t[2], l[2]],
                     "us_tool_only": sorted(t[3] - l[3]), "us_lookup_only": sorted(l[3] - t[3])})
print(json.dumps({"molecules_tool_file": len(tool), "molecules_linked_in_lookup": len(lk), "differences": len(diff)}))
for d in diff:
    print(json.dumps(d, ensure_ascii=False))
sys.exit(1 if diff else 0)
