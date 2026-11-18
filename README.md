# Jingwei Cui 个人网站与 7 个风味研究在线工具

- 个人主页：https://redamancy564.github.io/
- 在线工具目录：https://redamancy564.github.io/projects/

在线工具编号与网站一致（顺序定义在 `assets/projects.js`）。每个工具有简称和全称（下面列表中括号里是全称）：简称用于主页和在线工具目录的列表、工具页大标题、浏览器标签和站内互相引用；全称作为灰色小字显示在简称下方。文字在 `assets/i18n/*.json` 的 `home.X.title`（简称）、`home.X.full`（全称）和各工具 `i18n/*.json` 的 `hero.short`（简称）、`hero.title`（全称）：

1. GC-MS 风味解读（兼容多仪器格式的 GC-MS 数据自动分析）：https://redamancy564.github.io/gcms-interpreter/
2. 原料与替代物检索（基于气味描述词预测的风味原料检索及其替代物的筛选）：https://redamancy564.github.io/ingredient-finder/
3. 气味预测（基于图神经网络的分子气味描述词预测）：https://redamancy564.github.io/odor-predictor/
4. 乳品风味改良（基于贝叶斯优化的乳品风味改良与差距分析）：https://redamancy564.github.io/flavor-improver/
5. 气味地图（风味分子的气味空间与结构空间对比图谱）：https://redamancy564.github.io/odor-map/
6. 味觉预测（基于图神经网络的小分子味觉预测）：https://redamancy564.github.io/taste-predictor/
7. 风味知识库与法规查询（食品关键风味物质知识库与香料法规查询）：https://redamancy564.github.io/flavor-kb/ ，法规查询：https://redamancy564.github.io/flavor-kb/regulatory.html

## 7 食品关键风味物质知识库与香料法规查询（flavor-kb/）

三级数据，网页上用颜色标签区分：

| 级别 | 来源 | 说明 |
|---|---|---|
| 第一级·关键风味物质（深绿） | Dunkel et al., Angew. Chem. Int. Ed. 2014, 53, 7124（doi:10.1002/anie.201309508） | 只摘录正文中明确写出的食品与关键风味物质，附页码，见 `training/knowledge/dunkel2014_main_text.json`。完整对照在补充材料中，未收录 |
| 第一级·检出（浅绿） | FlavorDB2（Garg et al., NAR 2018），CC BY-NC-SA 3.0 | 「检出」不等于对气味有贡献；衍生数据按同一协议共享，见 `flavor-kb/data/LICENSE.md` |
| 第二级·实时文献（蓝） | Europe PMC（免费、无需密钥） | 标题和摘要中检索「物质名 + 食品 + aroma 等词」，只列文献 |
| 第三级·摘要文字匹配（橙） | Europe PMC，查不到时用 Crossref | 按 DOI 获取摘要，高亮其中的物质名，仅为文字匹配 |

物质之间用「去掉立体化学层的标准 InChI」对应（浏览器端与 Python 端结果一致）。

**更新知识库数据：**
```powershell
cd training
.\.venv\Scripts\Activate.ps1
python knowledge/fetch_flavordb.py   # 下载 FlavorDB2（约 1,000 次请求，每秒 1 次，已下载的会跳过）
python knowledge/build_kb.py         # 生成 flavor-kb/data/*.json
```
原文 PDF（Dunkel 2014、van Gemert 2011）有版权，已加入 `.gitignore`，不会上传。

### 法规查询（flavor-kb/regulatory.html）

食品香料在欧盟、中国和美国的法规状态。两份静态数据文件（同一个脚本生成，随页面加载，不访问外部接口），由 `assets/regulatory.js` 读取和显示，文字在 `assets/i18n/*.json` 的 `reg.*` 键：
- `flavor-kb/data/regulatory.json`（约 350 KB，gzip 约 130 KB）：只含与原料检索分子库按 CAS 重合的分子，供原料检索结果卡片、气味预测和知识库物质卡片使用。
- `flavor-kb/data/regulatory-lookup.json`（约 565 KB，gzip 约 160 KB）：欧盟 Union list 全部条目、附件 III A 部分、GB 2760 表 B.2/B.3 全部条目和美国条目，按共同 CAS 合并为物质，只由法规查询页加载；本站有的物质附跳转链接。英文检索另用 GB 2760 表中的英文名和 FDA 清单名称。FDA 自编号（977 开头）不是 CAS，只用于合并条目，不显示。

| 地区 | 来源 | 说明 |
|---|---|---|
| 欧盟 | Regulation (EC) No 1334/2008 附件 I Part A 表 1（Union list），EUR-Lex 合并版 02008R1334-20260216（修订至 (EU) 2026/175），CC BY 4.0 | 摘录 FL 号、CAS、使用限制（本站概括，`training/regulatory/notes.json`）、脚注；附件 III A 部分单独说明 |
| 中国 | GB 2760-2024 表 B.2、B.3（官方文本，食品安全国家标准数据检索平台），未包含修改单 | 只用编码、中文名、FEMA 号；FEMA→CAS 借助 FDA「Substances Added to Food」清单；无可用 FEMA 号的 30 个合成香料由本站在 PubChem 核实 CAS（`training/regulatory/cn_cas_manual.json`） |
| 美国 | eCFR 21 CFR 172.510、172.515、182.10/20/40/50/60、第 184 部分中用途含香料且物质本身是香料的节、第 189 部分与香料相关的 4 节（189.110/113/130/180），现行文本更新至 2026-10-20；FDA「Substances Added to Food」清单（2026-09-08 更新）。美国政府作品，公有领域；eCFR 是非官方汇编 | 条款不给 CAS：按 FDA 清单的条款引用对应 CAS，再与 eCFR 条文逐条核对名称（写法不同的对应和不收的引用见 `training/regulatory/us_cfr_alias.json`）；189 条文点名、FDA 清单没有的物质见 `us_189_manual.json`（PubChem 核实）；FEMA 编号和「已不再列为 FEMA GRAS」照录 FDA 清单；2018 年从 172.515 删除的 7 种单独标出；172.510 限制栏和 172.515(c) 照录英文原文。不使用 FEMA 网站或 FEMA 发布的数据 |

