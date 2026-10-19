# Jingwei Cui 个人网站 + 分子气味预测（GNN）

- 个人主页：https://redamancy564.github.io/
- 项目目录：https://redamancy564.github.io/projects/

项目编号与网站一致（顺序定义在 `assets/projects.js`）：

1. GC-MS 风味解读：https://redamancy564.github.io/gcms-interpreter/
2. 风味原料检索：https://redamancy564.github.io/ingredient-finder/
3. 气味预测：https://redamancy564.github.io/odor-predictor/
4. 风味改良（贝叶斯优化）：https://redamancy564.github.io/flavor-improver/
5. 气味空间地图：https://redamancy564.github.io/odor-map/
6. 味觉预测：https://redamancy564.github.io/taste-predictor/
7. 气味感知差异：https://redamancy564.github.io/perception-diversity/
8. 风味知识库：https://redamancy564.github.io/flavor-kb/

## 风味知识库（flavor-kb/）

三级数据，网页上用颜色标签区分：

| 级别 | 来源 | 说明 |
|---|---|---|
| 第一级·关键香气物质（深绿） | Dunkel et al., Angew. Chem. Int. Ed. 2014, 53, 7124（doi:10.1002/anie.201309508） | 只摘录正文中明确写出的食品与关键香气物质，附页码，见 `training/knowledge/dunkel2014_main_text.json`。完整对照在补充材料中，未收录 |
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

## 4 风味改良（flavor-improver/）

方法框架演示：选择一种乳制品基底和改良方向，用贝叶斯优化搜索「添加哪些风味物质、加多少」。评价函数是虚拟的（OAV → log 强度 → 描述词「提升度」向量加和 → 与目标轮廓的余弦相似度，减去种数和用量惩罚），不含掩蔽、协同、基质效应。

- **数据**：18 种候选添加物 + 基底物质，阈值取自 van Gemert 2011（固定规则：Czerny 2008 > Buttery > Karagül-Yüceer），基底浓度来自 3 篇定量文献（出处见网页页脚和 `flavor-improver/data/bases.json`）。单分子气味向量来自 3 气味预测的模型。
- **参数**：K = 5，λ₁ = 0.05，λ₂ = 0.002，α = 0.1，添加量为阈值的 0.01 至 100 倍（`flavor-improver/data/mixture_spec.json`）。λ₂ 和上限的调整过程记录在 `training/flavor_improver/mixture.py` 注释和网页「结果」部分。
- **网页**：默认阈值下播放预计算的优化过程（Python / BoTorch）；访客修改阈值后，可在浏览器中重新运行简化版贝叶斯优化（`bo.js`）。
- **一致性测试**：https://redamancy564.github.io/flavor-improver/tests/parity.html ，检查 `mixture.js` 与 Python 的混合规则、目标函数完全一致。浏览器版算法的表现见 `tests/bo_check.html`（运行约需几十秒）。**修改 `mixture.py` 或数据后，必须重新生成测试数据并确认全部 PASS。**

**配方奶粉对比母乳：婴儿配方奶粉与母乳的风味差距分析（参照食品模式）**：数据来自 Zhang et al. 2022（*Food Chem* 382:132348，表 2、表 3，录入后已与 PDF 逐格核对），奶粉浓度按奶粉计并除以 8 换算为冲调后；两侧都以论文中的单个样本为起点，访客可修改浓度、增删物质。只分析 OAV ≥ 10（可选 ≥ 5）的关键香气物质，输出轮廓对比、差距排序和前体方向（`flavor-improver/reference.js`），不给出添加量；另有标明“仅为方法演示、不适用于婴儿配方食品”的添加量模拟。前体对照表在 `flavor-improver/data/precursors.json`，每行注明文献位置；GB 10765-2021 的条款内容须对照官方原文核实。
```powershell
cd training
.\.venv\Scripts\Activate.ps1
pip install pymupdf                                                    # 仅提取 PDF 文本时需要
python flavor_improver/extract_vangemert.py "<van Gemert PDF>" vg.txt  # 提取阈值汇编文本（PDF 有版权，不上传）
python flavor_improver/prepare_reference.py vg.txt --final             # 生成 flavor-improver/data/reference.json
python flavor_improver/make_parity_fixtures.py                         # 更新一致性测试数据（含配方奶粉对比母乳）
```

