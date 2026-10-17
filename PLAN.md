# 开发计划：分子气味预测（GNN）+ GitHub Pages 个人主页

> 给 Claude Code 的说明：请完整阅读本文件后，按「阶段 0 → 阶段 5」顺序执行。
> 用户是食品风味方向的博士，懂科研和 Python 基础，**不会 Git 和 GitHub**。
> 你需要同时扮演「工程师」和「老师」两个角色。

---

## 0. 给 Claude Code 的工作规则

1. **全程用中文与用户沟通**，代码注释用英文。
2. 每个阶段开始前，用 3 到 5 句话说明「这一阶段要做什么、为什么」。
3. 凡是需要用户本人操作的步骤（注册账号、浏览器登录、点击网页设置），**停下来**，给出编号清晰的操作指引，等用户回复「完成」再继续。
4. 首次出现的术语（仓库、commit、push、ONNX 等）用一句话通俗解释。
5. 每个阶段结束时，运行「验收标准」中的检查并汇报结果。
6. 环境：Windows + PowerShell，NVIDIA RTX 5070 Ti，已安装 Python。
7. 坚持**最小可行方案**：能用简单方法实现的不引入框架；网页不使用构建工具（无 npm、无打包），纯 HTML/CSS/JS + CDN。
8. 实验结果如实报告，不夸大。模型效果不理想时照实写进页面的「局限」部分。

---

## 1. 项目目标

做一个可以放在简历上的在线 demo：

- 访客在网页上选择一个风味分子（或输入 SMILES），网页显示分子结构图和**图神经网络预测的气味描述词及概率**。
- 模型在浏览器中运行，不需要服务器，托管在 GitHub Pages。
- 网站结构：`https://<用户名>.github.io/` 为个人主页（本阶段做简洁版），`https://<用户名>.github.io/odor-predictor/` 为本项目页面。
- 支持中英切换。
- 面向不懂计算机的访客（HR、面试官）：页面语言通俗，有一段「这是什么、为什么有用」的说明。

---

## 2. 技术方案总览

| 环节 | 方案 | 理由 |
|---|---|---|
| 数据 | GoodScents + Leffingwell 合并清洗数据集（约 5,000 分子，约 138 个气味标签，多标签） | 公开、已清洗、学界常用 |
| 分子表征 | RDKit 将 SMILES 转为原子特征矩阵 + 邻接矩阵 | 标准做法 |
| 模型 | 纯 PyTorch 实现的小型 GNN（**稠密邻接矩阵**，不使用 PyTorch Geometric） | 稠密矩阵运算可直接导出 ONNX，浏览器能运行 |
| 对照基线 | Morgan 指纹 + 逻辑回归 / 随机森林 | 证明 GNN 的价值，结果更可信 |
| 评估 | 骨架划分（Murcko scaffold split），指标为 macro AUROC | 比随机划分更诚实 |
| 浏览器推理 | onnxruntime-web（CDN） | 无需服务器 |
| 浏览器分子处理 | RDKit.js（RDKit MinimalLib，CDN） | 解析 SMILES、画结构图、提取原子和键信息 |
| 图表 | Chart.js（CDN） | 简单 |
| 部署 | GitHub Pages，main 分支根目录 | 最简单 |

**关键风险及对策**：浏览器端（JS）的特征提取必须与 Python 端完全一致，否则预测结果会错。
对策：
- 网页**第一版只展示预计算结果**（Python 算好存 JSON），保证一定能跑通。
- 第二版再加浏览器实时推理，并用「一致性测试」验证 JS 与 Python 的特征和输出完全一致（见阶段 3、4）。

---

## 3. 仓库结构

只建**一个**仓库，名字必须是 `<用户名>.github.io`。

```
<用户名>.github.io/
├─ index.html                 # 个人主页（简洁版）
├─ .nojekyll                  # 关闭 GitHub 的 Jekyll 处理
├─ .gitignore
├─ README.md
├─ PLAN.md                    # 本文件
├─ assets/
│  ├─ style.css               # 全站共用样式
│  ├─ i18n.js                 # 中英切换逻辑
│  └─ profile.json            # 个人信息（用户填写）
├─ odor-predictor/
│  ├─ index.html
│  ├─ app.js
│  ├─ i18n/zh.json, en.json   # 本页面文案
│  ├─ model/
│  │  ├─ odor_gnn.onnx
│  │  ├─ labels.json          # 气味标签，含中英文
│  │  └─ feature_spec.json    # 特征定义（元素列表、最大原子数等）
│  ├─ data/
│  │  ├─ presets.json         # 预设分子及预计算结果
│  │  └─ metrics.json         # 模型评估结果
│  └─ tests/parity.html       # 浏览器端一致性测试页
└─ training/
   ├─ requirements.txt
   ├─ data/                   # 原始数据，加入 .gitignore，不上传
   ├─ download_data.py
   ├─ featurize.py
   ├─ split.py
   ├─ baseline.py
   ├─ model.py
   ├─ train.py
   ├─ export_onnx.py
   └─ make_site_assets.py     # 生成 presets.json、metrics.json、一致性测试数据
```