工具页只覆盖与原料检索分子库按 CAS 重合的物质（2026-10-22：欧盟 2014、中国 1283、美国 1868（其中「许可」1852）、三地都许可 1164、任一 2386）；法规查询页收录三地全部条目（欧盟 2475 + 附件 III 15，中国 1892，美国 2973，合并为 3861 个物质，其中 2451 个与分子库对应）。「未在清单中找到」不等于不允许。

**更新法规数据**：原始文件放在 `training/data/regulatory/`（不上传：欧盟合并版 XHTML、GB 2760 官方 PDF、FDA 清单 `fda/foodsubstances.txt`、eCFR XML `us/p172.xml` 等）。

欧盟有新合并版、GB 2760 修改单正式发布时：
```powershell
python training/regulatory/lib_cas.py          # 分子库 CAS（PubChem，有缓存）
python training/regulatory/parse_eu_annex.py   # 欧盟表 1 和附件 III
python training/regulatory/parse_gb.py         # GB 2760 表 B.2/B.3（需要 pip install pymupdf）
python training/regulatory/build_regulatory.py # 生成 flavor-kb/data/regulatory.json、regulatory-lookup.json 和核对报告
python training/regulatory/check_consistency.py # 核对两份数据对每个本站分子一致（应输出 differences: 0）
```

eCFR 香料条款（21 CFR 172、182、184、189 部分）或 FDA「Substances Added to Food」清单更新时：
1. 下载新文件。eCFR 用官方 API（必须带 `--compressed`，日期取 https://www.ecfr.gov/api/versioner/v1/titles.json 中 Title 21 的 `up_to_date_as_of`）：
   ```powershell
   curl --compressed -o training/data/regulatory/us/p172.xml "https://www.ecfr.gov/api/versioner/v1/full/<日期>/title-21.xml?part=172"
   ```
   对 182、184、189 同样下载。FDA 清单从 https://www.hfpappexternal.fda.gov/scripts/fdcc/cfc/XMLService.cfm?method=downloadxls&set=FoodSubstances 下载，存为 `training/data/regulatory/fda/foodsubstances.txt`（文件第一行有「Last updated」日期）。
2. 依次运行：
   ```powershell
   python training/regulatory/parse_us.py          # eCFR XML -> training/data/regulatory/out/us_parsed.json（先把脚本里的 ECFR_DATE 改为新日期）
   python training/regulatory/build_regulatory.py  # 重新生成两份数据文件；FDA 清单的更新日期在脚本 meta 的 fda_updated，查阅日期在 CHECKED
   python training/regulatory/check_consistency.py # 应输出 differences: 0
   ```
3. 看 `training/data/regulatory/out/build_report.json` 的 `us_name_check`（FDA 引用但名称对不上）、`us_cfr_only`（eCFR 有、FDA 无）、`us_dropped`、`us_not_found`、`us_184`：有新增时人工核对，必要时更新 `us_cfr_alias.json`（alias、drop、not_found）或 `us_189_manual.json`，再重跑第 2 步。若 172.515 等条款又有物质被删除，同时检查脚本中的 `US_DELETED`。

无论更新哪一地，之后都要：
- 同步修改页面上的日期和数量：`assets/i18n/*.json` 的 `reg.src_eu`、`reg.src_cn`、`reg.src_us`（美国写 eCFR 更新日期、查阅日期和 FDA 清单日期）；`flavor-kb/i18n/*.json` 的 `rq.scope`、`rq.footer`、`about.reg_src_*`、`about.reg_match_1`；`ingredient-finder/i18n/*.json` 的 `footer.reg`。中英文同步。
- 更新 `?v=` 版本号：所有 HTML 里的 `?v=` 换成新值（如 `grep -rl "v=20261022d" --include=*.html . | xargs sed -i "s/v=20261022d/v=<新版本>/g"`），否则浏览器可能继续用缓存的旧数据和脚本。
- 跑 `ingredient-finder/tests/unit.html`（含三地法规数据检查，测试中的计数需随数据更新）和 `python tools/prerender.py`。

## 1 GC-MS 风味解读：气相强度曲线（gcms-interpreter/curves.html）

GC-MS 风味解读的第二个标签（2026-11-17）。315 个香料物质在空气中的剂量反应曲线，来自 Wakayama H, Sakasai M, Yoshikawa K, Inoue M. *Ind. Eng. Chem. Res.* 2019, 58(32): 15036-15044，doi:10.1021/acs.iecr.9b01225（补充材料 Table S2 的 314 个物质，异戊酸来自正文 Table 3）。公式 Ψ = Imax / (1 + exp(-(X - C)/D))，X = log10(气相浓度, μg/L 空气)；阈值为 Ψ = 1.4 时的 X = C - D·ln((Imax-1.4)/1.4)；强度标尺为 LMS（刚能察觉 1.4、弱 6.1、中等 17.2、强 35.4、很强 53.3、能想象的最强 100）。

