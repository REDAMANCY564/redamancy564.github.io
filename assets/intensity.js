/*
 * Odor intensity curves in air (Wakayama et al. 2019, Ind. Eng. Chem. Res. 58(32):15036, doi:10.1021/acs.iecr.9b01225),
 * shared by the curve page (gcms-interpreter/curves.html) and the small "intensity curve" links on the tool pages.
 * Data: gcms-interpreter/data/intensity.json (built by training/intensity/build_intensity.py), a static file on this
 * site: no other request. Site compounds are matched by CAS when the data are built (kb id, library index, InChIKey
 * first block); byName is only for places without a CAS: exact name after trimming, English letters case-insensitive.
 *   Psi = Imax / (1 + exp(-(X - C) / D)), X = log10(gas-phase concentration, ug/L air)
 *   threshold: X at Psi = 1.4 = C - D ln((Imax - 1.4) / 1.4)
 * Step-like curves (D < 0.1) are listed but never converted.
 * Strings: assets/i18n/<lang>.json, keys int.*.
 */
(function () {
  const script = document.currentScript;
  const DATA_URL = new URL("../gcms-interpreter/data/intensity.json" + new URL(script.src).search, script.src);
  const PAGE_URL = new URL("../gcms-interpreter/curves.html", script.src);
  const X_MIN = -5, X_MAX = 5;
  // LMS scale (Green et al.), as used by the source
  const LMS = [[1.4, "barely"], [6.1, "weak"], [17.2, "moderate"], [35.4, "strong"], [53.3, "very_strong"], [100, "strongest"]];
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let loading = null;
  const R = { items: [], meta: null };
  const byCas = new Map(), byKb = new Map(), byLib = new Map(), byIk = new Map(), byNm = new Map();

  function ncas(s) {
    const m = /^0*(\d+)-(\d{2})-(\d)$/.exec(String(s == null ? "" : s).trim());
    return m ? m[1] + "-" + m[2] + "-" + m[3] : null;
  }
  // exact name rule: trim; ASCII letters compared case-insensitively; every other character as is
  const nameKey = s => String(s == null ? "" : s).trim().replace(/[A-Z]/g, c => c.toLowerCase());

  function decode(a) {
    return { cas: a[0], en: a[1], zh: a[2] || "", Imax: a[3], C: a[4], D: a[5], step: !!a[6], table: a[7],
             kb: a[8] || null, lib: a[9], ik: a[10] || null, alias: a[11] || [] };
  }

  function load() {
    if (!loading) {
      loading = fetch(DATA_URL).then(r => {
        if (!r.ok) throw new Error("Failed to load " + DATA_URL);
        return r.json();
      }).then(d => {
        R.meta = d.meta;
        R.items = d.c.map(decode);
        R.items.forEach(e => {
          byCas.set(e.cas, e);
          if (e.kb) byKb.set(e.kb, e);
          if (e.lib >= 0) byLib.set(e.lib, e);
          if (e.ik) byIk.set(e.ik, e);
          [e.en, e.zh].filter(Boolean).forEach(n => byNm.set(nameKey(n), e));
        });
        return R;
      }).catch(err => { loading = null; throw err; });
    }
    return loading;
  }

  /** Psi at X (log10 ug/L air); null for step-like curves. */
  function psi(e, x) {
    if (!e || e.step) return null;
    return e.Imax / (1 + Math.exp(-(x - e.C) / e.D));
  }
  /** X of the detection threshold (Psi = 1.4); null for step-like curves. */
  function thresholdX(e) {
    if (!e || e.step) return null;
    return e.C - e.D * Math.log((e.Imax - 1.4) / 1.4);
  }
  /**
   * Intensity level of a Psi value: {at: key} on a scale mark (to 0.05), {below: "barely"} under 1.4,
   * otherwise {from: key, to: key} for the two marks around it.
   */
  function level(p) {
    if (p == null || !isFinite(p)) return null;
    for (const [v, k] of LMS) if (Math.abs(p - v) < 0.05) return { at: k };
    if (p < LMS[0][0]) return { below: LMS[0][1] };
    for (let i = 0; i < LMS.length - 1; i++) if (p < LMS[i + 1][0]) return { from: LMS[i][1], to: LMS[i + 1][1] };
    return { at: LMS[LMS.length - 1][1] };
  }
  function levelText(lv) {
    if (!lv) return "";
    const n = k => I18N.t("int.lv." + k);
    if (lv.at) return n(lv.at);
    if (lv.below) return I18N.t("int.lv_below", { a: n(lv.below) });
    return I18N.t("int.lv_between", { a: n(lv.from), b: n(lv.to) });
  }
  /**
   * Convert a gas-phase concentration (ug/L air): {x, psi, level} | {error: "invalid" | "range" | "step"}.
   */
  function convert(e, conc) {
    const c = typeof conc === "number" ? conc : Number(String(conc == null ? "" : conc).trim().replace(/,/g, ""));
    if (!(c > 0) || !isFinite(c)) return { error: "invalid" };
    if (e.step) return { error: "step" };
    const x = Math.log10(c);
    if (x < X_MIN || x > X_MAX) return { error: "range", x };
    const p = psi(e, x);
    return { x, psi: p, level: level(p) };
  }

  /**
   * Search by CAS (exact, leading zeros ignored), or by Chinese name, English name or search alias
   * (substring, English letters case-insensitive; names starting with the query first, then shorter names).
   */
  function search(q, n = 8) {
    const raw = String(q == null ? "" : q).trim();
    if (!raw) return [];
    const c = ncas(raw);
    if (c) return byCas.has(c) ? [byCas.get(c)] : [];
    const k = nameKey(raw);
    const hits = [];
    R.items.forEach(e => {
      const names = [e.zh, e.en].concat(e.alias).filter(Boolean).map(nameKey);
      const pos = Math.min(...names.map(s => { const i = s.indexOf(k); return i < 0 ? Infinity : i === 0 ? 0 : 1; }));
      if (pos < Infinity) hits.push([pos, Math.min(...names.filter(s => s.includes(k)).map(s => s.length)), e]);
    });
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].en.localeCompare(b[2].en));
    return hits.slice(0, n).map(h => h[2]);
  }

  const name = e => (I18N.lang === "zh" && e.zh ? e.zh : e.en);
  const href = e => PAGE_URL.pathname + "?cas=" + encodeURIComponent(e.cas);
  /** The small link placed next to a compound name ("" without a curve). */
  function link(e) {
    if (!e) return "";
    return ' <a class="int-link" href="' + esc(href(e)) + '">' + esc(I18N.t("int.link")) + "</a>";
  }

  window.Intensity = {
    load, search, psi, thresholdX, level, levelText, convert, link, href, name, ncas, nameKey, LMS, X_MIN, X_MAX,
    get items() { return R.items; },
    get meta() { return R.meta; },
    get ready() { return !!R.meta; },
    byCas: c => byCas.get(ncas(c)) || null,
    byKb: id => (id ? byKb.get(id) || null : null),
    byLib: i => (i == null ? null : byLib.get(i) || null),
    byIk: ik => (ik ? byIk.get(String(ik).slice(0, 14)) || null : null),
    byName: n => (nameKey(n) ? byNm.get(nameKey(n)) || null : null),
    /** One rule for the tables of the GC-MS tools: valid file CAS, else KB compound found by CAS or exact synonym, else exact name. */
    forIdent(ident, nm, cas) {
      if (!R.meta) return null;
      if (ident && ident.casStatus === "ok" && ident.casNorm) { const e = byCas.get(ncas(ident.casNorm)); if (e) return e; }
      else if (cas) { const e = byCas.get(ncas(cas)); if (e) return e; }
      if (ident && ident.kbId && (ident.method === "cas" || ident.method === "name")) { const e = byKb.get(ident.kbId); if (e) return e; }
      const hasCas = (ident && ident.casStatus === "ok") || ncas(cas);
      return hasCas ? null : (nameKey(nm) ? byNm.get(nameKey(nm)) || null : null);
    },
  };
})();
