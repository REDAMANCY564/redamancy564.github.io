"""Build the simulated example files for gcms-interpreter (PLAN-gcms.md section 16).

Compound sets and concentrations come from three published dairy studies already used by
flavor-improver (flavor-improver/data/bases.json): long shelf-life yoghurt (Wang et al.
2025), pasteurized milk (Xu et al.) and Gouda at 4 and 30 weeks (Duensing et al.). Everything
else is SIMULATED: retention times (from approximate polar-column retention indices),
peak areas (concentration x a random response factor), replicate noise, and the format
problems the page must handle:
  leading-zero CAS, CAS stored as numbers, a CAS turned into a date, a CAS with a wrong
  check digit, CAS-index (inverted) names, Greek letters, sample names in different word
  orders, a split peak (adjacent peaks of one compound), the same compound at two distant
  retention times, a co-eluting peak with two library hits, and noise compounds (column
  bleed siloxanes, a plasticizer, an antioxidant).
Scope (user decision 2026-10-17): one file = one sample with peak areas.

Outputs (gcms-interpreter/examples/):
  example1_yogurt_agilent_style.csv   UTF-8 with BOM, comma, instrument header lines
  example2_milk_shimadzu_style.txt    GBK, tab, [Header] sections, Chinese column names, RI
  example3_gouda_thermo_style.xlsx    Excel peak table with metadata rows above the header
  standard_example{1,2,3}_*.csv       standard files (target lists): name, CAS, reference RT, RI
  examples.json                       sources, notes and the preset tolerances of each example
"""
import csv
import datetime
import io
import json
import random
from pathlib import Path

from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "gcms-interpreter" / "examples"
BASES = {b["id"]: b for b in json.loads((ROOT / "flavor-improver" / "data" / "bases.json").read_text(encoding="utf-8"))}
SEED = 7

# name -> (CAS, approximate retention index on a polar (WAX) column; simulated)
COMPOUNDS = {
    "diacetyl": ("431-03-8", 980), "2,3-pentanedione": ("600-14-6", 1060), "hexanal": ("66-25-1", 1083),
    "2-heptanone": ("110-43-0", 1182), "2-pentylfuran": ("3777-69-3", 1231), "ethyl hexanoate": ("123-66-0", 1233),
    "acetoin": ("513-86-0", 1284), "octanal": ("124-13-0", 1289), "nonanal": ("124-19-6", 1391),
    "acetic acid": ("64-19-7", 1450), "furfural": ("98-01-1", 1461), "benzaldehyde": ("100-52-7", 1520),
    "butanoic acid": ("107-92-6", 1625), "2-undecanone": ("112-12-9", 1598), "hexanoic acid": ("142-62-1", 1846),
    "octanoic acid": ("124-07-2", 2060), "decanoic acid": ("334-48-5", 2272), "1-butanol": ("71-36-3", 1145),
    "(E)-2-octenal": ("2548-87-0", 1429), "gamma-nonalactone": ("104-61-0", 2020), "delta-decalactone": ("705-86-2", 2190),
    "gamma-dodecalactone": ("2305-05-7", 2380), "delta-dodecalactone": ("713-95-1", 2420), "pentanoic acid": ("109-52-4", 1735),
    "ethyl butanoate": ("105-54-4", 1035), "3-methylbutanal": ("590-86-3", 918), "3-methyl-1-butanol": ("123-51-3", 1209),
    "3-methylbutanoic acid": ("503-74-2", 1670), "2-methylbutanoic acid": ("116-53-0", 1664),
    "2-methylpropanoic acid": ("79-31-2", 1570), "2-phenylethanol": ("60-12-8", 1910), "phenylacetic acid": ("103-82-2", 2560),
    # noise compounds
    "hexamethylcyclotrisiloxane": ("541-05-9", 830), "octamethylcyclotetrasiloxane": ("556-67-2", 1010),
    "decamethylcyclopentasiloxane": ("541-02-6", 1095), "dodecamethylcyclohexasiloxane": ("540-97-6", 1340),
    "diisobutyl phthalate": ("84-69-5", 2870), "butylated hydroxytoluene": ("128-37-0", 1905),
}