- **页面**：按中文名、英文名或 CAS 搜索，最多叠加 4 条曲线（自写 SVG，无外部库、无外部请求），输入气相浓度（μg/L 空气 = mg/m³）换算强度和等级；X 超出 -5 到 5（原文作图范围）只提示“超出原文作图范围”，不给数值；D < 0.1 的 5 个物质（如香兰素）可以搜到，但不画曲线、不换算。`?cas=` 直接打开一个物质。浓度是空气中的浓度，不适用于水、乳等介质，也不能用 OAV 或相对气味活性值换算。
- **数据**：`gcms-interpreter/data/intensity.json`（只含必要字段，不提供整表下载）由 `training/intensity/build_intensity.py` 从本地 `_inputs/wakayama2019_curves.json` 生成（`_inputs/` 和 PDF 不提交）。脚本断言 5 个自测值（柠檬烯 X=1.67 时 Ψ≈25.3；芳樟醇 X=-2.55 时 Ψ≈0.87；粪臭素阈值 ≈4.89e-4 μg/L；异戊酸来自正文 Table 3；2,6-壬二烯醛 CAS 557-48-2），并写出本地匹配报告 `training/intensity/match_report.md`（不提交）。原文数据的问题记在脚本的 `DATA_NOTES` 里，页面图例中也会显示：2,6-nonadienal 的 CAS 原文印为 140-88-5，改为 557-48-2；furaneol 给的 CAS 4166-20-5 是 furaneol 乙酸酯，diethyl malonate 给的 CAS 108-59-8 是丙二酸二甲酯，无法确定测的是哪个物质：这两条按原文保留，中文名留空，曲线页可以搜到并显示说明，但其他页面不加链接（脚本的 `NO_LINK`）。异戊酸的参数已对照正文 Table 3 核对；正文 Table 3 有 5 个物质的 CAS 与补充材料 Table S2 不同（参数相同），网站沿用 Table S2 的 CAS。
- **中文名**：`training/intensity/zh_names.csv`（2026-11-17 审核通过：245 个中文名，其余 70 个显示英文名），只有 `status=approved` 的行进入网站数据；`python training/intensity/build_intensity.py --propose` 重新生成候选（保留已通过的行）和本地审核表 `/INTENSITY-ZH-REVIEW.md`。来源顺序：GB 2760-2024 中文名（法规数据中按 CAS 已有的）、本站已有中文名、作者为常见物质拟的名字；商品名保留英文。
- **全站链接**：`assets/intensity.js` 在物质名旁加小链接“强度曲线”（跳到 `curves.html?cas=`），只按 CAS 精确匹配（构建时算好：风味知识库按 `names.json` 的 CAS，寻香原料库分子按 `lib_cas.json` 的 CAS，气味预测按库分子的 InChIKey 第一段）；没有 CAS 的地方只在名称完全一致（去掉首尾空格，英文不分大小写）时匹配。链接点：GC-MS 结果表、关键风味物质排序和气味阈值表的名称列（文件 CAS，或按 CAS / 同义词完全一致鉴定到的知识库物质）；乳品风味改良的物质表、配方表和“我的 GC-MS 数据”的对比表、差距表、推荐列表；风味知识库物质卡片标题；法规查询结果；寻香原料的查询分子和结果卡片；气味图谱详情卡片；气味预测的分子名。OAV、相对气味活性值等数字上不加链接。一个库分子的 CAS 同时命中多条曲线时只链接名称相同的那条（异冰片）。
- **测试**：`gcms-interpreter/tests/intensity.html`（40 项，含上述 5 个自测值）。改数据或 `assets/intensity.js` 后跑这个页面和 `gcms-interpreter/tests/unit.html`，再跑 `python tools/prerender.py`，并更新 `?v=` 版本号。

## 4 基于贝叶斯优化的乳品风味改良与差距分析（flavor-improver/）

方法框架演示：选择一种乳制品基底和改良方向，用贝叶斯优化搜索「添加哪些风味物质、加多少」。评价函数是虚拟的（OAV → log 强度 → 描述词「提升度」向量加和 → 与目标轮廓的余弦相似度，减去种数和用量惩罚），不含掩蔽、协同、基质效应。

- **数据**：18 种候选添加物 + 基底物质，阈值取自 van Gemert 2011（固定规则：Czerny 2008 > Buttery > Karagül-Yüceer），基底浓度来自 3 篇定量文献（出处见网页页脚和 `flavor-improver/data/bases.json`）。单分子气味向量来自 3 气味预测的模型。
- **参数**：K = 5，λ₁ = 0.05，λ₂ = 0.002，α = 0.1，添加量为阈值的 0.01 至 100 倍（`flavor-improver/data/mixture_spec.json`）。λ₂ 和上限的调整过程记录在 `training/flavor_improver/mixture.py` 注释和网页「结果」部分。
- **网页**：默认阈值下播放预计算的优化过程（Python / BoTorch）；访客修改阈值后，可在浏览器中重新运行简化版贝叶斯优化（`bo.js`）。
- **一致性测试**：https://redamancy564.github.io/flavor-improver/tests/parity.html ，检查 `mixture.js` 与 Python 的混合规则、目标函数完全一致。浏览器版算法的表现见 `tests/bo_check.html`（运行约需几十秒）。**修改 `mixture.py` 或数据后，必须重新生成测试数据并确认全部 PASS。**

**配方奶粉对比母乳：婴儿配方奶粉与母乳的风味差距分析（参照食品模式）**：数据来自 Zhang et al. 2022（*Food Chem* 382:132348，表 2、表 3，录入后已与 PDF 逐格核对），奶粉浓度按奶粉计并除以 8 换算为冲调后；两侧都以论文中的单个样本为起点，访客可修改浓度、增删物质。只分析 OAV ≥ 10（可选 ≥ 5）的关键风味物质，输出轮廓对比、差距排序和前体方向（`flavor-improver/reference.js`），不给出添加量；另有标明“仅为方法演示、不适用于婴儿配方食品”的添加量模拟。前体对照表在 `flavor-improver/data/precursors.json`，每行注明文献位置；GB 10765-2021 的条款内容须对照官方原文核实。
```powershell
cd training
.\.venv\Scripts\Activate.ps1
pip install pymupdf                                                    # 仅提取 PDF 文本时需要
python flavor_improver/extract_vangemert.py "<van Gemert PDF>" vg.txt  # 提取阈值汇编文本（PDF 有版权，不上传）
python flavor_improver/prepare_reference.py vg.txt --final             # 生成 flavor-improver/data/reference.json
python flavor_improver/make_parity_fixtures.py                         # 更新一致性测试数据（含配方奶粉对比母乳）
```

