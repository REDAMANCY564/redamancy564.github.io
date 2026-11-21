"""Build case/index.html and case/i18n/{zh,en}.json for the case page /case/ (branch case-page only).

Step 9 uses the author group's data on infant formula and 303 human milk samples (mean relative
contents, and the group's own ROAV values in AUTHOR_ROAV below).

Inputs, all in _inputs/case-build/ (not committed): url_example4_zh.json (GC-MS example 4 result),
fi_{cmf,pof}_sample_n10.csv.json (flavor-improver comparisons), preds.json (odor and taste model
outputs), and the three group-mean CSVs hm_target_n303.csv, cmf_sample_n10.csv, pof_sample_n10.csv
(made by build_fc.py from the author group's data; copies are published in case/data/).
Run from the repository root: python tools/build_case.py, then python tools/prerender.py.
Edit the page text here, not in case/index.html or case/i18n/*.json.
"""
import csv, html, json, re, sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
B = ROOT / "_inputs" / "case-build"
OUT = ROOT / "case"
V = "20261121i"
# Source of the step 9 data (formula and 303 human milk samples). No paper citation yet: the data are
# named as the author group's. When the paper is out, add the citation and DOI here only, e.g.
# FC_WHO = ("作者课题组（Cui 等，期刊 年份，doi:…）", "the author group (Cui et al., Journal year, doi:…)").
FC_WHO = ("作者课题组", "the author group")                       # "第 9 步用{FC_WHO} 303 份母乳……"
FC_DATA = ("作者课题组数据", "data of the author group")         # source line in the data list
FC_COL = ("课题组计算值", "Group values")           # header of the ROAV column in step 9
FC_RANK = ("课题组排序", "Group rank")                            # header of the rank column in step 9

# ---------------------------------------------------------------- names (CAS -> zh, en)
N = {
    "64-19-7": ("乙酸", "acetic acid"), "107-92-6": ("丁酸", "butanoic acid"), "142-62-1": ("己酸", "hexanoic acid"),
    "124-07-2": ("辛酸", "octanoic acid"), "112-05-0": ("壬酸", "nonanoic acid"), "334-48-5": ("癸酸", "decanoic acid"),
    "143-07-7": ("十二酸", "dodecanoic acid"), "66-25-1": ("己醛", "hexanal"), "111-71-7": ("庚醛", "heptanal"),
    "124-13-0": ("辛醛", "octanal"), "18829-55-5": ("(E)-2-庚烯醛", "(E)-2-heptenal"), "124-19-6": ("壬醛", "nonanal"),
    "2548-87-0": ("(E)-2-辛烯醛", "(E)-2-octenal"), "4313-03-5": ("(E,E)-2,4-庚二烯醛", "(E,E)-2,4-heptadienal"),
    "100-52-7": ("苯甲醛", "benzaldehyde"), "18829-56-6": ("(E)-2-壬烯醛", "(E)-2-nonenal"),
    "3913-81-3": ("(E)-2-癸烯醛", "(E)-2-decenal"), "5910-87-2": ("(E,E)-2,4-壬二烯醛", "(E,E)-2,4-nonadienal"),
    "25152-83-4": ("(E,Z)-2,4-癸二烯醛", "(E,Z)-2,4-decadienal"), "25152-84-5": ("(E,E)-2,4-癸二烯醛", "(E,E)-2,4-decadienal"),
    "71-41-0": ("1-戊醇", "1-pentanol"), "2918-13-0": ("1-庚烯-3-酮", "1-hepten-3-one"),
    "4312-99-6": ("1-辛烯-3-酮", "1-octen-3-one"), "111-11-5": ("辛酸甲酯", "methyl octanoate"),
    "106-32-1": ("辛酸乙酯", "ethyl octanoate"), "110-42-9": ("癸酸甲酯", "methyl decanoate"),
    "5989-27-5": ("D-柠檬烯", "D-limonene"), "3777-69-3": ("2-戊基呋喃", "2-pentylfuran"),
    "4229-91-8": ("2-丙基呋喃", "2-propylfuran"), "585-25-1": ("2,3-辛二酮", "2,3-octanedione"),
    "3391-86-4": ("1-辛烯-3-醇", "1-octen-3-ol"), "3658-80-8": ("二甲基三硫", "dimethyl trisulfide"),
    "624-92-0": ("二甲基二硫", "dimethyl disulfide"), "110-43-0": ("2-庚酮", "2-heptanone"),
    "110-62-3": ("戊醛", "pentanal"),
}
LABEL = {x["zh"]: x["en"] for x in json.load(open(ROOT / "odor-predictor/model/labels.json", encoding="utf-8"))}

zh, en = {}, {}
def T(key, z, e):
    """Register a text in both languages and return its key."""
    zh[key], en[key] = z, e
    return key
def cn(cas):
    T("cn." + cas, N[cas][0], N[cas][1])
    return f'<span data-i18n="cn.{cas}">{html.escape(N[cas][0])}</span>'
def nobr_end(t, lang):
    """Keep the end of a paragraph together (no one- or two-character last line), as elsewhere on the site."""
    m = re.search(r"([^<>]*)$", t); tail = m.group(1); head = t[:m.start(1)]
    if lang == "zh":
        if len(tail) < 9 or "&" in tail[-6:] or "nobr" in head[-40:]: return t
        cut = len(tail) - 5
        while cut > 0 and re.match(r"[A-Za-z0-9_]{2}", tail[cut - 1:cut + 1]): cut -= 1   # not inside a Latin word ("HM0031")
        if cut < 4: return t
        return head + tail[:cut] + '<span class="nobr">' + tail[cut:] + "</span>"
    w = tail.rsplit(" ", 2)
    if len(w) < 3 or len(tail) < 20 or "&" in w[1] + w[2]: return t
    return head + w[0] + ' <span class="nobr">' + w[1] + " " + w[2] + "</span>"
def p(key, z, e, cls=None, tag="p"):
    z, e = nobr_end(z, "zh"), nobr_end(e, "en")
    T(key, z, e)
    c = f' class="{cls}"' if cls else ""
    return f'<{tag}{c} data-i18n-html="{key}">{z}</{tag}>'
def th(key, z, e, num=False):
    T(key, z, e)
    cls = ' class="num"' if num else ""
    return f'<th{cls} data-i18n-html="{key}">{z}</th>'
def a(href, text):
    return f'<a href="{href}">{text}</a>'
def ext(href, text):
    return f'<a href="{href}" target="_blank" rel="noopener">{text}</a>'
def doi(d):
    return '<a class="nobr" href="https://doi.org/' + d + '" target="_blank" rel="noopener">doi:' + d + "</a>"

P4 = "10.1016/j.fbio.2026.110162"
P4ZH = f"Cui 等（2026，<i>Food Bioscience</i>，{doi(P4)}）"   # full citation: background and data sources only
P4EN = f"Cui et al. (2026, <i>Food Bioscience</i>, {doi(P4)})"
C4ZH, C4EN = "Cui 等（2026）", "Cui et al. (2026)"                 # everywhere else
SAMPLE = "HM_Test"   # the example sample everywhere on the site; its number in Cui et al. (2026) is given once, in the data sources
SAMPLE_NO = "HM0031"
FLAVORNET = '<a href="https://www.flavornet.org/" target="_blank" rel="noopener">Flavornet</a>'

# ---------------------------------------------------------------- data
ex4 = json.load(open(B / "url_example4_zh.json", encoding="utf-8"))
step1 = [(r[5], float(r[2]), r[3]) for r in ex4["result"][1:] if r[2] not in ("-", "")]
assert len(step1) == 27, len(step1)
rank = {re.sub(r"\s*强度曲线.*", "", r[1]): r for r in ex4["rank"][1:]}
KEY9 = [("5910-87-2", "0.243", 0.01, "100"), ("2918-13-0", "0.809", 0.04, "83.4"), ("18829-56-6", "0.447", 0.08, "23.0"),
        ("25152-83-4", "0.164", 0.04, "16.9"), ("2548-87-0", "1.02", 0.34, "12.4"), ("66-25-1", "13.1", 4.5, "12.0"),
        ("124-19-6", "0.683", 0.32, "8.79"), ("3913-81-3", "0.511", 0.30, "7.02"), ("124-13-0", "0.221", 0.70, "1.30")]
preds = json.load(open(B / "preds.json", encoding="utf-8"))

def fi(name):
    o = json.load(open(B / name, encoding="utf-8"))
    m = re.search(r"共有 (\d+) 个物质参与.*?余弦相似度为 ([\d.]+)", o["user-cmp"], re.S)
    return int(m.group(1)), m.group(2), o["gap"][1]
cmf_n, cmf_cos, cmf_gap = fi("fi_cmf_sample_n10.csv.json")
pof_n, pof_cos, pof_gap = fi("fi_pof_sample_n10.csv.json")
NAME2CAS = {"(E)-2-Nonenal": "18829-56-6", "Dimethyl trisulfide": "3658-80-8", "1-Octen-3-one": "4312-99-6",
            "Dimethyl disulfide": "624-92-0", "(E,E)-2,4-Decadienal": "25152-84-5", "1-Hepten-3-one": "2918-13-0",
            "2-Heptanone": "110-43-0", "Pentanal": "110-62-3", "Hexanal": "66-25-1", "(E,Z)-2,4-Decadienal": "25152-83-4",
            "(E,E)-2,4-Nonadienal": "5910-87-2", "2,3-Octanedione": "585-25-1", "Heptanal": "111-71-7",
            "(E)-2-Decenal": "3913-81-3", "Nonanal": "124-19-6", "Octanal": "124-13-0", "(E)-2-Octenal": "2548-87-0",
            "1-Octen-3-ol": "3391-86-4", "(E)-Hept-2-enal": "18829-55-5", "1-Penten-3-one": "1629-58-9"}
