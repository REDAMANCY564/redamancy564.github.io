"""One-off page update for PLAN-mixture.md (user chose option 2, 2026-10-18): flavor-improver's
Limitations section reports the mixture-similarity experiment (not adopted). Numbers from
training/data/mixture/eval.json (test set, computed once)."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FI = ROOT / "flavor-improver"
ev = json.loads((ROOT / "training" / "data" / "mixture" / "eval.json").read_text(encoding="utf-8"))
T, CI = ev["test"], ev["test_diff_ci95_pearson"]
f = lambda x: f"{x:.3f}"

rows = [("c", "mix.row.c"), ("a21", "mix.row.a21"), ("a_all", "mix.row.a_all"), ("b12", "mix.row.b12"), ("b138", "mix.row.b138")]
table = "\n".join(
    f'          <tr{" class=\"highlight\"" if k == "c" else ""}><td data-i18n="{key}"></td>'
    f'<td class="num">{f(T[k]["pearson"])}</td><td class="num">{f(T[k]["spearman"])}</td></tr>' for k, key in rows)
block = f'''      <p class="small muted" style="margin-top:12px" data-i18n="limits.future"></p>

      <h3 style="margin-top:22px" data-i18n="mix.title">Tried: a mixture odor similarity model (not adopted)</h3>
      <p class="small" data-i18n-html="mix.why"></p>
      <p class="small" data-i18n-html="mix.how"></p>
      <div class="table-wrap">
        <table>
          <thead><tr><th data-i18n="mix.col.method">Method</th><th class="num">Pearson</th><th class="num">Spearman</th></tr></thead>
          <tbody>
{table}
          </tbody>
        </table>
      </div>
      <p class="small" style="margin-top:8px" data-i18n-html="mix.result"></p>
      <p class="small" data-i18n-html="mix.note"></p>'''

p = FI / "index.html"
s = p.read_text(encoding="utf-8")
a = '''      <p class="small muted" style="margin-top:12px" data-i18n="limits.future"></p>'''
assert s.count(a) == 1
s = s.replace(a, block)
a = '''      <p data-i18n-html="footer.odor_model"></p>'''
assert s.count(a) == 1
s = s.replace(a, a + '''\n      <p data-i18n-html="footer.mix"></p>''')
s = s.replace('i18n.js?v=20261018f"', 'i18n.js?v=20261018j"')
p.write_text(s, encoding="utf-8")

ci = {k: f"[{v[0]:+.2f}, {v[1]:+.2f}]" for k, v in CI.items()}
cite = ('Satarifard V, Sisson L, Han Y, et al. A semantic-based community model for high-fidelity tuning of olfactory '
        'mixture distances. <i>PNAS</i> 2026, 123(32): e2611057123. '
        '<a href="https://doi.org/10.1073/pnas.2611057123" target="_blank" rel="noopener">doi:10.1073/pnas.2611057123</a>')
snitz = ('Snitz K, Yablonka A, Weiss T, Frumin I, Khan RM, Sobel N. Predicting odor perceptual similarity from odor structure. '
         '<i>PLoS Comput Biol</i> 2013, 9(9): e1003184. '
         '<a href="https://doi.org/10.1371/journal.pcbi.1003184" target="_blank" rel="noopener">doi:10.1371/journal.pcbi.1003184</a>')
add = {
    "zh": {
        "limits.future": "后续可能的改进：前体物质推荐（基于反应路径知识）；更好的混合物模型（下面记录了一次尝试）；加入成本和法规约束；由用户为方案打分，代替虚拟评价函数（人在回路）。",
        "mix.title": "尝试过的改进：混合物气味相似度模型（未采用）",
        "mix.why": "<b>为什么要尝试：</b>本页的加和规则把各物质的气味轮廓按强度相加，忽略了真实混合物中的掩蔽和协同，这是本项目最大的局限。2026 年 Monell 化学感官中心、耶鲁大学、IBM 研究院等机构的研究表明，用单分子的气味描述词特征可以较好地预测两个混合物闻起来有多像（Satarifard et al., <i>PNAS</i> 2026）。我们借鉴这一思路，试着训练一个能比较两个混合物的小模型，计划只用于「参照食品」示例（目标本身是一个真实混合物），不用于示例 1~4 的方向型目标。",
        "mix.how": "<b>怎么做的：</b>该研究整理的大数据集没有开放许可（挑战赛条款禁止用于其他目的），所以只用了 Snitz et al. (2013) 公开的人类相似度评分（CC BY 4.0）：等强度的单分子或混合物两两比较，0~100 评分。混合物表示为各组分预测气味向量（138 个描述词）的幂平均，距离为带可学习维度权重的角度。按混合物分组划分：实验 2、3 共 165 对用于训练和交叉验证，实验 1 中组分不重叠的 {n} 对作为测试集，只计算一次。下表为测试集上预测距离与人类评分（不相似度）的相关系数。",
        "mix.col.method": "方法",
        "mix.row.c": "混合物模型（新）",
        "mix.row.a21": "对照：Snitz 角距离（21 个结构描述符）",
        "mix.row.a_all": "对照：Snitz 角距离（全部 1,433 个结构描述符）",
        "mix.row.b12": "对照：本页现用的加和规则（12 维轮廓余弦）",
        "mix.row.b138": "对照：加和规则，改用 138 维预测概率",
        "mix.result": "<b>结果：</b>新模型的 Pearson 最高，但 Spearman 低于 Snitz 角距离和 138 维加和，与各对照的 Pearson 差值的 95% 置信区间都包含 0（按混合物重抽样；对 Snitz 21 描述符 {a21}，对本页加和规则 {b12}）。事先约定的替换条件（两项指标都高于对照、差值显著）没有达到，<b>所以本页的评价函数没有更换</b>。另一个观察：本页现用的 12 维加和规则在所有方法中最弱，但这是看到测试结果后才注意到的，没有据此修改。",
        "mix.note": "这次检验本身也有局限：训练和测试数据都是等强度、非食品基质的混合物，只有约 300 对，来自同一实验室；用于乳品风味还需要按浓度（如 OAV）给组分加权，这一做法没有被这些数据验证。模型预测的是整体相似度，也不能说明具体是哪种掩蔽或协同作用。",
        "footer.mix": "<b>混合物相似度实验（未采用）：</b>数据来自 " + snitz + "（CC BY 4.0）；思路参考 " + cite + "。代码在 training/mixture/。",
    },
    "en": {
        "limits.future": "Possible next steps: precursor recommendations (from reaction-pathway knowledge); a better mixture model (one attempt is recorded below); cost and regulatory constraints; letting users score the suggestions instead of the virtual evaluation function (human in the loop).",
        "mix.title": "Tried: a mixture odor similarity model (not adopted)",
        "mix.why": "<b>Why:</b> the additive rule on this page sums the odor profiles of the compounds by intensity and ignores masking and synergy in real mixtures, the largest limitation of this project. In 2026, work by the Monell Chemical Senses Center, Yale University, IBM Research and others showed that odor-descriptor features of single molecules predict fairly well how similar two mixtures smell (Satarifard et al., <i>PNAS</i> 2026). Following this idea, we tried to train a small model that compares two mixtures, meant only for the reference-food example (where the target is itself a real mixture), not for the directional targets of examples 1-4.",
        "mix.how": "<b>How:</b> the large dataset of that study has no open licence (the challenge terms forbid other uses), so only the public human similarity ratings of Snitz et al. (2013, CC BY 4.0) were used: pairwise comparisons of intensity-matched molecules or mixtures, rated 0-100. A mixture is the power mean of its components' predicted odor vectors (138 descriptors) and the distance is an angle with learned per-descriptor weights. The split is by mixture: experiments 2 and 3 (165 pairs) for training and cross-validation, the {n} non-overlapping pairs of experiment 1 as the test set, computed once. The table shows the correlation between predicted distance and human ratings (dissimilarity) on the test set.",
        "mix.col.method": "Method",
        "mix.row.c": "Mixture model (new)",
        "mix.row.a21": "Baseline: Snitz angle (21 structural descriptors)",
        "mix.row.a_all": "Baseline: Snitz angle (all 1,433 structural descriptors)",
        "mix.row.b12": "Baseline: this page's additive rule (cosine of 12-dimension profiles)",
        "mix.row.b138": "Baseline: additive rule with the 138 predicted probabilities",
        "mix.result": "<b>Result:</b> the new model has the highest Pearson correlation but a lower Spearman correlation than the Snitz angle and the 138-dimension additive rule, and every 95% confidence interval of its Pearson difference to a baseline includes 0 (resampling mixtures; vs the 21-descriptor Snitz angle {a21}, vs this page's additive rule {b12}). The replacement criterion fixed in advance (better on both metrics, with a clear difference) was not met, <b>so this page's evaluation function was not changed</b>. One more observation: the 12-dimension additive rule used here is the weakest of all methods, but this was noticed only after seeing the test results, so nothing was changed because of it.",
        "mix.note": "The test has limits of its own: training and test data are intensity-matched mixtures outside a food matrix, only about 300 pairs from one laboratory; using it for dairy flavor would also need concentration weights for the components (e.g. by OAV), which these data do not validate. The model predicts overall similarity and cannot tell which masking or synergy is involved.",
        "footer.mix": "<b>Mixture similarity experiment (not adopted):</b> data from " + snitz + " (CC BY 4.0); idea from " + cite + ". Code in training/mixture/.",
    },
}
for lang, d2 in add.items():
    q = FI / "i18n" / f"{lang}.json"
    d = json.loads(q.read_text(encoding="utf-8"))
    for k, v in d2.items():
        d[k] = v.replace("{n}", str(ev["n_test"])).replace("{a21}", ci["c-a21"]).replace("{b12}", ci["c-b12"])
    q.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("ok")
