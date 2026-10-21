"""Check that the tool-page file and the lookup-page file agree for every library molecule (run after
build_regulatory.py). For each molecule: the EU FL numbers, GB 2760 codes and Annex III flag in
flavor-kb/data/regulatory.json must equal those of the lookup substances linked to it in
flavor-kb/data/regulatory-lookup.json. Prints the number of molecules checked and every difference; exit 1 if any.
"""
import collections, json, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
small = json.load(open(REPO / "flavor-kb" / "data" / "regulatory.json", encoding="utf-8"))
look = json.load(open(REPO / "flavor-kb" / "data" / "regulatory-lookup.json", encoding="utf-8"))

tool = {it[0]: ({e.split(";")[0] for e in it[7]}, {e.split(";")[1] for e in it[8]}, bool(it[9])) for it in small["items"]}
lk = collections.defaultdict(lambda: (set(), set(), False))
for s in look["s"]:
    for li, *_ in s[6]:
        eu, cn, a3 = lk[li]
        lk[li] = (eu | {e.split(";")[0] for e in s[3]}, cn | {e.split(";")[1] for e in s[4]}, a3 or bool(s[5]))

diff = []
for li in sorted(set(tool) | set(lk)):
    t, l = tool.get(li, (set(), set(), False)), lk.get(li, (set(), set(), False))
    if t != l:
        diff.append({"li": li, "eu_tool_only": sorted(t[0] - l[0]), "eu_lookup_only": sorted(l[0] - t[0]),
                     "cn_tool_only": sorted(t[1] - l[1]), "cn_lookup_only": sorted(l[1] - t[1]), "a3": [t[2], l[2]]})
print(json.dumps({"molecules_tool_file": len(tool), "molecules_linked_in_lookup": len(lk), "differences": len(diff)}))
for d in diff:
    print(json.dumps(d, ensure_ascii=False))
sys.exit(1 if diff else 0)