# Name spellings as library searches / instrument software tend to print them
NIST_STYLE = {
    "diacetyl": "2,3-Butanedione", "acetoin": "2-Butanone, 3-hydroxy-", "2-pentylfuran": "Furan, 2-pentyl-",
    "ethyl hexanoate": "Hexanoic acid, ethyl ester", "butanoic acid": "Butanoic acid", "hexanoic acid": "Hexanoic acid",
    "acetic acid": "Acetic acid", "2-heptanone": "2-Heptanone", "2-undecanone": "2-Undecanone", "nonanal": "Nonanal",
    "octanal": "Octanal", "hexanal": "Hexanal", "furfural": "Furfural", "benzaldehyde": "Benzaldehyde",
    "2,3-pentanedione": "2,3-Pentanedione", "pentanoic acid": "Pentanoic acid",
    "octamethylcyclotetrasiloxane": "Cyclotetrasiloxane, octamethyl-",
    "decamethylcyclopentasiloxane": "Cyclopentasiloxane, decamethyl-",
    "dodecamethylcyclohexasiloxane": "Cyclohexasiloxane, dodecamethyl-",
}
MILK_STYLE = {
    "hexanal": "Hexanal", "octanal": "Octanal", "nonanal": "Nonanal", "benzaldehyde": "Benzaldehyde",
    "butanoic acid": "Butanoic acid", "octanoic acid": "Octanoic acid", "decanoic acid": "n-Decanoic acid",
    "1-butanol": "1-Butanol", "(E)-2-octenal": "2-Octenal, (E)-", "acetic acid": "Acetic acid",
    "gamma-nonalactone": "γ-Nonalactone", "delta-decalactone": "δ-Decalactone", "gamma-dodecalactone": "γ-Dodecalactone",
    "delta-dodecalactone": "2H-Pyran-2-one, 6-heptyltetrahydro-", "diacetyl": "Diacetyl",
    "hexamethylcyclotrisiloxane": "Cyclotrisiloxane, hexamethyl-", "decamethylcyclopentasiloxane": "Cyclopentasiloxane, decamethyl-",
    "butylated hydroxytoluene": "Butylated Hydroxytoluene",
}
GOUDA_STYLE = {
    "butanoic acid": "Butyric acid", "hexanoic acid": "Caproic acid", "pentanoic acid": "Valeric acid",
    "ethyl butanoate": "Ethyl butyrate", "ethyl hexanoate": "Ethyl caproate", "delta-dodecalactone": "delta-Dodecalactone",
    "delta-decalactone": "delta-Decalactone", "diacetyl": "Diacetyl", "3-methylbutanal": "3-Methylbutanal",
    "3-methyl-1-butanol": "Isoamyl alcohol", "3-methylbutanoic acid": "Isovaleric acid", "2-methylbutanoic acid": "2-Methylbutyric acid",
    "acetic acid": "Acetic acid", "2-methylpropanoic acid": "Isobutyric acid", "2-phenylethanol": "Phenethyl alcohol",
    "phenylacetic acid": "Phenylacetic acid", "diisobutyl phthalate": "Diisobutyl phthalate",
}


def cas_ok(cas):
    digits = cas.replace("-", "")
    body, check = digits[:-1], int(digits[-1])
    return sum((i + 1) * int(d) for i, d in enumerate(reversed(body))) % 10 == check


def rt_of(ri):
    """Simulated linear RI -> RT (min) mapping for a 60 m WAX column."""
    return round(3.0 + (ri - 700) / 1900 * 40.0, 3)


def replicate(value, rng, cv=0.08):
    return value * max(0.5, rng.gauss(1.0, cv))


