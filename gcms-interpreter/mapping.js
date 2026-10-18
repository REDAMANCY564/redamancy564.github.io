/*
 * Column mapping for gcms-interpreter: header-row detection, column meaning guesses from the
 * keyword dictionary (data/column_keywords.json), conversion to peak records, and instrument
 * templates (saved only in this browser's localStorage).
 * Scope (user decision 2026-10-17): one file = one sample, one row per peak. A file that still
 * contains several samples is handled one sample at a time (samplesIn + toRecords(sample)).
 */
(function () {
  const FIELDS = ["name", "cas", "rt", "ri", "area", "rel", "conc", "match", "peak", "sample"];   // peak tables
  const TARGET_FIELDS = ["name", "cas", "rt", "thr", "ri", "qion", "note"];                       // standard files
  const TEMPLATE_KEY = "gcms-templates";
  let DICT = null;

  function setDictionary(dict) { DICT = dict; }

  /** Lower case, full-width -> half-width, drop spaces and punctuation except % # . / ( ) μ. */
  function normHeader(h) {
    return String(h || "").normalize("NFKC").toLowerCase().replace(/µ/g, "μ")
      .replace(/[^\p{L}\p{N}%#./()μ]/gu, "");
  }

  /** Field id for one header, or null. Fields are tried in dictionary order; allowed limits the choice. */
  function guessField(header, allowed) {
    const h = normHeader(header);
    if (!h) return null;
    const fields = allowed ? DICT.fields.filter(f => allowed.includes(f.id)) : DICT.fields;
    for (const f of fields) if (f.exact.includes(h)) return f.id;
    for (const f of fields) if (f.contains.some(k => h.includes(k))) return f.id;
    return null;
  }

  const isNumeric = (s, dc) => GcmsIO.parseNumber(s, dc) !== null;

  /**
   * Header row = the row (among the first 40) with the most recognized column names that is
   * followed by rows of a similar width containing numbers. Instrument info lines above it
   * are skipped.
   */
  function detectHeaderRow(rows, decimalComma, allowed) {
    let best = { index: 0, score: -1 };
    const limit = Math.min(rows.length, 40);
    for (let i = 0; i < limit; i++) {
      const cells = rows[i].filter(c => c !== "");
      if (cells.length < 2) continue;
      const known = new Set(rows[i].map(c => guessField(c, allowed)).filter(Boolean)).size;
      const below = rows.slice(i + 1, i + 6).filter(r => r.filter(c => c !== "").length >= Math.max(2, cells.length - 1));
      const numericBelow = below.filter(r => r.some(c => isNumeric(c, decimalComma))).length;
      const headerLike = cells.filter(c => !isNumeric(c, decimalComma)).length / cells.length;
      const score = known * 3 + numericBelow + headerLike;
      if (score > best.score) best = { index: i, score };
    }
    return best.index;
  }

  /** Data rows under the header: stop at the first blank row or a new "[section]" line. */
  function dataRows(rows, headerIndex) {
    const out = [];
    for (let i = headerIndex + 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.every(c => c === "") || /^\[.*\]$/.test(r[0] || "")) {
        if (out.length) break;
        continue;
      }
      out.push({ index: i, cells: r });
    }
    return out;
  }

  /** Guess the meaning of every column; each field is used once (first column wins). */
  function guessMapping(header, allowed) {
    const used = new Set();
    return header.map(h => {
      const f = guessField(h, allowed || FIELDS);
      if (!f || used.has(f)) return null;
      used.add(f);
      return f;
    });
  }

  /** Distinct sample names in the sample column, in order of first appearance ([] if no such column). */
  function samplesIn(mapping, rows) {
    const j = mapping.indexOf("sample");
    if (j < 0) return [];
    return [...new Set(rows.map(r => r.cells[j]).filter(v => v))];
  }

  /**
   * Convert to peak records of ONE sample: {source_row, peak, name, cas, casIsDate, rt, ri, area,
   * rel, conc, match; standard files also thr}. opts: {sample (keep only rows of this sample when there is a sample
   * column), decimalComma, dates}.
   */
  function toRecords(mapping, rows, opts) {
    const col = f => mapping.indexOf(f);
    const get = (r, f) => (col(f) >= 0 ? r.cells[col(f)] : "");
    const num = (r, f) => (col(f) >= 0 ? GcmsIO.parseNumber(r.cells[col(f)], opts.decimalComma) : null);
    const out = [];
    for (const r of rows) {
      if (!get(r, "name") && !get(r, "cas")) continue;   // totals, footers
      if (opts.sample != null && col("sample") >= 0 && get(r, "sample") !== opts.sample) continue;
      out.push({
        source_row: r.index + 1,
        peak: get(r, "peak"),
        name: get(r, "name"),
        cas: get(r, "cas"),
        casIsDate: col("cas") >= 0 && opts.dates.has(r.index + ":" + col("cas")),
        rt: num(r, "rt"), ri: num(r, "ri"), match: num(r, "match"),
        area: num(r, "area"), rel: num(r, "rel"), conc: num(r, "conc"),
        qion: get(r, "qion"), note: get(r, "note"), thr: num(r, "thr"),
      });
    }
    return out;
  }

  // ---------- Instrument templates (this browser only) ----------
  function loadTemplates() {
    try { return JSON.parse(localStorage.getItem(TEMPLATE_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveTemplates(list) {
    try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
  }

  /** A template stores the mapping by normalized header text, so column order may change. */
  function makeTemplate(name, header, mapping) {
    const byHeader = {};
    header.forEach((h, j) => { if (mapping[j]) byHeader[normHeader(h)] = mapping[j]; });
    return { name, saved: new Date().toISOString().slice(0, 10), byHeader };
  }

  /** Best template whose mapped headers all appear in this header row, or null. */
  function findTemplate(templates, header) {
    const hs = new Set(header.map(normHeader));
    const fits = templates.filter(t => Object.keys(t.byHeader).length && Object.keys(t.byHeader).every(h => hs.has(h)));
    fits.sort((a, b) => Object.keys(b.byHeader).length - Object.keys(a.byHeader).length);
    return fits[0] || null;
  }

  /** Template mapping for a header; optional columns (built-in templates) are mapped when present. */
  function applyTemplate(t, header) {
    return header.map(h => t.byHeader[normHeader(h)] || (t.optional && t.optional[normHeader(h)]) || null);
  }

  window.GcmsMapping = {
    FIELDS, TARGET_FIELDS, setDictionary, normHeader, guessField, detectHeaderRow, dataRows,
    guessMapping, samplesIn, toRecords, loadTemplates, saveTemplates, makeTemplate, findTemplate, applyTemplate,
  };
})();