**用自己的数据（2026-10-18）**：在 GC-MS 风味解读中分别处理当前样品和目标样品，点「作为当前样品发送 / 作为目标发送」（`assets/flavor-handoff.js`，浏览器本地存储，不上传），或上传其导出的排名 CSV（也接受自己整理的 CSV：物质名称列 + 浓度、相对含量 / 峰面积、OAV 或 ROAV 中至少一列，列名中英文均可，单位写在列名里；页面上有「上传 CSV 的要求」和模板 `flavor-improver/examples/userdata_template.csv`）；在乳品风味改良页面选「我的 GC-MS 数据」（或打开 `flavor-improver/?mode=user`）。页面按化合物合并两边（阈值可改），两边都定量时按 OAV 比较，否则按 ROAV（贡献占比）；轮廓维度默认母乳 / 奶粉 12 维，可切换；「一方较高」的标准默认 2 倍 / 2 个百分点，可在设置窗口调整；只推荐添加哪些物质（OAV 模式按补到目标水平后的轮廓相似度排序），不给添加量。不在风味知识库中的物质可提供 SMILES（或点击后从 PubChem 按 CAS / 名称查询）由 odor-predictor 模型在浏览器中预测气味。页面有内容安全策略（脚本只来自本站；数据只能发往本站和用户点击时的 PubChem）。逻辑在 `userdata-core.js`，单元测试 `flavor-improver/tests/userdata.html`；示例数据 `flavor-improver/examples/` 由 `training/flavor_improver/make_userdata_examples.py` 从「配方奶粉对比母乳」的已发表数据生成。

**尝试过的改进：混合物气味相似度模型（2026-10-18，未采用）**：借鉴 Satarifard et al., *PNAS* 2026（doi:10.1073/pnas.2611057123），想用一个比较两个混合物的小模型替换参照食品模式的加和规则。DREAM 挑战赛整理的数据没有开放许可（Synapse 条款禁止用于其他目的），只用了 Snitz et al. 2013（*PLoS Comput Biol*，CC BY 4.0）的相似度评分。按混合物分组：实验 2、3 共 165 对训练和交叉验证，实验 1 的 141 对不重叠比较作测试集（只算一次；实验 1 的 11 号混合物在补充表中组成被截断，已去掉）。测试集 Pearson / Spearman：新模型（GNN 预测概率幂平均 + 138 维权重的角距离）0.537 / 0.516，Snitz 21 描述符角距离 0.504 / 0.563，现用加和规则（12 维）0.315 / 0.382，138 维加和 0.449 / 0.553；与各基线的 Pearson 差值置信区间都包含 0，未达到替换条件，评价函数不变，只在网页「局限」部分报告。（2026-11-18 气味模型更新为消息传递网络后，用同样流程重新计算一次：交叉验证选 λ = 10；测试集新模型 0.563 / 0.594，Snitz 21 描述符 0.504 / 0.563，现用加和规则 0.318 / 0.395，138 维加和 0.446 / 0.554；与现用加和规则和 138 维加和的 Pearson 差值置信区间不含 0，与 Snitz 两种角距离的仍包含 0，替换条件仍未完全达到，评价函数不变。）
```powershell
cd training
.\.venv\Scripts\Activate.ps1
python mixture/snitz_data.py         # 下载好的 Snitz 补充材料 → training/data/mixture/snitz.json（结构来自 PubChem）
python mixture/evaluate.py           # 交叉验证选模型（不看测试集）
python mixture/evaluate.py --test    # 测试集，只运行一次
python mixture/patch_page.py         # 把测试结果写入 flavor-improver 页面（一次性）
```

**重新运行优化实验**（CPU 即可，约 1 小时）：
```powershell
cd training
.\.venv-bo\Scripts\Activate.ps1      # 首次：python -m venv .venv-bo，再安装 CPU 版 torch 和 botorch
python flavor_improver/mixture.py               # 写出 mixture_spec.json
python flavor_improver/run_experiments.py       # 4 示例 × 4 方法 × 10 种子 + 已知答案检验（可中断续跑）
python flavor_improver/analyze.py               # 生成 bo_metrics.json、bo_traces.json（含与随机稀疏搜索的 Mann-Whitney 检验）
python flavor_improver/make_parity_fixtures.py  # 生成一致性测试数据
```

## 3 基于图神经网络的分子气味描述词预测（odor-predictor/）

用图神经网络（GNN）从分子结构预测风味分子的气味描述词。模型导出为 ONNX，网页为纯 HTML/CSS/JS，托管在 GitHub Pages，不需要服务器。

- **模型（2026-11-18 起）**：带键特征的消息传递网络（`training/model_mpnn.py`，结构参考 Lee et al. 2023 的消息传递思路，不是复现）。原子特征 26 维（与原 GCN 相同），键特征 6 维（单 / 双 / 三 / 芳香 / 其他键型 + 是否在环中，`training/featurize_mpnn.py`）；3 层、256 维、残差更新，约 94 万个参数，ONNX 3.75 MB。层数、维度、更新方式在验证集上从 12 组中选出（`training/train_mpnn.py`，结果 `training/mpnn_results.json`）。测试集 macro AUROC 3 个种子均值 0.866 ± 0.002（原 GCN 0.860 ± 0.0003；去掉键特征的对照 0.863）。原 GCN（`training/model.py`、`featurize.py`）仍用于味觉预测，不要修改。