N["1629-58-9"] = ("1-戊烯-3-酮", "1-penten-3-one")

# HM ROAV: tool (mean contents) vs the author group's values (per-sample, then averaged)
hm = {}
for row in list(csv.reader(open(B / "hm_target_n303.csv", encoding="utf-8-sig")))[1:]:
    if row[2] != "not detected" and row[3]:
        hm[row[1]] = float(row[2]) / float(row[3])
mx = max(hm.values())
AUTHOR_ROAV = {"5910-87-2": 51.94, "4312-99-6": 46.18, "2918-13-0": 37.99, "66-25-1": 33.05, "18829-56-6": 17.84, "124-19-6": 14.01,
        "124-13-0": 5.42, "2548-87-0": 5.14, "25152-83-4": 4.64, "3913-81-3": 2.50, "111-71-7": 2.11, "25152-84-5": 0.85,
        "585-25-1": 0.84}
hm_rows = sorted([(c, 100 * v / mx) for c, v in hm.items() if 100 * v / mx >= 1], key=lambda x: -x[1])
fc_rank = {c: i + 1 for i, (c, _) in enumerate(sorted(AUTHOR_ROAV.items(), key=lambda x: -x[1]))}

def f3(x):
    return f"{x:.3g}" if x < 100 else f"{x:.0f}"

# ---------------------------------------------------------------- page
S = []   # sections
def section(sid, key, z, e, body):
    T(key, z, e)
    S.append(f'    <section id="{sid}">\n      <h2 data-i18n="{key}">{z}</h2>\n' + "\n".join("      " + b for b in body) + "\n    </section>")
def qa(sid, q_z, q_e, tool_z, tool_e):
    return [p(f"{sid}.q", f"<b>问题：</b>{q_z}", f"<b>Question:</b> {q_e}", "cs-q"),
            p(f"{sid}.tool", f"<b>工具：</b>{tool_z}", f"<b>Tool:</b> {tool_e}", "cs-tool")]
def lim(sid, z, e):
    return p(f"{sid}.lim", f"<b>局限：</b>{z}", f"<b>Limitations:</b> {e}", "cs-lim")
def h3(key, z, e):
    T(key, z, e)
    return f'<h3 data-i18n="{key}">{z}</h3>'
def fig(src, w, h, key, z, e, alt_key, alt_z, alt_e):
    T(key, z, e); T(alt_key, alt_z, alt_e)
    return (f'<figure class="cs-fig"><img src="img/{src}" width="{w}" height="{h}" loading="lazy" '
            f'data-i18n-attr="alt:{alt_key}" alt="{html.escape(alt_z)}"><figcaption data-i18n-html="{key}">{z}</figcaption></figure>')

# 0 background (user's final text, verbatim)
section("background", "s0.h", "背景", "Background", [
    p("s0.p1", "母乳是婴儿喂养的金标准。婴儿配方奶粉的研发目标已从“营养母乳化”“结构母乳化”进一步迈向“风味母乳化”：婴儿配方奶粉的宏量营养素已较接近母乳，但在风味上仍有明显差异，这会影响婴儿的接受度，也可能影响婴儿日后的饮食偏好。弄清母乳的关键风味物质及其与配方奶粉的差别，是风味母乳化的第一步。",
      "Human milk is the gold standard for infant feeding. Infant formula development has moved from matching human milk in nutrition, to matching its structure, and now towards matching its flavor. Infant formula is already close to human milk in macronutrients but still differs clearly in flavor, which affects how well infants accept it and may also shape their later food preferences. Identifying the key flavor compounds of human milk, and how formula differs, is the first step towards matching its flavor."),
    p("s0.p2", f"本页以一份母乳样品为例，演示完整的分析流程。样品 {SAMPLE} 是 {P4ZH}50 份母乳中的一份，挥发物组成接近 50 份的平均水平（按三种距离计算，与平均值的接近程度分别排第 2、3、2 位）。第 1~8 步只使用这份样品和已发表数据；第 9 步使用{FC_WHO[0]} 303 份母乳和 20 个婴儿配方奶粉样品的平均数据。每一步依次说明要回答的问题、所用工具（点击链接可载入相同的输入）、结果、解读和局限。",
      f"This page takes one human milk sample as an example of the complete analysis. Sample {SAMPLE} is one of the 50 human milk samples of {P4EN}, and its volatile profile is close to the average of the 50 (ranked 2nd, 3rd and 2nd for closeness to the mean by three distance measures). Steps 1 to 8 use only this sample and published data; step 9 uses the mean data of {FC_WHO[1]} for 303 human milk samples and 20 infant formula samples. Each step gives the question, the tool (the links load the same input), the result, the interpretation and the limitations."),
])

# 1 GC-MS
rows1 = []
for cas, rel, rt in step1:
    rows1.append(f'<tr><td class="nm">{cn(cas)}</td><td class="nw">{cas}</td><td class="num">{rt}</td><td class="num">{rel:.2f}</td></tr>')
tot = sum(r[1] for r in step1)
T("s1.total", "合计（27 个物质）", "Total (27 compounds)")
tbl1 = ('<div class="table-wrap"><table class="cs-table"><thead><tr>' + th("s1.c1", "物质", "Compound") + th("s1.c2", "CAS 号", "CAS")
        + th("s1.c3", "实际保留时间（min）", "Retention time (min)", True) + th("s1.c4", "相对含量（%）", "Relative content (%)", True)
        + "</tr></thead><tbody>" + "".join(rows1)
        + f'<tr class="cs-sum"><td colspan="3" data-i18n="s1.total">合计（27 个物质）</td><td class="num">{tot:.2f}</td></tr></tbody></table></div>')
section("step1", "s1.h", "第 1 步　GC-MS 数据处理", "Step 1. GC-MS data processing", qa("s1",
    "一份母乳的 GC-MS 峰表里有哪些目标物质，各占多少？",
    "Which target compounds are in the GC-MS peak table of one human milk sample, and in what proportions?",
    f'{a("../gcms-interpreter/?example=example4", "GC-MS 风味解读，示例 4")}（{SAMPLE} 的原始仪器导出报告，Agilent MassHunter 谱库检索结果，345 条峰记录）。标准文件由 {C4ZH}补充材料 Table S1 的 75 个物质和保留时间生成；保留时间范围 ± 0.3 min，相对含量按目标物质归一化，阈值用“作者课题组取值”。',
    f'{a("../gcms-interpreter/?example=example4", "GC-MS flavor interpreter, example 4")} (the original instrument report of {SAMPLE}, an Agilent MassHunter library search with 345 peak records). The standard file holds the 75 compounds and retention times of Table S1 of {C4EN}; retention time range ± 0.3 min, relative content normalized to the targets, author group threshold values.') + [
    tbl1,
    p("s1.r1", "共找到 27 个目标物质（按这 27 个物质归一化）。相对含量最高的是辛酸、己酸、癸酸和己醛。",
      "27 target compounds were found (normalized over these 27). Octanoic, hexanoic and decanoic acid and hexanal have the highest relative contents."),
    p("s1.i1", f"<b>解读：</b>与作者开发的数据处理程序对比（同一份峰表）。作者程序在 125 个目标物质中找到 29 个，并按这 29 个归一化；本工具在 Table S1 的 75 个物质中找到 27 个（1-癸醇和 3-庚烯酸不在 Table S1 中），按这 27 个归一化，因此各物质的数值约为作者程序的 1.002 倍。统一按这 27 个物质归一化后，两者全部一致，最大相差 0.005 个百分点。Table S1 的保留时间比 {SAMPLE} 的实测值早 0.1~0.3 min，因此范围取 ± 0.3 min；取 ± 0.2 min 会漏掉壬醛、(E)-2-壬烯醛等 4 个物质，取 ± 0.1 min 只能找到 16 个。",
      f"<b>Interpretation:</b> compared with the data processing program developed by the author (same peak table). The author's program finds 29 of its 125 target compounds and normalizes over these 29; this tool finds 27 of the 75 Table S1 compounds (1-decanol and 3-heptenoic acid are not in Table S1) and normalizes over these 27, so each value is about 1.002 times the author's. Normalized over the same 27 compounds, the two agree for all of them, with a largest difference of 0.005 percentage points. The retention times in Table S1 are 0.1 to 0.3 min earlier than those measured for {SAMPLE}, hence a range of ± 0.3 min; ± 0.2 min misses 4 compounds such as nonanal and (E)-2-nonenal, and ± 0.1 min finds only 16."),
    lim("s1", f"相对含量是半定量结果（未加内标）。工具不重新定性，直接采用谱库检索结果；保留时间范围越大，越容易把误鉴定的峰也纳入（本例未出现）。2,4-二叔丁基苯酚、2-乙基-1-己醇、2-苯氧基乙醇和异佛尔酮是采样容器和实验耗材带入的迁移物（Table S1 注 A），保留在标准文件中，但在 {SAMPLE} 中均未检出。",
        f"Relative contents are semi-quantitative (no internal standard). The tool does not re-identify peaks and takes the library search results as they are; a wider retention time range is more likely to take in misidentified peaks (none here). 2,4-Di-tert-butylphenol, 2-ethyl-1-hexanol, 2-phenoxyethanol and isophorone are migrants from sampling containers and laboratory materials (Table S1, footnote A); they stay in the standard file, but none was detected in {SAMPLE}."),
])