**用自己的数据（2026-10-18）**：在 GC-MS 风味解读中分别处理当前样品和目标样品，点「作为当前样品发送 / 作为目标发送」（`assets/flavor-handoff.js`，浏览器本地存储，不上传），或上传其导出的排名 CSV（也接受自己整理的 CSV：物质名称列 + 浓度、相对含量 / 峰面积、OAV 或 ROAV 中至少一列，列名中英文均可，单位写在列名里；页面上有「上传 CSV 的要求」和模板 `flavor-improver/examples/userdata_template.csv`）；在风味改良页面选「我的 GC-MS 数据」（或打开 `flavor-improver/?mode=user`）。页面按化合物合并两边（阈值可改），两边都定量时按 OAV 比较，否则按 ROAV（贡献占比）；轮廓维度默认母乳 / 奶粉 12 维，可切换；「一方较高」的标准默认 2 倍 / 2 个百分点，可在设置窗口调整；只推荐添加哪些物质（OAV 模式按补到目标水平后的轮廓相似度排序），不给添加量。不在风味知识库中的物质可提供 SMILES（或点击后从 PubChem 按 CAS / 名称查询）由 odor-predictor 模型在浏览器中预测气味。页面有内容安全策略（脚本只来自本站、cdnjs、jsdelivr；数据只能发往本站、jsdelivr 和用户点击时的 PubChem）。逻辑在 `userdata-core.js`，单元测试 `flavor-improver/tests/userdata.html`；示例数据 `flavor-improver/examples/` 由 `training/flavor_improver/make_userdata_examples.py` 从「配方奶粉对比母乳」的已发表数据生成。