---

## 阶段 0：环境与账号（教学重点）

### 0.1 用户本人操作（Claude Code 给出指引后等待）

1. 注册 GitHub 账号（github.com），建议用户名简洁专业，例如 `simoncui` 一类。**用户名会出现在网址里，之后改名会导致网址变化。**
2. 开启两步验证（GitHub 要求）。
3. 把用户名告诉 Claude Code。

### 0.2 安装工具（Claude Code 可代为执行，执行前说明每条命令的作用）

```powershell
winget install --id Git.Git -e
winget install --id GitHub.cli -e
```
安装后**需要重新打开 PowerShell / 终端**，再检查：
```powershell
git --version
gh --version
```

配置 Git 身份（邮箱用 GitHub 账号邮箱，或 GitHub 提供的 noreply 邮箱以保护隐私）：
```powershell
git config --global user.name "Simon Cui"
git config --global user.email "<邮箱>"
```

### 0.3 登录 GitHub

```powershell
gh auth login
```
选择：GitHub.com → HTTPS → 用浏览器登录。由**用户本人**在浏览器中完成授权。
（用 gh 登录可以避免配置 SSH 密钥，对新手最友好。）

### 0.4 Python 环境

1. 检查 Python 版本：`python --version`。建议 3.11 或 3.12；若版本过新导致 PyTorch 无法安装，引导用户安装 3.12。
2. 在 `training/` 下创建虚拟环境：
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```
若提示脚本执行被禁止，执行：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，并向用户解释这条命令的含义。
3. 安装 PyTorch：**RTX 50 系列（Blackwell 架构）需要 CUDA 12.8 或更新版本的 PyTorch 安装包**。请到 pytorch.org 获取当前对应的安装命令，不要使用旧的 cu118/cu121 版本。
4. 其余依赖：`rdkit pandas numpy scikit-learn onnx onnxruntime tqdm`，写入 `requirements.txt`。

### 0.5 创建仓库并做一次「Hello World」部署

目的：在训练模型之前先打通部署流程，让用户尽早看到自己的网址。

1. `gh repo create <用户名>.github.io --public --clone`
2. 写一个最简单的 `index.html`（显示「Hello, I'm Simon」）和 `.nojekyll`。
3. 用通俗语言讲解并执行：`git add` → `git commit` → `git push`。
   - 类比讲解：add = 把文件放进待寄出的箱子；commit = 封箱并写上说明；push = 寄到 GitHub。
4. 开启 Pages：
```powershell
gh api -X POST repos/<用户名>/<用户名>.github.io/pages -f "source[branch]=main" -f "source[path]=/"
```
若命令失败，引导用户在网页上操作：仓库 → Settings → Pages → Source 选 `Deploy from a branch` → Branch 选 `main`、`/ (root)` → Save。
5. 等待 1 到 3 分钟后访问 `https://<用户名>.github.io`。

### 验收标准
- [ ] `git --version`、`gh auth status` 正常
- [ ] `python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"` 输出 True 和 5070 Ti
- [ ] `python -c "import rdkit; print(rdkit.__version__)"` 正常
- [ ] 浏览器能打开 `https://<用户名>.github.io` 看到 Hello 页面

---

## 阶段 1：数据准备

1. `download_data.py`：下载 GoodScents + Leffingwell 合并清洗数据集。
   - 优先来源：OpenPOM 项目（GitHub: BioMachineLearning/openpom）提供的 curated GS-LF 合并数据集 CSV；备选来源：pyrfume-data 仓库中的 goodscents 与 leffingwell 数据。
   - **请先核实数据的许可协议和引用要求**，向用户汇报。原始数据放在 `training/data/` 并加入 `.gitignore`，**不上传到公开仓库**；网站只发布模型和预测结果。