# 2 key flavor compounds
rows2 = "".join(f'<tr><td class="nm">{cn(c)}</td><td class="num">{rel}</td><td class="num">{thr:g}</td><td class="num">{ro}</td></tr>' for c, rel, thr, ro in KEY9)
tbl2 = ('<div class="table-wrap"><table class="cs-table"><thead><tr>' + th("s2.c1", "物质", "Compound") + th("s2.c2", "相对含量（%）", "Relative content (%)", True)
        + th("s2.c3", "阈值（μg/kg，水中）", "Threshold (μg/kg, water)", True) + th("s2.c4", "ROAV", "ROAV", True) + "</tr></thead><tbody>" + rows2 + "</tbody></table></div>")
section("step2", "s2.h", "第 2 步　关键风味物质", "Step 2. Key flavor compounds", qa("s2",
    f"哪些物质对 {SAMPLE} 的气味贡献最大？", f"Which compounds contribute most to the aroma of {SAMPLE}?",
    f'同一页的“风味解读”一步，计算相对气味活性值（ROAV）；{a("../gcms-interpreter/?example=example4", "示例 4")} 已自动选好“作者课题组取值”。',
    f'The “flavor interpretation” step of the same page, which computes the relative odor activity value (ROAV); {a("../gcms-interpreter/?example=example4", "example 4")} selects the author group values automatically.') + [
    tbl2,
    fig("gcms-rank.webp", 840, 590, "s2.fig", "工具中的排序表（前 10 位）：阈值单位为 mg/kg，气味描述来自风味知识库或模型预测。", "The ranking table in the tool (top 10): thresholds in mg/kg; odor descriptions from the flavor knowledge base or the model.",
        "s2.alt", "GC-MS 风味解读示例 4 的 ROAV 排序表截图", "Screenshot of the ROAV ranking table of GC-MS example 4"),
    p("s2.i1", "<b>解读：</b>ROAV ≥ 1 的关键风味物质共 9 个（8 个醛、1 个酮），其中 (E,E)-2,4-壬二烯醛（ROAV 100）和 1-庚烯-3-酮（83.4）贡献最大。己醛在这 9 个物质中含量最高（13.1%），但阈值较高，ROAV 只排第 6。ROAV 使用水中觉察阈值，取自 van Gemert（2011）的汇编（作者课题组取值）。",
      "<b>Interpretation:</b> 9 key flavor compounds have ROAV ≥ 1 (eight aldehydes, one ketone), led by (E,E)-2,4-nonadienal (ROAV 100) and 1-hepten-3-one (83.4). Hexanal has the highest content of these 9 (13.1%) but a higher threshold, so its ROAV ranks only 6th. The ROAV uses odor detection thresholds in water from the compilation of van Gemert (2011) (author group values)."),
    lim("s2", "ROAV 只反映样品内各物质的相对贡献，不能说明是否能被闻到；阈值是水中的，不是母乳基质中的。",
        "ROAV shows only the relative contributions within one sample, not whether a compound can be smelled; the thresholds are for water, not for the milk matrix."),
])

# 3 odor prediction
# Flavornet (Acree & Arn, flavornet.org) descriptors: English as given there, Chinese = the model's descriptor words
# (fried and tallow have no model descriptor). The ranks in MATCH are over all 138 model descriptors (the same model's
# probabilities in ingredient-finder/data/probs.bin; the table shows the top 5 of preds.json).
FN = {"5910-87-2": ("脂肪、蜡香、青香", "fat, wax, green"), "2918-13-0": ("金属", "metal"), "18829-56-6": ("黄瓜、脂肪、青香", "cucumber, fat, green"),
      "25152-83-4": ("油炸、脂肪", "fried, fat"), "2548-87-0": ("青香、坚果、脂肪", "green, nut, fat"), "66-25-1": ("青草、牛脂、脂肪", "grass, tallow, fat"),
      "124-19-6": ("脂肪、柑橘、青香", "fat, citrus, green"), "3913-81-3": ("牛脂", "tallow"), "124-13-0": ("脂肪、皂样、柠檬、青香", "fat, soap, lemon, green")}
MATCH = {"5910-87-2": ("青香第 1 位，脂肪第 2 位；蜡香第 12 位", "green 1st, fatty 2nd; waxy 12th"),
         "2918-13-0": ("金属第 4 位", "metallic 4th"),
         "18829-56-6": ("脂肪第 1 位，青香第 2 位；黄瓜第 10 位", "fatty 1st, green 2nd; cucumber 10th"),
         "25152-83-4": ("脂肪第 1 位；模型没有“油炸”", "fatty 1st; the model has no “fried”"),
         "2548-87-0": ("青香第 1 位，脂肪第 2 位；坚果第 29 位", "green 1st, fatty 2nd; nutty 29th"),
         "66-25-1": ("脂肪第 3 位；青草第 9 位；模型没有“牛脂”", "fatty 3rd; grassy 9th; the model has no “tallow”"),
         "124-19-6": ("柑橘第 1 位，脂肪第 2 位；青香第 6 位", "citrus 1st, fatty 2nd; green 6th"),
         "3913-81-3": ("模型没有“牛脂”，无法对照", "the model has no “tallow”: no comparison"),
         "124-13-0": ("脂肪第 3 位，青香第 4 位；皂样第 11 位，柠檬第 23 位", "fatty 3rd, green 4th; soapy 11th, lemon 23rd")}
rows3 = []
for c, *_ in KEY9:
    o = preds["odor"][c]["chart"]
    top = list(zip(o["labels"], o["data"][0]))[:5]
    T(f"s3.top.{c}", "、".join(f"{l} {round(v)}" for l, v in top), ", ".join(f"{LABEL[l]} {round(v)}" for l, v in top))
    T(f"s3.fn.{c}", FN[c][0], FN[c][1]); T(f"s3.m.{c}", MATCH[c][0], MATCH[c][1])
    dcls = ' class="cs-diff"' if c == "3913-81-3" else ""
    rows3.append(f'<tr{dcls}><td class="nm">{a("../odor-predictor/?q=" + c, cn(c))}</td><td data-i18n="s3.top.{c}">{zh["s3.top." + c]}</td>'
                 f'<td data-i18n="s3.fn.{c}">{zh["s3.fn." + c]}</td><td data-i18n="s3.m.{c}">{zh["s3.m." + c]}</td></tr>')
tbl3 = ('<div class="table-wrap"><table class="cs-table"><thead><tr>' + th("s3.c1", "物质（点击打开预测）", "Compound (opens the prediction)")
        + th("s3.c2", "模型预测前 5 个描述词（%）", "Top 5 predicted descriptors (%)") + th("s3.c3", "Flavornet 描述", "Flavornet descriptors")
        + th("s3.c4", "对照", "Comparison") + "</tr></thead><tbody>" + "".join(rows3) + "</tbody></table></div>")
section("step3", "s3.h", "第 3 步　气味预测", "Step 3. Odor prediction", qa("s3",
    "模型预测的气味与文献中的气味描述一致吗？", "Does the predicted odor agree with the odor descriptions in the literature?",
    f'{a("../odor-predictor/", "气味预测")}（图神经网络，预测 138 个气味描述词的概率）。表中每个物质都链接到它的预测结果；文献描述取自 {FLAVORNET}（Acree &amp; Arn，flavornet.org），中文按模型的描述词翻译。',
    f'{a("../odor-predictor/", "Odor prediction")} (a graph neural network giving probabilities for 138 odor descriptors). Each compound in the table links to its prediction; the literature descriptors are those of {FLAVORNET} (Acree &amp; Arn, flavornet.org).') + [
    tbl3,
    p("s3.i1", "<b>解读：</b>9 个物质中，8 个至少有一个 Flavornet 描述词出现在模型预测的前 5 位，包括 1-庚烯-3-酮的金属味（第 4 位）。例外是 (E)-2-癸烯醛：Flavornet 只给出“牛脂”，而模型的 138 个描述词中没有这个词。没有进入前 5 位的描述词有：黄瓜（(E)-2-壬烯醛，第 10 位）、蜡香（(E,E)-2,4-壬二烯醛，第 12 位）、青草（己醛，第 9 位）、青香（壬醛，第 6 位）、皂样和柠檬（辛醛，第 11、23 位）以及坚果（(E)-2-辛烯醛，第 29 位）；“油炸”和“牛脂”不在模型的描述词中。名次按全部 138 个描述词计算。",
      "<b>Interpretation:</b> 8 of the 9 compounds have at least one Flavornet descriptor among the top 5 predictions, including the metallic note of 1-hepten-3-one (4th). The exception is (E)-2-decenal: Flavornet gives only “tallow”, which is not one of the model's 138 descriptors. Descriptors outside the top 5: cucumber ((E)-2-nonenal, 10th), waxy ((E,E)-2,4-nonadienal, 12th), grassy (hexanal, 9th), green (nonanal, 6th), soapy and lemon (octanal, 11th and 23rd) and nutty ((E)-2-octenal, 29th); “fried” and “tallow” are not model descriptors. Ranks are counted over all 138 descriptors."),
    lim("s3", "这 9 个都是常见物质，都在模型的数据集中（气味预测页会提示）：7 个在训练集，(E,Z)-2,4-癸二烯醛和辛醛在测试集，因此这里的吻合不能说明模型对新分子的预测能力。Flavornet 汇编的是文献中 GC-O 检出的气味物质及其描述，不是本研究的嗅闻结果。模型不区分顺反异构，(E,Z)- 和 (E,E)-2,4-癸二烯醛的预测相同。",
        "All 9 are common compounds and all are in the model's dataset (the odor prediction page says so): 7 in the training split, (E,Z)-2,4-decadienal and octanal in the test split, so the agreement here says nothing about predictions for new molecules. Flavornet compiles odorants detected by GC-O in the literature and their descriptors; these are not the sniffing results of this study. The model does not distinguish cis/trans isomers: (E,Z)- and (E,E)-2,4-decadienal get the same prediction."),
])

