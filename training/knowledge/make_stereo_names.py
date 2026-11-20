"""Write stereo_names.json from the curated table below (case-fix-3, item 3; 2026-11-20).

Input: training/data/gcms/stereo_candidates.json (stereo_candidates.py), 240 skeletons with
several stereo CAS numbers. The table (curated by hand, user to review in
_inputs/STEREO-NAMES-REVIEW.md) gives a generic English and Chinese name for the skeletons
whose current name carries a configuration (cis/trans, E/Z, D/L, (+)/(-), rel, ...) or is not
a usable name (a CAS number, a database code, a mixture name, a charged form). Merged
diastereomers with different trivial names (e.g. mannitol / sorbitol) get a name listing them.
Skeletons not in the table keep their name: it already has no configuration.
Also writes _inputs/STEREO-NAMES-REVIEW.md (not committed).
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CAND = ROOT / "training" / "data" / "gcms" / "stereo_candidates.json"
OUT = Path(__file__).with_name("stereo_names.json")
REVIEW = ROOT / "_inputs" / "STEREO-NAMES-REVIEW.md"

NAMES = {   # first 14 InChIKey characters: (English, Chinese)
    "COLNVLDHVKWLRT": ("Phenylalanine", "苯丙氨酸"),
    "NOOLISFMXDJSKH": ("Menthol", "薄荷醇"),
    "BSAIUMLZVGUGKX": ("2-Nonenal", "2-壬烯醛"),
    "PFTAWBLQPZVEMU": ("Catechin", "儿茶素"),
    "ZHHYXNZJDGDGPJ": ("2,4-Nonadienal", "2,4-壬二烯醛"),
    "JZQKTMZYLHNFPL": ("2,4-Decadienal", "2,4-癸二烯醛"),
    "AWNIQMQADACLCJ": ("Ethyl 4-decenoate", "4-癸烯酸乙酯"),
    "XXHDAWYDNSXJQM": ("3-Hexenoic acid", "3-己烯酸"),
    "GBKGJMYPQZODMI": ("Furfurylideneacetone", "糠叉丙酮"),
    "FEWJPZIEWOKRBE": ("Tartaric acid", "酒石酸"),
    "XMGQYMWWDOXHJM": ("Limonene", "柠檬烯"),
    "WTJKGGKOPKCXLL": ("1-Palmitoyl-2-oleoyl-glycero-3-phosphocholine (POPC)", "1-棕榈酰-2-油酰甘油-3-磷酸胆碱（POPC）"),
    "VVGOCOMZRGWHPI": ("4-Heptenal", "4-庚烯醛"),
    "YTHRBOFHFYZBRJ": ("Carvyl acetate", "乙酸香芹酯"),
    "IMKHDCBNRDRUEB": ("Dihydroactinidiolide", "二氢猕猴桃内酯"),
    "NOPLRNXKHZRXHT": ("beta-Sinensal", "β-甜橙醛"),
    "CIWBSHSKHKDKBQ": ("Ascorbic acid", "抗坏血酸"),
    "BRHDDEIRQPDPMG": ("Linalool oxide (furanoid)", "芳樟醇氧化物（呋喃型）"),
    "GKGOLPMYJJXRGD": ("2-Methyl-4-propyl-1,3-oxathiane", "2-甲基-4-丙基-1,3-氧硫杂环己烷"),
    "QOKMHYUWJKXWOV": ("1-(Methylthio)-1-butene", "1-甲硫基-1-丁烯"),
    "MLUCVPSAIODCQM": ("2-Butenal", "2-丁烯醛（巴豆醛）"),
    "AYFVYJQAPQTCCC": ("Threonine", "苏氨酸"),
    "AGPKZVBTJJNPAG": ("Isoleucine", "异亮氨酸"),
    "PMMYEEVYMWASQN": ("4-Hydroxyproline", "4-羟基脯氨酸"),
    "AZOCECCLWFDTAP": ("Dihydrocarvone", "二氢香芹酮"),
    "GAIBLDCXCZKKJE": ("Germacrene D", "大根香叶烯 D"),
    "JSNRRGGBADWTMC": ("beta-Farnesene", "β-法尼烯"),
    "VWYBQOFZVSNDAW": ("1,5-Octadien-3-one", "1,5-辛二烯-3-酮"),
    "OPFTUNCRGUEPRZ": ("beta-Elemene", "β-榄香烯"),
    "XHXUANMFYXWVNG": ("Menthyl acetate", "乙酸薄荷酯"),
    "AMXPURQVAMENCC": ("Menthone-8-thioacetate", "薄荷酮-8-硫代乙酸酯"),
    "XBGUIVFBMBVUEG": ("gamma-Bisabolene", "γ-红没药烯"),
    "IZXYHAXVIZHGJV": ("p-Menth-2-en-1-ol", "对薄荷-2-烯-1-醇"),
    "VUVQBYIJRDUVHT": ("Mintlactone", "薄荷内酯"),
    "RKQDKXOBRXTSFS": ("1,5,9,9-Tetramethyl-12-oxabicyclo[9.1.0]dodeca-4,7-diene", "1,5,9,9-四甲基-12-氧杂双环[9.1.0]十二碳-4,7-二烯"),
    "USMNOWBWPHYOEA": ("Thujone", "侧柏酮"),
    "MQPHVIPKLRXGDJ": ("3-Pinanone (pinocamphone)", "3-蒎烷酮（松樟酮）"),
    "DZVXRFMREAADPP": ("Thujan-3-ol", "侧柏醇"),
    "UCFQYMKLDPWFHZ": ("Citronellyl 2-methyl-2-butenoate", "2-甲基-2-丁烯酸香茅酯"),
    "WSWCOQWTEOXDQX": ("Sorbic acid", "山梨酸"),
    "PFVYLGTZGQUUOT": ("Geranyl 2-ethylbutyrate", "2-乙基丁酸香叶酯"),
    "SATICYYAWWYRAM": ("2,4-Heptadienal", "2,4-庚二烯醛"),
    "DTCCTIQRPGSLPT": ("2-Pentenal", "2-戊烯醛"),
    "XEAIHUDTEINXFG": ("Methyl 3-hexenoate", "3-己烯酸甲酯"),
    "XMLSXPIVAXONDL": ("Jasmone", "茉莉酮"),
    "GITGIBUELGTBSG": ("Ethyl 4-heptenoate", "4-庚烯酸乙酯"),
    "HZYHMHHBBBSGHB": ("2,6-Nonadienal", "2,6-壬二烯醛"),
    "RTNPCOBSXBGDMO": ("6-Nonenal", "6-壬烯醛"),
    "VDHRTASWKDTLER": ("5-Octen-1-ol", "5-辛烯-1-醇"),
    "OSMAJVWUIUORGC": ("3-Hexenyl isobutyrate", "异丁酸-3-己烯酯"),
    "RGACQXBDYBCJCY": ("3-Hexenyl hexanoate", "己酸-3-己烯酯"),
    "BCOXBEHFBZOJJZ": ("3-Hexenyl benzoate", "苯甲酸-3-己烯酯"),
    "PAEBAEDUARAOSG": ("Acetaldehyde ethyl 3-hexenyl acetal", "乙醛乙基 3-己烯基缩醛"),
    "XJHQVZQZUGLZLS": ("3-Hexenyl formate", "甲酸-3-己烯酯"),
    "NIONDZDPPYHYKY": ("2-Hexenoic acid", "2-己烯酸"),
    "NGQTTWDHJIMWOI": ("Hexyl 2-hexenoate", "2-己烯酸己酯"),
    "MBDOYVRWFFCFHM": ("2-Hexenal", "2-己烯醛"),
    "SSPBQLGVUAXSMH": ("Methyl 4-octenoate", "4-辛烯酸甲酯"),
    "HRHOWZHRCRZVCU": ("2-Hexenyl acetate", "乙酸-2-己烯酯"),
    "YDXQPTHHAPCTPP": ("3-Octen-1-ol", "3-辛烯-1-醇"),
    "IFTBJDZSLBRRMC": ("3-Nonen-1-ol", "3-壬烯-1-醇"),
    "NSSALFVIQPAIQK": ("2-Nonen-1-ol", "2-壬烯-1-醇"),
    "GNJARWZWODMTDR": ("Ethyl 2-decenoate", "2-癸烯酸乙酯"),
    "QKTZBZWNADPFOL": ("2,4-Dodecadienal", "2,4-十二碳二烯醛"),
    "YSAVZVORKRDODB": ("Diethyl tartrate", "酒石酸二乙酯"),
    "CKLJMWTZIZZHCS": ("Aspartic acid", "天冬氨酸"),
    "WHUUTDBJXJRKMK": ("Glutamic acid", "谷氨酸"),
    "ODKSFYDXXFIFQN": ("Arginine", "精氨酸"),
    "KDXKERNSBIXSRK": ("Lysine", "赖氨酸"),
    "NGHOLYJTSCBCGC": ("Benzyl cinnamate", "肉桂酸苄酯"),
    "BJEPYKJPYRNKOW": ("Malic acid", "苹果酸"),
    "FBPFZTCFMRRESA": ("Mannitol / sorbitol", "甘露醇 / 山梨醇"),
    "UNXHWFMMPAWVPI": ("Erythritol / threitol", "赤藓糖醇 / 苏糖醇"),
    "DUYRYUZIBGFLDD": ("gamma-Gurjunene", "γ-古芸烯"),
    "CCEFMUBVSUDRLG": ("Limonene oxide", "氧化柠檬烯"),
    "BCTBAGTXFYWYMW": ("Linalool oxide (pyranoid)", "芳樟醇氧化物（吡喃型）"),
    "LPTITAGPBXDDGR": ("Hexopyranose pentaacetate", "五乙酰己吡喃糖"),
    "QLTCHMYAEJEXBT": ("Linamarin", "亚麻苦苷"),
    "NZGWDASTMWDZIW": ("Pulegone", "胡薄荷酮"),
    "DTGKSKDOIYIVQL": ("Borneol / isoborneol", "龙脑 / 异龙脑"),
    "LHXDLQBQYFFVNW": ("Fenchone", "葑酮"),
    "DSSYKIVIOFKYAU": ("Camphor", "樟脑"),
    "YSTPAHQEHQSRJD": ("Piperitone", "胡椒酮"),
    "FUCYIEXQVQJBKY": ("delta-Cadinene", "δ-杜松烯"),
    "RKBAYVATPNYHLW": ("Bisabolol oxide B", "红没药醇氧化物 B"),
    "SHZGCJCMOBCMKK": ("6-Deoxyhexose (rhamnose, fucose)", "6-脱氧己糖（鼠李糖、岩藻糖）"),
    "RKFAZBXYICVSKP": ("Asarone", "细辛脑"),
    "UMFCIIBZHQXRCJ": ("4-(1-Propenyl)phenol", "4-(1-丙烯基)苯酚"),
    "UFLHIIWVXFIJGU": ("3-Hexen-1-ol", "3-己烯-1-醇"),
    "AIQLNKITFBJPFO": ("3-Hexenyl isovalerate", "异戊酸-3-己烯酯"),
    "NPFVOOAXDOBMCE": ("3-Hexenyl acetate", "乙酸-3-己烯酯"),
    "WRUZCQAJIHSQPL": ("Ethyl 4-octenoate", "4-辛烯酸乙酯"),
    "GKJZMAHZJGSBKD": ("10,12-Octadecadienoic acid", "10,12-十八碳二烯酸"),
    "XUJNEKJLAYXESH": ("Cysteine", "半胱氨酸"),
    "HNDVDQJCIGZPNO": ("Histidine", "组氨酸"),
    "WMBWREPUVVBILR": ("Epigallocatechin gallate", "表没食子儿茶素没食子酸酯"),
    "PYMYPHUHKUWMLA": ("Pentose (arabinose, ribose, xylose)", "戊醛糖（阿拉伯糖、核糖、木糖）"),
    "LKDRXBCSQODPBY": ("Hexulose (fructose, sorbose)", "己酮糖（果糖、山梨糖）"),
    "GUBGYTABKSRVRQ": ("Disaccharide (maltose and stereoisomers)", "二糖（麦芽糖及其立体异构体）"),
}


def main():
    cand = json.loads(CAND.read_text(encoding="utf-8"))
    missing = set(NAMES) - set(cand)
    assert not missing, missing
    out = {}
    rows = []
    for k14, e in cand.items():
        if k14 not in NAMES:
            continue
        en, zh = NAMES[k14]
        cas = sorted({c for g in e["groups"].values() for c in g["cas"]})
        olds = sorted({n for _, n in e["kb"]} | {x[1] for x in e["lib"] if x[1]})
        out[k14] = {"en": en, "zh": zh, "cas": cas}
        changed = [o for o in olds if o != en]
        rows.append((olds, en, zh, cas, bool(e["kb"]), len(e["lib"]), changed))
    OUT.write_text(json.dumps({"source": "curated by hand 2026-11-20 from training/knowledge/stereo_candidates.py; "
                                         "see apply_stereo_names.py", "names": out},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    n_changed = sum(len(r[6]) for r in rows)
    L = ["# 合并异构体的通用名（待核对）\n",
         "（自动生成：training/knowledge/make_stereo_names.py，2026-11-20。不提交。）\n",
         f"- 对应多个立体 CAS 的合并分子共 {len(cand)} 个骨架（知识库物质 {sum(len(e['kb']) for e in cand.values())} 个、"
         f"分子库 {sum(len(e['lib']) for e in cand.values())} 个）。CAS 经 PubChem 解析，去掉同位素标记的 CID 后仍有 2 个以上不同完整 InChIKey 的才算。",
         f"- 其中 {len(rows)} 个骨架改名（原名带构型，或原名不是可用的名称：CAS 号、数据库代码、混合物名、带电荷形式），"
         f"涉及 {n_changed} 个不同的旧名；其余 {len(cand) - len(rows)} 个原名已不带构型，保持不变。",
         "- 非对映异构体被合并、各有俗名的（如甘露醇与山梨醇），新名把它们列出来。",
         "- 中文页面显示“中文名 (英文名)”；旧名保留为同义词，仍可搜索。\n",
         "| 旧名 | 新英文名 | 新中文名 | 涉及的 CAS | 知识库 / 分子库 |", "|---|---|---|---|---|"]
    for olds, en, zh, cas, kb, nlib, changed in sorted(rows, key=lambda r: r[1].lower()):
        L.append(f"| {' / '.join(olds)} | {en} | {zh} | {', '.join(cas)} | {'知识库' if kb else ''}"
                 f"{' + ' if kb and nlib else ''}{f'分子库 {nlib}' if nlib else ''} |")
    REVIEW.write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"{len(rows)} skeletons renamed, {n_changed} old names; wrote {OUT.name} and {REVIEW}")


if __name__ == "__main__":
    main()