- **搜索任意分子**：输入英文名称、CAS 号或 SMILES。名称和 CAS 号通过 PubChem 转为结构，然后在访客的浏览器中实时计算特征并运行模型。网址可带参数直接分享，例如 `odor-predictor/?q=linalool`。
- **原子贡献高亮（遮挡法）**：依次删去每个原子重新预测，概率变化即该原子的贡献，橙色为提高、蓝色为降低（`training/occlusion.py`；浏览器端 `OdorEngine.occlusion`；绘图与图例在共用的 `assets/contrib.js`）。预设分子在 Python 中预计算，搜索的分子在浏览器中现场计算。页面注明高亮只反映模型的判断依据，不代表构效因果。
- **一致性测试**：https://redamancy564.github.io/odor-predictor/tests/parity.html ，检查浏览器端（`odor-predictor/engine.js`）的特征和预测与 Python 完全一致（50 个随机测试分子 + 10 个预设分子 + 15 个边界结构），以及 20 个分子的原子贡献。`tests/features-all.html` 对训练数据和候选库全部 5,112 个分子逐项比对原子和键特征（`training/make_feature_parity.py` 生成参考数据）。**修改特征或重新训练后，必须先打开这个页面确认全部 PASS 再上线。**
- **尝试过的改进（未采用，2026-10-17）**：参考 PharmaGNN（Liu et al., J Sci Food Agric 106, 8114-8120, 2026, doi:10.1002/jsfa.70826），在同一骨架划分上、对上一版模型（GCN）做消融：非对称损失、原子药效团标记（供体 / 受体 / 疏水，RDKit BaseFeatures 定义，冻结在 `training/pharmacophore_smarts.json`）及两者组合。测试集 macro AUROC：原模型 0.860 ± 0.0003，ASL 0.8615 ± 0.0029，药效团 0.8606 ± 0.0017，两者 0.8595 ± 0.0013；稀有标签未改善，未达到事先约定的替换条件（提升 ≥ 0.005、3 个种子都更好、稀有标签不下降），当时线上模型不变。详见 `training/ablation_results.json`（网页注明这些实验在上一版模型上进行）。
- **气味阈值**：仅 10 个预设分子显示水中阈值文献值（van Gemert 2011 汇编；数据在 `training/odor_thresholds.json`）。该书有版权，PDF 已加入 `.gitignore`，不会上传。

## 6 基于图神经网络的小分子味觉预测（taste-predictor/）

沿用气味预测上一版的 GCN 结构（`training/model.py`，不区分键型）、原子特征和 ONNX 流程，预测小分子的甜、苦、鲜、无味四类（多标签，各一个概率）。酸、咸样本太少，不建模；数据中记载为酸或咸的预设分子在页面上单独提示。

- **数据**：ChemTastesDB v2.1（Zenodo 15051366，CC BY 4.0）为主，VirtuousMultiTaste（GitHub，MIT，固定 commit）为辅。BitterDB 为 CC BY-NC-ND（禁止演绎），未直接使用；SuperSweet 已下线。清洗后 3,937 个分子：甜 1,799、苦 1,569、鲜 127、无味 201。剔除多肽（3 个及以上残基，二肽如阿斯巴甜保留）、无机物和超过 64 个重原子的分子。
- **标签规则**（`training/taste/clean.py`）：同一分子在不同记录中冲突时取阳性；「非甜」等只给该类记阴性，其余为未知；未知标签不计入损失和 AUROC。
- **部署模型**：评估用只训练集的模型；评估后按相同设置用全部数据重新训练作为网页模型（因为核苷酸类鲜味分子整组落在测试集，用户 2026-10-17 选择此方案）。
- **浏览器端标准化**：RDKit.js 没有 neutralize，`taste-predictor/engine.js` 按 RDKit Uncharger 规则重写了中和步骤，其余复用 `odor-predictor/engine.js`。
- **原子贡献高亮**：同气味页面，在标准化后的结构上计算和绘图（预设分子显示原始形式备注）。
- **一致性测试**：https://redamancy564.github.io/taste-predictor/tests/parity.html （64 个特征用例 + 23 个标准化用例，含盐和两性离子，+ 23 个原子贡献用例）。**修改特征、标准化或重新训练后，必须确认全部 PASS。**

**重新训练：**
```powershell
cd training
.\.venv\Scripts\Activate.ps1
python taste/download.py           # 下载 ChemTastesDB、VirtuousMultiTaste、ChEMBL 临床阶段分子列表（不上传）
python taste/clean.py              # 解析标签、标准化、过滤、合并，汇报冲突
python taste/drug_flags.py         # 用 ChEMBL 标记药物分子（评估苦味偏差）
python taste/split.py              # 混合骨架划分（80/10/10）
python taste/baseline_fp.py        # Morgan 指纹 + 逻辑回归
python taste/train_gnn.py          # GNN 3 个种子 + 全数据部署模型
python taste/umami_valid.py        # 鲜味的验证集参考值
python taste/export_taste_onnx.py  # 导出 ONNX 并验证
python taste/make_site_assets.py   # labels、presets、一致性测试数据
```

**当前结果（测试集 AUROC，GNN 为 3 个种子均值）：** 甜 0.854 / 基线 0.866；苦 0.863 / 0.867；无味 0.889 / 0.826；鲜两者均为 1.000，但测试集鲜味以核苷酸为主且无含磷阴性样本，不可信（验证集无磷鲜味参考 0.943 / 0.950）。苦味中药物分子 AUROC 0.736，非药物 0.875。

## 5 风味分子的气味空间与结构空间对比图谱（odor-map/）

把原料与替代物检索的候选库（5,072 个有机分子）用 UMAP 降到二维：气味地图按 GNN 的 138 维预测概率排列（余弦距离，邻居数 30，最小距离 0.3），结构地图按 Morgan 指纹排列（Jaccard 距离，15，0.1），随机种子 42。参数在验证集上从 3 组中选，以「至少一个标签相同」的比例为准；结构地图取最好的一组。2026-11-18 换用消息传递网络后，气味地图在验证集上 (15, 0.1) 略高（0.755 对 0.746），但分子被拉成细条、成团不明显，为可读性保留 (30, 0.3)（用户决定，页面如实说明）。测试集定稿后只算一次。颜色按描述词固定（`training/odormap/make_site_data.py` 的 `COLOUR_OF`，写入 `map.json` 的 `colour_hex`），新进前十的描述词须先在那里指定颜色。

- **页面**：Canvas 2D 绘图，d3-zoom 缩放拖动，d3-quadtree 悬停查找（固定版本，本站托管于 `assets/vendor/`）；两张地图平滑切换；按主要预测描述词或单个描述词的概率着色；自动区域标签；点击打开详情卡片（跳转气味预测、找替代原料、风味知识库）；搜索；食品高亮（Dunkel 2014 的 16 种食品为关键风味物质，其余 FlavorDB 食品为检出物质）。分子、名称和预测概率直接读取 `ingredient-finder/data/`，不重复存储。
- **链接参数**：`?smiles=`、`?food=` / `?food2=`（知识库食品 id）、`?map=structure`、`?colour=<描述词 id>`。
- **测试集结果**（486 个分子，二维地图上最近 15 个有标签邻居）：至少一个真实标签相同的比例，气味地图 0.756、结构地图 0.647、随机 0.387；平均 Jaccard 0.196 / 0.156 / 0.059；差值 95% 置信区间不含 0。