# 4 intensity curves vs FD
FD = [("66-25-1", "3238", "64"), ("124-13-0", "345", "64"), ("124-19-6", "27.0", "4"), ("111-71-7", "2.3", "1")]
rows4 = "".join(f'<tr><td class="nm">{a("../gcms-interpreter/curves.html?cas=" + c, cn(c))}</td><td class="num">{v}</td><td class="num">{fd}</td></tr>' for c, v, fd in FD)
tbl4 = ('<div class="table-wrap"><table class="cs-table cs-narrow"><thead><tr>' + th("s4.c1", "物质（点击打开曲线）", "Compound (opens the curve)")
        + th("s4.c2", f"{SAMPLE}：相对含量 ÷ 气相阈值", f"{SAMPLE}: relative content ÷ gas-phase threshold", True) + th("s4.c3", "FD（AEDA）", "FD (AEDA)", True) + "</tr></thead><tbody>" + rows4 + "</tbody></table></div>")
section("step4", "s4.h", "第 4 步　强度曲线与 FD 对照", "Step 4. Intensity curves and FD", qa("s4",
    "按气相阈值估算的结果与 AEDA 得到的 FD 排序一致吗？", "Does the estimate from gas-phase thresholds rank the compounds as the FD from AEDA does?",
    f'{a("../gcms-interpreter/curves.html", "气相强度曲线")}，使用 Wakayama 等（2019）的剂量-强度曲线和气相阈值。用 {SAMPLE} 的相对含量除以气相阈值，与 {C4ZH}中 50 份母乳混合样的 FD 对照。',
    f'{a("../gcms-interpreter/curves.html", "Gas-phase intensity curves")}, with the dose-response curves and gas-phase thresholds of Wakayama et al. (2019). The relative content in {SAMPLE} divided by the gas-phase threshold is set against the FD of the pooled sample of 50 human milks in {C4EN}.') + [
    tbl4,
    p("s4.i1", "<b>解读：</b>己醛、辛醛的比值高（FD 均为 64），壬醛、庚醛的比值低（FD 分别为 4 和 1），两者排序一致。",
      "<b>Interpretation:</b> hexanal and octanal have high ratios (both FD 64), nonanal and heptanal low ratios (FD 4 and 1): the two rankings agree."),
    lim("s4", "只有这 4 个醛有强度曲线；(E,E)-2,4-壬二烯醛、1-庚烯-3-酮、(E)-2-壬烯醛、(E)-2-辛烯醛等其余关键风味物质在 Wakayama 等（2019）的数据中没有曲线，无法核对。",
        "Only these 4 aldehydes have intensity curves; (E,E)-2,4-nonadienal, 1-hepten-3-one, (E)-2-nonenal, (E)-2-octenal and the other key flavor compounds have no curve in Wakayama et al. (2019) and cannot be checked."),
])

# 5 ingredient finder
section("step5", "s5.h", "第 5 步　原料检索", "Step 5. Ingredient search", qa("s5",
    "哪些分子的气味与 1-庚烯-3-酮（ROAV 第 2）相近？它在哪些食物中出现过？", "Which molecules smell like 1-hepten-3-one (2nd by ROAV)? In which foods has it been found?",
    f'{a("../ingredient-finder/?mode=b&amp;smiles=C%3DCC(%3DO)CCCC", "原料与替代物检索，模式 B")}（按预测气味的余弦相似度找相近分子），以及{a("../flavor-kb/?food=fdb796", "风味知识库")}中母乳的检出物质和关键风味物质。',
    f'{a("../ingredient-finder/?mode=b&amp;smiles=C%3DCC(%3DO)CCCC", "Ingredient and substitute search, mode B")} (similar molecules by cosine similarity of the predicted odor), and the compounds detected in human milk and its key flavor compounds in the {a("../flavor-kb/?food=fdb796", "flavor knowledge base")}.') + [
    p("s5.r1", f"与 1-庚烯-3-酮最相近的是 (Z)-1,5-辛二烯-3-酮（0.978）和 1-辛烯-3-酮（0.977），其中 1-辛烯-3-酮也是 {C4ZH}鉴定的关键风味物质（FD 64，金属味）。醛之间的预测气味高度相似（如壬醛与辛醛为 0.995），模型把它们归为同一类脂肪、柑橘样的醛香，彼此替代意义不大。",
      f"The closest molecules to 1-hepten-3-one are (Z)-1,5-octadien-3-one (0.978) and 1-octen-3-one (0.977); 1-octen-3-one is also a key flavor compound identified by {C4EN} (FD 64, metallic). The predicted odors of the aldehydes are very similar to each other (for example nonanal and octanal 0.995): the model puts them in one fatty, citrus-like aldehydic group, so substituting one for another means little."),
    p("s5.r2", "<b>知识库随研究扩充：</b>最初知识库只有 FlavorDB2 的数据，1-庚烯-3-酮没有任何食物来源，“Milk Human”只关联 3 个分子，母乳的关键风味物质一个也没有收录。并入 FooDB 后情况没有改变，因为 FooDB 的母乳条目都是脂肪酸、氨基酸、维生素等营养成分。因此作者把已发表的母乳数据加入知识库（见" + a("../flavor-kb/about.html#updates", "知识库 7.5 更新记录") + f"），现在母乳页收录了 {C4ZH}的检出物质和 10 个关键风味物质。",
      "<b>The knowledge base grew with the research:</b> at first the knowledge base held only FlavorDB2 data: 1-hepten-3-one had no food source at all, “Milk Human” was linked to only 3 molecules, and none of the key flavor compounds of human milk was included. Adding FooDB did not change this, because its human milk entries are nutrients such as fatty acids, amino acids and vitamins. So the author added the published human milk data to the knowledge base (see " + a("../flavor-kb/about.html#updates", "update log 7.5") + f"); the human milk page now holds the compounds detected by {C4EN} and 10 key flavor compounds."),
    p("s5.warn", "<b>婴儿配方奶粉不得加香：</b>GB 2760-2024 表 B.1“不得添加食品用香料、香精的食品名单”列有 13.01 婴幼儿配方食品。该表脚注 a 规定，较大婴儿和幼儿配方食品中可以使用香兰素、乙基香兰素和香荚兰豆浸膏（提取物），最大使用量分别为 5 mg/100 mL、5 mg/100 mL 和按照生产需要适量使用；“凡使用范围涵盖0~6个月婴幼儿配方食品不得添加任何食用香料”。因此在婴儿配方奶粉中，无法通过直接添加关键风味物质来改良风味，只能从前体入手（脂肪酸组成、油脂来源），见第 7~9 步。",
      "<b>No flavorings in infant formula:</b> GB 2760-2024 Table B.1, the list of foods to which flavorings may not be added, includes 13.01 infant and young child formulas. Its footnote a allows vanillin, ethyl vanillin and vanilla bean extract in follow-on and young child formulas, at most 5 mg/100 mL, 5 mg/100 mL and as needed for production, and states that no flavoring at all may be added to formulas whose scope covers infants aged 0 to 6 months. Infant formula therefore cannot be improved by adding key flavor compounds directly; improvement can only start from precursors (fatty acid composition, lipid sources); see steps 7 to 9.", "note warn"),
    lim("s5", "模式 B 只比较预测的气味，不能说明分子之间能否相互替代；FlavorDB2 只记录“有/无”，没有含量。",
        "Mode B compares predicted odor only and does not show whether the molecules can replace one another; FlavorDB2 records presence only, with no amounts."),
])

# 6 odor map
section("step6", "s6.h", "第 6 步　气味地图", "Step 6. Odor map", qa("s6",
    "母乳中检出的分子在气味地图上分布在哪里？", "Where do the molecules detected in human milk lie on the odor map?",
    a("../odor-map/?food=fdb796&amp;food2=fdb88", "气味地图，母乳与牛乳叠加") + "（5000 多个分子按预测气味排列）。",
    a("../odor-map/?food=fdb796&amp;food2=fdb88", "Odor map with human milk and cow milk overlaid") + " (over 5,000 molecules arranged by predicted odor).") + [
    fig("odor-map.webp", 852, 819, "s6.fig", "气味地图上的母乳（蓝色，大圆点为 10 个关键风味物质）和牛乳（红色）；灰色为其他分子。", "Human milk (blue; large dots: the 10 key flavor compounds) and cow milk (red) on the odor map; grey: other molecules.",
        "s6.alt", "气味地图截图：母乳和牛乳的分子位置", "Odor map screenshot: positions of human milk and cow milk molecules"),
    p("s6.r1", f"知识库中与母乳关联的分子共 100 个，其中 99 个在气味地图上（硫胺素不在地图的分子库中）：78 个来自 {C4ZH}，29 个来自 FooDB（10 个两者都有），2 个只来自 FlavorDB2。这 99 个分子主要落在脂肪区和青香区（预测首位描述词为脂肪的 22 个、青香的 20 个，合计 42%）；牛乳的 207 个分子分布更分散（无气味 29、果香 28、脂肪 22、青香 16、酚样 12、鱼腥 11、硫味 9，脂肪和青香合计仅 18%）。",
      f"The knowledge base links 100 molecules to human milk, 99 of which are on the odor map (thiamine is not in the map's molecule library): 78 come from {C4EN}, 29 from FooDB (10 from both) and 2 only from FlavorDB2. These 99 molecules lie mainly in the fatty and green regions (top predicted descriptor fatty for 22, green for 20, together 42%); the 207 molecules of cow milk are more spread out (odorless 29, fruity 28, fatty 22, green 16, phenolic 12, fishy 11, sulfurous 9; fatty and green together only 18%)."),
    p("s6.i1", "<b>解读：</b>这一分布与“母乳风味以脂质氧化产生的醛、酮为主”的认识一致。", "<b>Interpretation:</b> this distribution is consistent with the view that human milk aroma is dominated by aldehydes and ketones from lipid oxidation."),
    lim("s6", "两边的数据来源不对等，母乳数据来自作者已发表的研究，牛乳数据来自 FlavorDB2 和 FooDB，因此不能据此认为牛乳缺少这些物质（不少是被隐藏的批量条目，或公开数据库未收录）。",
        "The two data sources are not comparable: the human milk data come from the author's published research, the cow milk data from FlavorDB2 and FooDB, so this does not show that cow milk lacks these compounds (many are hidden bulk entries, or the public databases have not recorded them)."),
])