**尝试过的改进：混合物气味相似度模型（2026-10-18，未采用）**：借鉴 Satarifard et al., *PNAS* 2026（doi:10.1073/pnas.2611057123），想用一个比较两个混合物的小模型替换参照食品模式的加和规则。DREAM 挑战赛整理的数据没有开放许可（Synapse 条款禁止用于其他目的），只用了 Snitz et al. 2013（*PLoS Comput Biol*，CC BY 4.0）的相似度评分。按混合物分组：实验 2、3 共 165 对训练和交叉验证，实验 1 的 141 对不重叠比较作测试集（只算一次；实验 1 的 11 号混合物在补充表中组成被截断，已去掉）。测试集 Pearson / Spearman：新模型（GNN 预测概率幂平均 + 138 维权重的角距离）0.537 / 0.516，Snitz 21 描述符角距离 0.504 / 0.563，现用加和规则（12 维）0.315 / 0.382，138 维加和 0.449 / 0.553；与各基线的 Pearson 差值置信区间都包含 0，未达到替换条件，评价函数不变，只在网页「局限」部分报告。
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
python flavor_improver/analyze.py               # 生成 bo_metrics.json、bo_traces.json
python flavor_improver/make_parity_fixtures.py  # 生成一致性测试数据
```

## 分子气味预测（odor-predictor/）

用图神经网络（GNN）从分子结构预测风味分子的气味描述词。模型导出为 ONNX，网页为纯 HTML/CSS/JS，托管在 GitHub Pages，不需要服务器。

- **搜索任意分子**：输入英文名称、CAS 号或 SMILES。名称和 CAS 号通过 PubChem 转为结构，然后在访客的浏览器中实时计算特征并运行模型。网址可带参数直接分享，例如 `odor-predictor/?q=linalool`。
- **原子贡献高亮（遮挡法）**：依次删去每个原子重新预测，概率变化即该原子的贡献，橙色为提高、蓝色为降低（`training/occlusion.py`；浏览器端 `OdorEngine.occlusion`；绘图与图例在共用的 `assets/contrib.js`）。预设分子在 Python 中预计算，搜索的分子在浏览器中现场计算。页面注明高亮只反映模型的判断依据，不代表构效因果。
- **一致性测试**：https://redamancy564.github.io/odor-predictor/tests/parity.html ，检查浏览器端（`odor-predictor/engine.js`）的特征和预测与 Python 完全一致（50 个随机测试分子 + 10 个预设分子 + 15 个边界结构），以及 20 个分子的原子贡献。**修改特征或重新训练后，必须先打开这个页面确认全部 PASS 再上线。**
- **尝试过的改进（未采用，2026-10-17）**：参考 PharmaGNN（Liu et al., J Sci Food Agric 106, 8114-8120, 2026, doi:10.1002/jsfa.70826），在同一骨架划分上做消融：非对称损失、原子药效团标记（供体 / 受体 / 疏水，RDKit BaseFeatures 定义，冻结在 `training/pharmacophore_smarts.json`）及两者组合。测试集 macro AUROC：原模型 0.860 ± 0.0003，ASL 0.8615 ± 0.0029，药效团 0.8606 ± 0.0017，两者 0.8595 ± 0.0013；稀有标签未改善，未达到事先约定的替换条件（提升 ≥ 0.005、3 个种子都更好、稀有标签不下降），线上模型不变。详见 `training/ablation_results.json`。
- **气味阈值**：仅 10 个预设分子显示水中阈值文献值（van Gemert 2011 汇编；数据在 `training/odor_thresholds.json`）。该书有版权，PDF 已加入 `.gitignore`，不会上传。

## 味觉预测（taste-predictor/）

沿用气味预测的 GNN 结构、原子特征和 ONNX 流程，预测小分子的甜、苦、鲜、无味四类（多标签，各一个概率）。酸、咸样本太少，不建模；数据中记载为酸或咸的预设分子在页面上单独提示。

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

## 气味空间地图（odor-map/）

把风味原料检索的候选库（5,072 个有机分子）用 UMAP 降到二维：气味地图按 GNN 的 138 维预测概率排列（余弦距离，邻居数 30，最小距离 0.3），结构地图按 Morgan 指纹排列（Jaccard 距离，15，0.1），随机种子 42。参数各取验证集上最好的一组（3 组中选），测试集定稿后只算一次。

- **页面**：Canvas 2D 绘图，d3-zoom 缩放拖动，d3-quadtree 悬停查找（jsdelivr 固定版本）；两张地图平滑切换；按主要预测描述词或单个描述词的概率着色；自动区域标签；点击打开详情卡片（跳转气味预测、找替代原料、风味知识库）；搜索；食品高亮（Dunkel 2014 的 16 种食品为关键香气物质，其余 FlavorDB 食品为检出物质）。分子、名称和预测概率直接读取 `ingredient-finder/data/`，不重复存储。
- **链接参数**：`?smiles=`、`?food=` / `?food2=`（知识库食品 id）、`?map=structure`、`?colour=<描述词 id>`。
- **测试集结果**（486 个分子，二维地图上最近 15 个有标签邻居）：至少一个真实标签相同的比例，气味地图 0.752、结构地图 0.647、随机 0.387；平均 Jaccard 0.192 / 0.156 / 0.059；差值 95% 置信区间不含 0。

**重新生成：**
```powershell
cd training
.\.venv\Scripts\Activate.ps1
python ingredient/build_library.py   # 候选库（含非风味分子的排除规则）
python odormap/umap_compare.py      # 第 1 阶段：3 组参数对比（效果图和验证集指标）
python odormap/build_maps.py        # 定稿地图 + 评估（测试集只算一次）
python odormap/make_site_data.py    # odor-map/data/：坐标、区域标签、食品列表
```

## 气味感知的个体差异（perception-diversity/）

用 Keller & Vosshall 2016（BMC Neuroscience 17:55，数据 CC0）中 55 人对 480 个分子（每个两个浓度）的嗅觉评价，回答「同一个气味，为什么每个人感受不同」。人口学信息在导入时丢弃，受试者随机重新编码为 P01 到 P55。

- **数据处理**：CAS 校验位、CAS / CID / 名称三方比对（二对一纠正；发现原表 1 个 CID 指向错误结构），浓度和量表标准化，描述词映射（词义相同且数据相关 ≥ 0.3 才映射），每人的重测一致性和打分习惯；问题只标记不删除，处理日志在 `perception-diversity/data/processing_log.json`。
- **差异来源**（矩估计，噪音用重复测试估计，置信区间用分组刀切法）：愉悦度中可重复的差异 58% 来自个人口味，强度只有 18%；各种剔除规则下结论不变。
- **个性化预测**：群体模型可以预测平均评分；但只给 5 个评分时，除整体偏移外学不到个人偏好。
- **分群**：按预先规定的标准（轮廓系数高于对照，且折半稳定性 ARI ≥ 0.5）没有可靠的群体；唯一可重复的个人差异方向主要反映对浓烈气味的接受度。

**重新生成：**
```powershell
cd training
.\.venv\Scripts\Activate.ps1
# 原始数据：论文附件 1（12868_2016_287_MOESM1_ESM.xlsx）放到 training/data/perception/raw/keller2016_S1.xlsx
python perception/prepare.py         # 标签标准化与质量检查（PubChem 查询有缓存）
python perception/variance.py        # 差异来源分解（约 20 秒）
python perception/predict.py         # 个性化预测（约 20 分钟）
python perception/cluster.py         # 分群与连续维度（约 5 分钟）
python perception/make_site_data.py  # perception-diversity/data/site.json
```

---

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

**添加简历 PDF**：把文件放到 `assets/cv.pdf`，再在 `assets/profile.json` 里写 `"cv_pdf": "assets/cv.pdf"`。

**注意**：网页文字中不使用破折号（——）；联系方式只放邮箱，不放手机号。

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
assets/                 全站共用：样式、中英切换、个人信息、原子贡献绘图（contrib.js）
odor-predictor/         3 气味预测
  index.html, app.js    页面与交互逻辑
  i18n/                 页面中英文案
  model/                odor_gnn.onnx、labels.json、feature_spec.json
  data/                 presets.json（预设分子预测）、metrics.json（评估结果）
  engine.js             浏览器端特征提取 + ONNX 推理（须与 training/featurize.py 一致）
  tests/                一致性测试页 parity.html 及测试数据
flavor-improver/        4 风味改良
  index.html, app.js    页面与交互逻辑
  mixture.js, bo.js     浏览器端评价函数（须与 training/flavor_improver/mixture.py 一致）与贝叶斯优化
  reference.js          配方奶粉对比母乳：参照食品模式（差距分析、前体方向）
  data/                 palette、bases、presets、mixture_spec、bo_traces、bo_metrics、reference（配方奶粉对比母乳）、precursors（前体对照表）
  tests/                parity.html（一致性）、bo_check.html（浏览器版算法表现）
flavor-kb/              风味知识库
taste-predictor/        味觉预测（结构同 odor-predictor；engine.js 在气味引擎上加中和步骤）
odor-map/               气味空间地图（data/：coords.bin、map.json、foods.json；分子数据读 ingredient-finder/data/）
perception-diversity/   气味感知的个体差异（data/：site.json、映射表、质量检查、处理日志）
training/               训练代码（原始数据不上传）
  flavor_improver/      风味改良的数据准备、贝叶斯优化实验与分析
  taste/                味觉预测的数据处理、训练、导出
  odormap/              气味空间地图的 UMAP、评估和站点数据
  perception/           个体差异项目：标准化与质量检查、差异分解、预测、分群
```