**重新生成：**
```powershell
cd training
.\.venv\Scripts\Activate.ps1
python ingredient/build_library.py   # 候选库（含非风味分子的排除规则）
python ingredient/export_embed.py    # 新气味模型对候选库的预测（features.npz）
python ingredient/evaluate_finder.py --embedding probs   # 原料检索评估（嵌入按用户决定用概率向量）
python ingredient/make_site_data.py  # ingredient-finder/data/（probs.bin 等）
python odormap/umap_compare.py      # 第 1 阶段：3 组参数对比（效果图和验证集指标）
python odormap/build_maps.py        # 定稿地图 + 评估（测试集只算一次）
python odormap/make_site_data.py    # odor-map/data/：坐标、区域标签、食品列表
```

## 如何更新网站（最常用）

在 `network` 文件夹里打开 PowerShell（文件夹空白处按住 `Shift` 点右键，选「在终端中打开」），依次运行：

```powershell
git add .
git commit -m "说明这次改了什么"
git push
```

| 命令 | 作用 | 类比 |
|---|---|---|
| `git add .` | 把所有修改放进待提交区 | 把文件放进待寄出的箱子 |
| `git commit -m "..."` | 保存为一个版本，附上说明 | 封箱并写上说明 |
| `git push` | 上传到 GitHub | 寄到 GitHub |

推送后约 1 分钟网站自动更新。可运行 `gh run list --limit 3` 查看部署状态，显示 `completed success` 即完成。浏览器看到的还是旧内容时，按 `Ctrl + F5` 强制刷新。

### 常见修改在哪里改

| 想改的内容 | 文件 |
|---|---|
| 姓名、一句话介绍、邮箱、LinkedIn、简历 PDF | `assets/profile.json`（字段留空 `""` 则网页上不显示） |
| 主页的其他文字（中 / 英） | `assets/i18n/zh.json`、`assets/i18n/en.json` |
| 项目页的文字（中 / 英） | `odor-predictor/i18n/`、`flavor-improver/i18n/`、`flavor-kb/i18n/` 下的 `zh.json`、`en.json` |
| 网站样式（颜色、字号等） | `assets/style.css` |
| 气味标签的中文译名 | `training/label_translations.csv`，改完运行下文的 `make_site_assets.py` |

**简历 PDF**：中文 `assets/cv-zh.pdf`、英文 `assets/cv-en.pdf`，写在 `assets/profile.json` 的 `cv_pdf_lang`（`zh` / `en` 两项）。主页的简历链接和简历页的下载按钮按当前语言取对应文件，切换语言时跟着变。`assets/cv.pdf` 是两份合并（中文在前），写在 `cv_pdf`，只为旧链接保留。更新简历时：用 Word 导出两份 PDF，覆盖 `cv-zh.pdf`、`cv-en.pdf`，重新合并 `cv.pdf`（例如 `training/.venv` 里的 pymupdf：`fitz.open()` 后依次 `insert_pdf`），再把 `profile.json` 里三个地址的 `?v=` 改成新值。Word 原件和根目录导出的 PDF 已加入 `.gitignore`，不上传。

**语言参数 `?lang=`**：任何页面加 `?lang=en` 或 `?lang=zh` 直接以该语言打开（也会记住这个选择）；点页眉的中 / EN 切换时，地址栏的 `lang` 参数跟着更新（`history.replaceState`，保留其他参数和 `#` 锚点），所以复制当前地址分享出去是同一种语言。逻辑在 `assets/i18n.js` 的 `urlLang`、`syncUrl`；页面脚本自己改地址时用 `I18N.keepLang(qs)` 保留 `lang`。

**不断行的术语**：GC-MS、GC-O-MS、GC×GC-TOFMS、HS-SPME、LC-MS 等带连字符的术语不在连字符处换行。`assets/i18n.js` 的 `NOBR_RE` 列出这些写法，`I18N.apply` 之后把匹配的文字包进 `span.nobr`；脚本自己画出的文字调用 `I18N.nobr(元素)`；`tools/prerender.py` 的 `NOBR_RE` 是同一份列表（静态中文页面），两处要一起改。

**孤字换行**：段落最后一行不能只剩 1 到 2 个字（如“似。”）或一个英文单词。`assets/style.css` 给正文段落、列表项、图注和研究页旁白加了 `text-wrap: pretty`，标题加了 `text-wrap: balance`；剩下的由 `assets/i18n.js` 的 `NOBR_END` 处理：其中的词只在文字末尾（后面只有标点）时包进 `span.nobr`，文字不变（`tools/prerender.py` 直接读这份列表；研究页旁白在 `research.js` 的 `setLine` 里调用 `I18N.nobr`；页面脚本写出的文字要调用 `I18N.nobr(元素)`）。改了文字后运行 `python tools/check_orphans.py`（需要 `pip install playwright`，使用本机 Chrome）：375、768、1280 三种宽度、中英文打开全站每个页面，研究页两段动画逐步播放，列出孤字（页面、宽度、语言、元素、整句）；出现新的孤字就把句末的词加进 `NOBR_END`，再运行 `prerender.py`。已知保留 6 处：化合物名清单（`#excluded-list`）的最后一项是一个长化学名，与前一项连在一起在手机上会超出屏幕；SMILES 字符串（`#mol-smiles`）不是单词，按字符断行。

**试用示例**：GC-MS 风味解读和乳品风味改良（贝叶斯优化模式）页面顶部有「试用示例」框，点一下就载入示例并跑出结果，然后滚动到结果处（GC-MS 停在风味轮廓，乳品风味改良可选「直接看结果」或「播放优化过程」）。原料与替代物检索点示例后滚到结果；气味地图搜索框下有「示例：高亮黄油中的关键风味物质」；风味知识库搜索只有一个匹配时直接打开卡片。上传自己数据的流程不变。

