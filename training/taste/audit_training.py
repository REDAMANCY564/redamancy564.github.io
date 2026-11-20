"""Self-check of the deployed taste model on its own training data (all 3,937 molecules).

The model on the website was trained on ALL data, so this is not an evaluation of new
molecules: it shows where the model does not even reproduce the labels it was trained on.

case-fix-3 (2026-11-20): compares the first version (checkpoints/taste_gnn_v1.pt, the model
the site used until then) with the retrained one (--new, default checkpoints/taste_gnn.pt),
each at probability 0.5 and at its per-label judgement thresholds (Youden J on the validation
split, computed from the matching train-split model *_eval.pt, as in train_gnn.py).
Detailed sections use the new model at its thresholds.
Writes a Markdown report (default: _inputs/TASTE-AUDIT.md, not committed).

Compound classes are heuristic SMARTS rules (first match wins, in the order of CLASSES).
"""
import argparse
import numpy as np
import pandas as pd
from rdkit import Chem

from common import DATA_DIR, LABELS, ROOT, auroc, load
from export_taste_onnx import load_model, predict_smiles
from train_gnn import youden

ZH = {"sweet": "甜", "bitter": "苦", "umami": "鲜", "tasteless": "无味"}
P = Chem.MolFromSmarts
GLYCERIDE = P("[CH2]([OX2])[CH]([OX2])[CH2][OX2]C(=O)[#6]")
ESTER = P("[#6][CX3](=O)[OX2][#6]")
ACID = P("[CX3](=O)[OX2H1]")
ALPHA_AA = P("[NX3;H2,H1;!$(NC=O)][CX4][CX3](=O)[OX2H1]")
AMIDE_PEPTIDE = P("[NX3][CX4][CX3](=O)[NX3][CX4][CX3](=O)[OX2H1,OX2]")
ALIPH_OH = P("[CX4][OX2H1]")
SUGAR_RING = P("[OX2;R]1[CX4;R][CX4;R]([OX2])[CX4;R]([OX2])[CX4;R]1")  # furanose with 2 OH
SUGAR_RING6 = P("[OX2;R]1[CX4;R][CX4;R]([OX2])[CX4;R]([OX2])[CX4;R]([OX2])[CX4;R]1")


def n_carbon(m):
    return sum(a.GetAtomicNum() == 6 for a in m.GetAtoms())


def classify(m):
    elems = {a.GetAtomicNum() for a in m.GetAtoms()}
    ring = m.GetRingInfo().NumRings() > 0
    nC = n_carbon(m)
    if m.HasSubstructMatch(GLYCERIDE):
        return "脂类/甘油酯"
    if not ring and elems <= {6, 8} and len(m.GetSubstructMatches(ACID)) == 1 and \
            sum(a.GetAtomicNum() == 8 for a in m.GetAtoms()) == 2:
        return "长链脂肪酸 (≥C12)" if nC >= 12 else "短/中链脂肪酸 (<C12)"
    if m.HasSubstructMatch(AMIDE_PEPTIDE):
        return "肽 (二肽等)"
    if m.HasSubstructMatch(ALPHA_AA) and nC <= 15:
        return "氨基酸"
    n_oh = len(m.GetSubstructMatches(ALIPH_OH))
    if 7 not in elems and (m.HasSubstructMatch(SUGAR_RING6) or m.HasSubstructMatch(SUGAR_RING)
                           or (not ring and n_oh >= 3 and n_oh >= nC - 2)):
        return "糖类/糖醇/糖苷"
    if m.HasSubstructMatch(ESTER):
        return "酯类"
    return "其他"


CLASSES = ["长链脂肪酸 (≥C12)", "短/中链脂肪酸 (<C12)", "脂类/甘油酯", "酯类", "氨基酸", "肽 (二肽等)",
           "糖类/糖醇/糖苷", "其他"]


def run(name, smiles):
    model, ckpt = load_model(name)
    return predict_smiles(model, ckpt, smiles)


def thresholds(eval_name, d):
    va = d["split"] == "valid"
    P = run(eval_name, [s for s, v in zip(d["smiles"], va) if v])
    return np.array([youden(d["Y"][va][:, j], P[:, j])[0] for j in range(len(LABELS))])