# 7 taste
tp = preds["taste"]
def pct(x):
    return "&lt;0.1" if x < 0.1 else (f"{x:.1f}" if x < 10 or x >= 99.5 else f"{x:.0f}")
FA = [("linoleic acid", "60-33-3", ("亚油酸", "linoleic acid"), ("苦", "bitter")), ("alpha-linolenic acid", "463-40-1", ("α-亚麻酸", "α-linolenic acid"), ("苦", "bitter")),
      ("eicosanoic acid", "506-30-9", ("二十碳酸", "eicosanoic acid"), ("不在训练数据中", "not in the training data"))]
rows7 = []
for k, cas, (nz, ne), (rz, re_) in FA:
    v = tp[k]["chart"]["data"][0]
    T(f"s7.fa.{cas}", nz, ne); T(f"s7.rec.{cas}", rz, re_)
    rows7.append(f'<tr><td class="nm">{a("../taste-predictor/?q=" + cas, "<span data-i18n='s7.fa." + cas + "'>" + nz + "</span>")}</td><td class="num">{pct(v[0])}</td><td class="num"><b>{pct(v[1])}</b></td><td class="num">{pct(v[2])}</td><td data-i18n="s7.rec.{cas}">{rz}</td></tr>')
hdr7 = (th("s7.c1", "分子（点击打开预测）", "Molecule (opens the prediction)") + th("s7.c2", "甜（%）", "Sweet (%)", True) + th("s7.c3", "苦（%）", "Bitter (%)", True)
        + th("s7.c4", "鲜（%）", "Umami (%)", True))
tbl7 = ('<div class="table-wrap"><table class="cs-table"><thead><tr>' + hdr7 + th("s7.c5", "数据集记录", "Dataset record") + "</tr></thead><tbody>" + "".join(rows7) + "</tbody></table></div>")
AA = [("Glu", "56-86-0", "谷氨酸", "Glu", 704), ("Ala", "56-41-7", "丙氨酸", "Ala", 161), ("Thr", "72-19-5", "苏氨酸", "Thr", 97), ("Asp", "56-84-8", "天冬氨酸", "Asp", 78),
      ("Pro", "147-85-3", "脯氨酸", "Pro", 54), ("Val", "72-18-4", "缬氨酸", "Val", 53), ("Gly", "56-40-6", "甘氨酸", "Gly", 51), ("Lys", "56-87-1", "赖氨酸", "Lys", 49),
      ("Ser", "56-45-1", "丝氨酸", "Ser", 29), ("Leu", "61-90-5", "亮氨酸", "Leu", 28), ("His", "71-00-1", "组氨酸", "His", 27), ("Arg", "74-79-3", "精氨酸", "Arg", 24),
      ("Cystine", "56-89-3", "胱氨酸", "Cys", 22), ("Tyr", "60-18-4", "酪氨酸", "Tyr", 19), ("Phe", "63-91-2", "苯丙氨酸", "Phe", 14), ("Ile", "73-32-5", "异亮氨酸", "Ile", 11),
      ("Met", "63-68-3", "甲硫氨酸", "Met", 10)]
TASTE = {"甜": "sweet", "苦": "bitter", "鲜": "umami", "酸": "sour", "咸": "salty", "无味": "tasteless"}
rows7b = []
for k, cas, nz, ab, conc in AA:
    o = tp[k]; v = o["chart"]["data"][0]
    over = [t for t, x, thr in zip(["甜", "苦", "鲜"], v[:3], [57.6, 42.2, 17.6]) if x >= thr]
    rec = re.search(r"数据集记录：(.*?)（", o["body"]).group(1)
    T(f"s7.aa.{cas}", f"{nz}（{ab}）", f"{ab}"); T(f"s7.over.{cas}", "、".join(over), ", ".join(TASTE[t] for t in over))
    T(f"s7.arec.{cas}", rec, ", ".join(TASTE[t] for t in rec.split("、")))
    rows7b.append(f'<tr><td class="nm">{a("../taste-predictor/?q=" + cas, "<span data-i18n='s7.aa." + cas + "'>" + nz + "（" + ab + "）</span>")}</td><td class="num">{conc}</td>'
                  f'<td class="num">{pct(v[0])}</td><td class="num">{pct(v[1])}</td><td class="num">{pct(v[2])}</td>'
                  f'<td data-i18n="s7.over.{cas}">{"、".join(over)}</td><td data-i18n="s7.arec.{cas}">{rec}</td></tr>')
tbl7b = ('<div class="table-wrap"><table class="cs-table"><thead><tr>' + th("s7.d1", "氨基酸", "Amino acid") + th("s7.d2", "母乳（μmol/L）", "Human milk (μmol/L)", True)
         + th("s7.d3", "甜（%）", "Sweet (%)", True) + th("s7.d4", "苦（%）", "Bitter (%)", True) + th("s7.d5", "鲜（%）", "Umami (%)", True)
         + th("s7.d6", "超过判断阈值", "Above the judgement threshold") + th("s7.d7", "数据集记录", "Dataset record") + "</tr></thead><tbody>" + "".join(rows7b) + "</tbody></table></div>")
LIT7 = {
    "stephan": ("Stephan A, Steinhart H. Bitter taste of unsaturated free fatty acids in emulsions: contribution to the off-flavour of soybean lecithin. <i>Eur Food Res Technol</i> 2000, 212: 17-25", "10.1007/s002170000216"),
    "glaser": ("Gläser P, Mittermeier-Kleßinger VK, Spaccasassi A, et al. Quantification and bitter taste contribution of lipids and their oxidation products in pea-protein isolates (<i>Pisum sativum</i> L.). <i>J Agric Food Chem</i> 2021, 69: 8768-8776", "10.1021/acs.jafc.1c02889"),
    "huseynli": ("Huseynli L, Gigl M, Müller J, et al. Characterization of bitter off-taste stimuli in sunflower press cake using the sensomics approach. <i>J Agric Food Chem</i> 2025, 73: 23548-23559", "10.1021/acs.jafc.5c07283"),
    "cheon": ("Cheon E, Mattes RD. Perceptual quality of nonesterified fatty acids varies with fatty acid chain length. <i>Chem Senses</i> 2021, 46: bjab023", "10.1093/chemse/bjab023"),
    "mattes": ("Mattes RD. Is there a fatty acid taste? <i>Annu Rev Nutr</i> 2009, 29: 305-327", "10.1146/annurev-nutr-080508-141108"),
    "agostoni": ("Agostoni C, Carratù B, Boniglia C, et al. Free amino acid content in standard infant formulas: comparison with human milk. <i>J Am Coll Nutr</i> 2000, 19: 434-438", "10.1080/07315724.2000.10718943"),
    "chuang": ("Chuang CK, Lin SP, Lee HC, et al. Free amino acids in full-term and pre-term human milk and infant formula. <i>J Pediatr Gastroenterol Nutr</i> 2005, 40: 496-500", "10.1097/01.mpg.0000150407.30058.47"),
}
section("step7", "s7.h", "第 7 步　滋味", "Step 7. Taste", qa("s7",
    f"如果从前体入手，亚油酸和 α-亚麻酸本身是什么滋味？选这两种，是因为在 {C4ZH}的随机森林重要性排序中，二者是母乳风味最主要的前体（归一化得分 1.00 和 0.83，明显高于其他前体）。",
    f"If improvement starts from precursors, what do linoleic acid and α-linolenic acid taste like themselves? These two were chosen because the random forest importance ranking of {C4EN} puts them first among the precursors of human milk flavor (normalized scores 1.00 and 0.83, clearly above all other precursors).",
    a("../taste-predictor/", "味觉预测") + "（图神经网络，判断甜、苦、鲜、无味；判断阈值甜 58%、苦 42%、鲜 18%，由验证集选出）。",
    a("../taste-predictor/", "Taste prediction") + " (a graph neural network for sweet, bitter, umami and tasteless; judgement thresholds sweet 58%, bitter 42%, umami 18%, chosen on the validation split).") + [
    tbl7,
    p("s7.i1", "<b>解读：</b>亚油酸和 α-亚麻酸都被预测为苦，且超过判断阈值。但两者都在训练数据中（标签为苦），因此这只说明模型复现了数据集的记录，而这一记录与文献一致：Stephan 等（2000）发现游离亚油酸、亚麻酸在乳液中的苦味阈值最低，是大豆卵磷脂苦味的主要来源；Gläser 等（2021）发现豌豆蛋白中的游离 α-亚麻酸和亚油酸是苦味的关键来源；Huseynli 等（2025）在葵花籽压榨饼中鉴定的苦味物质包括 α-亚麻酸、亚油酸、油酸、棕榈酸和硬脂酸；Cheon 等（2021）报道 C18 游离脂肪酸主要被描述为苦。二十碳酸不在训练数据中，同样被预测为苦（56%），与 Cheon 等（2021）的结论方向一致，但单个例子不能证明模型的能力。",
      "<b>Interpretation:</b> both linoleic and α-linolenic acid are predicted bitter, above the judgement threshold. But both are in the training data (labelled bitter), so this only shows that the model reproduces the dataset record, and that record agrees with the literature: Stephan et al. (2000) found free linoleic and linolenic acid to have the lowest bitter thresholds in emulsions and to be the main source of the bitterness of soybean lecithin; Gläser et al. (2021) found free α-linolenic and linoleic acid to be key bitter compounds in pea protein; the bitter compounds identified by Huseynli et al. (2025) in sunflower press cake include α-linolenic, linoleic, oleic, palmitic and stearic acid; Cheon et al. (2021) report that C18 free fatty acids are mainly described as bitter. Eicosanoic acid, not in the training data, is also predicted bitter (56%), in the same direction as the conclusion of Cheon et al. (2021), but a single example cannot prove the model's ability."),
    p("s7.i2", "需要注意，婴儿配方奶粉中的脂肪酸以甘油三酯（油脂）形式加入。Mattes（2009）指出，甘油三酯本身不是有效的滋味刺激，起作用的是游离脂肪酸；模型对甘油三酯的预测属于外推，这里不采用。",
      "Note that in infant formula the fatty acids are added as triglycerides (oils). Mattes (2009) points out that triglycerides themselves are not effective taste stimuli; free fatty acids are. The model's prediction for triglycerides is an extrapolation and is not used here."),
    h3("s7.h3", "补充：母乳的游离氨基酸", "Supplement: free amino acids of human milk"),
    p("s7.aa1", f"母乳中的蛋白质主要以完整蛋白形式存在，其次是多肽；游离氨基酸占比虽小，却可能是滋味的主要贡献者之一。Agostoni 等（2000）和 Chuang 等（2005）都报道母乳的游离氨基酸含量远高于配方奶粉。下表列出 {C4ZH}Table 2 中 50 份母乳的 17 种游离氨基酸，其中谷氨酸含量最高（704 μmol/L，占 17 种总量的 49.2%）。",
      "Human milk protein is mainly intact protein, then peptides; free amino acids are a small share but may be among the main contributors to taste. Agostoni et al. (2000) and Chuang et al. (2005) both report far higher free amino acid contents in human milk than in formula. The table lists the 17 free amino acids of the 50 human milk samples in Table 2 of Cui et al. (2026); glutamic acid is the most abundant (704 μmol/L, 49.2% of the 17 together)."),
    tbl7b,
    p("s7.aa2", "<b>解读：</b>预测结果与一般认识大体一致：谷氨酸、天冬氨酸呈鲜味；丝氨酸、甘氨酸、苏氨酸、丙氨酸呈甜味；亮氨酸、异亮氨酸、苯丙氨酸呈苦味。由于这些氨基酸都在训练数据中，这只能说明工具在适用范围内工作正常。苏氨酸（鲜 34%）和胱氨酸（鲜 31%）超过了鲜味判断阈值，但数据集记录中并不鲜，这是模型本身的偏差。",
      "<b>Interpretation:</b> the predictions broadly agree with common knowledge: glutamic and aspartic acid umami; serine, glycine, threonine and alanine sweet; leucine, isoleucine and phenylalanine bitter. All these amino acids are in the training data, so this only shows that the tool works within its domain. Threonine (umami 34%) and cystine (umami 31%) exceed the umami threshold although the dataset does not record them as umami: a bias of the model itself."),
    lim("s7", "模型不考虑浓度，也不考虑基质和协同作用；表中多数分子都在训练数据中。不能用于安全性评估。",
        "The model ignores concentration, matrix and synergy, and most molecules in the tables are in its training data. It cannot be used for safety assessment."),
])