2. 清洗：用 RDKit 解析 SMILES，去掉无法解析的分子；取最大片段；规范化 SMILES；去重。
3. 过滤：重原子数 > 64 的分子剔除（这是模型的最大原子数，见阶段 2）。去掉阳性样本少于 20 的标签（阈值可调，汇报剩余标签数）。
4. `split.py`：按 Murcko 骨架划分训练 / 验证 / 测试 = 80 / 10 / 10，固定随机种子。
   - **已决定（2026-10-16，用户确认）**：数据中约 45% 为无环分子，其 Murcko 骨架为空。严格划分会让它们全部进入训练集，测试集中就没有链状风味分子。因此采用**混合划分**：有环分子按骨架整组划分；无环分子逐个随机划分（80/10/10）。阶段 2 须分别汇报有环 / 无环测试子集的 AUROC，并在网页「局限」中说明无环部分可能因同系物泄漏而偏乐观。
   - 清洗步骤写在 `clean_data.py`（取最大片段 → 中和电荷 → 规范化 → 去重时标签取并集）。

### 验收标准
- [ ] 汇报：分子总数、标签数、每个标签的阳性数分布（前 10 和后 10）、三个集合的大小
- [ ] 汇报数据许可协议及需要的引用

---

## 阶段 2：模型训练

### 2.1 特征定义（Python 与 JS 必须完全一致，写入 `feature_spec.json`）

为方便在浏览器中复现，**特征保持精简**：

- 原子特征（one-hot 拼接）：
  - 元素：C, N, O, S, F, Cl, Br, I, P, 其他
  - 重原子度数：0 到 5（超出归入 5）
  - 连接的总氢数：0 到 4（超出归入 4）
  - 形式电荷：-1, 0, +1（其他归入 0）
  - 是否芳香：0/1
  - 是否在环中：0/1
- 邻接矩阵：只表示「是否成键」（不区分键类型，MVP 简化），加自环，按度数归一化。
- 最大原子数 `MAX_ATOMS = 64`，不足部分补零，并提供 atom mask。

### 2.2 模型（`model.py`）

- 纯 PyTorch，输入 `X [B, 64, F]`、`A [B, 64, 64]`、`mask [B, 64]`。
- 3 层图卷积（`H = ReLU(A @ H @ W)`），隐藏维度 128，加 dropout。
- 读出层：mask 后的均值池化 + 最大池化拼接 → 2 层 MLP → 每个标签一个 logit。
- 损失：多标签 BCEWithLogits，可对稀有标签加 `pos_weight`。
- **规模保持小**：参数量控制在约 50 万以内，ONNX 文件小于 5 MB。

### 2.3 训练（`train.py`）

- Adam，学习率 1e-3，批大小 64，最多 200 个 epoch，按验证集 macro AUROC 早停。
- 固定随机种子，保存最佳模型。
- 在 5070 Ti 上应在几分钟内完成；若 GPU 出问题，CPU 也能跑完，不要卡在显卡配置上。

### 2.4 基线（`baseline.py`）

- Morgan 指纹（半径 2，2048 位）+ 逻辑回归（One-vs-Rest）。
- 用同一份骨架划分评估。

### 验收标准
- [ ] 测试集 macro AUROC：GNN 与基线并列汇报
- [ ] 汇报表现最好和最差的各 5 个标签
- [ ] 若 GNN 不优于基线，如实汇报，并讨论可能原因，**不要为了好看而修改测试集划分**
- [ ] 结果写入 `odor-predictor/data/metrics.json`

---

## 阶段 3：导出与网站数据生成

1. `export_onnx.py`：导出 ONNX（opset 17），批大小维度动态，原子数固定 64。
   - 用 onnxruntime（Python）验证：同样输入下，ONNX 与 PyTorch 输出差异 < 1e-4。
   - 输出层是否带 sigmoid 要在 `feature_spec.json` 中写明。
2. `labels.json`：每个标签含英文原名和中文译名。
   - 中文译名由 Claude Code 初译，**列出全部标签请用户（风味专业）审核**，因为气味描述词的中文译法有行业习惯。
3. `presets.json`：预设分子及预计算的预测结果（前 8 个标签及概率），以及该分子是否在训练集中、若在则附上真实标签。预设分子（请用 RDKit 校验 SMILES，并与 PubChem 核对名称）：