def mismatch(Y, Pr, thr):
    pred = (Pr >= thr).astype(float)
    known = ~np.isnan(Y)
    return known, pred, known & (pred != np.nan_to_num(Y, nan=-1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "_inputs" / "TASTE-AUDIT.md"))
    ap.add_argument("--old", default="taste_gnn_v1.pt")
    ap.add_argument("--new", default="taste_gnn.pt")
    args = ap.parse_args()
    d = load()
    clean = pd.read_csv(DATA_DIR / "clean.csv")
    Y = d["Y"]
    cls = np.array([classify(Chem.MolFromSmiles(s)) for s in d["smiles"]])
    names = clean["name"].fillna("").tolist()
    models = {}
    for tag, name in (("旧模型", args.old), ("新模型", args.new)):
        Pr = run(name, d["smiles"])
        thr = thresholds(name.replace(".pt", "_eval.pt"), d)
        models[tag] = {"Pr": Pr, "thr": thr, "file": name}

    L = []
    w = L.append
    w("# 味觉预测：网页模型在训练数据上的自检（新旧对比）\n")
    w("（自动生成：training/taste/audit_training.py，2026-11-20。不提交。）\n")
    w("- 两个模型都是网页部署用的版本（用全部 3,937 个分子训练）。这些分子模型训练时都见过，"
      "所以这里的不符说明模型连训练标签都没有学到，而不是对新分子的泛化误差。")
    w(f"- 旧模型：{args.old}（第一版，3 层 GCN，平均 + 最大池化）。新模型：{args.new}"
      "（同样 3 层 GCN，读出层加求和池化和 8 个全局分子描述符）。")
    w("- 判定有两种口径：概率 ≥ 0.5；概率 ≥ 该标签的判断阈值（验证集 Youden J，由对应的只用训练集训练的模型算出）。"
      "只统计数据集中该标签已知（1 或 0）的分子；未知（-）不计。")
    w("- 化合物类别是启发式 SMARTS 规则（按下表顺序，先匹配先归类）：甘油酯骨架 → 无环、只含 C/O、一个羧基的脂肪酸"
      "（按碳数分 ≥C12 / <C12）→ 肽 → α-氨基酸 → 糖环（≥2 个环上 OH）或多元醇 → 酯 → 其他。\n")

    w("## 0. 新旧对比\n")
    w("判断阈值：" + "；".join(f"{tag} " + "、".join(f"{ZH[l]} {m['thr'][j]:.3f}" for j, l in enumerate(LABELS))
                          for tag, m in models.items()) + "。\n")
    w("| 指标 | 旧模型 | 新模型 |")
    w("|---|---:|---:|")
    for j, l in enumerate(LABELS):
        w(f"| 训练分子 AUROC：{ZH[l]} | " + " | ".join(f"{auroc(Y[:, j], m['Pr'][:, j]):.3f}" for m in models.values()) + " |")
    for basis in ("0.5", "阈值"):
        row_any, rows = [], {l: [] for l in LABELS}
        fnfp = {l: [] for l in ("sweet", "bitter")}
        for m in models.values():
            thr = 0.5 if basis == "0.5" else m["thr"]
            known, pred, wrong = mismatch(Y, m["Pr"], thr)
            row_any.append(f"{int(wrong.any(1).sum())}（{wrong.any(1).mean():.1%}）")
            for j, l in enumerate(LABELS):
                rows[l].append(f"{int(wrong[:, j].sum())}（{wrong[:, j].sum() / known[:, j].sum():.1%}）")
            for l in fnfp:
                j = LABELS.index(l)
                fn = int((known[:, j] & (Y[:, j] == 1) & (pred[:, j] == 0)).sum())
                fp = int((known[:, j] & (Y[:, j] == 0) & (pred[:, j] == 1)).sum())
                fnfp[l].append(f"漏 {fn} / 误 {fp}")
        w(f"| 至少一个标签不符（{basis}） | " + " | ".join(row_any) + " |")
        for l in LABELS:
            w(f"| {ZH[l]} 不符（{basis}） | " + " | ".join(rows[l]) + " |")
        for l in fnfp:
            w(f"| {ZH[l]} 漏报 / 误报（{basis}） | " + " | ".join(fnfp[l]) + " |")
    w("\n按类别，至少一个标签不符（阈值口径 / 0.5 口径）：\n")
    w("| 类别 | 分子数 | 旧模型 | 新模型 |")
    w("|---|---:|---:|---:|")
    for c in CLASSES:
        idx = cls == c
        cells = []
        for m in models.values():
            a = mismatch(Y[idx], m["Pr"][idx], m["thr"])[2].any(1)
            b = mismatch(Y[idx], m["Pr"][idx], 0.5)[2].any(1)
            cells.append(f"{int(a.sum())} / {int(b.sum())}")
        w(f"| {c} | {int(idx.sum())} | " + " | ".join(cells) + " |")
    w("")

    new = models["新模型"]
    Pr, thr = new["Pr"], new["thr"]
    known, pred, wrong = mismatch(Y, Pr, thr)
    old = models["旧模型"]

    w("## 1. 新模型总体（每个标签，判断阈值口径）\n")
    w("| 标签 | 判断阈值 | 已知分子 | 数据为“有” | 不符 | 不符比例 | 其中漏报（数据有、预测无） | 误报（数据无、预测有） |")
    w("|---|---:|---:|---:|---:|---:|---:|---:|")
    for j, l in enumerate(LABELS):
        k = known[:, j]
        fn = int((k & (Y[:, j] == 1) & (pred[:, j] == 0)).sum())
        fp = int((k & (Y[:, j] == 0) & (pred[:, j] == 1)).sum())
        w(f"| {ZH[l]} | {thr[j]:.3f} | {int(k.sum())} | {int(np.nansum(Y[:, j]))} | {int(wrong[:, j].sum())} | "
          f"{wrong[:, j].sum() / k.sum():.1%} | {fn} | {fp} |")
    any_wrong = wrong.any(axis=1)
    w(f"\n至少一个标签不符的分子：{int(any_wrong.sum())} / {len(Y)}（{any_wrong.mean():.1%}）。\n")

    w("## 2. 新模型按化合物类别（判断阈值口径）\n")
    w("| 类别 | 分子数 | 至少一个标签不符 | 比例 | 甜 不符/已知 | 苦 不符/已知 | 鲜 不符/已知 | 无味 不符/已知 |")
    w("|---|---:|---:|---:|---:|---:|---:|---:|")
    for c in CLASSES:
        idx = cls == c
        if not idx.any():
            continue
        cells = [f"{int(wrong[idx, j].sum())}/{int(known[idx, j].sum())}" for j in range(len(LABELS))]
        w(f"| {c} | {int(idx.sum())} | {int(any_wrong[idx].sum())} | {any_wrong[idx].mean():.1%} | " + " | ".join(cells) + " |")

    def lab(i):
        return " ".join(f"{ZH[l]}{'?' if np.isnan(Y[i, j]) else int(Y[i, j])}" for j, l in enumerate(LABELS))

    def prob(P, i, t=None):
        return " ".join(f"{ZH[l]}{P[i, j] * 100:.0f}" + ("" if t is None else ("✓" if P[i, j] >= t[j] else ""))
                        for j, l in enumerate(LABELS))

    def bad(i):
        return "、".join(ZH[l] for j, l in enumerate(LABELS) if wrong[i, j])

    w("\n## 3. 重点类别：全部分子（含相符的），新旧对比\n")
    w("概率为百分数；✓ 表示超过该模型的判断阈值。“不符”按新模型、阈值口径。\n")
    for c in ["长链脂肪酸 (≥C12)", "脂类/甘油酯"]:
        idx = np.flatnonzero(cls == c)
        w(f"### {c}（{len(idx)} 个）\n")
        w("| 名称 | SMILES | 数据集标签（1 有 / 0 无 / ? 未知） | 旧模型 % | 新模型 % | 不符 |")
        w("|---|---|---|---|---|---|")
        for i in sorted(idx, key=lambda i: n_carbon(Chem.MolFromSmiles(d["smiles"][i]))):
            w(f"| {names[i] or '（无名称）'} | `{d['smiles'][i]}` | {lab(i)} | {prob(old['Pr'], i, old['thr'])} | "
              f"{prob(Pr, i, thr)} | {bad(i) or '无'} |")
        w("")

    w("## 4. 新模型不符分子名单（按类别；每个至少一个标签不符，判断阈值口径）\n")
    for c in CLASSES:
        idx = np.flatnonzero((cls == c) & any_wrong)
        if c in ("长链脂肪酸 (≥C12)", "脂类/甘油酯") or not len(idx):
            continue
        w(f"### {c}（{len(idx)} 个）\n")
        w("| 名称 | SMILES | 数据集标签 | 预测概率 % | 不符 | 划分 |")
        w("|---|---|---|---|---|---|")
        for i in idx:
            w(f"| {names[i] or '（无名称）'} | `{d['smiles'][i]}` | {lab(i)} | {prob(Pr, i)} | {bad(i)} | {d['split'][i]} |")
        w("")
    from pathlib import Path
    Path(args.out).write_text("\n".join(L) + "\n", encoding="utf-8")
    print("Wrote", args.out)
    for tag, m in models.items():
        for basis, t in (("0.5", 0.5), ("thr", m["thr"])):
            wr = mismatch(Y, m["Pr"], t)[2]
            print(f"{tag} {basis}: any wrong {wr.any(1).sum()} ({wr.any(1).mean():.1%})")


if __name__ == "__main__":
    main()