# 8 regulation
rows8 = [("s8.la", "亚油酸", "Linoleic acid", "0.07~0.33 g/100 kJ（0.3~1.4 g/100 kcal）", "0.07 to 0.33 g/100 kJ (0.3 to 1.4 g/100 kcal)", "120~300 mg/100 kJ", "120 to 300 mg/100 kJ"),
         ("s8.ala", "α-亚麻酸", "α-Linolenic acid", "≥ 12 mg/100 kJ（≥ 50 mg/100 kcal），上限未规定", "≥ 12 mg/100 kJ (≥ 50 mg/100 kcal), no upper limit", "12~24 mg/100 kJ", "12 to 24 mg/100 kJ"),
         ("s8.dha", "DHA", "DHA", "可选（表 4）：3.6~9.6 mg/100 kJ；添加 DHA 时 ARA 至少等量，ARA ≤ 19.1 mg/100 kJ", "optional (Table 4): 3.6 to 9.6 mg/100 kJ; if DHA is added, at least as much ARA, ARA ≤ 19.1 mg/100 kJ", "必需：4.8~12 mg/100 kJ", "mandatory: 4.8 to 12 mg/100 kJ")]
r8 = []
for k, nz, ne, gz, ge, ez, ee in rows8:
    T(k + ".n", nz, ne); T(k + ".gb", gz, ge); T(k + ".eu", ez, ee)
    r8.append(f'<tr><td class="nm" data-i18n="{k}.n">{nz}</td><td data-i18n="{k}.gb">{gz}</td><td data-i18n="{k}.eu">{ez}</td></tr>')
tbl8 = ('<div class="table-wrap"><table class="cs-table"><thead><tr>' + th("s8.c1", "成分", "Component") + th("s8.c2", "GB 10765-2021 表 1", "GB 10765-2021, Table 1")
        + th("s8.c3", "欧盟 (EU) 2016/127 附件 I", "EU Regulation (EU) 2016/127, Annex I") + "</tr></thead><tbody>" + "".join(r8) + "</tbody></table></div>")
section("step8", "s8.h", "第 8 步　法规", "Step 8. Regulation", qa("s8",
    "1-庚烯-3-酮能作为香料使用吗？前体物质有哪些法规要求？", "Can 1-hepten-3-one be used as a flavoring? What do the rules say about the precursors?",
    f'法规查询（{a("../flavor-kb/regulatory.html?q=2918-13-0", "1-庚烯-3-酮")}，以 {a("../flavor-kb/regulatory.html?q=4312-99-6", "1-辛烯-3-酮")} 作对照）。',
    f'Regulatory lookup ({a("../flavor-kb/regulatory.html?q=2918-13-0", "1-hepten-3-one")}, with {a("../flavor-kb/regulatory.html?q=4312-99-6", "1-octen-3-one")} as a control).') + [
    p("s8.r1", "按名称的各种写法和 CAS 号（2918-13-0）检索中国 GB 2760-2024 表 B.2 和 B.3、欧盟 Union list（2026-02-16 合并版）、美国 21 CFR 172/182/184/189 和 FDA 清单（Substances Added to Food）的原文，均未查到 1-庚烯-3-酮（截至网站数据日期）；GB 2760 中只有它的异构体 4-庚烯-3-酮（S1262）。也就是说，即使不考虑表 B.1，它也没有列入这三地的香料名单。作为对照，用同样方法可以在中国（S0219）、欧盟和 FDA 清单（FEMA 2677）中查到 1-辛烯-3-酮，说明检索方法有效。",
      "Searching the texts of GB 2760-2024 Tables B.2 and B.3 (China), the EU Union list (consolidated version of 2026-02-16) and US 21 CFR Parts 172, 182, 184 and 189 with the FDA list “Substances Added to Food” under every spelling of the name and the CAS number (2918-13-0) finds no 1-hepten-3-one (as of the site's data date); GB 2760 has only its isomer 4-hepten-3-one (S1262). So even leaving Table B.1 aside, it is not on the flavoring lists of any of the three. As a control, the same search finds 1-octen-3-one in China (S0219), the EU and the FDA list (FEMA 2677), so the search works."),
    p("s8.r2", "婴儿配方奶粉不得加香（GB 2760-2024 表 B.1，见第 5 步）；前体物质则由营养成分标准规定：", "Infant formula may not be flavored (GB 2760-2024 Table B.1, see step 5); the precursors are governed by the nutrient standards:"),
    tbl8,
    p("s8.r3", "GB 10765-2021 还要求亚油酸与 α-亚麻酸之比为 5:1~15:1。", "GB 10765-2021 also requires a linoleic to α-linolenic acid ratio of 5:1 to 15:1."),
    lim("s8", "网站的法规查询只覆盖香料名单，不含营养成分标准；法规以官方最新原文为准。", "The site's regulatory lookup covers only the flavoring lists, not nutrient standards; the latest official texts prevail."),
])

# 9 flavor improvement (author group data)
rows9 = []
for i, (c, v) in enumerate(hm_rows):
    f = AUTHOR_ROAV.get(c)
    swap = c in ("2548-87-0", "124-13-0", "3913-81-3", "25152-83-4")
    dcls = ' class="cs-diff"' if swap or f is None or f < 1 else ""
    rows9.append(f'<tr{dcls}><td class="num">{i + 1}</td><td class="nm">{cn(c)}</td><td class="num">{f3(v)}</td>'
                 f'<td class="num">{"-" if f is None else f"{f:.2f}"}</td><td class="num">{fc_rank.get(c, "-")}</td></tr>')
tbl9 = ('<div class="table-wrap"><table class="cs-table cs-rank"><thead><tr>' + th("s9.c0", "工具排序", "Tool rank", True) + th("s9.c1", "物质", "Compound")
        + th("s9.c2", "工具计算值", "Tool values", True) + th("s9.c3", FC_COL[0], FC_COL[1], True)
        + th("s9.c4", FC_RANK[0], FC_RANK[1], True) + "</tr></thead><tbody>" + "".join(rows9) + "</tbody></table></div>")
