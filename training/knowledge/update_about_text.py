"""Write the numbers of flavor-kb/data/meta.json into the «数据来源与更新记录» section of the knowledge base
notes (flavor-kb/i18n/{zh,en}.json keys about.sources_table, about.updates), so the page text follows the data.
Run after build_kb.py, then python tools/prerender.py.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "flavor-kb" / "data"


def main():
    m = json.loads((DATA / "meta.json").read_text(encoding="utf-8"))
    foods = json.loads((DATA / "foods.json").read_text(encoding="utf-8"))
    comps = json.loads((DATA / "compounds.json").read_text(encoding="utf-8"))
    L = m["counts"]["links"]
    dk = {fid for fid, f in foods.items() if f.get("kfo") and f.get("kfo_src") != "author"}
    kfo_links = sum(len(foods[f]["kfo"]) for f in dk)
    kfo_mols = sum(1 for c in comps.values() if dk & set(c.get("kfo", [])))
    t1 = sum(len(f["kfo"]) for f in foods.values() if f.get("kfo_src") == "author")
    up = m["updates"][1]
    up3 = m["updates"][2]
    n = lambda x: f"{x:,}"
    th = {"zh": ["来源", "许可", "版本或日期", "分子数", "关联数"], "en": ["Source", "License", "Version or date", "Molecules", "Links"]}
    rows = {
        "zh": [
            ["Dunkel 等 (2014) 综述正文（关键风味物质）", "引用（短引文，注明页码）", "2014", n(kfo_mols), n(kfo_links)],
            ["FlavorDB2（检出）", "CC BY-NC-SA 3.0", "2026-10-16 下载", n(L["flavordb"]["molecules"]),
             f'{n(L["flavordb"]["links"])}（另有 {n(L["flavordb"]["hidden"])} 条已隐藏，见下）'],
            ["FooDB（检出，有出处的条目）", "CC BY-NC 4.0", "2020-04-07 导出版", n(L["foodb"]["molecules"]), n(L["foodb"]["links"])],
            ["作者已发表数据（母乳，表 S1、S2）", "引用（Cui 等，<i>Food Bioscience</i> 2026）", "2026", n(L["author"]["molecules"]), n(L["author"]["links"])],
            ["作者已发表数据（母乳关键风味物质，Table 1）", "引用（Cui 等，<i>Food Bioscience</i> 2026）", "2026", n(t1), n(t1)],
        ],
        "en": [
            ["Dunkel et al. (2014), main text (key food odorants)", "quotation (short, with page numbers)", "2014", n(kfo_mols), n(kfo_links)],
            ["FlavorDB2 (detected)", "CC BY-NC-SA 3.0", "downloaded 2026-10-16", n(L["flavordb"]["molecules"]),
             f'{n(L["flavordb"]["links"])} (another {n(L["flavordb"]["hidden"])} hidden, see below)'],
            ["FooDB (detected, entries with a reference)", "CC BY-NC 4.0", "2020-04-07 export", n(L["foodb"]["molecules"]), n(L["foodb"]["links"])],
            ["Author's published data (human milk, Tables S1, S2)", "citation (Cui et al., <i>Food Bioscience</i> 2026)", "2026", n(L["author"]["molecules"]), n(L["author"]["links"])],
            ["Author's published data (key flavor compounds of human milk, Table 1)", "citation (Cui et al., <i>Food Bioscience</i> 2026)", "2026", n(t1), n(t1)],
        ],
    }
    total = {"zh": f'合计 {n(m["counts"]["compounds"])} 个物质、{n(m["counts"]["foods"])} 种食品；{n(m["counts"]["compounds_with_foods"])} 个物质有检出记录。一个分子-食品关联可以同时来自几个来源。',
             "en": f'In total {n(m["counts"]["compounds"])} compounds and {n(m["counts"]["foods"])} foods; {n(m["counts"]["compounds_with_foods"])} compounds have detection records. One compound-food link can come from several sources.'}
    table = {}
    for lang in ("zh", "en"):
        table[lang] = ('<table class="preview"><thead><tr>' + "".join(f"<th>{h}</th>" for h in th[lang]) + "</tr></thead><tbody>" +
                       "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows[lang]) + "</tbody></table>" +
                       f'<span class="small muted">{total[lang]}</span>')
    updates = {
        "zh": "<ul>"
              "<li><b>2026-10-16</b>：建立知识库，收录 FlavorDB2 检出数据和 Dunkel 等 (2014) 正文中的关键风味物质，共 1,648 个物质、952 种食品。</li>"
              f'<li><b>{up["date"]}</b>：① 并入 FooDB（2020-04-07 导出版）中有出处的条目（数据库、期刊论文、专著），{n(up["foodb_links"])} 条关联，'
              f'新增 {n(up["compounds_added_foodb"])} 个物质；推测数据（HMDB、PathBank）和无出处的条目不用。只按结构骨架（InChIKey 前 14 位）对应上的分子，'
              f'物质卡片注明未区分立体构型；FlavorDB2 与 FooDB 名称不同的 4 种乳制品（牛乳 Milk / Milk (Cow)，奶粉 Milk Powder / Dried milk，脱脂乳 Skimmed Milk / Cow milk 0% fat，乳脂 Milk Fat / Butterfat）合并为同一食品。② 隐藏 FlavorDB2 中来自 FooDB 无出处批量条目的关联 {n(up["flavordb_links_hidden"])} 条（涉及 {n(up["flavordb_molecules_hidden"])} 个物质）：'
              "FooDB 把这些分子各自无出处地关联到 300 种以上食品，FlavorDB2 沿用了这批数据；同一食品有 FooDB 有出处的条目确认时保留。"
              f'③ 加入作者已发表数据：母乳（Human milk），{n(up["author_links"])} 个分子，出处为 Cui 等，<i>Food Bioscience</i> 2026，'
              '<a href="https://doi.org/10.1016/j.fbio.2026.110162" target="_blank" rel="noopener">doi:10.1016/j.fbio.2026.110162</a>：'
              f'表 S1 中 50 份母乳检出的挥发物（表注所述采样容器和实验耗材带入的 4 个迁移物不计；顺反异构体在本站算同一分子），以及表 S2 中结构明确的 {L["author"]["s2"]} 个脂肪酸；'
              f'新增 {n(up["compounds_added_author"])} 个物质。更新后共 {n(m["counts"]["compounds"])} 个物质、{n(m["counts"]["foods"])} 种食品。</li>'
              f'<li><b>{up3["date"]}</b>：母乳增加“关键风味物质”一层：同文 Table 1 的 {up3["kfo"]} 个物质（ROAV ≥ 1 且在 GC-O 中闻到），与 Dunkel 等 (2014) 的关键风味物质同一层级；'
              f'{up3["dairy_zh"]} 种乳制品加了中文名。</li>'
              "</ul>",
        "en": "<ul>"
              "<li><b>2026-10-16</b>: knowledge base built from FlavorDB2 detection data and the key food odorants in the main text of Dunkel et al. (2014): 1,648 compounds, 952 foods.</li>"
              f'<li><b>{up["date"]}</b>: (1) FooDB (2020-04-07 export) entries with a reference (databases, journal articles, books) added: {n(up["foodb_links"])} links, '
              f'{n(up["compounds_added_foodb"])} new compounds; predicted data (HMDB, PathBank) and entries without a reference are not used. Molecules matched only by the skeleton '
              f'(first 14 InChIKey characters) say so on their card (stereoisomers not distinguished); 4 dairy foods named differently in FlavorDB2 and FooDB are merged (Milk / Milk (Cow), Milk Powder / Dried milk, Skimmed Milk / Cow milk 0% fat, Milk Fat / Butterfat). (2) {n(up["flavordb_links_hidden"])} FlavorDB2 links '
              f'({n(up["flavordb_molecules_hidden"])} compounds) hidden that came from FooDB bulk entries without a reference: FooDB links each of these molecules to more than 300 foods '
              "without a reference, and FlavorDB2 took these over; a link stays when a FooDB entry with a reference confirms the same food. "
              f'(3) Author\'s published data added: human milk, {n(up["author_links"])} molecules, from Cui et al., <i>Food Bioscience</i> 2026, '
              '<a href="https://doi.org/10.1016/j.fbio.2026.110162" target="_blank" rel="noopener">doi:10.1016/j.fbio.2026.110162</a>: '
              "the volatiles detected in 50 human milk samples in Table S1 (without the 4 migrants from sampling containers and laboratory consumables named in its footnote; "
              f'cis/trans isomers count as one molecule on this site) and the {L["author"]["s2"]} fatty acids of defined structure in Table S2; '
              f'{n(up["compounds_added_author"])} new compounds. After the update: {n(m["counts"]["compounds"])} compounds, {n(m["counts"]["foods"])} foods.</li>'
              f'<li><b>{up3["date"]}</b>: human milk gets a key flavor compound layer: the {up3["kfo"]} compounds of Table 1 of the same article (ROAV ≥ 1 and perceived in GC-O), '
              f'the same tier as the key food odorants of Dunkel et al. (2014); {up3["dairy_zh"]} dairy foods got a Chinese name.</li>'
              "</ul>",
    }
    for lang in ("zh", "en"):
        p = ROOT / "flavor-kb" / "i18n" / f"{lang}.json"
        d = json.loads(p.read_text(encoding="utf-8"))
        d["about.sources_table"] = table[lang]
        d["about.updates"] = updates[lang]
        p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("updated about.sources_table, about.updates")


if __name__ == "__main__":
    main()
