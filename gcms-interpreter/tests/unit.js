/* Unit tests for gcms-interpreter, run by tests/unit.html (kept external because of the page's CSP). */
(async function () {
  const results = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function check(group, name, actual, expected) {
    const ok = eq(actual, expected);
    results.push({ group, name, ok, detail: ok ? "" : "got " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected) });
  }
  async function bytes(url) { return new Uint8Array(await (await fetch(url)).arrayBuffer()); }
  async function file(name) { return new File([await bytes("../examples/" + name)], name); }
  const file_ = file;

  GcmsMapping.setDictionary(await (await fetch("../data/column_keywords.json")).json());
  const IO = GcmsIO, M = GcmsMapping;

  // ---------- io.js: decoding ----------
  const gbk = new Uint8Array([209, 249, 198, 183, 195, 251, 9, 183, 229, 186, 197, 9, 177, 163, 193, 244, 202, 177, 188, 228, 13, 10,
    176, 205, 202, 207, 196, 204, 95, 65, 95, 49, 9, 49, 9, 53, 44, 55, 51, 55, 13, 10]);
  const d1 = IO.decode(gbk);
  check("decode", "GBK bytes fall back from UTF-8", [d1.encoding, d1.text.split("\r\n")[0]], ["GBK / GB18030", "样品名\t峰号\t保留时间"]);
  const utf8 = new TextEncoder().encode("Name,RT\nHexanal,11.08\n");
  check("decode", "plain UTF-8", IO.decode(utf8).encoding, "UTF-8");
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
  check("decode", "UTF-8 BOM is stripped", [IO.decode(bom).encoding, IO.decode(bom).text.slice(0, 4)], ["UTF-8 (BOM)", "Name"]);
  const u16 = new Uint8Array([0xff, 0xfe, 0x4e, 0x00, 0x2c, 0x00, 0x52, 0x00]);
  check("decode", "UTF-16 LE BOM", IO.decode(u16).text, "N,R");

  // ---------- io.js: delimited text ----------
  check("csv", "quoted comma, escaped quote and newline", IO.parseDelimited('a,"b,c","say ""hi""","x\ny"\n1,2,3,4', ","),
    [["a", "b,c", 'say "hi"', "x\ny"], ["1", "2", "3", "4"]]);
  check("csv", "CRLF and trailing line without newline", IO.parseDelimited("a;b\r\n1;2", ";"), [["a", "b"], ["1", "2"]]);
  const withInfo = "Data Path,C:\\x\nMethod,M1\n\nPeak,RT,Area,Name\n1,5.1,100,A\n2,6.2,200,B\n3,7.3,300,C\n";
  check("csv", "comma detected despite instrument lines", IO.detectDelimiter(withInfo), ",");
  check("csv", "tab detected", IO.detectDelimiter("[Header]\nFile\tx.qgd\n\nPeak\tRT\tArea\n1\t5,1\t10\n2\t6,2\t20\n"), "\t");
  check("csv", "semicolon detected", IO.detectDelimiter("Peak;RT;Area;Name\n1;5,1;100;A\n2;6,2;200;B\n"), ";");

  // ---------- io.js: numbers ----------
  check("number", "decimal comma detected (semicolon file)", IO.detectDecimalComma([["1", "5,12", "100,5"], ["2", "6,25", "3,1"]], ";"), true);
  check("number", "no decimal comma with dot decimals", IO.detectDecimalComma([["5.12", "100.5"]], "\t"), false);
  check("number", "never with comma delimiter", IO.detectDecimalComma([["5,12"]], ","), false);
  check("number", "12,5 with decimal comma", IO.parseNumber("12,5", true), 12.5);
  check("number", "1.234,56 with decimal comma", IO.parseNumber("1.234,56", true), 1234.56);
  check("number", "1,234 thousands separator", IO.parseNumber("1,234", false), 1234);
  check("number", "1,234,567.8 thousands separator", IO.parseNumber("1,234,567.8", false), 1234567.8);
  check("number", "percent sign and spaces", IO.parseNumber(" 12.5 % ", false), 12.5);
  check("number", "scientific notation", IO.parseNumber("1.2E+05", false), 120000);
  check("number", "text is not a number", IO.parseNumber("n.d.", false), null);
  check("number", "empty is not a number", IO.parseNumber("", false), null);

  // ---------- mapping.js: column names ----------
  const headers = {
    "Library/ID": "name", "Compound Name": "name", "化合物名称": "name", "Hit Name": "name", "Component": "name",
    "CAS#": "cas", "CAS No.": "cas", "CAS Number": "cas", "CAS号": "cas", "ＣＡＳ号": "cas",
    "R.T. (min)": "rt", "RT": "rt", "Ret.Time": "rt", "Retention Time (min)": "rt", "保留时间": "rt",
    "RI": "ri", "Ret. Index": "ri", "Retention Index": "ri", "保留指数": "ri",
    "Area": "area", "Peak Area": "area", "峰面积": "area",
    "Pct Total": "rel", "Area %": "rel", "面积%": "rel", "相对含量（%）": "rel", "Relative content": "rel",
    "Conc. (ug/kg)": "conc", "浓度(μg/kg)": "conc", "Concentration": "conc", "含量(μg/kg)": "conc",
    "Qual": "match", "SI": "match", "Similarity": "match", "Match Factor": "match", "相似度": "match",
    "Peak": "peak", "Peak#": "peak", "峰号": "peak",
    "Data File": "sample", "Sample Name": "sample", "样品名": "sample",
    "Height": null, "Mass": null, "Proc.From": null,
  };
  for (const [h, f] of Object.entries(headers)) check("columns", JSON.stringify(h), M.guessField(h), f);

  // ---------- examples: header row, mapping, layout, records ----------
  async function readExample(name) {
    const f = await IO.readFile(await file(name));
    const sheet = f.sheets[0];
    const hi = M.detectHeaderRow(sheet.rows, f.decimalComma);
    const header = sheet.rows[hi];
    const mapping = M.guessMapping(header);
    const rows = M.dataRows(sheet.rows, hi);
    return { f, sheet, hi, header, mapping, rows };
  }

  const e1 = await readExample("example1_yogurt_agilent_style.csv");
  check("example1", "encoding / delimiter", [e1.f.encoding, e1.f.delimiter], ["UTF-8 (BOM)", ","]);
  check("example1", "header row skips 4 instrument lines and a blank", e1.hi, 5);
  check("example1", "column guesses", e1.mapping, ["sample", "peak", "rt", "area", "rel", "name", "cas", "match"]);
  check("example1", "one sample in the file", M.samplesIn(e1.mapping, e1.rows), ["Yogurt_H_rep1.D"]);
  const r1 = M.toRecords(e1.mapping, e1.rows, { sample: "Yogurt_H_rep1.D", decimalComma: false, dates: e1.sheet.dates });
  check("example1", "all peak rows read (co-elution hit counted as its own row)", r1.length, e1.rows.length);
  check("example1", "leading-zero CAS kept raw for stage 2", r1[0].cas, "000431-03-8");
  check("example1", "inverted name kept raw", r1.some(r => r.name === "2-Butanone, 3-hydroxy-"), true);
  check("example1", "numbers parsed", typeof r1[0].rt === "number" && typeof r1[0].area === "number", true);

  const e2 = await readExample("example2_milk_shimadzu_style.txt");
  check("example2", "encoding / delimiter", [e2.f.encoding, e2.f.delimiter], ["GBK / GB18030", "\t"]);
  check("example2", "header row after [Header] section", e2.sheet.rows[e2.hi][0], "样品名");
  check("example2", "column guesses", e2.mapping, ["sample", "peak", "rt", "ri", "area", "rel", "name", "cas", "match"]);
  const r2 = M.toRecords(e2.mapping, e2.rows, { sample: "巴氏奶_A_1", decimalComma: false, dates: e2.sheet.dates });
  check("example2", "Greek letter names survive GBK", r2.some(r => r.name === "δ-Decalactone"), true);
  check("example2", "Chinese sample name", M.samplesIn(e2.mapping, e2.rows), ["巴氏奶_A_1"]);
  check("example2", "retention index parsed", r2.every(r => typeof r.ri === "number"), true);

  const e3 = await readExample("example3_gouda_thermo_style.xlsx");
  check("example3", "Excel read", e3.f.kind, "excel");
  check("example3", "header row below the metadata block", e3.hi, 4);
  check("example3", "column guesses (Calc. Amt. = amount)", e3.mapping, ["peak", "name", "cas", "rt", "area", "rel", "conc"]);
  check("example3", "no sample column (name comes from the metadata line)", M.samplesIn(e3.mapping, e3.rows), []);
  const r3 = M.toRecords(e3.mapping, e3.rows, { sample: null, decimalComma: false, dates: e3.sheet.dates });
  check("example3", "17 peaks", r3.length, 17);
  check("example3", "CAS stored as a number reads as digits", r3.some(r => r.name === "Butyric acid" && r.cas === "107926"), true);
  check("example3", "CAS stored as a date is flagged", r3.filter(r => r.casIsDate).map(r => r.name), ["Acetic acid"]);
  check("example3", "leading-zero text CAS kept", r3.find(r => r.name === "Diacetyl").cas, "000431-03-8");

  // ---------- a file with several samples: only the chosen one is read ----------
  const multi = IO.parseDelimited(["Sample,Compound,RT,Area", "A,Hexanal,11.1,100", "B,Hexanal,11.1,200",
    "A,Nonanal,17.5,50", "B,Octanal,15.4,70"].join("\n"), ",");
  const mm = M.guessMapping(multi[0]), mr = M.dataRows(multi, 0);
  check("multi-sample", "samples listed in order", M.samplesIn(mm, mr), ["A", "B"]);
  check("multi-sample", "only the chosen sample is read",
    M.toRecords(mm, mr, { sample: "B", decimalComma: false, dates: new Set() }).map(r => [r.name, r.area]), [["Hexanal", 200], ["Octanal", 70]]);

  // ---------- templates ----------
  const t = M.makeTemplate("lab A", ["RT", "Name", "Area"], ["rt", "name", "area"]);
  const shuffled = ["Area", "Extra", "Name", "RT"];
  check("templates", "template fits reordered columns", M.findTemplate([t], shuffled) === t, true);
  check("templates", "applied by header text", M.applyTemplate(t, shuffled), ["area", null, "name", "rt"]);
  check("templates", "no fit when a mapped column is missing", M.findTemplate([t], ["Name", "Area"]), null);

  // ---------- cas.js ----------
  const C = GcmsCas;
  const cas = (raw, isDate) => { const r = C.normalizeCas(raw, isDate); return [r.cas, r.status]; };
  check("cas", "leading zeros removed", cas("000110-43-0"), ["110-43-0", "ok"]);
  check("cas", "spaces trimmed", cas("  110-43-0 "), ["110-43-0", "ok"]);
  check("cas", "Excel number", cas("110430"), ["110-43-0", "ok"]);
  check("cas", "Excel number with .0", cas("110430.0"), ["110-43-0", "ok"]);
  check("cas", "Excel scientific notation", cas("1.1043E+05"), ["110-43-0", "ok"]);
  check("cas", "shortest CAS from 5 digits", cas("64197"), ["64-19-7", "ok"]);
  check("cas", "number with leading zeros", cas("000431038"), ["431-03-8", "ok"]);
  check("cas", "wrong check digit is suspicious", cas("71-36-4"), ["71-36-4", "suspicious"]);
  check("cas", "Excel date cell", cas("2019-06-04", true), [null, "date"]);
  check("cas", "date text yyyy-mm-dd", cas("2019-06-04"), [null, "date"]);
  check("cas", "date text m/d/yyyy", cas("6/4/2019"), [null, "date"]);
  check("cas", "date text 4-Jun", cas("4-Jun"), [null, "date"]);
  check("cas", "date text Jun-19", cas("Jun-19"), [null, "date"]);
  check("cas", "prefix text", cas("CAS 64-19-7"), ["64-19-7", "ok"]);
  check("cas", "full-width characters", cas("１１０－４３－０"), ["110-43-0", "ok"]);
  check("cas", "en dash as hyphen", cas("110\u201343\u20130"), ["110-43-0", "ok"]);
  check("cas", "empty", cas(""), [null, "empty"]);
  check("cas", "not a number", cas("n.a."), [null, "invalid"]);
  check("cas", "too short", cas("1234"), [null, "invalid"]);
  check("cas", "check digit: water 7732-18-5", C.checkDigitOk("7732-18-5"), true);
  check("cas", "check digit: formaldehyde 50-00-0", C.checkDigitOk("50-00-0"), true);
  check("cas", "4-digit CAS is not a date: 2548-87-0", cas("2548-87-0"), ["2548-87-0", "ok"]);
  check("cas", "date text 2019/6/4", cas("2019/6/4"), [null, "date"]);

  // ---------- names.js: normalization ----------
  const N = GcmsNames;
  const same = (a, b) => N.normName(a) === N.normName(b);
  check("names", "Greek letter = spelled out", same("δ-Decalactone", "delta-decalactone"), true);
  check("names", "inverted stereo descriptor", same("2-Octenal, (E)-", "(E)-2-octenal"), true);
  check("names", "trans = (E)", same("trans-2-Octenal", "(E)-2-octenal"), true);
  check("names", "cis = (Z)", same("cis-3-Hexen-1-ol", "(Z)-3-hexen-1-ol"), true);
  check("names", "E and Z stay different", same("(E)-2-octenal", "(Z)-2-octenal"), false);
  check("names", "n- before a chain stem dropped", same("n-Decanoic acid", "Decanoic acid"), true);
  check("names", "N-methyl kept (nitrogen)", same("N-Methylpyrrole", "Methylpyrrole"), false);
  check("names", "punctuation and case", same("2,3-Butanedione", "2 3 butanedione"), true);
  check("names", "positions keep different compounds apart", same("2,3-dimethylpyrazine", "2,5-dimethylpyrazine"), false);

  // ---------- names.js: identification against the knowledge base ----------
  const namesJson = await (await fetch("../data/names.json")).json();
  const idx = N.buildIndex(namesJson);
  const allCas = namesJson.compounds.flatMap(c => c[2]);
  const notOk = allCas.filter(c => C.normalizeCas(c).status !== "ok");
  check("cas", "all " + allCas.length + " knowledge-base CAS numbers normalize as valid", notOk, []);
  const kbName = r => (r.kbId ? idx.info.get(r.kbId).name : null);
  const idf = (name, c, d) => { const r = N.identify(idx, name, c, d); return [kbName(r), r.method, r.note]; };
  check("identify", "by CAS with leading zeros", idf("2,3-Butanedione", "000431-03-8"), ["Diacetyl", "cas", null]);
  check("identify", "inverted CAS index name, no CAS", idf("2-Butanone, 3-hydroxy-", ""), ["Acetoin", "name", null]);
  check("identify", "Greek letter name, no CAS", idf("γ-Nonalactone", "")[0] !== null && idf("γ-Nonalactone", "")[1], "norm");
  check("identify", "suspicious CAS falls back to name", idf("1-Butanol", "71-36-4").slice(0, 2), ["1-butanol", "name"]);
  check("identify", "date CAS falls back to name", idf("Acetic acid", "2019-06-04", true).slice(0, 2), ["acetic acid", "name"]);
  check("identify", "CAS from an Excel number", idf("Butyric acid", "107926").slice(0, 2), ["Butyric acid", "cas"]);
  check("identify", "CAS wins over a conflicting name", idf("Hexanal", "124-19-6"), ["Nonanal", "cas", "cas_name_conflict"]);
  check("identify", "valid CAS not in the knowledge base", idf("Cyclotetrasiloxane, octamethyl-", "556-67-2").slice(1), [null, "cas_not_in_kb"]);
  const typo = N.identify(idx, "Hexanall", "");
  check("identify", "typo: not adopted, offered as a candidate", [typo.kbId, typo.candidates.length > 0 && idx.info.get(typo.candidates[0].id).name], [null, "Hexanal"]);
  check("identify", "search by part of a name", N.search(idx, "decalactone").map(c => idx.info.get(c.id).name).some(n => /decalactone/i.test(n)), true);

  // ---------- examples: every peak identified as designed ----------
  for (const [file, sample] of [["example1_yogurt_agilent_style.csv", "Yogurt_H_rep1.D"], ["example2_milk_shimadzu_style.txt", "巴氏奶_A_1"], ["example3_gouda_thermo_style.xlsx", null]]) {
    const e = await readExample(file);
    const recs = M.toRecords(e.mapping, e.rows, { sample, decimalComma: false, dates: e.sheet.dates });
    const res = recs.map(r => N.identify(idx, r.name, r.cas, r.casIsDate));
    const unmatched = recs.filter((r, i) => !res[i].kbId).map(r => r.name);
    const expected = { "example1_yogurt_agilent_style.csv": ["Cyclotetrasiloxane, octamethyl-", "Cyclopentasiloxane, decamethyl-"],
      "example2_milk_shimadzu_style.txt": ["Cyclotrisiloxane, hexamethyl-", "Cyclopentasiloxane, decamethyl-"],
      "example3_gouda_thermo_style.xlsx": [] }[file];
    check("examples", file + ": only siloxanes (not in the knowledge base) unmatched", unmatched, expected);
    check("examples", file + ": no CAS / name conflicts", res.filter(r => r.note === "cas_name_conflict").length, 0);
  }

  // ---------- rules.js: peak grouping, rule 3 (standard file) and rule 2 ----------
  const R = GcmsRules;
  // records + identification, built like the page does
  function sampleOf(rows) {
    const recs = rows.map(([peak, name, cas, rt, area]) => ({ peak, name, cas, rt, area, casIsDate: false }));
    const ident = recs.map(r => { const a = N.identify(idx, r.name, r.cas, false); return { auto: a, kbId: a.kbId }; });
    return { recs, ident, peaks: R.groupPeaks(recs, ident) };
  }
  function targetsOf(rows) {
    return rows.map(([name, cas, rt]) => {
      const a = N.identify(idx, name, cas, false);
      return { name, cas, rt, ident: a, keys: R.idKeys(a.kbId, a.casNorm, a.casStatus, name) };
    });
  }
  const st = res => res.targets.map(t => t.status);

  const s1 = sampleOf([
    ["1", "2,3-Butanedione", "431-03-8", 8.90, 1000],
    ["2", "Furan, 2-pentyl-", "3777-69-3", 14.18, 500],
    ["2", "Hexanoic acid, ethyl ester", "123-66-0", 14.18, 500],     // same peak number: second library hit
    ["3", "Acetic acid", "64-19-7", 18.75, 700],
    ["4", "Acetic acid", "64-19-7", 18.83, 300],                     // split peak
    ["5", "Nonanal", "124-19-6", 17.60, 900],
  ]);
  check("rules", "hits sharing a peak number form one peak", [s1.peaks.length, s1.peaks.find(p => p.no === "2").hits.length], [5, 2]);
  const noNo = sampleOf([["", "Hexanal", "66-25-1", 11.06, 10], ["", "Octanal", "124-13-0", 11.0605, 5], ["", "Nonanal", "124-19-6", 17.5, 3]]);
  check("rules", "without peak numbers, identical RT = one peak", noNo.peaks.length, 2);

  const T1 = targetsOf([
    ["diacetyl", "431-03-8", 8.89], ["2-pentylfuran", "", 14.18], ["ethyl hexanoate", "", 14.22],
    ["acetic acid", "", 18.79], ["nonanal", "", 17.55], ["hexanal", "66-25-1", 11.06], ["1-octen-3-ol", "", 18.79],
  ]);

  // rules 2 and 1 (user decision 2026-10-20): within reference RT +- range, the target's peaks are
  // added up when no peak of another compound lies between them; rule 2 (nearest reference RT) first
  const m1 = R.sumInRange(s1.peaks, T1, 0.15);
  check("rule 1", "statuses (range 0.15)", st(m1),
    ["detected", "detected", "not_detected", "detected", "detected", "not_detected", "not_detected"]);
  const acet = m1.targets[3].peak;
  check("rule 1", "split acetic acid peaks (18.75, 18.83) in the range are added up", [acet.area, acet.merged.length], [1000, 2]);
  check("rule 1", "the sum keeps the RT of the larger peak and is logged", [acet.rt, m1.log.filter(l => l.kind === "summed").length], [18.75, 1]);
  check("rule 2", "co-eluting peak goes to the target with the closer reference RT", m1.targets[1].peak.no, "2");
  check("rule 2", "the other target is not found and told why", [m1.targets[2].lostTo, m1.log.filter(l => l.kind === "peak_to_closer_target").length], [1, 1]);
  check("rule 2", "several library hits: the standard file decides (logged)", m1.log.some(l => l.kind === "hit_chosen"), true);
  check("rule 1", "found by name only (no CAS in the standard file)", m1.targets[4].delta.toFixed(2), "0.05");
  check("rule 1", "no agreeing peak in the range: not found (no automatic pending)", m1.targets[6].status, "not_detected");
  check("manual", "peaks already added for another target are not offered", R.windowPeaks(s1.peaks, T1[6], 0.15, m1.used).length, 0);
  const TO = targetsOf([["1-octen-3-ol", "", 18.79]]);
  check("manual", "free peaks of the range offered for assigning by hand", R.windowPeaks(s1.peaks, TO[0], 0.15, new Set()).map(p => p.rt), [18.75, 18.83]);
  check("rule 1", "agreement by CAS for a compound outside the knowledge base",
    R.sumInRange(sampleOf([["1", "Cyclotetrasiloxane, octamethyl-", "556-67-2", 9.5, 10]]).peaks, targetsOf([["D4 siloxane", "556-67-2", 9.5]]), 0.1).targets[0].status, "detected");

  // no chain merging: only peaks within the range of the reference RT count
  const s3 = sampleOf([["1", "Hexanal", "66-25-1", 11.00, 1], ["2", "Hexanal", "66-25-1", 11.06, 8], ["3", "Hexanal", "66-25-1", 11.12, 2], ["4", "Hexanal", "66-25-1", 11.18, 4]]);
  const ch = R.sumInRange(s3.peaks, targetsOf([["hexanal", "66-25-1", 11.06]]), 0.07);
  check("rule 1", "no chain merging: 4 peaks 0.06 min apart, range 0.07 -> the 3 in range are added", [ch.targets[0].peak.area, ch.targets[0].peak.merged.length], [11, 3]);
  check("rule 1", "...the peak outside the range is logged, not added", ch.log.filter(l => l.kind === "elsewhere").map(l => l.rts), [[11.18]]);

  // another compound in between separates; the group with the peak nearest the reference RT is used
  const s2 = sampleOf([
    ["1", "Hexanal", "66-25-1", 11.06, 10], ["2", "Octanal", "124-13-0", 11.10, 5], ["3", "Hexanal", "66-25-1", 11.14, 4],
    ["4", "(E)-2-Octenal", "", 18.38, 8], ["5", "(Z)-2-Octenal", "", 18.40, 2],
  ]);
  const sp = R.sumInRange(s2.peaks, targetsOf([["hexanal", "66-25-1", 11.06], ["octanal", "124-13-0", 11.10], ["(E)-2-octenal", "", 18.38]]), 0.15);
  check("rule 1", "same compound with another compound in between: not added (nearest group used)", [sp.targets[0].peak.area, sp.targets[0].peak.rt], [10, 11.06]);
  check("rule 1", "...the separated peak is logged as a possible misidentification", sp.log.filter(l => l.kind === "separated").map(l => [l.target, l.rts]), [[0, [11.14]]]);
  check("rule 1", "the compound in between is found as itself", sp.targets[1].peak.area, 5);
  check("rule 1", "cis/trans isomers are never added together", sp.targets[2].peak.area, 8);
  const s5 = sampleOf([["1", "Hexanal", "66-25-1", 11.06, 10], ["2", "Cyclopentasiloxane, decamethyl-", "541-02-6", 11.09, 50], ["3", "Hexanal", "66-25-1", 11.12, 4]]);
  check("rule 1", "a siloxane peak in between also separates (user decision 2026-10-20)",
    R.sumInRange(s5.peaks, targetsOf([["hexanal", "66-25-1", 11.06]]), 0.15).targets[0].peak.area, 10);

  // a peak that rule 2 gives to another target is not added
  const s4 = sampleOf([["1", "Hexanal", "66-25-1", 11.06, 10], ["2", "Octanal", "124-13-0", 11.09, 5], ["2", "Hexanal", "66-25-1", 11.09, 5]]);
  const tk = R.sumInRange(s4.peaks, targetsOf([["hexanal", "66-25-1", 11.06], ["octanal", "124-13-0", 11.10]]), 0.15);
  check("rule 2", "a peak taken by the nearer target is not added to the other one", [tk.targets[0].peak.area, tk.targets[1].peak.area, tk.targets[0].status], [10, 5, "detected"]);

  // no reference RT: the range is centred on the compound's largest peak
  const nr = R.sumInRange(s1.peaks, targetsOf([["acetic acid", "", null]]), 0.15);
  check("rule 1", "no reference RT: centred on the largest peak, peaks in range added, flagged", [nr.targets[0].status, nr.targets[0].peak.area, nr.targets[0].peak.rt], ["no_rt", 1000, 18.75]);
  check("rule 1", "...and logged", nr.log.filter(l => l.kind === "no_rt_center").map(l => l.rt), [18.75]);

  // the range changes the result
  const TA = targetsOf([["acetic acid", "", 18.77]]);   // peaks at dRT -0.02 and +0.06
  const at = r => R.sumInRange(s1.peaks, TA, r).targets[0];
  check("range", "range 0.03: one acetic acid peak inside -> 700 at 18.75", [at(0.03).status, at(0.03).peak.area, at(0.03).peak.rt], ["detected", 700, 18.75]);
  check("range", "range 0.07: both inside -> added (1000)", at(0.07).peak.area, 1000);
  check("range", "range 0.01: no peak inside -> not detected", at(0.01).status, "not_detected");
  check("range", "range 0: only exact reference RTs", st(R.sumInRange(s1.peaks, targetsOf([["2-pentylfuran", "", 14.18], ["nonanal", "", 17.55]]), 0)), ["detected", "not_detected"]);

  // whole run: relative content, peaks assigned by hand
  const run1 = R.run(s1.recs, s1.ident, T1, { range: 0.15 }, new Map());
  check("run", "relative content from areas when the file has none (added acetic acid = 1000 / 3400)",
    +run1.rows[3].rel.toFixed(2), 29.41);
  check("run", "not found -> no value", [run1.rows[5].found, run1.rows[5].rel], [false, null]);
  check("run", "relative content source", run1.relSource, "area");
  const TM = targetsOf([["mystery compound", "", 17.58]]);
  const tolM = { range: 0.05 };
  const nm = R.run(s1.recs, s1.ident, TM, tolM, new Map());
  check("manual", "free peak in the range, other identification: not found", [nm.rows[0].status, nm.rows[0].found], ["not_detected", false]);
  const am = R.run(s1.recs, s1.ident, TM, tolM, new Map([[0, "p5"]]));
  check("manual", "assigned by hand: counted, with its relative content", [am.rows[0].status, am.rows[0].found, +am.rows[0].rel.toFixed(2)], ["manual", true, 26.47]);
  const TM2 = targetsOf([["nonanal", "", 17.55], ["mystery compound", "", 17.58]]);
  check("manual", "a peak used by a found target cannot be assigned", R.run(s1.recs, s1.ident, TM2, tolM, new Map([[1, "p5"]])).rows[1].status, "not_detected");
  const TM3 = targetsOf([["mystery A", "", 17.58], ["mystery B", "", 17.62]]);
  check("manual", "one peak can be assigned to one target only",
    R.run(s1.recs, s1.ident, TM3, tolM, new Map([[0, "p5"], [1, "p5"]])).rows.map(r => r.status), ["manual", "not_detected"]);
  check("manual", "a peak outside the range cannot be assigned", R.run(s1.recs, s1.ident, TM, tolM, new Map([[0, "p1"]])).rows[0].status, "not_detected");

  // Agilent MassHunter library-search report: hits 2 to 5 are rows without number, RT and area
  const mh = sampleOf([["1", "Heptanal", "000111-71-7", 3.909, 32159], ["", "Cyclohexane, 1,2,3-trimethyl-", "001678-97-3", null, null],
    ["", "Hexanal", "66-25-1", null, null], ["2", "Octanal", "124-13-0", 10.72, 900], ["", "Nonanal", "124-19-6", null, null]]);
  check("continuation", "rows without number, RT and area are further candidates of the previous peak",
    [mh.peaks.length, mh.peaks.map(p => p.hits.length)], [2, [3, 2]]);
  check("continuation", "a target that is candidate 3 of a peak in its range is found (rule 2)",
    R.sumInRange(mh.peaks, targetsOf([["hexanal", "66-25-1", 3.95]]), 0.15).targets[0].status, "detected");
  check("continuation", "MassHunter LibRes header (Chinese)", M.guessMapping(["化合物编号 (#)", "保留时间 (分)", "扫描编号 (#)", "面积 (Ab*s)", "基线高度 (Ab)",
    "绝对高度 (Ab)", "峰宽 50% (分)", "匹配项数量", "匹配项名称", "定性", "分子量 (amu)", "CAS 编号", "谱库", "条目编号谱库"]),
    ["peak", "rt", null, "area", null, null, null, null, "name", "match", null, "cas", null, null]);
  const withRel = s1.recs.map((r, i) => Object.assign({}, r, { rel: [10, 5, 5, 7, 3, 9][i] }));
  check("run", "relative content column used and added for peaks added by rule 1",
    [R.run(withRel, s1.ident, T1, { range: 0.15 }, new Map()).rows[3].rel, R.run(withRel, s1.ident, T1, { range: 0.15 }, new Map()).relSource], [10, "column"]);

  // ---------- flavor.js: OAV, ROAV, profile ----------
  const F = GcmsFlavor;
  const FLI = F.buildIndex(await (await fetch("../data/flavor.json")).json());
  check("standard file", "threshold headers: 阈值 (µg/kg), Odor threshold (mg/kg), OT; not read as an amount",
    ["阈值 (µg/kg)", "Odor threshold (mg/kg)", "OT"].map(h => M.guessMapping([h, "Compound"], M.TARGET_FIELDS)), [["thr", "name"], ["thr", "name"], ["thr", "name"]]);
  check("flavor", "unit from header: Calc. Amt. (µg/kg), Conc (mg/L), ng/g, ppt, Amount",
    ["Calc. Amt. (µg/kg)", "Conc (mg/L)", "Konz. ng/g", "Amount (ppt)", "Amount"].map(F.guessUnit), ["ug_kg", "mg_kg", "ug_kg", "ng_kg", null]);
  const oav = F.compute([{ value: 10, thr: 0.001 }, { value: 0.5, thr: 0.001 }, { value: 3, thr: null }, { value: null, thr: 0.1 }], "oav");
  check("flavor", "OAV = ug/kg / (mg/kg x 1000); I = log10 OAV only above 1; missing threshold / value",
    oav.rows.map(r => [r.score, r.I, r.status]), [[10, 1, "ok"], [0.5, 0, "ok"], [null, 0, "no_threshold"], [null, 0, "no_value"]]);
  const roav = F.compute([{ value: 10, thr: 0.1 }, { value: 5, thr: 0.01 }, { value: 1, thr: 1 }], "roav");
  check("flavor", "ROAV: largest content/threshold = 100", roav.rows.map(r => +r.score.toFixed(6)), [20, 100, 0.2]);
  check("flavor", "ROAV intensities", roav.rows.map(r => +r.I.toFixed(6)), [+Math.log10(20).toFixed(6), 2, 0]);
  const pr = F.compute([{ value: 100, thr: 0.001, lift: [2, 0, 0] }, { value: 10, thr: 0.001, lift: [0, 1, 1] },
    { value: 0.1, thr: 0.001, lift: [0, 0, 9] }, { value: 50, thr: 0.001, lift: null }], "oav");
  // I = 2 and 1: profile = (4, 1, 1) / 6; the third (I = 0) and fourth (no lift) are left out
  check("flavor", "profile = L1-normalized sum of I x lift (I = 0 and no-lift compounds left out)",
    [Array.from(pr.profile, v => +v.toFixed(6)), pr.nProfile], [[+(4 / 6).toFixed(6), +(1 / 6).toFixed(6), +(1 / 6).toFixed(6)], 2]);
  check("flavor", "no profile when every intensity is 0", F.compute([{ value: 1, thr: 1, lift: [1] }], "oav").profile, null);
  const kbOf = cas => [...(idx.byCas.get(cas) || [])][0];
  const dia = kbOf("431-03-8");
  check("flavor", "diacetyl threshold 0.001 mg/kg (Czerny et al. 2008)", [F.threshold(FLI, dia).mg_kg, F.threshold(FLI, dia).src], [0.001, "Czerny et al. (2008)"]);
  const pent = kbOf("600-14-6"), dairyI = FLI.labels.findIndex(l => l.id === "dairy");
  check("flavor", "2,3-pentanedione dairy lift as in flavor-improver (5.476)", +F.lift(FLI, pent)[dairyI].toFixed(1), 5.5);
  check("flavor", "descriptors: Dunkel first (2-methylbutanal: malty)", F.descriptors(FLI, kbOf("96-17-3")), { src: "dunkel", terms: ["malty"] });
  check("flavor", "descriptors: FlavorDB when no Dunkel entry", F.descriptors(FLI, pent).src, "flavordb");
  const gnnOnly = Object.keys(FLI.compounds).find(k => !FLI.compounds[k].d && !FLI.compounds[k].f && FLI.compounds[k].p);
  const dg = F.descriptors(FLI, gnnOnly, 3);
  check("flavor", "descriptors: GNN top 3 when the knowledge base has none", [dg.src, dg.labels.length], ["gnn", 3]);
  check("flavor", "unknown compound: no threshold, lift or descriptors", [F.threshold(FLI, null), F.lift(FLI, "nope"), F.descriptors(FLI, null).src], [null, null, null]);
  // profile views: dairy 12 (lift, fixed order, renormalized) and all 138 (probabilities, top 10)
  const pv = new Float64Array(FLI.labels.length);
  F.DAIRY_DIMS.forEach((d, k) => { pv[FLI.labels.findIndex(l => l.id === d)] = k + 1; });
  pv[FLI.labels.findIndex(l => l.id === "cucumber")] = 100;
  const dv = F.viewDims(FLI, pv, "dairy");
  check("flavor", "dairy view: the 12 flavor-improver dimensions in order, renormalized (other labels ignored)",
    [dv.map(([i]) => FLI.labels[i].id), +dv.reduce((a, [, v]) => a + v, 0).toFixed(9), +dv[11][1].toFixed(6)], [F.DAIRY_DIMS, 1, +(12 / 78).toFixed(6)]);
  check("flavor", "all view: the 10 largest labels", [F.viewDims(FLI, pv, "all").length, FLI.labels[F.viewDims(FLI, pv, "all")[0][0]].id], [10, "cucumber"]);
  check("flavor", "weights: lift for dairy, probabilities for all",
    [+F.weights(FLI, pent, "dairy")[dairyI].toFixed(1), F.weights(FLI, pent, "all")[dairyI]], [5.5, 0.138]);
  check("flavor", "radar: one axis per dimension", (F.radarSvg(F.topDims(pr.profile, 3).map(([i, v]) => ({ label: "L" + i, value: v }))).match(/<line /g) || []).length, 3);

  // examples: the whole pipeline with the example standard files and tolerances
  for (const [ex, file, std, sample] of [
    ["example1", "example1_yogurt_agilent_style.csv", "standard_example1_yogurt.csv", "Yogurt_H_rep1.D"],
    ["example2", "example2_milk_shimadzu_style.txt", "standard_example2_milk.csv", "巴氏奶_A_1"],
    ["example3", "example3_gouda_thermo_style.xlsx", "standard_example3_gouda.csv", null]]) {
    const e = await readExample(file);
    const recs = M.toRecords(e.mapping, e.rows, { sample, decimalComma: false, dates: e.sheet.dates });
    const ident = recs.map(r => { const a = N.identify(idx, r.name, r.cas, r.casIsDate); return { auto: a, kbId: a.kbId }; });
    const sf = await IO.readFile(await file_(std));
    const sh = sf.sheets[0], hi = M.detectHeaderRow(sh.rows, false, M.TARGET_FIELDS);
    const tm = M.guessMapping(sh.rows[hi], M.TARGET_FIELDS);
    check("standard file", ex + ": threshold column found, unit from its header",
      [tm.includes("thr"), F.guessUnit(sh.rows[hi][tm.indexOf("thr")])], [true, "ug_kg"]);
    const thrUnit = F.guessUnit(sh.rows[hi][tm.indexOf("thr")]);
    const tg = M.toRecords(tm, M.dataRows(sh.rows, hi), { sample: null, decimalComma: false, dates: sh.dates }).map(r => {
      const a = N.identify(idx, r.name, r.cas, r.casIsDate);
      return Object.assign(r, { ident: a, keys: R.idKeys(a.kbId, a.casNorm, a.casStatus, r.name) });
    });
    const out = R.run(recs, ident, tg, { range: 0.15 }, new Map());
    const missing = out.rows.map((r, i) => (r.found ? null : tg[i].name)).filter(Boolean);
    const expect = { example1: ["ethyl hexanoate", "2-methylbutanoic acid", "1-octen-3-ol", "dimethyl sulfide"], example2: [], example3: [] }[ex];
    if (ex === "example1") {
      const k = tg.findIndex(t => t.name === "2-methylbutanoic acid");
      check("examples", "example1: 2-methylbutanoic acid not found, the pentanoic acid peak can be assigned by hand",
        [out.rows[k].status, R.windowPeaks(out.peaks, tg[k], 0.15, out.taken).map(p => p.hits[0].name)], ["not_detected", ["Pentanoic acid"]]);
    }
    check("examples", ex + ": targets not found", missing, expect);

    // flavor step on the example: same inputs as the page (OAV with the amount column, else ROAV from areas)
    const found = out.rows.map((r, i) => [r, i]).filter(([r]) => r.found);
    const mode = found.some(([r]) => r.conc != null) ? "oav" : "roav";
    const items = found.map(([r, i]) => ({
      value: mode === "oav" ? r.conc : r.area,
      // the standard file's threshold (converted to mg/kg) first, as on the page
      thr: tg[i].thr != null ? (tg[i].thr * F.UNITS[thrUnit]) / 1000 : (F.threshold(FLI, tg[i].ident.kbId) || {}).mg_kg,
      lift: F.lift(FLI, tg[i].ident.kbId),
    }));
    const fc = F.compute(items, mode);
    check("flavor", ex + ": mode", mode, ex === "example3" ? "oav" : "roav");
    check("flavor", ex + ": every found target has a built-in threshold and a GNN prediction",
      [fc.rows.filter(r => r.status !== "ok").length, items.filter(x => !x.lift).length], [0, 0]);
    if (ex === "example1") check("standard file", "example1: diacetyl 1 µg/kg read as 0.001 mg/kg", items[found.findIndex(([, i]) => tg[i].name === "diacetyl")].thr, 0.001);
    if (mode === "roav") check("flavor", ex + ": largest ROAV is 100", Math.max(...fc.rows.map(r => r.score)), 100);
    check("flavor", ex + ": profile sums to 1", fc.profile && Math.abs(fc.profile.reduce((x, y) => x + y, 0) - 1) < 1e-9, true);
  }

  // ---------- report ----------
  const passed = results.filter(r => r.ok).length;
  document.getElementById("rows").innerHTML = results.map((r, i) =>
    "<tr><td>" + (i + 1) + "</td><td>" + r.group + "</td><td>" + r.name.replace(/</g, "&lt;") + "</td><td class=\"" +
    (r.ok ? "pass\">PASS" : "fail\">FAIL " + r.detail.replace(/</g, "&lt;")) + "</td></tr>").join("");
  const s = document.getElementById("summary");
  s.textContent = (passed === results.length ? "PASS " : "FAIL ") + passed + "/" + results.length;
  s.className = passed === results.length ? "pass" : "fail";
  s.dataset.status = passed === results.length ? "pass" : "fail";
})().catch(e => {
  const s = document.getElementById("summary");
  s.textContent = "ERROR " + e;
  s.className = "fail";
  s.dataset.status = "error";
});