def example1(rng):
    """Yoghurt, Agilent-style CSV: long table, leading-zero CAS, NIST names, split peak, co-elution."""
    base = BASES["yogurt_high_acid"]
    comp = dict(base["composition_ug_kg"])
    rf = {n: rng.lognormvariate(0, 0.6) * 1e3 for n in list(comp) + ["octamethylcyclotetrasiloxane", "decamethylcyclopentasiloxane", "ethyl hexanoate"]}
    samples = ["Yogurt_H_rep1.D"]
    rows = []
    for s in samples:
        peaks = []
        for n, c in comp.items():
            area = replicate(c, rng) * rf[n]
            rt = rt_of(COMPOUNDS[n][1]) + rng.gauss(0, 0.004)
            if n == "acetic acid":   # split peak: two adjacent peaks of the same compound
                peaks.append([rt - 0.03, n, area * 0.7, 91, None])
                peaks.append([rt + 0.04, n, area * 0.3, 86, None])
                continue
            if n == "2-pentylfuran":  # co-elution: one peak, two library hits
                pk = [rt, n, area, 83, ["ethyl hexanoate", 80]]
                peaks.append(pk)
                continue
            peaks.append([rt, n, area, rng.randint(80, 97), None])
        peaks.append([rt_of(1010), "octamethylcyclotetrasiloxane", 4.2e5 * rng.uniform(0.7, 1.3), 90, None])
        peaks.append([rt_of(1095), "decamethylcyclopentasiloxane", 6.8e5 * rng.uniform(0.7, 1.3), 92, None])
        peaks.append([rt_of(1800), "hexanal", comp["hexanal"] * rf["hexanal"] * 0.4, 62, None])  # same name far away
        # simulated library misidentification: a peak at the RT of 2-methylbutanoic acid reported as
        # its isomer pentanoic acid (the standard file lists 2-methylbutanoic acid: "to confirm")
        peaks.append([rt_of(1664) + 0.01, "pentanoic acid", 2.1e4, 74, None])
        peaks.sort(key=lambda p: p[0])
        total = sum(p[2] for p in peaks)
        for i, (rt, n, area, q, alt) in enumerate(peaks, start=1):
            for name, qual in [(n, q)] + ([tuple(alt)] if alt else []):
                first, rest = COMPOUNDS[name][0].split("-", 1)
                cas = first.zfill(6) + "-" + rest   # Agilent-style: first CAS block padded to 6 digits
                rows.append([s, i, f"{rt:.3f}", f"{area:.0f}", f"{100 * area / total:.2f}", NIST_STYLE[name], cas, qual])
    buf = io.StringIO()
    buf.write("Data Path,C:\\MassHunter\\Data\\Yogurt\\\n")
    buf.write("Acq. Method,SPME_DBWAX_60m.M\n")
    buf.write("Library,NIST20 (simulated example; not a real export)\n")
    buf.write("Report Created,2026-10-17 10:15\n\n")
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["Data File", "Peak", "R.T. (min)", "Area", "Pct Total", "Library/ID", "CAS#", "Qual"])
    w.writerows(rows)
    (OUT / "example1_yogurt_agilent_style.csv").write_bytes(b"\xef\xbb\xbf" + buf.getvalue().encode("utf-8"))
    return {"source": base["source"], "samples": samples}