| 中文名 | 英文名 | SMILES |
|---|---|---|
| 双乙酰 | Diacetyl | `CC(=O)C(C)=O` |
| 乙偶姻 | Acetoin | `CC(O)C(C)=O` |
| 丁酸 | Butyric acid | `CCCC(=O)O` |
| 2-庚酮 | 2-Heptanone | `CCCCCC(C)=O` |
| δ-癸内酯 | delta-Decalactone | `CCCCCC1CCCC(=O)O1` |
| γ-十二内酯 | gamma-Dodecalactone | `CCCCCCCCC1CCC(=O)O1` |
| 香兰素 | Vanillin | `COc1cc(C=O)ccc1O` |
| 甲硫基丙醛 | Methional | `CSCCC=O` |
| 呋喃酮 | Furaneol | `CC1=C(O)C(=O)C(C)O1` |
| 2-乙酰基-1-吡咯啉 | 2-Acetyl-1-pyrroline | `CC(=O)C1=NCCC1` |

4. 一致性测试数据：随机抽 50 个测试集分子，导出 SMILES、Python 计算的特征矩阵、邻接矩阵和模型输出，存为 `odor-predictor/tests/parity_fixtures.json`。

### 验收标准
- [ ] ONNX 与 PyTorch 输出一致
- [ ] 用户已审核标签中文译名
- [ ] presets.json 包含 10 个分子

---

## 阶段 4：网页开发

### 4.1 共用部分
- `assets/i18n.js`：读取 `data-i18n` 属性替换文案；右上角「中 / EN」切换按钮；默认语言按浏览器语言判断；用户选择存入 localStorage（读写包在 try/catch 中）。
- `assets/style.css`：简洁、专业、适配手机（手机宽度下无横向滚动）。
- 不使用 em dash（—）。

### 4.2 个人主页 `index.html`（本阶段为简洁版）
- 姓名：Simon Cui / 崔京伟
- 一句话介绍：Food Science PhD candidate | Flavor Chemistry × Machine Learning（中文版对应翻译）
- 联系方式：邮箱、LinkedIn、简历 PDF 下载。**内容从 `assets/profile.json` 读取，先放占位符，由用户填写**，不要编造任何信息。
- 「项目」区：一张卡片链接到 odor-predictor。
- 页脚注明「本网站持续更新」。

### 4.3 项目页 `odor-predictor/`，分两版

**第一版（必须完成）：预计算结果展示**
1. 顶部：标题 + 一段通俗介绍（面向非专业访客，约 3 句话：气味由分子结构决定；本项目用 AI 从分子结构预测气味；可用于风味研发中的分子初筛）。
2. 交互区：下拉选择预设分子 → 显示分子结构图（RDKit.js 绘制 SVG）+ 前 8 个气味描述词的概率条形图（Chart.js）。若该分子在训练集中，显示提示和真实标签对照。
3. 「方法」区：用一张简单流程图（可用纯 HTML/CSS 或内联 SVG）展示「分子 → 图 → 图神经网络 → 气味标签」。
4. 「结果」区：读取 metrics.json，展示 GNN 与基线的 AUROC 对比。
5. 「局限」区：如实说明。至少包括：预测的是数据库中的描述词，不是气味强度或阈值；训练数据规模有限；不适用于安全性判断。
6. 页脚：数据来源引用、相关文献引用（Lee et al., Science, 2023, Principal Odor Map）、GitHub 代码链接。

**第二版（第一版上线后再做）：浏览器实时推理**
1. 新增 SMILES 输入框（标注「高级」，附 2 个示例）。
2. 流程：RDKit.js 解析 SMILES → 按 `feature_spec.json` 提取特征（可借助 `get_json()` 获取原子、键、芳香性、环信息，注意隐式氢的计算）→ onnxruntime-web 运行模型 → 显示结果。
3. 错误处理：SMILES 无效、原子数超过 64、含不支持元素时给出友好提示。
4. **一致性测试**：`tests/parity.html` 读取 `parity_fixtures.json`，在浏览器中逐个比较 JS 特征与 Python 特征、JS 输出与 Python 输出。**50 个分子全部通过后，才在正式页面启用实时输入。**
5. RDKit.js 的 WASM 文件较大，首次加载时显示加载提示。

### 4.4 本地预览
不要直接双击打开 HTML（浏览器会阻止读取本地 JSON 和模型文件）。在仓库根目录运行：
```powershell
python -m http.server 8000
```
然后访问 `http://localhost:8000`，并向用户解释原因。

