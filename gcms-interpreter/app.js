/*
 * GC-MS flavor interpreter: page logic.
 * Scope (user decisions 2026-10-17/18): one file = one sample's peak table; only the compounds
 * of the user's standard file (target list) matter. The result lists every target with its
 * relative content, or "-" when not found. Batch work is offered by email.
 *
 * Flow: import peak table + standard file -> check the columns of both -> one confirmation
 * ("the two files above are read correctly") -> tolerances -> run -> result table (CSV export;
 * a target that was not found can be assigned a free peak of its window by hand) and processing log -> flavor: OAV or ROAV with editable odor
 * thresholds, key flavor compound ranking (CSV export), flavor profile radar.
 * All data the page needs is fetched from this site when the page loads, so it keeps
 * working offline; user files are only read in memory.
 */
(async function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const PREVIEW_ROWS = 12;
  const VERSION = new URL(document.currentScript.src).search;   // "?v=...": data files of a new version bypass the cache

  async function getJson(url) {
    const res = await fetch(url + VERSION);
    if (!res.ok) throw new Error("Failed to load " + url);
    return res.json();
  }
  async function getBytes(url) {
    const res = await fetch(url + VERSION);
    if (!res.ok) throw new Error("Failed to load " + url);
    return res.arrayBuffer();
  }

  // ---------- Preload everything (offline use after this point) ----------
  const [dict, builtin, examples, profile, namesJson, flavorJson] = await Promise.all([
    getJson("data/column_keywords.json"),
    getJson("data/templates.json"),
    getJson("examples/examples.json"),
    getJson("../assets/profile.json").catch(() => ({})),
    getJson("data/names.json"),
    getJson("data/flavor.json"),
    I18N.ready,
  ]);
  GcmsMapping.setDictionary(dict);
  const nameIndex = GcmsNames.buildIndex(namesJson);
  const FL = GcmsFlavor.buildIndex(flavorJson);
  const exampleFiles = {};
  const exampleStd = {};
  await Promise.all(Object.entries(examples.examples).map(async ([id, ex]) => {
    exampleFiles[id] = new File([await getBytes("examples/" + ex.file)], ex.file);
    const std = examples.standards[id];
    exampleStd[id] = new File([await getBytes("examples/" + std)], std);
  }));

  // ---------- State ----------
  const S = {
    file: null,          // peak table: result of GcmsIO.readFile
    sheet: 0,
    headerIndex: 0,
    mapping: [],         // per column: field id or null
    decimalComma: false,
    autoNote: null,      // {key, vars}: how the mapping was obtained
    templateName: null,  // template applied to the current file, if any
    sample: null,        // the one sample processed
    records: null,       // set by the confirmation
    ident: null,
    exampleId: null,
  };
  const STD = { file: null, headerIndex: 0, mapping: [], targets: null, thrUnit: null };   // thrUnit null = from the header
  const RUN = { ready: false, result: null, tol: null, manual: new Map(), open: new Set(), stale: false };

  const rows = () => S.file.sheets[S.sheet].rows;
  const header = () => rows()[S.headerIndex] || [];
  const data = () => GcmsMapping.dataRows(rows(), S.headerIndex);
  const samples = () => GcmsMapping.samplesIn(S.mapping, data());
  const stdRows = () => STD.file.sheets[0].rows;
  const stdData = () => GcmsMapping.dataRows(stdRows(), STD.headerIndex);
  const TF = GcmsMapping.TARGET_FIELDS;

  /** Anything about the files changed: the confirmation and the results no longer hold. */
  function invalidate() {
    RUN.ready = false;
    RUN.result = null;
    RUN.manual = new Map();
    RUN.open = new Set();
    S.records = null;
    S.ident = null;
    STD.targets = null;
  }

  // ---------- Scope notice (single sample; the batch-by-email note is on the about page) ----------
  function renderScope() {
    $("scope-upload").innerHTML = esc(I18N.t("scope.upload"));
  }

  function download(text, name, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function dropZone(zoneId, inputId, onFile) {
    const input = $(inputId), zone = $(zoneId);
    input.addEventListener("change", () => { if (input.files[0]) onFile(input.files[0]); input.value = ""; });
    ["dragenter", "dragover"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add("over"); }));
    ["dragleave", "drop"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove("over"); }));
    zone.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) onFile(f); });
  }

  // ---------- Peak table ----------
  function setStatus(key, vars, isError) {
    const el = $("import-status");
    el.textContent = key ? I18N.t(key, vars) : "";
    el.classList.toggle("error", !!isError);
  }

  async function load(file, exampleId) {
    try {
      S.file = await GcmsIO.readFile(file);
    } catch (e) {
      console.error(e);
      setStatus(e.code === "excel_lib" ? "err.excel_lib" : "err.read", { name: file.name }, true);
      return;
    }
    S.exampleId = exampleId || null;
    S.sheet = Math.max(0, S.file.sheets.findIndex(s => s.rows.length > 1));
    S.decimalComma = S.file.decimalComma;
    invalidate();
    setStatus(exampleId ? "import.loaded_example" : "import.loaded", { name: file.name });
    autoDetect();
    renderAll();
  }

  /** Header row and mapping from a matching template if any, else from the dictionary. */
  function autoDetect() {
    S.headerIndex = GcmsMapping.detectHeaderRow(rows(), S.decimalComma);
    const tpl = GcmsMapping.findTemplate(allTemplates(), header());
    S.templateName = tpl ? tpl.name : null;
    if (tpl) {
      S.mapping = GcmsMapping.applyTemplate(tpl, header());
      S.autoNote = { key: "map.auto_tpl", vars: { name: tpl.name } };
    } else {
      S.mapping = GcmsMapping.guessMapping(header());
      S.autoNote = { key: "map.auto_dict" };
    }
    pickSample();
  }

  /**
   * The sample processed: the first one in the sample column (the user may pick another),
   * else a "Sample name" entry in the lines above the header, else the file name.
   */
  function pickSample() {
    const list = samples();
    if (list.length) {
      if (!list.includes(S.sample)) S.sample = list[0];
      return;
    }
    S.sample = null;
    for (const r of rows().slice(0, S.headerIndex)) {
      const k = r.findIndex(c => GcmsMapping.guessField(c) === "sample");
      if (k >= 0 && r[k + 1]) { S.sample = r[k + 1]; return; }
    }
    S.sample = S.file.fileName.replace(/\.[^.]+$/, "");
  }

  dropZone("drop", "file-input", f => load(f));
  document.querySelectorAll("[data-example]").forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.example;
    await load(exampleFiles[id], id);
    await loadStd(exampleStd[id], true);
    setTolerances(examples.examples[id].tolerances, true);
  }));

  $("dl-template").addEventListener("click", e => {
    e.preventDefault();
    download("﻿Peak,Compound,CAS,RT (min),RI,Area,Area %,Match\n" +
      "1,Diacetyl,431-03-8,8.85,980,2673,0.06,91\n2,Hexanal,66-25-1,11.08,1083,16036,0.34,84\n",
      "gcms_peak_table_template.csv", "text/csv");
  });

  // ---------- Templates ----------
  const allTemplates = () => builtin.templates.concat(GcmsMapping.loadTemplates());

  function renderTemplates() {
    const sel = $("tpl-select");
    sel.innerHTML = "";
    allTemplates().forEach((t, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = (t.builtin ? "" : "★ ") + t.name;
      o.selected = t.name === S.templateName;
      sel.appendChild(o);
    });
  }
  $("tpl-apply").addEventListener("click", () => {
    const t = allTemplates()[+$("tpl-select").value];
    if (!t || !S.file) return;
    S.templateName = t.name;
    S.mapping = GcmsMapping.applyTemplate(t, header());
    S.autoNote = { key: "map.auto_tpl", vars: { name: t.name } };
    pickSample();
    invalidate();
    renderAll();
  });
  $("tpl-save").addEventListener("click", () => {
    const name = $("tpl-name").value.trim();
    if (!name) { $("tpl-status").textContent = I18N.t("tpl.need_name"); return; }
    if (!S.file) return;
    const mine = GcmsMapping.loadTemplates().filter(t => t.name !== name);
    mine.push(GcmsMapping.makeTemplate(name, header(), S.mapping));
    const ok = GcmsMapping.saveTemplates(mine);
    $("tpl-status").textContent = I18N.t(ok ? "tpl.saved" : "tpl.storage_off", { name });
    renderTemplates();
  });
  $("tpl-delete").addEventListener("click", () => {
    const t = allTemplates()[+$("tpl-select").value];
    if (!t) return;
    if (t.builtin) { $("tpl-status").textContent = I18N.t("tpl.builtin"); return; }
    GcmsMapping.saveTemplates(GcmsMapping.loadTemplates().filter(x => x.name !== t.name));
    $("tpl-status").textContent = I18N.t("tpl.deleted", { name: t.name });
    renderTemplates();
  });

  // ---------- Column mapping (shared by both files) ----------
  function fieldOptions(current, fields) {
    const opts = [["", I18N.t("field.none")]].concat(fields.map(f => [f, I18N.t("field." + f)]));
    return opts.map(([v, l]) => '<option value="' + v + '"' + (v === (current || "") ? " selected" : "") + ">" + esc(l) + "</option>").join("");
  }

  /** Rows around the header with a field selector above every column; onChange(column, field|null). */
  function renderPreview(table, allRows, headerIndex, mapping, fields, onChange) {
    const ncol = Math.max(...allRows.slice(headerIndex, headerIndex + PREVIEW_ROWS).map(r => r.length), 1);
    let html = "<thead><tr>";
    for (let j = 0; j < ncol; j++) {
      html += '<th class="' + (mapping[j] ? "mapped" : "") + '"><select data-col="' + j + '" aria-label="' +
        esc(I18N.t("map.col_aria", { n: j + 1 })) + '">' + fieldOptions(mapping[j], fields) + "</select></th>";
    }
    html += "</tr></thead><tbody>";
    const start = Math.max(0, headerIndex - 2);
    allRows.slice(start, headerIndex + PREVIEW_ROWS).forEach((r, k) => {
      const i = start + k;
      html += '<tr class="' + (i === headerIndex ? "hdr" : i < headerIndex ? "skip" : "") + '">';
      for (let j = 0; j < ncol; j++) html += "<td>" + esc(r[j]) + "</td>";
      html += "</tr>";
    });
    table.innerHTML = html + "</tbody>";
    table.querySelectorAll("select[data-col]").forEach(sel => sel.addEventListener("change", e => {
      onChange(+e.target.dataset.col, e.target.value || null);
    }));
  }

  $("header-row").addEventListener("change", e => {
    if (!S.file) return;
    S.headerIndex = Math.max(1, Math.min(rows().length, parseInt(e.target.value, 10) || 1)) - 1;
    S.mapping = GcmsMapping.guessMapping(header());
    S.autoNote = { key: "map.auto_manual" };
    pickSample();
    invalidate();
    renderAll();
  });
  $("sample-select").addEventListener("change", e => { S.sample = e.target.value; invalidate(); renderAll(); });
  $("decimal-comma").addEventListener("change", e => { if (!S.file) return; S.decimalComma = e.target.checked; invalidate(); renderAll(); });

  function peakWarnings() {
    const w = [];
    const has = f => S.mapping.includes(f);
    if (!has("name") && !has("cas")) w.push(I18N.t("warn.no_id"));
    if (!has("rt")) w.push(I18N.t("warn.no_rt"));
    if (!has("area") && !has("rel")) w.push(I18N.t("warn.no_value"));
    const counts = {};
    S.mapping.forEach(m => { if (m) counts[m] = (counts[m] || 0) + 1; });
    Object.entries(counts).filter(([, n]) => n > 1).forEach(([f]) => w.push(I18N.t("warn.dup", { field: I18N.t("field." + f) })));
    return w;
  }
  const peakMappingOk = () => S.file && (S.mapping.includes("name") || S.mapping.includes("cas")) && S.mapping.includes("rt") &&
    (S.mapping.includes("area") || S.mapping.includes("rel"));

  function renderSamplePicker() {
    const list = samples();
    const multi = list.length > 1;
    $("sample-wrap").classList.toggle("hidden", !multi);
    $("multi-sample").classList.toggle("hidden", !multi);
    if (!multi) return;
    $("sample-select").innerHTML = list.map(s => '<option value="' + esc(s) + '"' + (s === S.sample ? " selected" : "") + ">" + esc(s) + "</option>").join("");
    const email = profile.email || "";
    $("multi-sample").innerHTML = esc(I18N.t("scope.multi", { n: list.length })) +
      (email ? ' <a href="mailto:' + esc(email) + '">' + esc(email) + "</a>" + esc(I18N.t("scope.end")) : "");
  }

  function renderMap() {
    const box = $("step-map");
    if (!S.file) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    $("header-row").value = S.headerIndex + 1;
    $("header-row").max = rows().length;
    $("decimal-comma").checked = S.decimalComma;
    $("decimal-comma-wrap").classList.toggle("hidden", S.file.kind !== "text");
    $("map-auto").textContent = S.autoNote ? I18N.t(S.autoNote.key, S.autoNote.vars) : "";
    renderSamplePicker();
    renderPreview($("preview"), rows(), S.headerIndex, S.mapping, GcmsMapping.FIELDS, (j, v) => {
      S.mapping[j] = v;
      S.autoNote = { key: "map.auto_manual" };
      pickSample();
      invalidate();
      renderAll();
    });
    $("map-warnings").innerHTML = peakWarnings().map(w => "<li>" + esc(w) + "</li>").join("");
  }

  // ---------- Standard file (target list) ----------
  function setStdStatus(key, vars, isError) {
    const el = $("std-status");
    el.textContent = key ? I18N.t(key, vars) : "";
    el.classList.toggle("error", !!isError);
  }

  function useStd(parsed, isExample) {
    STD.file = parsed;
    STD.headerIndex = GcmsMapping.detectHeaderRow(stdRows(), parsed.decimalComma, TF);
    STD.mapping = GcmsMapping.guessMapping(stdRows()[STD.headerIndex] || [], TF);
    STD.thrUnit = null;
    invalidate();
    setStdStatus(isExample ? "std.loaded_example" : "std.loaded", { name: parsed.fileName });
    renderAll();
  }

  async function loadStd(file, isExample) {
    try {
      const parsed = await GcmsIO.readFile(file);
      // a standard file holds one table: use the first sheet that has data
      const k = Math.max(0, parsed.sheets.findIndex(sh => sh.rows.length > 1));
      parsed.sheets = [parsed.sheets[k]];
      useStd(parsed, isExample);
    } catch (e) {
      console.error(e);
      setStdStatus("err.read", { name: file.name }, true);
    }
  }

  dropZone("std-drop", "std-input", f => loadStd(f));
  $("std-paste-btn").addEventListener("click", () => {
    const text = $("std-paste").value;
    if (!text.trim()) { setStdStatus("std.paste_empty", null, true); return; }
    const delimiter = GcmsIO.detectDelimiter(text);
    const pasted = GcmsIO.parseDelimited(text, delimiter);
    useStd({ kind: "paste", fileName: I18N.t("std.pasted"), encoding: null, delimiter,
             decimalComma: GcmsIO.detectDecimalComma(pasted, delimiter), sheets: [{ name: "paste", rows: pasted, dates: new Set() }] });
  });
  $("std-clear").addEventListener("click", () => {
    STD.file = null;
    invalidate();
    setStdStatus("std.cleared");
    renderAll();
  });
  $("dl-std-template").addEventListener("click", e => {
    e.preventDefault();
    download("﻿Compound,CAS,Reference RT (min),Odor threshold (µg/kg),RI,Quant ion,Note\n" +
      "Diacetyl,431-03-8,8.89,1,980,86,\nHexanal,66-25-1,11.06,2.4,1083,56,\n", "gcms_standard_file_template.csv", "text/csv");
  });
  $("std-header-row").addEventListener("change", e => {
    if (!STD.file) return;
    STD.headerIndex = Math.max(1, Math.min(stdRows().length, parseInt(e.target.value, 10) || 1)) - 1;
    STD.mapping = GcmsMapping.guessMapping(stdRows()[STD.headerIndex] || [], TF);
    invalidate();
    renderAll();
  });
  const stdMappingOk = () => STD.file && (STD.mapping.includes("name") || STD.mapping.includes("cas"));

  function renderStd() {
    const box = $("std-step-map"), info = $("std-file-info");
    if (!STD.file) { box.classList.add("hidden"); info.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    info.classList.remove("hidden");
    info.innerHTML = "<span>" + esc(I18N.t("info.file")) + ": <b>" + esc(STD.file.fileName) + "</b></span>" +
      (STD.file.encoding ? "<span>" + esc(I18N.t("info.encoding")) + ": <b>" + esc(STD.file.encoding) + "</b></span>" : "") +
      "<span>" + esc(I18N.t("info.rows")) + ": <b>" + stdRows().length + "</b></span>";
    $("std-header-row").value = STD.headerIndex + 1;
    renderPreview($("std-preview"), stdRows(), STD.headerIndex, STD.mapping, TF, (j, v) => {
      STD.mapping[j] = v;
      invalidate();
      renderAll();
    });
    const w = [];
    if (!STD.mapping.includes("name") && !STD.mapping.includes("cas")) w.push(I18N.t("warn.no_id"));
    if (!STD.mapping.includes("rt")) w.push(I18N.t("std.warn_no_rt"));
    if (!STD.mapping.includes("thr")) w.push(I18N.t("std.warn_no_thr"));
    $("std-warnings").innerHTML = w.map(x => "<li>" + esc(x) + "</li>").join("");
    // threshold column: unit from its header, or chosen here
    const hasThr = STD.mapping.includes("thr");
    $("std-thr-unit-wrap").classList.toggle("hidden", !hasThr);
    const guess = stdThrGuess(), unit = stdThrUnit();
    $("std-thr-unit").innerHTML = Object.keys(GcmsFlavor.UNITS).map(u =>
      '<option value="' + u + '"' + (u === unit ? " selected" : "") + ">" + esc(I18N.t("fl.unit_" + u)) + "</option>").join("");
    $("std-thr-note").textContent = !hasThr ? "" : I18N.t(STD.thrUnit ? "std.thr_unit_user" : guess ? "std.thr_unit_header" : "std.thr_unit_default",
      { col: (stdRows()[STD.headerIndex] || [])[STD.mapping.indexOf("thr")] });
  }
  function stdThrGuess() {
    const j = STD.mapping.indexOf("thr");
    return j >= 0 ? GcmsFlavor.guessUnit((stdRows()[STD.headerIndex] || [])[j]) : null;
  }
  const stdThrUnit = () => STD.thrUnit || stdThrGuess() || "mg_kg";
  $("std-thr-unit").addEventListener("change", e => { STD.thrUnit = e.target.value; invalidate(); renderAll(); });

  // ---------- One confirmation for both files ----------
  function renderConfirm() {
    const box = $("step-confirm");
    box.classList.toggle("hidden", !S.file && !STD.file);
    const missing = !S.file ? "confirm.need_peak" : !STD.file ? "confirm.need_std"
      : !peakMappingOk() || !stdMappingOk() ? "confirm.need_cols" : null;
    $("files-confirm").disabled = !!missing;
    $("confirm-msg").textContent = missing ? I18N.t(missing) : RUN.ready ? I18N.t("confirm.done") : "";
  }

  /** Progress bar under the confirmation button; null hides it. */
  function setProgress(done, total) {
    const box = $("confirm-progress");
    box.classList.toggle("hidden", total == null);
    document.body.classList.toggle("busy", total != null);
    if (total == null) return;
    $("confirm-bar").value = total ? Math.round((100 * done) / total) : 0;
    $("confirm-progress-text").textContent = I18N.t("confirm.progress", { done, total });
  }
  const nextFrame = () => new Promise(r => setTimeout(r, 0));
  const CHUNK = 200;   // rows identified between two progress updates

  let confirming = false;
  $("files-confirm").addEventListener("click", async () => {
    if (confirming || !S.file || !STD.file || !peakMappingOk() || !stdMappingOk()) return;
    confirming = true;
    $("files-confirm").disabled = true;
    try {
      await confirmFiles();
    } finally {
      confirming = false;
      setProgress(null);
      renderAll();
    }
    if (RUN.ready) $("step-match").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  async function confirmFiles() {
    S.records = GcmsMapping.toRecords(S.mapping, data(), {
      sample: samples().length ? S.sample : null, decimalComma: S.decimalComma, dates: S.file.sheets[S.sheet].dates,
    });
    // library hits repeat (the same name and CAS in many rows): identify each distinct one once
    const memo = new Map();
    const ident = r => {
      const k = r.name + "|" + r.cas + "|" + r.casIsDate;
      if (!memo.has(k)) memo.set(k, GcmsNames.identify(nameIndex, r.name, r.cas, r.casIsDate, false));
      return memo.get(k);
    };
    const recs = GcmsMapping.toRecords(STD.mapping, stdData(), { sample: null, decimalComma: STD.file.decimalComma, dates: STD.file.sheets[0].dates });
    const total = S.records.length + recs.length;
    setProgress(0, total);
    await nextFrame();
    S.ident = [];
    for (let k = 0; k < S.records.length; k++) {
      const a = ident(S.records[k]);
      S.ident.push({ auto: a, kbId: a.kbId });
      if ((k + 1) % CHUNK === 0) { setProgress(k + 1, total); await nextFrame(); }
    }
    setProgress(S.records.length, total);
    await nextFrame();
    STD.targets = recs.map(r => {
      const a = ident(r);
      const kb = a.kbId && nameIndex.info.get(a.kbId);
      const base = r.name || (kb && kb.name) || "";
      return Object.assign(r, {
        ident: a, keys: GcmsRules.idKeys(a.kbId, a.casNorm, a.casStatus, r.name),
        // standard files may list CAS only: name from the knowledge base, else (after the run) from the matched library hit
        baseLabel: base, label: base || a.casNorm || r.cas || "",
        thrFile: r.thr != null && r.thr > 0 ? (r.thr * GcmsFlavor.UNITS[stdThrUnit()]) / 1000 : null,   // mg/kg
      });
    });
    setProgress(total, total);
    RUN.ready = true;
    RUN.result = null;
    RUN.manual = new Map();
    RUN.open = new Set();
  }

  // ---------- Retention time range (saved in this browser) ----------
  // One setting since 2026-10-20 (rule 1 = add up within reference RT +- range); settings saved
  // before that hold {window, merge}: the window becomes the range, the merge tolerance is dropped.
  const TOL_KEY = "gcms-tolerances";
  const TOL = { range: null, fromExample: false };
  try {
    const saved = JSON.parse(localStorage.getItem(TOL_KEY) || "{}") || {};
    TOL.range = saved.range != null ? saved.range : saved.window != null ? saved.window : null;
  } catch (e) { /* storage off */ }
  const tolNum = v => (v === "" || v == null || !(+v >= 0) ? null : +v);

  /** t: {range} or an example's {range_min}; example values are not saved. */
  function setTolerances(t, fromExample) {
    TOL.range = t.range_min != null ? t.range_min : t.range;
    TOL.fromExample = !!fromExample;
    if (!fromExample) {
      try { localStorage.setItem(TOL_KEY, JSON.stringify({ range: TOL.range })); } catch (e) { /* storage off */ }
    }
    if (RUN.result) RUN.stale = true;
    renderMatch();
  }
  $("tol-window").addEventListener("change", () => setTolerances({ range: tolNum($("tol-window").value) }, false));

  // ---------- Run ----------
  function runNow() {
    RUN.tol = { range: tolNum(TOL.range) };
    RUN.result = GcmsRules.run(S.records, S.ident, STD.targets, RUN.tol, RUN.manual);
    RUN.result.rows.forEach((r, i) => {
      const t = STD.targets[i];
      t.label = t.baseLabel || (r.hit && r.hit.name) || t.ident.casNorm || t.cas || "";
    });
    RUN.stale = false;
  }
  $("run-btn").addEventListener("click", async () => {
    if (!RUN.ready || $("run-btn").disabled) return;
    if (tolNum(TOL.range) == null) { renderMatch(); return; }
    // large files take about a second: say so before the page is busy
    $("run-btn").disabled = true;
    $("run-msg").textContent = I18N.t("run.busy");
    document.body.classList.add("busy");
    await nextFrame();
    try {
      RUN.manual = new Map();
      RUN.open = new Set();
      runNow();
    } finally {
      $("run-btn").disabled = false;
      document.body.classList.remove("busy");
    }
    renderMatch();
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // ---------- Results ----------
  const fmtRt = v => (v == null ? "" : (+v).toFixed(3));
  const fmtRel = v => (v == null ? "-" : v > 0 && v < 0.01 ? v.toPrecision(2) : v.toFixed(2));
  const peakName = p => p.hits.map(h => h.name).join(" / ");
  const tname = i => STD.targets[i].label;

  function logText(l) {
    const v = Object.assign({}, l);
    if (l.target != null) v.target = tname(l.target);
    if (l.kept != null) v.kept = tname(l.kept);
    if (l.rts) v.rts = l.rts.map(fmtRt).join(", ");
    if (l.rt != null) v.rt = fmtRt(l.rt);
    if (l.hits) v.hits = l.hits.join(" / ");
    return I18N.t("log." + l.kind, v);
  }

  function renderMatch() {
    const box = $("step-match");
    box.classList.toggle("hidden", !RUN.ready);
    if (!RUN.ready) return;
    $("read-summary").textContent = I18N.t("read.summary", {
      sample: S.sample, peaks: S.records.length, n: STD.targets.length,
      rt: STD.targets.filter(t => t.rt != null).length,
      bad: STD.targets.filter(t => ["suspicious", "date", "invalid"].includes(t.ident.casStatus)).length,
    });
    $("tol-window").value = TOL.range == null ? "" : TOL.range;
    $("tol-note").textContent = TOL.fromExample ? I18N.t("tol.example") : "";
    const msg = tolNum(TOL.range) == null ? "run.need_window" : RUN.stale ? "run.stale" : null;
    $("run-msg").textContent = msg ? I18N.t(msg) : "";
    $("run-msg").classList.toggle("error", msg === "run.need_window" || msg === "run.stale");
    const show = RUN.result && !RUN.stale;
    $("results").classList.toggle("hidden", !show);
    if (show) renderResults();
    renderFlavor();
  }

  function renderResults() {
    const res = RUN.result;
    // result: every target of the standard file, relative content or "-"
    const found = res.rows.filter(r => r.found).length;
    $("result-summary").textContent = I18N.t("result.summary", {
      n: res.rows.length, found, miss: res.rows.length - found, manual: res.rows.filter(r => r.status === "manual").length, win: RUN.tol.range,
    });
    // most important first (narrow screens scroll the rest): name, relative content, RTs, CAS
    let html = "<thead><tr>" + ["result.col.no", "result.col.target", "result.col.rel", "result.col.rt", "result.col.ref_rt", "result.col.cas"]
      .map(k => "<th>" + esc(I18N.t(k)) + "</th>").join("") + "</tr></thead><tbody>";
    res.rows.forEach((r, i) => {
      const t = STD.targets[i];
      // not found: the user may look at the free peaks of the window and assign one by hand
      const free = r.status === "not_detected" ? GcmsRules.windowPeaks(res.peaks, t, RUN.tol.range, res.taken) : [];
      let act = "";
      if (r.status === "manual") {
        act = ' <span class="m user">' + esc(I18N.t("manual.chip")) + '</span> <button type="button" class="linkbtn" data-unassign="' + i + '">' + esc(I18N.t("manual.undo")) + "</button>";
      } else if (free.length) {
        act = ' <button type="button" class="linkbtn" data-look="' + i + '">' + esc(I18N.t(RUN.open.has(i) ? "manual.hide" : "manual.look", { n: free.length })) + "</button>";
      }
      html += "<tr><td>" + (i + 1) + '</td><td class="wrap">' + esc(t.label) + act + "</td><td><b>" + esc(r.found ? fmtRel(r.rel) : "-") + "</b></td><td>" +
        (r.found ? esc(fmtRt(r.peak.rt)) : "-") + "</td><td>" + esc(fmtRt(t.rt)) + "</td><td>" + esc(t.ident.casNorm || t.cas || "") + "</td></tr>";
      if (free.length && RUN.open.has(i)) {
        let sub = '<p class="small muted" style="margin:0 0 4px">' + esc(I18N.t("manual.intro")) + "</p>";
        sub += free.map(p => {
          const hits = p.hits.slice(0, 3).map(h => h.name + (h.match != null ? " (" + h.match + ")" : "")).join(" / ") + (p.hits.length > 3 ? " / ..." : "");
          const d = p.rt - t.rt;
          return '<div class="row-wrap" style="margin-top:4px"><button type="button" class="btn secondary" data-assign="' + i + '" data-key="' + esc(p.key) + '">' +
            esc(I18N.t("manual.assign")) + "</button><span>" + esc(fmtRt(p.rt) + " min (" + (d >= 0 ? "+" : "") + d.toFixed(3) + ")") + "</span><span>" +
            esc(hits) + "</span><span class=\"muted\">" + esc(I18N.t("result.col.rel") + " " + fmtRel(GcmsRules.relativeContent(p, res.peaks))) + "</span></div>";
        }).join("");
        html += '<tr class="sub"><td></td><td colspan="5">' + sub + "</td></tr>";
      }
    });
    $("result-table").innerHTML = html + "</tbody>";
    $("rel-note").textContent = I18N.t(res.relSource === "column" ? "result.rel_column" : "result.rel_area");

    // processing log: every entry concerns a target of the standard file
    const entries = res.log.slice();
    res.rows.forEach((r, i) => { if (r.status === "manual") entries.push({ rule: "-", kind: "manual", target: i, rt: r.peak.rt, name: peakName(r.peak) }); });
    let lh = "<thead><tr><th>" + esc(I18N.t("log.col.rule")) + "</th><th>" + esc(I18N.t("log.col.what")) + "</th></tr></thead><tbody>";
    entries.forEach(l => { lh += "<tr><td>" + esc(l.rule) + '</td><td class="wrap" style="max-width:none">' + esc(logText(l)) + "</td></tr>"; });
    if (!entries.length) lh += '<tr><td></td><td class="muted">' + esc(I18N.t("log.empty")) + "</td></tr>";
    $("log-table").innerHTML = lh + "</tbody>";
  }

  $("result-table").addEventListener("click", e => {
    const look = e.target.closest("[data-look]"), as = e.target.closest("[data-assign]"), un = e.target.closest("[data-unassign]");
    if (look) {
      const i = +look.dataset.look;
      if (RUN.open.has(i)) RUN.open.delete(i); else RUN.open.add(i);
      renderMatch();
      return;
    }
    if (as) { RUN.manual.set(+as.dataset.assign, as.dataset.key); RUN.open.delete(+as.dataset.assign); }
    else if (un) RUN.manual.delete(+un.dataset.unassign);
    else return;
    runNow();
    renderMatch();
  });

  $("export-btn").addEventListener("click", () => {
    if (!RUN.result) return;
    const q = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const lines = [["No.", "Compound", "CAS", "Reference RT (min)", "Measured RT (min)", "Relative content (%)"].map(q).join(",")];
    RUN.result.rows.forEach((r, i) => {
      const t = STD.targets[i];
      lines.push([i + 1, t.label, t.ident.casNorm || t.cas || "", fmtRt(t.rt), r.found ? fmtRt(r.peak.rt) : "-", r.found ? fmtRel(r.rel) : "-"].map(q).join(","));
    });
    const name = String(S.sample || "sample").replace(/[\\/:*?"<>|]+/g, "_");
    download("﻿" + lines.join("\r\n") + "\r\n", name + "_result.csv", "text/csv");
  });

  // ---------- Flavor: OAV or ROAV, thresholds, ranking, profile ----------
  const THR_KEY = "gcms-thresholds";   // the user's own threshold values (mg/kg) by compound key
  let THR = {};
  try { THR = JSON.parse(localStorage.getItem(THR_KEY) || "{}") || {}; } catch (e) { /* storage off */ }
  const saveThr = () => { try { localStorage.setItem(THR_KEY, JSON.stringify(THR)); } catch (e) { /* storage off */ } };
  const FLV = { mode: null, unit: null, view: "dairy" };   // mode/unit null = automatic; view: profile dimensions
  try { if (localStorage.getItem("gcms-profile-view") === "all") FLV.view = "all"; } catch (e) { /* storage off */ }
  const tkey = t => (t.ident.kbId ? "kb:" + t.ident.kbId
    : t.ident.casNorm && t.ident.casStatus === "ok" ? "cas:" + t.ident.casNorm : "name:" + GcmsNames.normName(t.name || ""));
  const sig = (v, n) => (v == null ? "-" : v === 0 ? "0" : String(+v.toPrecision(n || 3)));
  const fmtScore = v => (v == null ? "-" : v >= 100 ? String(Math.round(v)) : sig(v, 3));
  const concHeader = () => { const i = S.mapping.indexOf("conc"); return i >= 0 ? String(header()[i] || "") : null; };

  /**
   * Inputs of the found targets. OAV needs the amount column; ROAV uses peak areas when every
   * found target has one (most precise), else relative contents, else amounts.
   */
  function flavorInputs() {
    const found = RUN.result.rows.map((r, i) => [r, i]).filter(([r]) => r.found);
    const hasConc = found.some(([r]) => r.conc != null);
    const mode = hasConc && FLV.mode !== "roav" ? "oav" : "roav";
    const unitGuess = GcmsFlavor.guessUnit(concHeader());
    const unit = FLV.unit || unitGuess || "ug_kg";
    const basis = mode === "oav" ? "conc" : found.every(([r]) => r.area != null) ? "area"
      : found.every(([r]) => r.rel != null) ? "rel" : "conc";
    const items = found.map(([r, i]) => {
      const t = STD.targets[i], key = tkey(t);
      // threshold: the user's edit on this page > the standard file > the built-in value
      const built = GcmsFlavor.threshold(FL, t.ident.kbId);
      const edited = THR[key] != null;
      const raw = r[basis];
      return {
        i, t, r, key, built, edited, fromFile: !edited && t.thrFile != null,
        thr: edited ? THR[key] : t.thrFile != null ? t.thrFile : built ? built.mg_kg : null,
        value: raw == null ? null : mode === "oav" ? raw * GcmsFlavor.UNITS[unit] : raw,
        lift: GcmsFlavor.weights(FL, t.ident.kbId, FLV.view),
      };
    });
    return { items, mode, unit, unitGuess, basis, hasConc };
  }

  const odorLink = text => '<a href="../odor-predictor/" target="_blank" rel="noopener">' + esc(text) + "</a>";

  function descText(kbId) {
    const d = GcmsFlavor.descriptors(FL, kbId, 3);
    if (d.src === "gnn") {
      const lab = id => I18N.pick(FL.labels.find(l => l.id === id));
      return { d, text: d.labels.map(lab).join(", ") };
    }
    return { d, text: d.terms.join(", "), short: d.terms.length > 6 ? d.terms.slice(0, 6).join(", ") + ", ..." : null };
  }

  function renderFlavor() {
    const show = RUN.ready && RUN.result && !RUN.stale;
    $("step-flavor").classList.toggle("hidden", !show);
    if (!show) return;
    const F = flavorInputs();
    const calc = GcmsFlavor.compute(F.items, F.mode);
    const opt = (v, label, sel) => '<option value="' + v + '"' + (sel ? " selected" : "") + ">" + esc(label) + "</option>";

    // calculation mode and unit
    $("fl-mode").innerHTML = (F.hasConc ? ["oav", "roav"] : ["roav"]).map(m => opt(m, I18N.t("fl.mode_" + m), m === F.mode)).join("");
    $("fl-mode").disabled = !F.hasConc;
    $("fl-unit-wrap").classList.toggle("hidden", F.mode !== "oav");
    $("fl-unit").innerHTML = Object.keys(GcmsFlavor.UNITS).map(u => opt(u, I18N.t("fl.unit_" + u), u === F.unit)).join("");
    let note = I18N.t(F.mode === "oav" ? "fl.note_oav" : F.hasConc ? "fl.note_roav_choice" : "fl.note_roav", { basis: I18N.t("fl.basis_" + F.basis) });
    if (F.mode === "oav") note += " " + I18N.t(F.unitGuess && !FLV.unit ? "fl.unit_from_header" : FLV.unit ? "fl.unit_user" : "fl.unit_default", { col: concHeader() });
    $("fl-mode-note").textContent = note;

    // thresholds, in standard-file order, editable
    $("thr-intro").textContent = I18N.t("thr.intro_short", { n: F.items.length, miss: F.items.filter(x => !(x.thr > 0)).length });
    let th = "<thead><tr>" + ["result.col.target", "result.col.cas", "thr.col.value", "thr.col.source", "thr.col.range", ""]
      .map(k => "<th>" + (k ? esc(I18N.t(k)) : "") + "</th>").join("") + "</tr></thead><tbody>";
    F.items.forEach(x => {
      const src = x.edited ? I18N.t("thr.src_user") : x.fromFile ? I18N.t("thr.src_file") : x.built ? x.built.src + I18N.t("thr.src_builtin") : I18N.t("thr.src_none");
      const range = !x.fromFile && !x.edited && x.built && x.built.range ? sig(x.built.range[0]) + " - " + sig(x.built.range[1]) : "";
      th += '<tr class="' + (x.thr > 0 ? "" : "no-thr") + '"><td>' + esc(x.t.label) + "</td><td>" + esc(x.t.ident.casNorm || x.t.cas || "") +
        '</td><td><input type="number" class="thr-in' + (x.edited ? " edited" : "") + '" min="0" step="any" data-thr="' + esc(x.key) +
        '" value="' + (x.thr > 0 ? x.thr : "") + '" aria-label="' + esc(I18N.t("thr.col.value") + ": " + x.t.label) + '"></td><td class="wrap">' +
        esc(src) + "</td><td>" + esc(range) + "</td><td>" +
        (x.edited && (x.built || x.t.thrFile != null) ? '<button type="button" class="linkbtn" data-thr-reset="' + esc(x.key) + '">' + esc(I18N.t("thr.reset")) + "</button>" : "") + "</td></tr>";
    });
    $("thr-table").innerHTML = th + "</tbody>";

    // ranking: largest OAV / ROAV first; compounds without a value or threshold at the end
    const order = F.items.map((x, k) => k).sort((a, b) => {
      const sa = calc.rows[a].score, sb = calc.rows[b].score;
      return (sa == null) - (sb == null) || (sb || 0) - (sa || 0) || a - b;
    });
    const scoreCol = F.mode === "oav" ? "OAV" : "ROAV";
    const valCol = F.mode === "oav" ? I18N.t("rank.col.amount") : I18N.t("result.col.rel");
    let rh = "<thead><tr>" + [I18N.t("rank.col.rank"), I18N.t("result.col.target"), valCol, I18N.t("thr.col.value"), scoreCol, I18N.t("rank.col.odor")]
      .map(k => "<th>" + esc(k) + "</th>").join("") + "</tr></thead><tbody>";
    let rank = 0;
    order.forEach(k => {
      const x = F.items[k], c = calc.rows[k], dt = descText(x.t.ident.kbId);
      const shown = F.mode === "oav" ? x.value : x.r.rel;
      const chip = dt.d.src ? '<span class="m ' + (dt.d.src === "gnn" ? "warn" : "name") + '">' + esc(I18N.t("rank.src_" + dt.d.src)) + "</span> " : "";
      const scoreCell = c.status === "ok" ? "<b>" + esc(fmtScore(c.score)) + "</b>" : '<span class="muted">' + esc(I18N.t("rank." + c.status)) + "</span>";
      rh += '<tr class="' + (c.status === "no_threshold" ? "no-thr" : "") + '"><td>' + (c.status === "ok" ? ++rank : "") + "</td><td>" + esc(x.t.label) +
        "</td><td>" + esc(shown == null ? "-" : sig(shown, 3)) + "</td><td>" + esc(x.thr > 0 ? sig(x.thr) : "-") + "</td><td>" + scoreCell +
        '</td><td class="wrap">' + chip + (dt.short ? '<span title="' + esc(dt.text) + '">' + esc(dt.short) + "</span>"
          : dt.d.src ? esc(dt.text) : odorLink(I18N.t("rank.no_kb"))) + "</td></tr>";
    });
    if (!F.items.length) rh += '<tr><td></td><td colspan="5" class="muted">' + esc(I18N.t("rank.none")) + "</td></tr>";
    $("rank-table").innerHTML = rh + "</tbody>";
    const ok = calc.rows.filter(c => c.status === "ok");
    $("rank-summary").textContent = I18N.t(F.mode === "oav" ? "rank.summary_oav" : "rank.summary_roav", {
      n: F.items.length, key: ok.filter(c => c.score >= 1).length, mod: ok.filter(c => c.score >= 0.1 && c.score < 1).length,
      miss: calc.rows.filter(c => c.status !== "ok").length,
    });

    // profile radar: the 12 dairy dimensions (default) or the 10 largest of the 138 odor labels
    $("radar-view").value = FLV.view;
    if (calc.profile) {
      const dims = GcmsFlavor.viewDims(FL, calc.profile, FLV.view).map(([i, v]) => ({ label: I18N.pick(FL.labels[i]), value: v }));
      $("radar").innerHTML = GcmsFlavor.radarSvg(dims) +
        '<p class="small muted" style="text-align:center">' + esc(dims.map(d => d.label + " " + (100 * d.value).toFixed(1) + "%").join(", ")) + "</p>";
    } else {
      $("radar").innerHTML = '<p class="small muted">' + esc(I18N.t("radar.none")) + "</p>";
    }
    // compounds outside the knowledge base have no model prediction: say so and point to the odor predictor
    const noLift = F.items.filter(x => !x.lift).map(x => x.t.label);
    $("radar-note").innerHTML = esc(I18N.t(FLV.view === "all" ? "radar.note_all_short" : "radar.note_short", { n: calc.nProfile, score: scoreCol })) +
      ' <a class="help" href="about.html#profile" aria-label="?">?</a>' +
      (noLift.length ? " " + esc(I18N.t("radar.no_lift", { list: noLift.join(", ") })) + " " + odorLink(I18N.t("radar.no_lift_link")) : "");
    FLV.last = { F, calc, order };
  }

  $("fl-mode").addEventListener("change", e => { FLV.mode = e.target.value; renderFlavor(); });
  $("fl-unit").addEventListener("change", e => { FLV.unit = e.target.value; renderFlavor(); });
  $("radar-view").addEventListener("change", e => {
    FLV.view = e.target.value === "all" ? "all" : "dairy";
    try { localStorage.setItem("gcms-profile-view", FLV.view); } catch (err) { /* storage off */ }
    renderFlavor();
  });
  $("thr-table").addEventListener("change", e => {
    const el = e.target.closest("[data-thr]");
    if (!el) return;
    const v = el.value.trim() === "" ? null : +el.value;
    if (v != null && v > 0) THR[el.dataset.thr] = v; else delete THR[el.dataset.thr];
    saveThr();
    renderFlavor();
  });
  $("thr-table").addEventListener("click", e => {
    const b = e.target.closest("[data-thr-reset]");
    if (!b) return;
    delete THR[b.dataset.thrReset];
    saveThr();
    renderFlavor();
  });
  $("thr-reset-all").addEventListener("click", () => {
    if (!FLV.last) return;
    FLV.last.F.items.forEach(x => { delete THR[x.key]; });
    saveThr();
    renderFlavor();
  });

  $("rank-export").addEventListener("click", () => {
    if (!FLV.last) return;
    const { F, calc, order } = FLV.last;
    const q = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const score = F.mode === "oav" ? "OAV" : "ROAV";
    const lines = [["Rank", "Compound", "CAS", F.mode === "oav" ? "Amount (ug/kg)" : "Relative content (%)", "Odor threshold in water (mg/kg)",
      "Threshold source", score, "Odor descriptors", "Descriptor source", "KB id"].map(q).join(",")];
    let rank = 0;
    order.forEach(k => {
      const x = F.items[k], c = calc.rows[k], dt = descText(x.t.ident.kbId);
      const src = x.edited ? "user" : x.fromFile ? "standard file" : x.built ? x.built.src + " (van Gemert 2011, built-in)" : "";
      lines.push([c.status === "ok" ? ++rank : "", x.t.label, x.t.ident.casNorm || x.t.cas || "",
        sig(F.mode === "oav" ? x.value : x.r.rel, 4), x.thr > 0 ? x.thr : "", src,
        c.status === "ok" ? sig(c.score, 4) : c.status, dt.text, dt.d.src || "", x.t.ident.kbId || ""].map(q).join(","));
    });
    // targets of the standard file that were not found in this sample (flavor-improver reads them as not detected)
    RUN.result.rows.forEach((r, i) => {
      if (r.found) return;
      const tg = STD.targets[i];
      lines.push(["", tg.label, tg.ident.casNorm || tg.cas || "", "not detected", "", "", "not_detected", "", "", tg.ident.kbId || ""].map(q).join(","));
    });
    const name = String(S.sample || "sample").replace(/[\\/:*?"<>|]+/g, "_");
    download("﻿" + lines.join("\r\n") + "\r\n", name + "_" + score + ".csv", "text/csv");
  });

  // ---------- Hand-off to flavor-improver (PLAN-userdata.md): this browser only ----------
  function handoffRecord() {
    const { F } = FLV.last;
    const thrSource = x => (x.edited ? "user" : x.fromFile ? "standard file" : x.built ? "built-in" : null);
    const compounds = F.items.filter(x => x.value != null).map(x => ({
      label: x.t.label, cas: x.t.ident.casNorm || x.t.cas || "", kbId: x.t.ident.kbId || null,
      value: x.value, thr_mg_kg: x.thr > 0 ? x.thr : null, thrSource: thrSource(x),
    }));
    const notFound = RUN.result.rows.map((r, i) => [r, STD.targets[i]]).filter(([r]) => !r.found)
      .map(([, t]) => ({ label: t.label, cas: t.ident.casNorm || t.cas || "", kbId: t.ident.kbId || null }));
    return { name: String(S.sample || "sample"), savedAt: new Date().toISOString(), source: "gcms",
             mode: F.mode, basis: F.basis, compounds, notFound };
  }
  ["sample", "target"].forEach(slot => $("handoff-" + slot).addEventListener("click", () => {
    if (!FLV.last) return;
    const rec = handoffRecord();
    const ok = FlavorHandoff.save(slot, rec);
    $("handoff-status").textContent = I18N.t(ok ? "handoff.saved_" + slot : "handoff.failed", { name: rec.name, n: rec.compounds.length });
    $("handoff-status").classList.toggle("error", !ok);
  }));

  // ---------- Render ----------
  function renderFileInfo() {
    const box = $("file-info");
    if (!S.file) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    const parts = [[I18N.t("info.file"), S.file.fileName]];
    if (S.file.kind === "text") {
      const d = { ",": I18N.t("delim.comma"), "\t": I18N.t("delim.tab"), ";": I18N.t("delim.semicolon"), "|": "|" }[S.file.delimiter];
      parts.push([I18N.t("info.encoding"), S.file.encoding], [I18N.t("info.delimiter"), d]);
    } else {
      parts.push([I18N.t("info.type"), "Excel"]);
    }
    parts.push([I18N.t("info.rows"), rows().length]);
    box.innerHTML = parts.map(([k, v]) => "<span>" + esc(k) + ": <b>" + esc(v) + "</b></span>").join("");
    if (S.file.sheets.length > 1) {
      const sel = document.createElement("select");
      S.file.sheets.forEach((s, i) => {
        const o = document.createElement("option");
        o.value = i; o.textContent = s.name; o.selected = i === S.sheet;
        sel.appendChild(o);
      });
      sel.addEventListener("change", () => { S.sheet = +sel.value; autoDetect(); invalidate(); renderAll(); });
      const span = document.createElement("span");
      span.append(I18N.t("info.sheet") + ": ", sel);
      box.appendChild(span);
    }
  }

  function renderAll() {
    renderScope();
    renderTemplates();
    renderFileInfo();
    renderMap();
    renderStd();
    renderConfirm();
    renderMatch();
  }

  renderAll();
  I18N.onChange(renderAll);
  window.__gcms = { S, STD, RUN, TOL, FLV, FL, load, loadStd, exampleFiles, exampleStd, nameIndex };  // test harness, offline check
})();