def example2(rng):
    """Pasteurized milk, Shimadzu-style TXT in GBK: [Header] sections, Chinese columns, RI, Greek names."""
    base = BASES["milk_pasteurized"]
    comp = dict(base["composition_ug_kg"])
    rf = {n: rng.lognormvariate(0, 0.6) * 1e3 for n in comp}
    samples = ["巴氏奶_A_1"]
    lines = ["[Header]", "Data File Name\tD:\\GCMSsolution\\Data\\milk.qgd", "Output Date\t2026/10/17",
             "Note\t模拟示例文件，并非真实仪器导出", "", "[MS Similarity Search Results for Spectrum Process Table]"]
    lines.append("\t".join(["样品名", "峰号", "保留时间", "保留指数", "峰面积", "面积%", "化合物名称", "CAS号", "相似度"]))
    for s in samples:
        peaks = []
        for n, c in comp.items():
            ri = COMPOUNDS[n][1] + rng.randint(-3, 3)
            peaks.append([rt_of(ri), ri, n, replicate(c, rng) * rf[n]])
        peaks.append([rt_of(830), 830, "hexamethylcyclotrisiloxane", 2.5e5 * rng.uniform(0.7, 1.3)])
        peaks.append([rt_of(1095), 1095, "decamethylcyclopentasiloxane", 3.1e5 * rng.uniform(0.7, 1.3)])
        peaks.append([rt_of(1905), 1905, "butylated hydroxytoluene", 1.2e5 * rng.uniform(0.7, 1.3)])
        peaks.sort()
        total = sum(p[3] for p in peaks)
        for i, (rt, ri, n, area) in enumerate(peaks, start=1):
            cas = COMPOUNDS[n][0]
            if n == "1-butanol":
                cas = "71-36-4"      # wrong check digit (typo): must be flagged as suspicious
            lines.append("\t".join([s, str(i), f"{rt:.3f}", str(ri), f"{area:.0f}", f"{100 * area / total:.2f}",
                                    MILK_STYLE[n], cas, str(rng.randint(80, 96))]))
    (OUT / "example2_milk_shimadzu_style.txt").write_bytes(("\r\n".join(lines) + "\r\n").encode("gbk"))
    return {"source": base["source"], "samples": samples}


def example3(rng):
    """Gouda 30 weeks, Thermo-style XLSX: metadata rows, CAS as numbers, a CAS as a date, a leading-zero CAS,
    and a calculated amount column (ug/kg), so the page computes OAV for this example."""
    base = BASES["gouda_30w"]
    comp = dict(base["composition_ug_kg"])
    comp["diisobutyl phthalate"] = 40.0
    sample = "Gouda_30w_rep1"
    peaks = []
    for n, c in comp.items():
        rt = rt_of(COMPOUNDS[n][1]) + rng.gauss(0, 0.004)
        amount = replicate(c, rng)                     # quantified amount (SIDA in the source study)
        peaks.append([rt, n, amount * rng.lognormvariate(0, 0.6) * 1e2, amount])
    peaks.sort()
    total = sum(p[2] for p in peaks)
    wb = Workbook()
    ws = wb.active
    ws.title = "Peak Table"
    ws.append(["Thermo-style peak table export (simulated example; not a real export)"])
    ws.append(["Sample Name", sample])
    ws.append(["Method", "Cheese_SAFE_DBWAX"])
    ws.append([])
    ws.append(["Peak", "Compound", "CAS No.", "RT (min)", "Area", "Area %", "Calc. Amt. (µg/kg)"])
    for i, (rt, n, area, amount) in enumerate(peaks, start=1):
        cas = COMPOUNDS[n][0]
        if n == "acetic acid":
            cas_cell = datetime.datetime(2019, 6, 4)   # simulates a CAS that Excel turned into a date
        elif n == "diacetyl":
            cas_cell = "000431-03-8"
        else:
            cas_cell = int(cas.replace("-", ""))      # CAS stored as a number (hyphens lost)
        ws.append([i, GOUDA_STYLE[n], cas_cell, round(rt, 3), round(area), round(100 * area / total, 2),
                   round(amount, 1)])
        if n == "acetic acid":
            ws.cell(ws.max_row, 3).number_format = "yyyy-mm-dd"
    wb.save(OUT / "example3_gouda_thermo_style.xlsx")
    return {"source": base["source"], "samples": [sample]}


def site_thresholds():
    """CAS -> water odor threshold (mg/kg) already published on this site by flavor-improver
    (van Gemert 2011, Part II; each value's source is listed there)."""
    out = {}
    for f in ("palette.json", "reference.json"):
        for c in json.loads((ROOT / "flavor-improver" / "data" / f).read_text(encoding="utf-8"))["compounds"].values():
            if c.get("threshold_mg_kg") and c.get("cas"):
                out[c["cas"]] = c["threshold_mg_kg"]
    return out


THRESHOLDS = site_thresholds()