### 验收标准
- [ ] 本地预览：主页和项目页都正常，中英切换正常
- [ ] 10 个预设分子都能显示结构图和预测结果
- [ ] 手机宽度（浏览器开发者工具模拟）下排版正常
- [ ] （第二版）一致性测试 50/50 通过，实时输入可用

---

## 阶段 5：部署上线

1. 检查 `.gitignore`：排除 `training/data/`、`.venv/`、`__pycache__/`、模型检查点（`.pt`）。
2. `git add` → `git commit` → `git push`，每一步向用户解释。
3. 等待部署完成：`gh run list --limit 3` 或在仓库 Actions 页面查看。
4. 访问线上地址，逐项检查第 4 阶段的验收标准。
5. 教会用户以后自己更新网站的三条命令：
```powershell
git add .
git commit -m "说明这次改了什么"
git push
```
6. 在 `README.md` 中用中文写一份「如何更新网站」的简短说明，方便用户日后查看。

### 验收标准
- [ ] `https://<用户名>.github.io/` 和 `https://<用户名>.github.io/odor-predictor/` 都能访问
- [ ] 用手机（非开发电脑）访问正常
- [ ] 用户能独立完成一次修改并推送（例如改一句介绍文字）

---

### 用户修改记录（2026-10-16，第一版上线后）
- 「局限」区按用户要求只保留两条：新骨架预测较弱、不可用于安全性判断（删除了用词说明、数据规模、无环划分、立体化学四条）。
- 10 个预设分子增加水中气味阈值文献值（van Gemert 2011；代表值优先取 Czerny et al. 2008，否则 Buttery et al.；另列文献范围），标注「文献值，非模型预测」。原书 PDF 有版权，不上传；任意搜索的分子不显示阈值。
- 第二版完成：搜索任意分子（名称 / CAS 经 PubChem 解析，或 SMILES），浏览器实时推理。一致性测试 75/75 通过（50 随机测试分子 + 10 预设 + 15 边界结构）。

### 风味知识库（2026-10-16，用户确认方案）
- 第一级：Dunkel 2014 只摘录正文明确写出的对应（补充材料未提供，按约定将来只摘录本站出现的物质）；FlavorDB2（CC BY-NC-SA 3.0）作为「检出」数据；不使用 FooDB。
- 所有物质名、食品名用英文；界面文字中英切换。
- 第二、三级只用 Europe PMC 与 Crossref（免费、无需密钥、允许浏览器调用）；OpenAlex 因无密钥时共享 IP 额度并引导申请密钥，不使用。
- flavor-improver 尚未开发，开发时其基底食品直接调用知识库数据。

---

### 味觉预测（2026-10-17，用户确认方案）
- 数据：ChemTastesDB（CC BY 4.0）为主，VirtuousMultiTaste（MIT）为辅；BitterDB（CC BY-NC-ND）不直接使用；SuperSweet 已下线。
- 只建模甜、苦、鲜、无味；酸、咸不建模，页面对数据中记载为酸或咸的预设分子单独提示。
- 剔除 3 个及以上残基的多肽，保留二肽（阿斯巴甜等）；多肽记入后续迭代。
- 冲突取阳性；「非 X」只给该类记阴性，其余为未知，不计入损失。
- 划分沿用混合骨架划分；核苷酸类鲜味分子整组落在测试集，测试集鲜味 AUROC 不可信，如实说明。评估用只训练集的模型，网页模型用全部数据重新训练（方案 A）。
- 局限：只预测类别；酸咸未建模；数据来源偏差（苦味中药物多）；多肽未纳入；不区分立体异构体；不可用于安全性判断。

## 6. 后续迭代清单（本次不做，记录在 README）

- 模型：加入键类型特征；改用更强的 GNN（如 MPNN）；与 OpenPOM 结果对比
- 展示：气味空间二维可视化（UMAP），可点击浏览分子
- 领域：加入乳品风味相关分子子集分析
- 主页：完整个人主页（教育经历、论文、专利、其他项目）

---

## 7. 时间预估

| 阶段 | 预计 |
|---|---|
| 0 环境与账号 + Hello World 上线 | 半天 |
| 1 数据 | 半天 |
| 2 训练 | 半天到 1 天 |
| 3 导出与数据生成 | 半天 |
| 4 网页第一版 + 5 部署 | 1 天 |
| 4 网页第二版（实时推理） | 1 天，可后续再做 |
