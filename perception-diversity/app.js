/*
 * perception-diversity page: renders precomputed results (data/site.json) as inline SVG charts.
 * Built by training/perception/make_site_data.py; nothing is trained in the browser.
 */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const COMP = ["molecule", "concentration", "subject_x_stimulus", "subject", "noise"];
  const COMP_COLOR = { molecule: "var(--s1)", concentration: "var(--s2)", subject_x_stimulus: "var(--s3)", subject: "var(--s4)", noise: "var(--s5)" };
  let D = null;
  const state = { demo: 4, demoMode: "model", predVar: "pleasantness", spread: 0 };
  const t = (k, v) => I18N.t(k, v);
  const pct = (x, d = 0) => (x * 100).toFixed(d) + "%";
  const f2 = x => (x == null ? "-" : Number(x).toFixed(2));
  const f3 = x => (x == null ? "-" : Number(x).toFixed(3));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const $ = id => document.getElementById(id);

  // ---------- small SVG helpers ----------
  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function txt(parent, x, y, s, attrs) {
    const e = el("text", Object.assign({ x, y }, attrs || {}), parent);
    e.textContent = s;
    return e;
  }
  function setup(svg, h) {
    const w = Math.max(280, svg.parentNode.clientWidth - 28);
    svg.innerHTML = "";
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    return w;
  }
  const lin = (d0, d1, r0, r1) => v => r0 + (v - d0) / (d1 - d0) * (r1 - r0);
  /** rounded data-end bar: square at the baseline (x0), 4px radius at the data end. */
  function hbar(parent, x0, x1, y, h, fill, roundEnd) {
    const w = Math.abs(x1 - x0), r = roundEnd ? Math.min(4, w / 2, h / 2) : 0;
    const dir = x1 >= x0 ? 1 : -1, a = x0, b = x1;
    let d;
    if (!r) d = `M${a},${y}H${b}V${y + h}H${a}Z`;
    else d = `M${a},${y}H${b - dir * r}Q${b},${y} ${b},${y + r}V${y + h - r}Q${b},${y + h} ${b - dir * r},${y + h}H${a}Z`;
    return el("path", { d, fill }, parent);
  }

  // shared tooltip per viz-box
  function tipFor(svg) {
    const box = svg.closest(".viz-box");
    let tip = box.querySelector(".tip");
    if (!tip) { tip = document.createElement("div"); tip.className = "tip hidden"; box.appendChild(tip); }
    return {
      show(evt, html) {
        tip.innerHTML = html;
        tip.classList.remove("hidden");
        const r = box.getBoundingClientRect();
        let x = evt.clientX - r.left + 12, y = evt.clientY - r.top + 12;
        if (x + 240 > r.width) x = Math.max(4, evt.clientX - r.left - 250);
        tip.style.left = x + "px"; tip.style.top = y + "px";
      },
      hide() { tip.classList.add("hidden"); },
    };
  }
  function hover(node, tip, html) {
    node.addEventListener("pointerenter", e => tip.show(e, html()));
    node.addEventListener("pointermove", e => tip.show(e, html()));
    node.addEventListener("pointerleave", () => tip.hide());
    node.style.cursor = "default";
  }
  function legend(id, items) {
    $(id).innerHTML = items.map(([color, label, dot]) =>
      `<span><i class="${dot ? "dot" : ""}" style="background:${color}"></i>${esc(label)}</span>`).join("");
  }
  /** x axis with ticks and solid hairline grid. */
  function xAxis(g, x, ticks, y0, y1, fmt) {
    ticks.forEach(v => {
      el("line", { x1: x(v), x2: x(v), y1: y0, y2: y1, stroke: "var(--grid)", "stroke-width": 1 }, g);
      txt(g, x(v), y1 + 14, fmt ? fmt(v) : v, { "text-anchor": "middle" });
    });
  }
  /** dot strip: values stacked in bins so every dot stays visible. */
  function stackDots(values, x, binW) {
    const bins = new Map();
    return values.map(v => {
      const b = Math.round(x(v) / binW);
      const k = bins.get(b) || 0;
      bins.set(b, k + 1);
      return { v, cx: b * binW, k };
    });
  }

  // ---------- 1. data processing ----------
  function renderProcessing() {
    const p = D.processing;
    if ($("hero-data")) $("hero-data").innerHTML = t("hero.data", { s: p.subjects, m: p.molecules, n: p.rows.toLocaleString() });
    if (!$("flow")) return;
    const steps = [
      ["flow.1", { n: p.rows.toLocaleString() }],
      ["flow.2", { m: p.molecules, fix: (p.identity.cid_replaced || 0) + p.cid_repaired }],
      ["flow.3", { nd: p.not_detected.toLocaleString() }],
      ["flow.4", {}],
      ["flow.5", {}],
    ];
    $("flow").innerHTML = steps.map(([k, v]) =>
      `<li>${esc(t(k + ".t"))}<span class="sep"></span>${esc(t(k + ".d", v))}</li>`).join("");
    const rc = p.row_checks;
    const tiles = [
      [p.rows.toLocaleString(), t("tile.rows")],
      [rc.rating_out_of_range + rc.duplicate_subject_stimulus_presentation + rc.detected_but_rating_missing, t("tile.row_problems")],
      [p.id_problem_molecules, t("tile.id_problems")],
      [pct(p.not_detected / p.rows), t("tile.not_detected")],
    ];
    $("qc-tiles").innerHTML = '<table class="data"><tbody>' +
      tiles.map(([v, l]) => `<tr><td class="num">${esc(v)}</td><td>${esc(l)}</td></tr>`).join("") + "</tbody></table>";

    const rows = [
      [p.cid_repaired_names.join(", "), t("issue.cas_in_cid.what"), t("issue.cas_in_cid.fix")],
      ...p.issues.map(x => [x.name + (x.cid !== x.cid_in_sheet ? ` (CID ${x.cid_in_sheet} → ${x.cid})` : ` (CID ${x.cid})`),
        t("issue." + (x.cas_check === "check_digit_failed" ? "cas_bad" : x.identity) + ".what", { cas: x.cas_raw }),
        t("issue." + (x.cas_check === "check_digit_failed" ? "cas_bad" : x.identity) + ".fix")]),
    ];
    $("issues-table").innerHTML = `<thead><tr><th>${t("issue.col.mol")}</th><th>${t("issue.col.what")}</th><th>${t("issue.col.fix")}</th></tr></thead><tbody>` +
      rows.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join("") + "</tbody>";

    $("desc-table").innerHTML = `<thead><tr><th>${t("desc.col.k")}</th><th>${t("desc.col.m")}</th><th class="num">${t("desc.col.rho")}</th><th>${t("desc.col.top")}</th><th>${t("desc.col.dec")}</th></tr></thead><tbody>` +
      D.descriptors.map(d => `<tr><td>${esc(d.keller_descriptor)}</td><td>${esc(d.odor_model_label || "-")}</td><td class="num">${esc(d.rho_mapped || "-")}</td>` +
        `<td class="small">${esc(d.top3_labels_by_rho)}</td><td>${d.decision === "mapped" ? '<span class="pass">' + t("desc.mapped") + "</span>" : esc(t("desc." + d.decision.replace(/[^a-z]+/g, "_")))}</td></tr>`).join("") + "</tbody>";
    renderRetest();
  }

  function renderRetest() {
    const svg = $("retest-svg"), tip = tipFor(svg);
    const rows = [["ri", t("v.intensity")], ["rp", t("v.pleasantness")]];
    const L = 92, R = 12, w0 = Math.max(280, svg.parentNode.clientWidth - 28);
    const x = lin(-1, 1, L, w0 - R);
    // row height from the tallest dot stack, so dots never run into the label or the next row
    const stacks = rows.map(([key]) => Math.max(0, ...stackDots(D.subjects_qc.filter(s => s[key] != null).map(s => s[key]), x, 9).map(p => p.k)));
    const rowH = stacks.map(k => 30 + k * 9), top = 24;
    const ys = [top + rowH[0], top + rowH[0] + 14 + rowH[1]];
    const h = ys[1] + 52, w = setup(svg, h);
    xAxis(svg, x, [-1, -0.5, 0, 0.5, 1], top - 4, ys[1] + 10, v => v.toFixed(1));
    el("line", { x1: x(0.2), x2: x(0.2), y1: top - 10, y2: ys[0] + 6, stroke: "var(--text)", "stroke-width": 1 }, svg);
    txt(svg, x(0.2) + 4, top - 12, t("proc.retest.rule"), { class: "ink" });
    rows.forEach((r, i) => r.push(ys[i] - 16));
    rows.forEach(([key, label, yc]) => {
      txt(svg, 0, yc + 4, label, { class: "ink" });
      const vals = D.subjects_qc.filter(s => s[key] != null).sort((a, b) => a[key] - b[key]);
      const pts = stackDots(vals.map(s => s[key]), x, 9);
      pts.forEach((pt, i) => {
        const s = vals[i], low = s.flags.includes("low_retest_intensity");
        const c = el("circle", { cx: pt.cx, cy: yc + 16 - pt.k * 9, r: 4, fill: low ? "var(--s2)" : "var(--s1)", stroke: "var(--surface)", "stroke-width": 2 }, svg);
        hover(c, tip, () => `<b>${esc(s.s)}</b>${esc(label)}: r = ${f2(s[key])}<br>${t("tip.pairs", { n: s.n })}`);
      });
    });
    txt(svg, (L + w - R) / 2, h - 4, t("proc.retest.x"), { "text-anchor": "middle" });
    legend("retest-legend", [["var(--s1)", t("leg.retest_ok"), true], ["var(--s2)", t("leg.retest_low", { n: D.processing.flag_counts.low_retest_intensity }), true]]);
    $("retest-note").textContent = t("proc.retest.note", {
      pr: f2(D.processing.panel_reliability.pleasantness), ir: f2(D.processing.panel_reliability.intensity) });
  }

  // ---------- 2. variance decomposition ----------
  function renderVariance() {
    const vars = ["pleasantness", "intensity"];
    const hp = D.variance.pleasantness.all, hi = D.variance.intensity.all, k = "personal_of_stimulus_related";
    renderVarianceTable(vars, k);
    if (!$("var-svg")) return;
    const svg = $("var-svg"), tip = tipFor(svg);
    const h = 112, w = setup(svg, h), L = 86, R = 8, bh = 24;
    const x = lin(0, 1, L, w - R);
    xAxis(svg, x, [0, 0.25, 0.5, 0.75, 1], 6, h - 22, v => pct(v));
    vars.forEach((v, i) => {
      const s = D.variance[v].all, y = 18 + i * 40;
      txt(svg, 0, y + 16, t("v." + v), { class: "ink" });
      let acc = 0;
      COMP.forEach((c, j) => {
        const a = x(acc) + (j ? 1 : 0), b = x(acc + s.shares[c]) - 1;
        acc += s.shares[c];
        if (b <= a) return;
        const p = hbar(svg, a, b, y, bh, COMP_COLOR[c], j === COMP.length - 1);
        hover(p, tip, () => `<b>${esc(t("comp." + c))}</b>${pct(s.shares[c])} (95% CI ${pct(s.ci95[c][0])} - ${pct(s.ci95[c][1])})`);
        const label = pct(s.shares[c]);
        const ink = c === "molecule" ? "#ffffff" : "#1f2328";   // white on the dark blue fill, ink on the lighter ones
        if (b - a > 34) txt(svg, (a + b) / 2, y + 16, label, { "text-anchor": "middle", style: `fill:${ink};font-weight:600` });
      });
    });
    legend("var-legend", COMP.map(c => [COMP_COLOR[c], t("comp." + c)]));
    // OWID-style: one sentence under the chart with the key numbers in bold (no big-number tiles)
    $("var-hero").innerHTML = t("var.line", {
      pl: "<b>" + pct(hp.shares[k]) + "</b>", plo: pct(hp.ci95[k][0]), phi: pct(hp.ci95[k][1]),
      in: "<b>" + pct(hi.shares[k]) + "</b>", ilo: pct(hi.ci95[k][0]), ihi: pct(hi.ci95[k][1]) });
    $("var-take").textContent = t("var.take", { noise: pct(hp.shares.noise) });
  }

  function renderVarianceTable(vars, k) {
    if (!$("var-table")) return;
    const variants = ["all", "excl_low_retest", "excl_P55", "zscore", "nondetect_zero"];
    let html = `<thead><tr><th>${t("var.col.variant")}</th><th>${t("var.col.var")}</th>` + COMP.map(c => `<th class="num">${t("comp." + c)}</th>`).join("") + `<th class="num">${t("var.col.personal")}</th></tr></thead><tbody>`;
    vars.forEach(v => variants.forEach(vr => {
      const s = D.variance[v][vr];
      if (!s) return;
      html += `<tr${vr === "all" ? ' class="highlight"' : ""}><td>${esc(t("variant." + vr))}</td><td>${esc(t("v." + v))}</td>` +
        COMP.map(c => `<td class="num">${pct(s.shares[c])}</td>`).join("") +
        `<td class="num">${pct(s.shares[k])} <span class="muted small">(${pct(s.ci95[k][0])} - ${pct(s.ci95[k][1])})</span></td></tr>`;
    }));
    $("var-table").innerHTML = html + "</tbody>";
    const nd = D.variance_noise;
    $("var-method").textContent = t("var.method", {
      rep: nd.pleasantness.residual_var_repeated_molecules, oth: nd.pleasantness.residual_var_other_molecules,
      lo: nd.intensity.noise_by_rating_tercile.high, mid: nd.intensity.noise_by_rating_tercile.middle });
  }

  // ---------- 3. individual spread ----------
  function renderSpread() {
    if (!$("spread-svg")) return;
    const P = D.spread.presets, p = P[state.spread];
    const sel = $("spread-select");
    sel.innerHTML = P.map((q, i) => `<option value="${i}"${i === state.spread ? " selected" : ""}>${esc(q.name)}</option>`).join("");
    $("spread-title").textContent = t("spread.chart", { name: p.name, dil: p.dilution });
    $("spread-sub").textContent = t("spread.sub", { k: p.n_detected, n: p.n });
    const svg = $("spread-svg"), tip = tipFor(svg);
    const L = 8, R = 8, w0 = Math.max(280, svg.parentNode.clientWidth - 28);
    const x = lin(0, 100, L + 6, w0 - R - 6);
    const binW = Math.max(9, (x(5) - x(0)));
    const pts = stackDots(p.values, x, binW);
    const maxK = Math.max(...pts.map(q => q.k));
    const h = 82 + (maxK + 1) * 9.5, w = setup(svg, h), base = h - 44;
    xAxis(svg, x, [0, 25, 50, 75, 100], 8, base + 6, v => v);
    pts.forEach(pt => {
      const c = el("circle", { cx: pt.cx, cy: base - 4 - pt.k * 9.5, r: 4, fill: "var(--s1)", stroke: "var(--surface)", "stroke-width": 2 }, svg);
      hover(c, tip, () => `${t("tip.rating")}: <b style="display:inline">${pt.v}</b>`);
    });
    el("line", { x1: x(p.mean), x2: x(p.mean), y1: 12, y2: base + 2, stroke: "var(--text)", "stroke-width": 1.5 }, svg);
    txt(svg, x(p.mean) + (p.mean > 70 ? -4 : 4), 22, t("spread.mean", { m: p.mean.toFixed(0) }), { class: "ink", "text-anchor": p.mean > 70 ? "end" : "start" });
    txt(svg, x(0), h - 4, t("spread.x0"), { "text-anchor": "start" });
    txt(svg, x(100), h - 4, t("spread.x1"), { "text-anchor": "end" });
    $("spread-note").textContent = t("spread.note", { sd: p.sd.toFixed(0), rank: p.sd_rank, med: D.spread.sd_median.toFixed(0), n: D.spread.n_stimuli_ranked }) +
      (t("spread.about." + p.cid) !== "spread.about." + p.cid ? " " + t("spread.about." + p.cid) : "");
  }

  // ---------- 4. new-consumer demo ----------
  function renderDemo() {
    if (!$("demo-svg")) return;
    const S = D.demo.subjects, s = S[state.demo];
    $("demo-select").innerHTML = S.map((q, i) => `<option value="${i}"${i === state.demo ? " selected" : ""}>${esc(q.s)}</option>`).join("");
    $("demo-known").innerHTML = esc(t("pred.known")) + " " +
      s.known.map(k => `${esc(k.name)} <b>${k.y}</b>`).join(I18N.lang === "zh" ? "、" : ", ");
    const model = state.demoMode === "model";
    $("btn-model").setAttribute("aria-pressed", model);
    $("btn-panel").setAttribute("aria-pressed", !model);
    $("demo-title").textContent = t(model ? "pred.chart.model" : "pred.chart.panel", { n: s.pts.length });
    $("demo-sub").textContent = t("pred.chart.sub", { r: f2(model ? s.r_model : s.r_panel), e: (model ? s.rmse_model : s.rmse_panel).toFixed(1),
      r2: f2(model ? s.r_panel : s.r_model), other: t(model ? "pred.btn.panel" : "pred.btn.model") });
    $("demo-rule").textContent = t("pred.rule");
    const svg = $("demo-svg"), tip = tipFor(svg);
    const w0 = Math.max(280, svg.parentNode.clientWidth - 28), size = Math.min(w0, 460);
    const h = size, w = setup(svg, h), L = 40, B = 34, T = 8, R = 10;
    const pw = Math.min(w - L - R, h - T - B);
    const x = lin(0, 100, L, L + pw), y = lin(0, 100, T + pw, T);
    [0, 25, 50, 75, 100].forEach(v => {
      el("line", { x1: x(v), x2: x(v), y1: T, y2: T + pw, stroke: "var(--grid)" }, svg);
      el("line", { x1: L, x2: L + pw, y1: y(v), y2: y(v), stroke: "var(--grid)" }, svg);
      txt(svg, x(v), T + pw + 14, v, { "text-anchor": "middle" });
      txt(svg, L - 6, y(v) + 4, v, { "text-anchor": "end" });
    });
    el("line", { x1: x(0), y1: y(0), x2: x(100), y2: y(100), stroke: "var(--axis)", "stroke-width": 1 }, svg);
    txt(svg, L + pw / 2, h - 2, t("pred.x"), { "text-anchor": "middle" });
    const yl = txt(svg, 12, T + pw / 2, t("pred.y"), { "text-anchor": "middle", transform: `rotate(-90 12 ${T + pw / 2})` });
    yl.setAttribute("dy", "0");
    const g = el("g", {}, svg);
    s.pts.forEach(([yy, pm, pp]) => {
      const pv = model ? pm : pp;
      el("circle", { cx: x(Math.max(0, Math.min(100, pv))), cy: y(yy), r: 3, fill: "var(--s1)", "fill-opacity": 0.45 }, g);
    });
    // nearest-point tooltip on one overlay
    const ov = el("rect", { x: L, y: T, width: pw, height: pw, fill: "transparent" }, svg);
    ov.addEventListener("pointermove", e => {
      const r = svg.getBoundingClientRect(), sc = w / r.width;
      const mx = (e.clientX - r.left) * sc, my = (e.clientY - r.top) * sc;
      let best = -1, bd = 1e9;
      s.pts.forEach(([yy, pm, pp], i) => {
        const dx = x(model ? pm : pp) - mx, dy = y(yy) - my, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      });
      if (best < 0 || bd > 400) return tip.hide();
      const q = s.pts[best];
      tip.show(e, `<b>${esc(s.names[best])}</b>${t("tip.actual")}: ${q[0]}<br>${t("tip.pred")}: ${(model ? q[1] : q[2]).toFixed(0)}`);
    });
    ov.addEventListener("pointerleave", () => tip.hide());
  }

  // ---------- 5. results table + curve ----------
  function renderPred() {
    if (!$("pred-table")) return;
    const v = state.predVar, P = D.prediction[v];
    $("btn-pl").setAttribute("aria-pressed", v === "pleasantness");
    $("btn-in").setAttribute("aria-pressed", v === "intensity");
    const row = (label, r, e, cls) => `<tr${cls ? ` class="${cls}"` : ""}><td>${esc(label)}</td><td class="num">${r == null ? "-" : f2(r)}</td><td class="num">${e == null ? "-" : e.toFixed(1)}</td></tr>`;
    let html = `<thead><tr><th>${t("pt.col.model")}</th><th class="num">${t("pt.col.r")}</th><th class="num">${t("pt.col.rmse")}</th></tr></thead><tbody>`;
    html += `<tr><th colspan="3">${esc(t("pt.A"))}</th></tr>`;
    html += row(t("m.global_mean"), null, P.A.global_mean.rmse);
    html += row(t("m.personal_mean"), P.A.personal_mean.r, P.A.personal_mean.rmse);
    html += row(t("m.population"), P.A.population.r, P.A.population.rmse);
    html += row(t("m.population_offset"), P.A.population_offset.r, P.A.population_offset.rmse);
    html += row(t("m.population_offset_slopes"), P.A.population_offset_slopes.r, P.A.population_offset_slopes.rmse, "highlight");
    html += row(t("m.fp_full"), P.A_fp.population_offset_slopes.r, P.A_fp.population_offset_slopes.rmse);
    html += row(t("m.reference"), P.A.reference_panel_mean_offset.r, P.A.reference_panel_mean_offset.rmse);
    html += `<tr><th colspan="3">${esc(t("pt.B"))}</th></tr>`;
    html += row(t("m.global_mean"), null, P.B.global_mean.rmse);
    html += row(t("m.personal_mean5"), P.B.personal_mean.r, P.B.personal_mean.rmse);
    html += row(t("m.molecule_mean"), P.B.molecule_mean.r, P.B.molecule_mean.rmse);
    html += row(t("m.molecule_offset"), P.B.molecule_offset.r, P.B.molecule_offset.rmse);
    html += row(t("m.molecule_offset_factors"), P.B.molecule_offset_factors.r, P.B.molecule_offset_factors.rmse, "highlight");
    html += row(t("m.probe"), P.B_probe.molecule_offset_factors.r, P.B_probe.molecule_offset_factors.rmse);
    html += `<tr><th colspan="3">${esc(t("pt.C"))}</th></tr>`;
    html += row(t("m.retest"), P.ceiling.retest_r, null);
    html += row(t("m.max"), P.ceiling.max_r, null);
    $("pred-table").innerHTML = html + "</tbody>";
    const c = P.cmp;
    $("pred-take").textContent = t("pred.take." + v, {
      pop: f2(P.A_pop.r_stimulus_means), rel: f2(P.ceiling.panel_reliability), unseen: f2(P.A_pop.r_stimulus_means_unseen), seen: f2(P.A_pop.r_stimulus_means_train),
      sl: f3(c.A_slopes_vs_offset.diff), sl0: f3(c.A_slopes_vs_offset.ci95[0]), sl1: f3(c.A_slopes_vs_offset.ci95[1]),
      fp: f3(c.A_gnn_vs_fingerprint_population.diff), fp0: f3(c.A_gnn_vs_fingerprint_population.ci95[0]), fp1: f3(c.A_gnn_vs_fingerprint_population.ci95[1]),
      off: f3(c.B5_offset_vs_molecule_mean.diff), off0: f3(c.B5_offset_vs_molecule_mean.ci95[0]), off1: f3(c.B5_offset_vs_molecule_mean.ci95[1]),
      fac: c.B5_factors_vs_offset.diff.toFixed(4) });
    renderCurve();
  }

  function renderCurve() {
    const P = D.prediction[state.predVar], svg = $("curve-svg"), tip = tipFor(svg);
    const ns = Object.keys(P.B_curve).map(Number).sort((a, b) => a - b);
    const h = 220, w = setup(svg, h), L = 40, R = 16, T = 10, B = 34;
    const x = lin(Math.log(1), Math.log(50), L, w - R);
    const lo = 0.3, hi = 0.8, y = lin(lo, hi, h - B, T);
    [0.3, 0.4, 0.5, 0.6, 0.7, 0.8].forEach(v => {
      el("line", { x1: L, x2: w - R, y1: y(v), y2: y(v), stroke: "var(--grid)" }, svg);
      txt(svg, L - 6, y(v) + 4, v.toFixed(1), { "text-anchor": "end" });
    });
    ns.forEach(n => txt(svg, x(Math.log(n)), h - B + 16, n, { "text-anchor": "middle" }));
    txt(svg, (L + w - R) / 2, h - 2, t("pred.curve.x"), { "text-anchor": "middle" });
    [["retest_r", t("m.retest")], ["max_r", t("m.max")]].forEach(([k, label]) => {
      el("line", { x1: L, x2: w - R, y1: y(P.ceiling[k]), y2: y(P.ceiling[k]), stroke: "var(--text)", "stroke-width": 1 }, svg);
      txt(svg, w - R, y(P.ceiling[k]) - 5, label + " " + f2(P.ceiling[k]), { "text-anchor": "end", class: "ink" });
    });
    const series = [["molecule_offset_factors", "var(--s1)"], ["molecule_mean", "var(--s2)"]];
    series.forEach(([m, col]) => {
      const pts = ns.map(n => [x(Math.log(n)), y(P.B_curve[n][m].r)]);
      el("path", { d: "M" + pts.map(p => p.join(",")).join("L"), fill: "none", stroke: col, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      pts.forEach((p, i) => {
        const c = el("circle", { cx: p[0], cy: p[1], r: 4, fill: col, stroke: "var(--surface)", "stroke-width": 2 }, svg);
        hover(c, tip, () => `<b>${esc(t("m." + m))}</b>${t("pred.curve.tip", { n: ns[i], r: f2(P.B_curve[ns[i]][m].r) })}`);
      });
    });
    legend("curve-legend", series.map(([m, col]) => [col, t("m." + m), true]));
  }

  // ---------- 6. segments ----------
  function renderSegments() {
    const S = D.segments, a = S.axes[0];
    const verdict = S.decision.segments_supported ? "seg.verdict.yes" : "seg.verdict.no";
    if ($("seg-verdict")) {
      // tool page: the one-sentence verdict and the score strip; the method page has the full text
      $("seg-verdict").textContent = t(S.decision.segments_supported ? "seg.verdict.yes" : "seg.verdict.short");
      renderScores(a);
      return;
    }
    if (!$("seg-table")) return;
    $("seg-verdict-full").textContent = t(verdict, { r: f2(S.pairwise_deviation_r.mean) });
    const tab = S.table.all;
    let html = `<thead><tr><th>${t("seg.col.method")}</th><th class="num">k</th><th class="num">${t("seg.col.sil")}</th><th class="num">${t("seg.col.null")}</th><th class="num">${t("seg.col.ari")}</th><th>${t("seg.col.sizes")}</th><th>${t("seg.col.pass")}</th></tr></thead><tbody>`;
    ["hierarchical", "kmeans"].forEach(m => Object.entries(tab[m]).forEach(([k, r]) => {
      const ok = r.silhouette > r.null_p95 && r.split_half_ari_mean >= 0.5;
      html += `<tr><td>${esc(t("seg.m." + m))}</td><td class="num">${k}</td><td class="num">${r.silhouette.toFixed(3)}</td><td class="num">${r.null_p95.toFixed(3)}</td>` +
        `<td class="num">${r.split_half_ari_mean.toFixed(2)}</td><td class="small">${r.sizes.join(" / ")}</td><td>${ok ? '<span class="pass">' + t("yes") + "</span>" : '<span class="fail">' + t("no") + "</span>"}</td></tr>`;
    }));
    $("seg-table").innerHTML = html + "</tbody>";
    $("seg-axis-text").textContent = t("seg.axis.text", { v: pct(a.variance_share, 1), vn: pct(a.null_p95, 1), r: f2(a.split_half_abs_r), rn: f2(a.split_half_null_p95), ri: f2(a.rho_with_panel_intensity) });
    renderAxis(S, a);
  }

  // subject scores strip
  function renderScores(a) {
    const svg = $("scores-svg"), tip = tipFor(svg);
    const h = 110, w = setup(svg, h), L = 10, R = 10;
    const ext = Math.max(...a.scores.map(Math.abs)) * 1.05;
    const x = lin(-ext, ext, L, w - R), base = 66;
    el("line", { x1: x(0), x2: x(0), y1: 8, y2: base + 4, stroke: "var(--axis)" }, svg);
    stackDots(a.scores, x, 9).forEach(pt => {
      const c = el("circle", { cx: pt.cx, cy: base - pt.k * 9, r: 4, fill: "var(--s1)", stroke: "var(--surface)", "stroke-width": 2 }, svg);
      hover(c, tip, () => t("tip.score", { v: pt.v.toFixed(1) }));
    });
    txt(svg, L, h - 18, t("seg.end.neg"), { class: "ink", "text-anchor": "start" });
    txt(svg, w - R, h - 18, t("seg.end.pos"), { class: "ink", "text-anchor": "end" });
    txt(svg, L, h - 3, t("seg.end.neg2"), { "text-anchor": "start" });
    txt(svg, w - R, h - 3, t("seg.end.pos2"), { "text-anchor": "end" });
  }

  // descriptor bars (intensity partialled), diverging
  function renderAxis(S, a) {
    const ds = Object.entries(a.descriptor_rho_intensity_partialled).sort((p, q) => q[1] - p[1]);
    const svg2 = $("axis-svg"), tip2 = tipFor(svg2);
    const rowH = 18, h2 = ds.length * rowH + 30, w2 = setup(svg2, h2), L2 = 118, R2 = 10;
    const m = 0.35, x2 = lin(-m, m, L2, w2 - R2);
    xAxis(svg2, x2, [-0.3, -0.15, 0, 0.15, 0.3], 0, h2 - 22, v => v.toFixed(2));
    ds.forEach(([d, v], i) => {
      const yy = 4 + i * rowH;
      txt(svg2, L2 - 8, yy + 11, d.replace("_", "/"), { "text-anchor": "end", class: "ink" });
      const p = hbar(svg2, x2(0), x2(v), yy + 2, 12, v >= 0 ? "var(--pos)" : "var(--neg)", true);
      hover(p, tip2, () => `<b>${esc(d.replace("_", "/"))}</b>rho = ${v.toFixed(2)}`);
    });
    el("line", { x1: x2(0), x2: x2(0), y1: 0, y2: h2 - 22, stroke: "var(--text)", "stroke-width": 1 }, svg2);
    legend("axis-legend", [["var(--pos)", t("seg.leg.pos")], ["var(--neg)", t("seg.leg.neg")]]);
    $("seg-axis-note").textContent = t("seg.axis.note", { q: Object.values(a.subject_score_rho_with_qc).map(Math.abs).reduce((p, q) => Math.max(p, q), 0).toFixed(2),
      v2: pct(S.axes[1].variance_share, 1), r2: f2(S.axes[1].split_half_abs_r), rn2: f2(S.axes[1].split_half_null_p95) });
  }

  function renderAll() {
    renderProcessing();
    renderVariance();
    renderSpread();
    renderDemo();
    renderPred();
    renderSegments();
  }

  async function main() {
    await I18N.ready;
    try {
      D = await (await fetch("data/site.json?v=20261019y")).json();
    } catch (e) {
      $("load-status").textContent = t("load_error");
      return;
    }
    $("load-status").classList.add("hidden");
    const on = (id, ev, fn) => { if ($(id)) $(id).addEventListener(ev, fn); };
    on("spread-select", "change", e => { state.spread = +e.target.value; renderSpread(); });
    on("demo-select", "change", e => { state.demo = +e.target.value; renderDemo(); });
    on("btn-model", "click", () => { state.demoMode = "model"; renderDemo(); });
    on("btn-panel", "click", () => { state.demoMode = "panel"; renderDemo(); });
    on("btn-pl", "click", () => { state.predVar = "pleasantness"; renderPred(); });
    on("btn-in", "click", () => { state.predVar = "intensity"; renderPred(); });
    // deep links for checking: ?spread=<i>&demo=<i>
    const q = new URLSearchParams(location.search);
    if (q.has("spread")) state.spread = Math.min(+q.get("spread") || 0, D.spread.presets.length - 1);
    if (q.has("demo")) state.demo = Math.min(+q.get("demo") || 0, D.demo.subjects.length - 1);
    renderAll();
    I18N.onChange(renderAll);
    let rt;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(renderAll, 150); });
  }
  main();
})();