## 重新训练模型

```powershell
cd training
.\.venv\Scripts\Activate.ps1
python download_data.py     # 下载 GS-LF 数据到 training/data/（不上传）
python clean_data.py        # 清洗、去重、过滤
python split.py             # 骨架 / 随机混合划分（80/10/10）
python baseline.py          # Morgan 指纹 + 逻辑回归 / 随机森林
python train.py             # GNN，3 个随机种子
python export_onnx.py       # 导出 ONNX 并验证与 PyTorch 一致
python make_site_assets.py  # 生成 labels.json、presets.json（含原子贡献）、一致性测试数据

# 可选：PharmaGNN 思路的消融实验（约 15 分钟，GPU）
python ablation.py          # 4 组设置 × 3 个种子，写出 ablation_results.json
python ablation_to_site.py  # 把摘要写入 odor-predictor/data/metrics.json
```

新电脑上先建环境：`python -m venv .venv`，然后按 `requirements.txt` 顶部的说明安装 PyTorch（RTX 50 系显卡需 CUDA 12.8 及以上版本）和其他依赖。

## 当前结果（测试集 macro AUROC）

| 模型 | 全部 | 含环 | 无环 |
|---|---|---|---|
| GNN（部署模型；3 个种子均值 0.860 ± 0.0003） | 0.860 | 0.799 | 0.862 |
| Morgan 指纹 + 随机森林 | 0.841 | 0.781 | 0.816 |
| Morgan 指纹 + 逻辑回归 | 0.837 | 0.779 | 0.814 |

