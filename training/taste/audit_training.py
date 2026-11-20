"""Self-check of the deployed taste model on its own training data (all 3,937 molecules).

The model on the website was trained on ALL data, so this is not an evaluation of new
molecules: it shows where the model does not even reproduce the labels it was trained on.
Prediction = deployed ONNX model (same file as the page), threshold 0.5.
Writes a Markdown report (default: _inputs/TASTE-AUDIT.md, not committed).

Compound classes are heuristic SMARTS rules (first match wins, in the order of CLASSES).
"""
import argparse
import numpy as np
import onnxruntime as ort
import pandas as pd
from rdkit import Chem

from common import DATA_DIR, LABELS, ROOT, load
from export_taste_onnx import ONNX_PATH
from featurize import featurize_many

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "_inputs" / "TASTE-AUDIT.md"))
    args = ap.parse_args()
    d = load()
    clean = pd.read_csv(DATA_DIR / "clean.csv")
    sess = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
    probs = []
    for s in range(0, len(d["smiles"]), 256):
        X, A, M = featurize_many(d["smiles"][s:s + 256])
        probs.append(sess.run(None, {"X": X, "A": A, "mask": M})[0])
    Pr = np.concatenate(probs)
    Y = d["Y"]
    pred = (Pr >= 0.5).astype(float)
    known = ~np.isnan(Y)
    wrong = known & (pred != np.nan_to_num(Y, nan=-1))
    cls = np.array([classify(Chem.MolFromSmiles(s)) for s in d["smiles"]])
    names = clean["name"].fillna("").tolist()

    L = []
    w = L.append
    w("# 味觉预测：网页模型在训练数据上的自检\n")
    w("（自动生成：training/taste/audit_training.py，2026-11-20。不提交。）\n")
    w("- 模型：网页上部署的 taste_gnn.onnx（用全部 3,937 个分子训练）。这些分子模型训练时都见过，"
      "所以这里的不符说明模型连训练标签都没有学到，而不是对新分子的泛化误差。")
    w("- 判定：概率 ≥ 0.5 视为预测有该味；只统计数据集中该标签已知（1 或 0）的分子；未知（-）不计。")
    w("- 化合物类别是启发式 SMARTS 规则（按下表顺序，先匹配先归类）：甘油酯骨架 → 无环、只含 C/O、一个羧基的脂肪酸"
      "（按碳数分 ≥C12 / <C12）→ 肽 → α-氨基酸 → 糖环（≥2 个环上 OH）或多元醇 → 酯 → 其他。\n")

    w("## 1. 总体（每个标签）\n")
    w("| 标签 | 已知分子 | 数据为“有” | 不符 | 不符比例 | 其中漏报（数据有、预测无） | 误报（数据无、预测有） |")
    w("|---|---:|---:|---:|---:|---:|---:|")
    for j, l in enumerate(LABELS):
        k = known[:, j]
        fn = int((k & (Y[:, j] == 1) & (pred[:, j] == 0)).sum())
        fp = int((k & (Y[:, j] == 0) & (pred[:, j] == 1)).sum())
        w(f"| {ZH[l]} | {int(k.sum())} | {int(np.nansum(Y[:, j]))} | {int(wrong[:, j].sum())} | "
          f"{wrong[:, j].sum() / k.sum():.1%} | {fn} | {fp} |")
    from common import auroc
    w("\n同一模型在这些训练分子上的 AUROC（不受 0.5 阈值影响）：" + "；".join(
        f"{ZH[l]} {auroc(Y[:, j], Pr[:, j]):.3f}" for j, l in enumerate(LABELS)) + "。")
    any_wrong = wrong.any(axis=1)
    w(f"\n至少一个标签不符的分子：{int(any_wrong.sum())} / {len(Y)}（{any_wrong.mean():.1%}）。\n")

    w("## 2. 按化合物类别\n")
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

    def prob(i):
        return " ".join(f"{ZH[l]}{Pr[i, j] * 100:.0f}" for j, l in enumerate(LABELS))

    def bad(i):
        return "、".join(ZH[l] for j, l in enumerate(LABELS) if wrong[i, j])

    w("\n## 3. 重点类别：全部分子（含相符的）\n")
    for c in ["长链脂肪酸 (≥C12)", "脂类/甘油酯"]:
        idx = np.flatnonzero(cls == c)
        w(f"### {c}（{len(idx)} 个）\n")
        w("| 名称 | SMILES | 数据集标签（1 有 / 0 无 / ? 未知） | 预测概率 % | 不符 |")
        w("|---|---|---|---|---|")
        for i in sorted(idx, key=lambda i: n_carbon(Chem.MolFromSmiles(d["smiles"][i]))):
            w(f"| {names[i] or '（无名称）'} | `{d['smiles'][i]}` | {lab(i)} | {prob(i)} | {bad(i) or '—'} |".replace("—", "无"))
        w("")

    w("## 4. 不符分子名单（按类别；每个至少一个标签不符）\n")
    for c in CLASSES:
        idx = np.flatnonzero((cls == c) & any_wrong)
        if c in ("长链脂肪酸 (≥C12)", "脂类/甘油酯") or not len(idx):
            continue
        w(f"### {c}（{len(idx)} 个）\n")
        w("| 名称 | SMILES | 数据集标签 | 预测概率 % | 不符 | 划分 |")
        w("|---|---|---|---|---|---|")
        for i in idx:
            w(f"| {names[i] or '（无名称）'} | `{d['smiles'][i]}` | {lab(i)} | {prob(i)} | {bad(i)} | {d['split'][i]} |")
        w("")
    from pathlib import Path
    Path(args.out).write_text("\n".join(L) + "\n", encoding="utf-8")
    print("Wrote", args.out)


if __name__ == "__main__":
    main()