def gaps(rows, n):
    hi_t, hi_s = [], []
    for r in rows:
        name = re.sub(r"\s*强度曲线.*", "", r[0]); cas = NAME2CAS[name]; d = r[3].replace(" 个百分点", "")
        nd_s = "未检出" in r[1]; nd_t = "未检出" in r[2]
        if r[4] == "目标": hi_t.append((cas, d, nd_s))
        elif r[4] == "当前样品": hi_s.append((cas, d, nd_t))
    return hi_t, hi_s
def gap_text(lst, nd_zh, nd_en):
    z = "、".join(f"{N[c][0]} {d}" + (f"（{nd_zh}）" if nd else "") for c, d, nd in lst)
    e = ", ".join(f"{N[c][1]} {d}" + (f" ({nd_en})" if nd else "") for c, d, nd in lst)
    return z, e
ct, cs = gaps(cmf_gap, cmf_n); pt, ps = gaps(pof_gap, pof_n)
ctz, cte = gap_text(ct, "CMF 未检出", "not detected in CMF"); csz, cse = gap_text(cs, "母乳未检出", "not detected in human milk")
ptz, pte = gap_text(pt, "POF 未检出", "not detected in POF"); psz, pse = gap_text(ps, "母乳未检出", "not detected in human milk")
for f in ["hm_target_n303.csv", "cmf_sample_n10.csv", "pof_sample_n10.csv"]:
    assert (OUT / "data" / f).exists(), f
dl = (f'<a href="data/hm_target_n303.csv" download>母乳 HM（n=303，目标）</a>、<a href="data/cmf_sample_n10.csv" download>牛乳基配方奶粉 CMF（n=10）</a>、<a href="data/pof_sample_n10.csv" download>植物油基配方奶粉 POF（n=10）</a>',
      f'<a href="data/hm_target_n303.csv" download>human milk HM (n=303, target)</a>, <a href="data/cmf_sample_n10.csv" download>cow-milk-based formula CMF (n=10)</a>, <a href="data/pof_sample_n10.csv" download>plant-oil-based formula POF (n=10)</a>')
# one-click entries of the flavor improver (flavor-improver/userdata.js CASE_EXAMPLES): HM target and one formula CSV each
FI_CMF, FI_POF = "../flavor-improver/?example=case-cmf", "../flavor-improver/?example=case-pof"
section("step9", "s9.h", "第 9 步　风味改良", "Step 9. Flavor improvement", qa("s9",
    "婴儿配方奶粉与母乳的风味差异在哪里？应朝哪个方向改良？", "Where does the flavor of infant formula differ from human milk, and in which direction should it be improved?",
    f'乳品风味改良的“我的 GC-MS 数据”，点击直接载入{a(FI_CMF, "母乳对比 CMF")} 或{a(FI_POF, "母乳对比 POF")}。输入是{FC_WHO[0]}各类样品的平均相对含量，按工具的 CSV 格式整理（{dl[0]}，均可下载）；母乳为目标，两类配方奶粉分别作为当前样品；阈值为“作者课题组取值”（写在 CSV 中），与课题组 27 个关键风味物质的阈值完全一致。这些数据与 {C4ZH}的数据使用同一台仪器（Agilent 8890B）和同一种萃取头（DVB/CAR/PDMS）测得。',
    f'The “my GC-MS data” mode of the dairy flavor improver; one click loads {a(FI_CMF, "human milk vs CMF")} or {a(FI_POF, "human milk vs POF")}. The input is the mean relative content of each sample group from {FC_WHO[1]}, arranged in the tool\'s CSV format (download: {dl[1]}); human milk is the target and each formula type in turn the current sample; thresholds are the author group values (given in the CSVs), identical to the group\'s thresholds for its 27 key flavor compounds. These data were measured with the same instrument (Agilent 8890B) and the same fibre (DVB/CAR/PDMS) as the data of {C4EN}.') + [
    h3("s9.h3a", "母乳的 ROAV：工具与课题组计算值对照", "Human milk ROAV: tool and author group values side by side"),
    tbl9,
    p("s9.r1", "课题组逐个样品计算 ROAV 再求平均，工具用平均含量计算，所以数值不同（工具中最大值固定为 100），只比较排序。主要物质排序一致：前 6 位（(E,E)-2,4-壬二烯醛、1-辛烯-3-酮、1-庚烯-3-酮、己醛、(E)-2-壬烯醛、壬醛）和第 11~13 位完全相同。例外有两对相邻物质互换：(E)-2-辛烯醛与辛醛（第 7、8 位），(E)-2-癸烯醛与 (E,Z)-2,4-癸二烯醛（第 9、10 位）。工具算出 ROAV ≥ 1 的物质比课题组多 3 个：(E,E)-2,4-癸二烯醛和 2,3-辛二酮（课题组计算值都小于 1），以及 1-辛烯-3-醇（课题组的母乳结果中未列）。",
      "The author group computes ROAV for each sample and then averages; the tool computes it from the mean contents, so the values differ (the tool fixes the largest at 100) and only the ranks are compared. The main compounds rank the same: the top 6 ((E,E)-2,4-nonadienal, 1-octen-3-one, 1-hepten-3-one, hexanal, (E)-2-nonenal, nonanal) and ranks 11 to 13 are identical. The exceptions are two swapped neighbouring pairs: (E)-2-octenal and octanal (ranks 7 and 8), and (E)-2-decenal and (E,Z)-2,4-decadienal (ranks 9 and 10). The tool finds 3 more compounds with ROAV ≥ 1 than the author group: (E,E)-2,4-decadienal and 2,3-octanedione (both below 1 in the group's values) and 1-octen-3-ol (not listed in the group's human milk results)."),
    h3("s9.h3b", "配方奶粉与母乳的差距", "Gaps between formula and human milk"),
    fig("improver-cmf.webp", 840, 341, "s9.fig", "牛乳基配方奶粉（实线）与母乳（虚线）的气味轮廓，母乳 / 奶粉 12 维视图。", "Odor profiles of cow-milk-based formula (solid) and human milk (dashed), human milk / formula 12-dimension view.",
        "s9.alt", "乳品风味改良中 CMF 与母乳的雷达图截图", "Radar chart screenshot of CMF against human milk in the dairy flavor improver"),
    p("s9.r2", f"<b>牛乳基配方奶粉（CMF）：</b>共 {cmf_n} 个物质参与比较（数值为贡献占比之差，单位为百分点）。母乳中更高的：{ctz}；CMF 中更高的：{csz}。",
      f"<b>Cow-milk-based formula (CMF):</b> {cmf_n} compounds compared (values are differences in contribution share, in percentage points). Higher in human milk: {cte}; higher in CMF: {cse}."),
    p("s9.r3", f"<b>植物油基配方奶粉（POF）：</b>共 {pof_n} 个物质参与比较（数值为贡献占比之差，单位为百分点）。母乳中更高的：{ptz}；POF 中更高的：{psz}。",
      f"<b>Plant-oil-based formula (POF):</b> {pof_n} compounds compared (values are differences in contribution share, in percentage points). Higher in human milk: {pte}; higher in POF: {pse}."),
    p("s9.i1", "<b>解读：</b>两类配方奶粉与母乳的差异方向相近：母乳中 (E)-2-壬烯醛、1-庚烯-3-酮、1-辛烯-3-酮和 (E,E)-2,4-壬二烯醛的贡献更大。这与课题组的结论一致：母乳以不饱和醛酮为主，其中 1-庚烯-3-酮和 1-辛烯-3-酮常被描述为金属味（1-辛烯-3-酮：蘑菇、金属）。配方奶粉中二甲基二硫和二甲基三硫更高，课题组认为它们带来洋葱、大蒜样气味，通常由甲硫氨酸的 Strecker 降解产生。对母乳中更高的物质，工具只给方向、不给添加量，并提示婴幼儿配方食品不得加香，只能从原料、工艺和前体调整；配方奶粉中更高的物质需要从原料或工艺方向降低（如控制氧化、热处理和储存条件）。",
      "<b>Interpretation:</b> both formula types differ from human milk in a similar direction: (E)-2-nonenal, 1-hepten-3-one, 1-octen-3-one and (E,E)-2,4-nonadienal contribute more in human milk. This agrees with the author group's conclusion: human milk is dominated by unsaturated aldehydes and ketones, and 1-hepten-3-one and 1-octen-3-one are often described as metallic (1-octen-3-one: mushroom, metal). Dimethyl disulfide and dimethyl trisulfide are higher in formula; the group links them to onion- and garlic-like notes, typically formed by Strecker degradation of methionine. For compounds higher in human milk the tool gives directions only, no amounts, and notes that infant formula may not be flavored, so only raw materials, processing and precursors can change; compounds higher in formula have to be lowered through raw materials or processing (for example oxidation control, heat treatment and storage)."),
    p("s9.i2", "<b>脂质来源（课题组数据）：</b>10 个 CMF 都含生牛乳；OPO 结构脂（1,3-二油酸-2-棕榈酸甘油三酯）见于 6 个 CMF 和 5 个 POF；POF 的脂质来源中没有生牛乳或稀奶油，主要是 OPO 和植物油（大豆油、葵花籽油、椰子油、菜籽油、棕榈油等），其中 2 个另加 DHA。课题组指出，CMF 和 POF 因组成不同而香气不同。",
      "<b>Lipid sources (author group data):</b> all 10 CMF contain raw cow's milk; OPO structured lipid (1,3-dioleoyl-2-palmitoyl glycerol) appears in 6 CMF and 5 POF; the lipid sources of POF include no raw cow's milk or cream and are mainly OPO and vegetable oils (soybean, sunflower, coconut, rapeseed, palm and others), 2 of them with added DHA. The author group notes that CMF and POF differ in aroma because their composition differs."),
    lim("s9", "输入是每类样品的平均值，丢失了样品间的差异，配方奶粉每类只有 10 个样品；ROAV 是半定量结果，两边的数值不能直接相比，只比较贡献占比；这一步只给方向，不给添加量。",
        "The input is the mean of each group, which loses the variation between samples, and each formula group has only 10 samples; ROAV is semi-quantitative, so the two sides are compared by contribution shares, not by value; this step gives directions only, no amounts."),
])