def standard_files():
    """One standard file (target list) per example: name, CAS, reference RT on the example's
    simulated method and the odor threshold in ug/kg (the user's own column; here the values
    flavor-improver already publishes; dimethyl sulfide has none). Names are written differently
    from the peak tables on purpose."""
    lists = {
        # yoghurt: includes ethyl hexanoate, which co-elutes with 2-pentylfuran (rule 2)
        "standard_example1_yogurt.csv": [
            "diacetyl", "2,3-pentanedione", "hexanal", "2-heptanone", "2-pentylfuran", "ethyl hexanoate", "acetoin",
            "octanal", "nonanal", "acetic acid", "furfural", "benzaldehyde", "2-undecanone", "butanoic acid",
            "hexanoic acid", "2-methylbutanoic acid", "1-octen-3-ol", "dimethyl sulfide"],
        "standard_example2_milk.csv": [
            "hexanal", "octanal", "nonanal", "(E)-2-octenal", "1-butanol", "acetic acid", "benzaldehyde",
            "butanoic acid", "octanoic acid", "decanoic acid", "gamma-nonalactone", "delta-decalactone",
            "gamma-dodecalactone", "delta-dodecalactone", "diacetyl"],
        "standard_example3_gouda.csv": [
            "diacetyl", "3-methylbutanal", "ethyl butanoate", "ethyl hexanoate", "3-methyl-1-butanol", "acetic acid",
            "2-methylpropanoic acid", "butanoic acid", "2-methylbutanoic acid", "3-methylbutanoic acid",
            "pentanoic acid", "hexanoic acid", "2-phenylethanol", "delta-decalactone", "delta-dodecalactone",
            "phenylacetic acid"],
    }
    # targets absent from the yoghurt sample: 1-octen-3-ol elutes with acetic acid on WAX (other compound
    # in the window); dimethyl sulfide has no peak near its reference RT (not detected)
    extra = {"1-octen-3-ol": ("3391-86-4", 1450), "dimethyl sulfide": ("75-18-3", 750)}
    zh = {"diacetyl": "双乙酰", "acetoin": "乙偶姻", "hexanal": "己醛", "acetic acid": "乙酸", "butanoic acid": "丁酸",
          "hexanoic acid": "己酸", "nonanal": "壬醛", "octanal": "辛醛", "benzaldehyde": "苯甲醛", "1-octen-3-ol": "1-辛烯-3-醇", "dimethyl sulfide": "二甲基硫醚"}
    for fname, names in lists.items():
        with open(OUT / fname, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["Compound", "CAS", "Reference RT (min)", "Odor threshold (µg/kg)", "RI", "Note"])
            for n in names:
                cas, ri = COMPOUNDS.get(n) or extra[n]
                thr = THRESHOLDS.get(cas)
                w.writerow([n, cas, f"{rt_of(ri):.2f}", f"{thr * 1000:g}" if thr else "", ri, zh.get(n, "")])


def main():
    bad = [n for n, (c, _) in COMPOUNDS.items() if not cas_ok(c)]
    assert not bad, f"CAS check digit failed: {bad}"
    OUT.mkdir(parents=True, exist_ok=True)
    rng = random.Random(SEED)
    meta = {
        "note": "Simulated data. Compound sets and concentrations follow the cited studies; retention times, "
                "areas, replicate noise and format problems are simulated.",
        "examples": {
            "example1": {"file": "example1_yogurt_agilent_style.csv", "tolerances": {"merge_min": 0.1, "window_min": 0.15}, **example1(rng)},
            "example2": {"file": "example2_milk_shimadzu_style.txt", "tolerances": {"merge_min": 0.1, "window_min": 0.15}, **example2(rng)},
            "example3": {"file": "example3_gouda_thermo_style.xlsx", "tolerances": {"merge_min": 0.1, "window_min": 0.15}, **example3(rng)},
        },
        "standards": {"example1": "standard_example1_yogurt.csv", "example2": "standard_example2_milk.csv",
                      "example3": "standard_example3_gouda.csv"},
    }
    standard_files()
    (OUT / "examples.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    for f in sorted(OUT.iterdir()):
        print(f"{f.name:40s} {f.stat().st_size:8d} bytes")


if __name__ == "__main__":
    main()