无环分子采用随机划分，分数可能因同系物泄漏而偏乐观。

## 数据与引用

- The Good Scents Company；Leffingwell & Associates（Sanchez-Lengeling et al., 2019, arXiv:1910.10685，CC BY-NC，仅限非商业用途）
- 合并清洗数据集：OpenPOM（Barsainyan et al., 2023），https://github.com/BioMachineLearning/openpom
- Lee et al., A principal odor map unifies diverse tasks in human olfactory perception, *Science* 381, 999-1006 (2023)

- 人类嗅觉评价：Keller A, Vosshall LB. Olfactory perception of chemically diverse molecules. *BMC Neuroscience* 17, 55 (2016)，doi:10.1186/s12868-016-0287-2（数据 CC0）

原始数据不在本仓库中转载。

## 后续迭代清单

- 模型：加入键类型特征；改用更强的 GNN（如 MPNN）；与 OpenPOM 结果对比
- 展示：气味空间二维可视化（UMAP），可点击浏览分子
- 领域：加入乳品风味相关分子子集分析
- 主页：完整个人主页（教育经历、论文、专利、其他项目）
- 训练数据：原始数据中有记为混合物的条目（如羟基香茅醛 + 吲哚、吡嗪异构体混合物、甘油酯类），清洗时取了最大片段并合并标签，标签描述的是混合物；后续应在清洗阶段排除这类条目并重新训练（2026-10-18 已从 ingredient-finder / odor-map 候选库中移除只来自混合物的 11 个分子，模型未重新训练）
- 味觉预测：纳入多肽（苦味肽、鲜味肽、kokumi 肽，需要适合长链的表示方法）；加入手性特征以区分 D/L 氨基酸和糖的异构体；补充酸、咸数据后再建模；对单一来源的可疑标签做人工复核（如丁酸、香兰素被记为甜）；预测强度或阈值（需要定量数据）
- 风味改良（原网页「局限」末尾「后续可能的改进」移到这里）：前体物质推荐（基于反应路径知识，「前体 → 风味物质 → 反应类型」对照表，作为规则查询）；更好的混合物模型；引入掩蔽效应（参考混合物模型，或用 Snitz 2013、Ravia 2020 等公开数据校准，需核实许可）；加入成本、法规限量、溶解度约束做多目标优化；人在回路模式（用户为方案打分，替代虚拟评价函数）；自定义基底和改良方向
