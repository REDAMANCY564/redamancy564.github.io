/*
 * Flavor calculation for one sample (PLAN-gcms.md section 14; user decisions 2026-10-17/18).
 *
 * OAV  = concentration / odor threshold (both converted to ug/kg), when the peak table has
 *        quantified amounts.
 * ROAV = 100 x (C_i / T_i) / max_j (C_j / T_j), when only peak areas or relative contents are
 *        known (any quantity proportional to concentration works: the factor cancels). The
 *        compound with the largest contribution has ROAV 100.
 * Intensity I = log10(OAV or ROAV) when > 1, else 0 (same rule as flavor-improver).
 * Profile = L1-normalized sum over compounds of I x weight (user decision 2026-10-18: two views):
 *   "dairy" (default): the 12 dairy dimensions of flavor-improver, weight = lift = GNN probability /
 *            label prevalence in the GNN training data (flavor-improver rule)
 *   "all":   all 138 odor labels, weight = GNN probability (lift over 138 labels inflates rare
 *            labels such as cucumber, prevalence 0.9 %)
 * Thresholds are never estimated: a compound without one is listed and left out.
 */
(function () {
  // amount units -> factor to ug/kg (aqueous samples: ug/L taken as ug/kg)
  const UNITS = { ug_kg: 1, mg_kg: 1000, ng_kg: 0.001 };
  const DAIRY_DIMS = ["dairy", "buttery", "creamy", "milky", "cheesy", "sweet", "sour", "fruity", "nutty", "caramellic", "fatty", "waxy"];

  /** Unit written in a column header, e.g. "Calc. Amt. (µg/kg)" -> "ug_kg"; null if none. */
  function guessUnit(header) {
    const h = String(header || "").toLowerCase().replace(/µ|μ/g, "u").replace(/\s+/g, "");
    if (/ng\/kg|ng\/l|ppt/.test(h)) return "ng_kg";
    if (/ug\/kg|ug\/l|ng\/g|ng\/ml|ppb/.test(h)) return "ug_kg";
    if (/mg\/kg|mg\/l|ug\/g|ug\/ml|ppm/.test(h)) return "mg_kg";
    return null;
  }

  function buildIndex(json) {
    return {
      labels: json.labels, prevalence: json.prevalence, thresholds: json.thresholds,
      compounds: json.compounds, medium: json.medium, source: json.source,
    };
  }

  /** Built-in threshold of a knowledge-base compound: {mg_kg, src, range, cas} or null. */
  const threshold = (idx, kbId) => (kbId && idx.thresholds[kbId]) || null;

  /** lift vector (one value per label) of a knowledge-base compound, or null without a GNN prediction. */
  function lift(idx, kbId) {
    const c = kbId && idx.compounds[kbId];
    if (!c || !c.p) return null;
    const v = new Float64Array(idx.labels.length);
    c.p.forEach(([i, p]) => { v[i] = p / idx.prevalence[i]; });
    return v;
  }

  /** GNN probability vector of a knowledge-base compound, or null. */
  function probs(idx, kbId) {
    const c = kbId && idx.compounds[kbId];
    if (!c || !c.p) return null;
    const v = new Float64Array(idx.labels.length);
    c.p.forEach(([i, p]) => { v[i] = p; });
    return v;
  }

  /** Weight vector for a profile view: "dairy" uses lift, "all" uses probabilities. */
  const weights = (idx, kbId, view) => (view === "all" ? probs(idx, kbId) : lift(idx, kbId));

  /**
   * Dimensions shown for a profile (sum over all labels): "dairy" = the 12 dairy dimensions in
   * fixed order, renormalized to sum 1; "all" = the 10 largest labels. Returns [[label index, value]].
   */
  function viewDims(idx, profile, view) {
    if (view !== "all") {
      const ids = DAIRY_DIMS.map(d => idx.labels.findIndex(l => l.id === d));
      const s = ids.reduce((a, i) => a + profile[i], 0);
      return ids.map(i => [i, s > 0 ? profile[i] / s : 0]);
    }
    return topDims(profile, 10);
  }

  /**
   * Odor descriptors, knowledge base first: Dunkel et al. 2014 odor quality, else FlavorDB
   * flavor terms, else the GNN's top labels (marked as a model prediction).
   * Returns {src: "dunkel" | "flavordb" | "gnn" | null, terms: [...], labels: [label ids, gnn only]}
   */
  function descriptors(idx, kbId, nTop) {
    const c = kbId && idx.compounds[kbId];
    if (!c) return { src: null, terms: [] };
    if (c.d) return { src: "dunkel", terms: [c.d] };
    if (c.f && c.f.length) return { src: "flavordb", terms: c.f.slice() };
    if (c.p && c.p.length) {
      const top = c.p.slice().sort((a, b) => b[1] - a[1]).slice(0, nTop || 3);
      return { src: "gnn", terms: [], labels: top.map(([i]) => idx.labels[i].id) };
    }
    return { src: null, terms: [] };
  }

  const intensity = x => (x != null && x > 1 ? Math.log10(x) : 0);

  /**
   * items: [{value, thr (mg/kg, null = none), lift (vector or null)}]
   *   mode "oav":  value = amount in ug/kg
   *   mode "roav": value = area, relative content or amount (anything proportional to concentration)
   * Returns {rows: [{score, I, status}], profile (L1-normalized vector or null), nProfile}
   *   status "ok", "no_threshold", "no_value"
   */
  function compute(items, mode) {
    const ratio = items.map(it => (it.value != null && it.value >= 0 && it.thr > 0
      ? (mode === "oav" ? it.value / (it.thr * 1000) : it.value / it.thr) : null));
    const max = Math.max(0, ...ratio.filter(r => r != null));
    const rows = items.map((it, i) => {
      if (!(it.thr > 0)) return { score: null, I: 0, status: "no_threshold" };
      if (ratio[i] == null) return { score: null, I: 0, status: "no_value" };
      const score = mode === "oav" ? ratio[i] : max > 0 ? (100 * ratio[i]) / max : 0;
      return { score, I: intensity(score), status: "ok" };
    });
    let profile = null, nProfile = 0;
    rows.forEach((r, i) => {
      const l = items[i].lift;
      if (!(r.I > 0) || !l) return;
      if (!profile) profile = new Float64Array(l.length);
      l.forEach((x, k) => { profile[k] += r.I * x; });
      nProfile++;
    });
    if (profile) {
      const s = profile.reduce((a, b) => a + b, 0);
      if (s > 0) profile = profile.map(x => x / s); else profile = null;
    }
    return { rows, profile, nProfile };
  }

  /** Largest n dimensions of a profile: [[label index, value], ...], largest first. */
  function topDims(profile, n) {
    return Array.from(profile, (v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  /**
   * Radar chart as an SVG string. dims: [{label, value}] (values >= 0, scaled to the largest).
   * Colors come from the page's CSS variables, so it follows the light and dark themes.
   */
  function radarSvg(dims, opt) {
    const o = Object.assign({ size: 360, rings: 4, pad: 78 }, opt);
    const n = dims.length;
    if (n < 3) return "";
    const c = o.size / 2, r = c - o.pad;
    const max = Math.max(...dims.map(d => d.value)) || 1;
    const pt = (i, f) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      return [c + r * f * Math.cos(a), c + r * f * Math.sin(a)];
    };
    const poly = f => dims.map((d, i) => pt(i, typeof f === "function" ? f(d) : f).map(v => v.toFixed(1)).join(",")).join(" ");
    const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    let s = '<svg viewBox="0 0 ' + o.size + " " + o.size + '" role="img" class="radar">';
    for (let k = 1; k <= o.rings; k++) {
      s += '<polygon points="' + poly(k / o.rings) + '" fill="none" stroke="var(--border)" stroke-width="1"/>';
    }
    dims.forEach((d, i) => {
      const [x, y] = pt(i, 1);
      s += '<line x1="' + c + '" y1="' + c + '" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="var(--border)" stroke-width="1"/>';
      const [lx, ly] = pt(i, 1.12);
      const anchor = Math.abs(lx - c) < 4 ? "middle" : lx > c ? "start" : "end";
      s += '<text x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="' + anchor +
        '" dominant-baseline="middle" font-size="12" fill="var(--text)">' + esc(d.label) + "</text>";
    });
    s += '<polygon points="' + poly(d => d.value / max) + '" fill="var(--accent)" fill-opacity=".22" stroke="var(--accent)" stroke-width="2"/>';
    dims.forEach((d, i) => {
      const [x, y] = pt(i, d.value / max);
      s += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3" fill="var(--accent)"><title>' +
        esc(d.label + ": " + (100 * d.value).toFixed(1) + " %") + "</title></circle>";
    });
    return s + "</svg>";
  }

  window.GcmsFlavor = { UNITS, DAIRY_DIMS, guessUnit, buildIndex, threshold, lift, probs, weights, viewDims, descriptors, intensity, compute, topDims, radarSvg };
})();
