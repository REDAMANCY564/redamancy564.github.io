/*
 * "Use my own data" mode of flavor-improver (PLAN-userdata.md): logic without DOM, shared by the
 * page (userdata.js) and tests/userdata.html.
 *
 * Inputs are two records in the format of assets/flavor-handoff.js ("sample" and "target"), sent by
 * gcms-interpreter or read from its ranking CSV export.
 * Comparison basis (user decision 2026-10-18): both sides quantified -> OAV; otherwise ROAV (each
 * side relative to its own largest contributor), and no addition amounts.
 */
(function () {
  /** RFC 4180 CSV -> array of rows (strings). Handles quotes, CRLF, a UTF-8 BOM, ";" or "," separators. */
  function parseCsv(text) {
    text = String(text).replace(/^﻿/, "");
    const first = text.split(/\r?\n/, 1)[0];
    const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : ",";
    const rows = [];
    let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ""));
  }

  const ND = /^(not detected|n\.?d\.?|nd|未检出)$/i;
  const num = s => {
    const t = String(s == null ? "" : s).trim().replace(",", ".");
    return t === "" || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t) ? null : Number(t);
  };

  /**
   * Record from the ranking CSV of gcms-interpreter ("Export the ranking (CSV)").
   * Columns used: Compound, CAS, "Amount (ug/kg)" (-> OAV) or "Relative content (%)" (-> ROAV),
   * "Odor threshold in water (mg/kg)", "Threshold source", optional "KB id". A value "not detected"
   * (also "n.d.", "nd", "未检出") marks a target of the standard file that was not found.
   * Returns {rec, error}: error "header" (not this format) or "empty" (no compound with a value).
   */
  function recordFromCsv(text, name) {
    const rows = parseCsv(text);
    if (!rows.length) return { rec: null, error: "empty" };
    const h = rows[0].map(x => x.trim().toLowerCase());
    const col = re => h.findIndex(x => re.test(x));
    const iName = col(/^compound$/), iCas = col(/^cas$/), iAmt = col(/^amount/), iRel = col(/^relative content/),
      iThr = col(/^odor threshold/), iSrc = col(/^threshold source/), iKb = col(/^kb id$/);
    if (iName < 0 || iThr < 0 || (iAmt < 0 && iRel < 0)) return { rec: null, error: "header" };
    const mode = iAmt >= 0 ? "oav" : "roav", iVal = iAmt >= 0 ? iAmt : iRel;
    const compounds = [];
    const notFound = [];
    rows.slice(1).forEach(r => {
      if (!r[iName] || !r[iName].trim()) return;
      if (ND.test(String(r[iVal] || "").trim())) {
        notFound.push({ label: r[iName].trim(), cas: iCas >= 0 ? (r[iCas] || "").trim() : "", kbId: iKb >= 0 && r[iKb] ? r[iKb].trim() : null });
        return;
      }
      const value = num(r[iVal]);
      if (value == null || value < 0) return;
      const thr = num(r[iThr]);
      compounds.push({
        label: r[iName].trim(), cas: iCas >= 0 ? (r[iCas] || "").trim() : "", kbId: iKb >= 0 && r[iKb] ? r[iKb].trim() : null,
        value, thr_mg_kg: thr != null && thr > 0 ? thr : null, thrSource: iSrc >= 0 && r[iSrc] ? r[iSrc].trim() : null,
      });
    });
    if (!compounds.length) return { rec: null, error: "empty" };
    return { rec: { name: name || "csv", savedAt: new Date().toISOString(), source: "csv", mode,
                    basis: mode === "oav" ? "conc" : "rel", compounds, notFound }, error: null };
  }

  /** Normalized compound name for matching when there is no KB id and no CAS. */
  const normName = s => String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

  /** Identity key of a compound: knowledge-base id, else CAS, else normalized name. */
  function keyOf(c) {
    if (c.kbId) return "kb:" + c.kbId;
    if (c.cas && /^\d{2,7}-\d\d-\d$/.test(c.cas)) return "cas:" + c.cas;
    return "name:" + normName(c.label);
  }

  /**
   * Merge the two sides. Returns {mode, rows}; rows in target-first order:
   *   {key, label, cas, kbId, s, t (the side's compound or null), sNotFound, tNotFound (target of that
   *    side's standard file, not detected), thr (mg/kg, target side first), thrFrom ("target" | "sample"
   *    | null), thrConflict (both sides give thresholds differing by more than 1 %)}
   * The mode is "oav" only when both records are OAV.
   */
  function merge(sample, target) {
    const mode = sample.mode === "oav" && target.mode === "oav" ? "oav" : "roav";
    const rows = new Map();
    const row = c => {
      const k = keyOf(c);
      if (!rows.has(k)) rows.set(k, { key: k, label: c.label, cas: c.cas || "", kbId: c.kbId || null, s: null, t: null, sNotFound: false, tNotFound: false });
      const r = rows.get(k);
      if (!r.kbId && c.kbId) r.kbId = c.kbId;
      if (!r.cas && c.cas) r.cas = c.cas;
      return r;
    };
    target.compounds.forEach(c => { row(c).t = c; });
    sample.compounds.forEach(c => { row(c).s = c; });
    (target.notFound || []).forEach(c => { row(c).tNotFound = true; });
    (sample.notFound || []).forEach(c => { row(c).sNotFound = true; });
    const out = [...rows.values()].filter(r => r.s || r.t);
    out.forEach(r => {
      const ts = r.t && r.t.thr_mg_kg, ss = r.s && r.s.thr_mg_kg;
      r.thr = ts || ss || null;
      r.thrFrom = ts ? "target" : ss ? "sample" : null;
      r.thrConflict = !!(ts && ss && Math.abs(ts - ss) / Math.max(ts, ss) > 0.01);
    });
    return { mode, rows: out };
  }

  // ---------- comparison (stage 2) ----------
  // Profile views: 12 dairy dimensions (examples 1-4, gcms-interpreter default) and the 12 of example 5
  // (human milk vs formula), both with lift = probability / label prevalence; or all labels with probabilities.
  const VIEWS = {
    dairy: ["dairy", "buttery", "creamy", "milky", "cheesy", "sweet", "sour", "fruity", "nutty", "caramellic", "fatty", "waxy"],
    ref: ["dairy", "creamy", "sweet", "sour", "fatty", "oily", "green", "mushroom", "metallic", "fishy", "floral", "cooked"],
  };
  // defaults of the "higher on one side" rule; the visitor can change both (settings dialog)
  const FOLD = 2;            // OAV mode: a compound is "higher" on one side from a 2-fold OAV difference
  const SHARE_PP = 0.02;     // ROAV mode: from a 2 percentage-point difference in contribution share

  const intensity = x => (x != null && x > 1 ? Math.log10(x) : 0);

  /**
   * Per side and compound: value (null = unknown, 0 = not detected), score (OAV or ROAV), intensity I.
   * rows: merged rows with thrUse.v (mg/kg) set. side: "s" | "t".
   */
  function sideScores(rows, side, mode) {
    const val = r => (r[side] ? r[side].value : r[side + "NotFound"] ? 0 : null);
    const ratio = rows.map(r => {
      const v = val(r), thr = r.thrUse && r.thrUse.v;
      if (v == null || !(thr > 0)) return null;
      return mode === "oav" ? v / (thr * 1000) : v / thr;
    });
    const max = Math.max(0, ...ratio.filter(x => x != null));
    return rows.map((r, i) => {
      const v = val(r);
      if (ratio[i] == null) return { value: v, score: null, I: 0 };
      const score = mode === "oav" ? ratio[i] : max > 0 ? (100 * ratio[i]) / max : 0;
      return { value: v, score, I: intensity(score) };
    });
  }

  /** Weight vector of a compound for a view: lift on the view's dimensions, or all probabilities. */
  function weights(vec, view, labels, prevalence) {
    const dense = new Float64Array(labels.length);
    vec.p.forEach(([i, p]) => { dense[i] = p; });
    if (view === "all") return Array.from(dense);
    return VIEWS[view].map(id => { const i = labels.findIndex(l => l.id === id); return dense[i] / prevalence[i]; });
  }

  function normalize(v) {
    const s = v.reduce((a, b) => a + b, 0);
    return s > 0 ? v.map(x => x / s) : null;
  }

  function cosine(a, b) {
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : null;
  }

  /**
   * Compare the two sides. rows need thrUse.v and vec ({p: [[label index, prob]]} or null).
   * Returns {mode, s, t (per-row scores), profiles {s, t}, cos, used (rows in the profiles),
   *          gaps (both sides known, threshold known, at least one side contributes), unknown (one side
   *          unknown: not in that side's standard file), higherSample, higherTarget, rec (recommendations)}
   * opts: {fold, pp} (defaults FOLD, SHARE_PP).
   * Recommendations (no amounts, user decision 2026-10-18): the "higher in the target" compounds with an
   * odor vector. OAV mode: each is ranked by the profile similarity after raising its intensity in the
   * sample to the target's (one compound at a time; cosAll = all of them together). ROAV mode: ranked by
   * the share difference only. unmeasured = in the target (contributing) but not in the sample's standard file.
   * Gap: OAV mode log10(OAV_t / OAV_s), a side not detected counted as OAV 1 for ranking only;
   *      ROAV mode share_t - share_s, share = I / sum of I over the side's compounds (OAV or ROAV > 1 counts).
   */
  function analyze(rows, mode, view, labels, prevalence, opts) {
    const fold = (opts && opts.fold > 1) ? opts.fold : FOLD, pp = (opts && opts.pp > 0) ? opts.pp : SHARE_PP;
    const S = sideScores(rows, "s", mode), T = sideScores(rows, "t", mode);
    const w = rows.map(r => (r.vec ? weights(r.vec, view, labels, prevalence) : null));
    const prof = I => {
      let v = null;
      rows.forEach((r, i) => {
        if (!w[i] || !(I[i] > 0)) return;
        if (!v) v = new Array(w[i].length).fill(0);
        w[i].forEach((x, k) => { v[k] += I[i] * x; });
      });
      return v ? normalize(v) : null;
    };
    const IS = S.map(x => x.I), IT = T.map(x => x.I);
    const profiles = { s: prof(IS), t: prof(IT) };
    const cos = profiles.s && profiles.t ? cosine(profiles.s, profiles.t) : null;
    const sumI = sc => sc.reduce((a, x) => a + x.I, 0);
    const sumS = sumI(S), sumT = sumI(T);
    const gaps = [], unknown = [];
    rows.forEach((r, i) => {
      const s = S[i], t = T[i];
      if (s.value == null || t.value == null) { unknown.push({ row: r, side: s.value == null ? "s" : "t" }); return; }
      if (s.score == null || t.score == null || !(s.I > 0 || t.I > 0)) return;
      let gap;
      if (mode === "oav") gap = Math.log10(Math.max(t.score, 1)) - Math.log10(Math.max(s.score, 1));
      else gap = (sumT > 0 ? t.I / sumT : 0) - (sumS > 0 ? s.I / sumS : 0);
      gaps.push({ row: r, i, s, t, gap, shareS: sumS > 0 ? s.I / sumS : null, shareT: sumT > 0 ? t.I / sumT : null });
    });
    gaps.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
    const lim = mode === "oav" ? Math.log10(fold) : pp;
    const higherTarget = gaps.filter(g => g.gap >= lim), higherSample = gaps.filter(g => g.gap <= -lim);

    // recommendations: what to add (no amounts)
    const withVec = higherTarget.filter(g => w[g.i]);
    const cosWith = idx => {
      const I = IS.slice();
      idx.forEach(i => { I[i] = Math.max(I[i], IT[i]); });
      const p = prof(I);
      return p && profiles.t ? cosine(p, profiles.t) : null;
    };
    const items = withVec.map(g => Object.assign({}, g, { cosAfter: mode === "oav" ? cosWith([g.i]) : null }));
    if (mode === "oav") items.sort((a, b) => (b.cosAfter - a.cosAfter) || (b.gap - a.gap));
    const rec = {
      items, cosAll: mode === "oav" && items.length ? cosWith(items.map(g => g.i)) : null,
      noVec: higherTarget.filter(g => !w[g.i]),
      unmeasured: unknown.filter(u => u.side === "s" && T[rows.indexOf(u.row)].I > 0),
    };
    return {
      mode, view, s: S, t: T, profiles, cos, used: rows.filter((r, i) => w[i] && (S[i].I > 0 || T[i].I > 0)).length, gaps, unknown,
      higherTarget, higherSample, lim, fold, pp, rec,
    };
  }

  window.UserCore = { parseCsv, recordFromCsv, normName, keyOf, merge, VIEWS, FOLD, SHARE_PP, sideScores, weights, cosine, analyze };
})();