# 10 summary
lims = [("s10.l1", "GC-MS 数据处理", "GC-MS processing", "半定量；依赖谱库鉴定；标准文件的保留时间有偏移", "semi-quantitative; relies on library identification; reference retention times offset"),
        ("s10.l2", "关键风味物质", "Key flavor compounds", "ROAV 是样品内相对值，阈值是水中的", "ROAV is relative within a sample; thresholds are for water"),
        ("s10.l3", "气味预测", "Odor prediction", "物质都在数据集中；不区分顺反异构", "compounds are in the dataset; no cis/trans distinction"),
        ("s10.l4", "强度曲线", "Intensity curves", "只有 4 个醛类有曲线", "curves for only 4 aldehydes"),
        ("s10.l5", "原料检索", "Ingredient search", "只比较预测气味；婴儿配方奶粉不得加香", "predicted odor only; infant formula may not be flavored"),
        ("s10.l6", "气味地图", "Odor map", "母乳与牛乳的数据来源不对等", "human milk and cow milk data are not comparable"),
        ("s10.l7", "滋味", "Taste", "不考虑浓度和基质；多数分子在训练数据中", "ignores concentration and matrix; most molecules in the training data"),
        ("s10.l8", "法规", "Regulation", "法规查询只含香料名单", "the lookup covers flavoring lists only"),
        ("s10.l9", "风味改良", "Flavor improvement", "输入为平均值；只给方向，不给添加量", "inputs are means; directions only, no amounts")]
r10 = []
for i, (k, sz, se, lz, le) in enumerate(lims):
    T(k + ".s", sz, se); T(k + ".l", lz, le)
    r10.append(f'<tr><td class="num">{i + 1}</td><td class="nm"><a href="#step{i + 1}" data-i18n="{k}.s">{sz}</a></td><td data-i18n="{k}.l">{lz}</td></tr>')
tbl10 = ('<div class="table-wrap"><table class="cs-table"><thead><tr>' + th("s10.c0", "步骤", "Step", True) + th("s10.c1", "工具", "Tool") + th("s10.c2", "主要局限", "Main limitation")
         + "</tr></thead><tbody>" + "".join(r10) + "</tbody></table></div>")
src = [
    ("s10.d1", f"样品与关键风味物质：{P4ZH}，补充材料 Table S1、Table 1、Table 2；样品 {SAMPLE} 为 {C4ZH}中编号 {SAMPLE_NO}。", f"Sample and key flavor compounds: {P4EN}, Supplementary Table S1, Table 1 and Table 2; sample {SAMPLE} is number {SAMPLE_NO} in {C4EN}."),
    ("s10.d2", f"婴儿配方奶粉与 303 份母乳：{FC_DATA[0]}。", f"Infant formula and 303 human milk samples: {FC_DATA[1]}."),
    ("s10.d3", "阈值：van Gemert（2011）<i>Odour Thresholds</i>，作者课题组取值。", "Thresholds: L.J. van Gemert (2011) <i>Odour Thresholds</i>, author group values."),
    ("s10.d7", f"气味描述：{FLAVORNET}（Acree &amp; Arn，flavornet.org）。", f"Odor descriptors: {FLAVORNET} (Acree &amp; Arn, flavornet.org)."),
    ("s10.d4", "气相强度曲线：Wakayama H, et al. <i>Ind Eng Chem Res</i> 2019, " + doi("10.1021/acs.iecr.9b01225") + "。", "Gas-phase intensity curves: Wakayama H, et al. <i>Ind Eng Chem Res</i> 2019, " + doi("10.1021/acs.iecr.9b01225") + "."),
    ("s10.d5", "食物来源：FlavorDB2（CC BY-NC-SA 3.0）、FooDB（2020-04-07 版，CC BY-NC 4.0）和作者已发表数据。", "Food sources: FlavorDB2 (CC BY-NC-SA 3.0), FooDB (2020-04-07 export, CC BY-NC 4.0) and the author's published data."),
    ("s10.d6", "法规：GB 2760-2024、GB 10765-2021、Regulation (EC) No 1334/2008 附件 I、Regulation (EU) 2016/127、21 CFR 与 FDA “Substances Added to Food”。", "Regulation: GB 2760-2024, GB 10765-2021, Regulation (EC) No 1334/2008 Annex I, Regulation (EU) 2016/127, 21 CFR and the FDA list “Substances Added to Food”."),
] + [(f"s10.lit.{k}", f"{t}, {doi(d)}.", f"{t}, {doi(d)}.") for k, (t, d) in LIT7.items()]
section("summary", "s10.h", "小结", "Summary", [
    p("s10.p1", "这个案例从一份原始仪器报告出发，依次用 7 个工具完成：数据处理（结果与作者程序一致）→ 筛选关键风味物质（ROAV）→ 用文献气味描述和 FD 核对 → 发现法规不允许加香，转向前体 → 检查前体的滋味和营养标准 → 用 303 份母乳和 20 个配方奶粉样品的平均数据找出差距和改良方向。每个工具单独只回答一个小问题，连起来才能从一张峰表走到改良方向。",
      "This case starts from one raw instrument report and uses 7 tools in turn: data processing (results match the author's program) → selecting the key flavor compounds (ROAV) → checking against literature odor descriptions and FD → finding that flavorings are not allowed, which turns the work to precursors → checking the taste and the nutrient rules of the precursors → finding the gaps and the direction of improvement from the means of 303 human milk samples and 20 infant formula samples. Each tool on its own answers one small question; only together do they lead from a peak table to a direction of improvement."),
    tbl10,
    h3("s10.h3", "数据来源", "Data sources"),
    '<ul class="cs-src">' + "".join(f'<li data-i18n-html="{k}">{nobr_end(z, "zh")}</li>' for k, z, e in src) + "</ul>",
])
for k, z, e in src: T(k, nobr_end(z, "zh"), nobr_end(e, "en"))

# ---------------------------------------------------------------- hero, toc, assemble
T("page.title", "母乳 → 婴儿配方奶粉 | 崔京伟", "Human milk → infant formula | Jingwei Cui")
T("case.h1", "母乳 → 婴儿配方奶粉", "Human milk → infant formula")
T("case.full", "用本站工具完成一次完整的风味分析", "A complete flavor analysis with this site's tools")
T("case.sub", "以一份母乳样品的 GC-MS 原始报告为起点，依次使用本站 7 个在线工具，最终找出婴儿配方奶粉与母乳的风味差距。", "Starting from the original GC-MS report of one human milk sample, the site's 7 online tools are used in turn to find the flavor gaps between infant formula and human milk.")
toc_items = [("background", "s0.h"), ("step1", "s1.h"), ("step2", "s2.h"), ("step3", "s3.h"), ("step4", "s4.h"), ("step5", "s5.h"),
             ("step6", "s6.h"), ("step7", "s7.h"), ("step8", "s8.h"), ("step9", "s9.h"), ("summary", "s10.h")]
toc = "\n".join(f'      <a href="#{i}" data-i18n="{k}">{zh[k]}</a>' for i, k in toc_items)

desc = "A worked example: one human milk GC-MS report taken through the site's seven tools, from key flavor compounds to the flavor gaps between infant formula and human milk."
head = open(ROOT / "research/index.html", encoding="utf-8").read().split("<body>")[0]
head = (head.replace("研究概览 | 崔京伟", zh["page.title"]).replace("/research/", "/case/")
        .replace(re.search(r'<meta name="description" content="(.*?)">', head).group(1), desc)
        .replace('research.css?v=', 'case.css?v='))
head = re.sub(r'(<meta (?:property="og:description"|name="twitter:description") content=")(.*?)(">)', lambda m: m.group(1) + desc + m.group(3), head)
head = re.sub(r"\?v=\d{8}[a-z]", "?v=" + V, head)
nav = open(ROOT / "research/index.html", encoding="utf-8").read().split("<body>")[1].split("<main")[0].replace(' aria-current="page"', "")
nav = re.sub(r"\?v=\d{8}[a-z]", "?v=" + V, nav)
page = (head + "<body>" + nav
        + '<main class="container about case">\n    <div class="hero">\n'
        + f'      <h1 data-i18n="case.h1">{zh["case.h1"]}</h1>\n      <p class="hero-full" data-i18n="case.full">{zh["case.full"]}</p>\n'
        + f'      <p class="sub" data-i18n="case.sub">{zh["case.sub"]}</p>\n    </div>\n'
        + f'    <nav class="toc">\n{toc}\n    </nav>\n\n' + "\n\n".join(S) + "\n  </main>\n\n"
        + '  <footer class="site-footer">\n    <div class="container">\n      <p data-i18n-html="footer.site">© 2026 崔京伟 · <a href="https://github.com/REDAMANCY564/redamancy564.github.io" target="_blank" rel="noopener">代码</a>（GitHub）</p>\n    </div>\n  </footer>\n</body>\n</html>\n')
page = page.replace('<html lang="zh-CN">', '<html lang="zh-CN">', 1)
OUT.mkdir(exist_ok=True); (OUT / "i18n").mkdir(exist_ok=True)
(OUT / "index.html").write_text(page, encoding="utf-8", newline="\n")
for lang, d in (("zh", zh), ("en", en)):
    for k, v in d.items():
        assert "——" not in v and "—" not in v, (k, v)   # no dashes
    (OUT / "i18n" / f"{lang}.json").write_text(json.dumps(d, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
print("keys", len(zh), "page bytes", len(page))