**页眉遮挡与锚点**：页眉固定在顶部，`assets/style.css` 的 `html { scroll-padding-top: 72px }` 让所有锚点跳转（方法页目录、`research/#master` 等）停在页眉下方。页面里不要再给标题另加 `scroll-margin-top`，否则偏移会叠加。

**主页缩略图**：主页工具列表左侧的小图（96×64，手机上 64×43）在 `assets/thumbs/small/`，是在线工具目录页大截图 `assets/thumbs/<工具>.webp`（600×450）中裁出的一块。重新截了大图后运行 `python tools/make_thumbs_small.py`（裁切位置在脚本的 `BOXES` 里，大图布局变了要核对）。主页加内容前注意总高度：1280×800 窗口下要在三屏（2400 px）以内，英文版目前约 2345 px。

**研究概览**（`research/`）：两部分，博士课题四步、硕士课题三步（锚点 `#master`），各自一个动画舞台，互不影响；每步的「重播」只重放当前这一步。博士第 1、2 步共用三种聚类颜色（`research.js` 的 `CL`）。主页简介里「我的博士课题是关于母乳风味的研究」链接到这里，「硕士是牛油渣的美拉德反应」链接到 `research/#master`（`assets/profile.json` 的 `bio_link` 是一个列表，每项的文字必须是 `bio` 原文的一部分，`href` 是链接地址），简历页科研经历的博士、硕士课题下也各有链接。字幕、短句和画面标签在 `research/i18n/*.json`，改了要跑 `python tools/prerender.py`。画面全是示意数据。

