# Simon Cui 个人网站 + 分子气味预测（GNN）

- 个人主页：https://redamancy564.github.io/
- 项目页：https://redamancy564.github.io/odor-predictor/
- 风味知识库：https://redamancy564.github.io/flavor-kb/

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

用图神经网络（GNN）从分子结构预测风味分子的气味描述词。模型导出为 ONNX，网页为纯 HTML/CSS/JS，托管在 GitHub Pages，不需要服务器。

- **搜索任意分子**：输入英文名称、CAS 号或 SMILES。名称和 CAS 号通过 PubChem 转为结构，然后在访客的浏览器中实时计算特征并运行模型。网址可带参数直接分享，例如 `odor-predictor/?q=linalool`。
- **一致性测试**：https://redamancy564.github.io/odor-predictor/tests/parity.html ，检查浏览器端（`odor-predictor/engine.js`）的特征和预测与 Python 完全一致（50 个随机测试分子 + 10 个预设分子 + 15 个边界结构）。**修改特征或重新训练后，必须先打开这个页面确认全部 PASS 再上线。**
- **气味阈值**：仅 10 个预设分子显示水中阈值文献值（van Gemert 2011 汇编；数据在 `training/odor_thresholds.json`）。该书有版权，PDF 已加入 `.gitignore`，不会上传。

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
| 项目页的文字（中 / 英） | `odor-predictor/i18n/zh.json`、`odor-predictor/i18n/en.json` |
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
assets/                 全站共用：样式、中英切换、个人信息
odor-predictor/         项目页
  index.html, app.js    页面与交互逻辑
  i18n/                 页面中英文案
  model/                odor_gnn.onnx、labels.json、feature_spec.json
  data/                 presets.json（预设分子预测）、metrics.json（评估结果）
  engine.js             浏览器端特征提取 + ONNX 推理（须与 training/featurize.py 一致）
  tests/                一致性测试页 parity.html 及测试数据
training/               训练代码（原始数据不上传）
PLAN.md                 开发计划
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
python make_site_assets.py  # 生成 labels.json、presets.json、一致性测试数据
```

新电脑上先建环境：`python -m venv .venv`，然后按 `requirements.txt` 顶部的说明安装 PyTorch（RTX 50 系显卡需 CUDA 12.8 及以上版本）和其他依赖。

## 当前结果（测试集 macro AUROC）

| 模型 | 全部 | 含环 | 无环 |
|---|---|---|---|
| GNN（部署模型；3 个种子均值 0.860 ± 0.0003） | 0.860 | 0.799 | 0.862 |
| Morgan 指纹 + 随机森林 | 0.841 | 0.781 | 0.816 |
| Morgan 指纹 + 逻辑回归 | 0.837 | 0.779 | 0.814 |

无环分子采用随机划分，分数可能因同系物泄漏而偏乐观，详见 `PLAN.md` 阶段 1 的说明。

## 数据与引用

- The Good Scents Company；Leffingwell & Associates（Sanchez-Lengeling et al., 2019, arXiv:1910.10685，CC BY-NC，仅限非商业用途）
- 合并清洗数据集：OpenPOM（Barsainyan et al., 2023），https://github.com/BioMachineLearning/openpom
- Lee et al., A principal odor map unifies diverse tasks in human olfactory perception, *Science* 381, 999-1006 (2023)

原始数据不在本仓库中转载。

## 后续迭代清单

- 模型：加入键类型特征；改用更强的 GNN（如 MPNN）；与 OpenPOM 结果对比
- 展示：气味空间二维可视化（UMAP），可点击浏览分子
- 领域：加入乳品风味相关分子子集分析
- 主页：完整个人主页（教育经历、论文、专利、其他项目）