**主页留言**：主页最下方的「留言」表单用 [Web3Forms](https://web3forms.com) 发到邮箱 785010405@qq.com（接收邮箱在 Web3Forms 后台设置，不在代码里）。access key 写在 `index.html` 表单的隐藏字段 `access_key` 里（这个 key 按设计可以公开，只能用来往这个邮箱发信）；提交逻辑在 `assets/home.js`，文字在 `assets/i18n/*.json` 的 `home.msg*` 键。免费版每月 250 条。只有访客点「发送」时才会请求 api.web3forms.com，页面加载时不发任何外部请求；主页的内容安全策略（`index.html` 的 `Content-Security-Policy`）只放行这一个外部地址，其他页面不受影响。表单默认折叠，点「写留言」才展开（保持主页在三屏以内）。

**注意**：网页文字中不使用破折号（——）；联系方式只放邮箱，不放手机号。

### 改完文字后：重新生成静态页面

每个页面的 HTML 里已经写好了中文全文（访客打开时第一眼就是完整页面，不再先空白或先英文再跳动；不执行脚本也能读到中文）。英文仍由浏览器里的 `assets/i18n.js` 切换。所以改了下面任何一项之后，要运行一次生成脚本，再提交：

- 任何 `i18n/zh.json`（全站或项目页）、`assets/profile.json`
- 页面 HTML 里带 `data-i18n` 的元素、章节标题（`data-sec`）或 `<title>` / `description`
- `assets/projects.js` 里的项目顺序或列表格式

```powershell
python tools/prerender.py           # 重写页面中的静态中文、编号、标题、分享标签和 sitemap.xml
python tools/prerender.py --check   # 只检查：有页面没更新时列出并返回错误
```

有些内容由页面脚本按数据画出（带 `data-snap` 的元素，例如气味地图方法页的数字、气味预测和味觉预测的第一张结构图）。改了这些数据或脚本后，先运行 `python tools/snapshot.py`（需要本机的 Chrome），再运行 `python tools/prerender.py`。

脚本只改上面这些部分，页面里的其他内容保持不变。分享预览图（`assets/og/`）和主屏幕图标（`apple-touch-icon.png`）由 `python tools/make_og.py` 生成（需要本机的 Chrome），项目页面样子有较大变化时再运行。


### 上传前先在本地预览

不要直接双击 HTML 文件：浏览器出于安全限制，不允许 `file://` 页面读取 JSON 和模型文件。在 `network` 文件夹运行：

```powershell
python -m http.server 8000
```

然后在浏览器打开 http://localhost:8000 ，看完在 PowerShell 按 `Ctrl + C` 关闭。

---

## 仓库结构

```
index.html              个人主页
404.html                地址不存在时显示的页面（GitHub Pages 自动使用）
robots.txt, sitemap.xml 搜索引擎用；sitemap.xml 由 tools/prerender.py 生成
tools/                  prerender.py（写入静态中文与分享标签）、snapshot.py（记录脚本按数据画出的内容）、make_og.py（分享图与图标）、make_thumbs_small.py（主页小缩略图）、make_font.py（标题字体）
assets/                 全站共用：样式、中英切换、个人信息、原子贡献绘图（contrib.js）
  vendor/               本站托管的第三方库（RDKit、ONNX Runtime、Chart.js、d3、SheetJS），版本、许可证与校验值见其中 README.md
  libs.js               按需加载 RDKit / ONNX Runtime / Chart.js（首次用到时才下载）
  fonts/                标题字体子集（由 tools/make_font.py 生成）
odor-predictor/         3 气味预测
  index.html, app.js    页面与交互逻辑
  i18n/                 页面中英文案
  model/                odor_mpnn.onnx、labels.json、feature_spec.json（model_type: mpnn）
  data/                 presets.json（预设分子预测）、metrics.json（评估结果）
  engine.js             浏览器端特征提取 + ONNX 推理（按 spec.model_type：mpnn 须与 training/featurize_mpnn.py 一致，GCN 路径供味觉预测）
  tests/                一致性测试页 parity.html、features-all.html 及测试数据
flavor-improver/        4 乳品风味改良
  index.html, app.js    页面与交互逻辑
  mixture.js, bo.js     浏览器端评价函数（须与 training/flavor_improver/mixture.py 一致）与贝叶斯优化
  reference.js          配方奶粉对比母乳：参照食品模式（差距分析、前体方向）
  data/                 palette、bases、presets、mixture_spec、bo_traces、bo_metrics、reference（配方奶粉对比母乳）、precursors（前体对照表）
  tests/                parity.html（一致性）、bo_check.html（浏览器版算法表现）
flavor-kb/              7 风味知识库与法规查询（regulatory.html 为法规查询页）
taste-predictor/        6 味觉预测（GCN，结构同上一版 odor-predictor；engine.js 在气味引擎上加中和步骤）
odor-map/               5 气味地图（data/：coords.bin、map.json、foods.json；分子数据读 ingredient-finder/data/）
research/               研究概览（博士课题四步 + 硕士课题三步动画，不是在线工具，不参与编号）：research.js 用固定种子生成示意数据并播放动画（不读论文或样本数据），文字在 i18n/；严格 CSP，不发外部请求
training/               训练代码（原始数据不上传）
  flavor_improver/      乳品风味改良的数据准备、贝叶斯优化实验与分析
  taste/                味觉预测的数据处理、训练、导出
  odormap/              气味地图的 UMAP、评估和站点数据
```

## 重新训练模型

```powershell
cd training
.\.venv\Scripts\Activate.ps1
python download_data.py     # 下载 GS-LF 数据到 training/data/（不上传）
python clean_data.py        # 清洗、去重、过滤
python split.py             # 骨架 / 随机混合划分（80/10/10）
python baseline.py          # Morgan 指纹 + 逻辑回归 / 随机森林
python train_mpnn.py pilot  # 计时试跑（只看验证集）
python train_mpnn.py grid   # 12 组超参数 × 3 个种子，只看验证集（约 1 小时，GPU）
python train_mpnn.py final  # 选定组合重训 3 个种子（存训练过程检查点）+ 去掉键特征的对照 + 测试集只算一次
python export_onnx_mpnn.py --site   # 导出 odor_mpnn.onnx 和 feature_spec.json 并验证与 PyTorch 一致
python mpnn_to_site.py      # 把结果写入 odor-predictor/data/metrics.json（只运行一次）
python make_site_assets.py  # 生成 labels.json、presets.json（含原子贡献）、一致性测试数据
python make_feature_parity.py   # 全部分子的特征参考数据（tests/features-all.html）
# 之后按顺序重新生成下游：原料检索与气味地图（见第 5 节）、gcms/build_flavor.py、
# 乳品风味改良（prepare_data.py --final、prepare_reference.py、mixture.py、run_experiments.py、analyze.py、
# make_parity_fixtures.py）、混合物实验（mixture/snitz_data.py、evaluate.py）。下游脚本都通过
# training/site_model.py 调用 feature_spec.json 指定的线上模型。
# 上一版 GCN：python train.py / export_onnx.py（保留作记录，不再写入网站）

# 可选：PharmaGNN 思路的消融实验（约 15 分钟，GPU）
python ablation.py          # 4 组设置 × 3 个种子，写出 ablation_results.json
python ablation_to_site.py  # 把摘要写入 odor-predictor/data/metrics.json
```

新电脑上先建环境：`python -m venv .venv`，然后按 `requirements.txt` 顶部的说明安装 PyTorch（RTX 50 系显卡需 CUDA 12.8 及以上版本）和其他依赖。

## 当前结果（测试集 macro AUROC）

| 模型 | 全部 | 含环 | 无环 |
|---|---|---|---|
| GNN：消息传递网络（部署模型 seed 2；3 个种子均值 0.866 ± 0.002） | 0.869 | 0.813 | 0.874 |
| 上一版 GCN（3 个种子均值） | 0.860 | 0.800 | 0.864 |
| Morgan 指纹 + 随机森林 | 0.841 | 0.781 | 0.816 |
| Morgan 指纹 + 逻辑回归 | 0.837 | 0.779 | 0.814 |

无环分子采用随机划分，分数可能因同系物泄漏而偏乐观。

## 数据与引用

- The Good Scents Company；Leffingwell & Associates（Sanchez-Lengeling et al., 2019, arXiv:1910.10685，CC BY-NC，仅限非商业用途）
- 合并清洗数据集：OpenPOM（Barsainyan et al., 2023），https://github.com/BioMachineLearning/openpom
- Lee et al., A principal odor map unifies diverse tasks in human olfactory perception, *Science* 381, 999-1006 (2023)

- 气相强度曲线：Wakayama H, Sakasai M, Yoshikawa K, Inoue M. Method for Predicting Odor Intensity of Perfumery Raw Materials Using Dose-Response Curve Database. *Ind. Eng. Chem. Res.* 2019, 58(32), 15036-15044, doi:10.1021/acs.iecr.9b01225

原始数据不在本仓库中转载。

## 后续迭代清单

- 模型：与 OpenPOM 结果对比（键类型特征与 MPNN 已于 2026-11-18 完成）
- 展示：气味空间二维可视化（UMAP），可点击浏览分子
- 领域：加入乳品风味相关分子子集分析
- 主页：完整个人主页（教育经历、论文、专利、其他项目）
- 训练数据：原始数据中有记为混合物的条目（如羟基香茅醛 + 吲哚、吡嗪异构体混合物、甘油酯类），清洗时取了最大片段并合并标签，标签描述的是混合物；后续应在清洗阶段排除这类条目并重新训练（2026-10-18 已从 ingredient-finder / odor-map 候选库中移除只来自混合物的 11 个分子，模型未重新训练）
- 味觉预测：纳入多肽（苦味肽、鲜味肽、kokumi 肽，需要适合长链的表示方法）；加入手性特征以区分 D/L 氨基酸和糖的异构体；补充酸、咸数据后再建模；对单一来源的可疑标签做人工复核（如丁酸、香兰素被记为甜）；预测强度或阈值（需要定量数据）
- 乳品风味改良（原网页「局限」末尾「后续可能的改进」移到这里）：前体物质推荐（基于反应路径知识，「前体 → 风味物质 → 反应类型」对照表，作为规则查询）；更好的混合物模型；引入掩蔽效应（参考混合物模型，或用 Snitz 2013、Ravia 2020 等公开数据校准，需核实许可）；加入成本、法规限量、溶解度约束做多目标优化；人在回路模式（用户为方案打分，替代虚拟评价函数）；自定义基底和改良方向
