/*
 * Odor space map: about page (method, parameters, results, limitations, data).
 * The text sections were moved here from app.js; they read the same library and map metadata.
 */
(async function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const VERSION = new URL(document.currentScript.src).search;

  const get = url => fetch(url + VERSION).then(r => {
    if (!r.ok) throw new Error("Failed to load " + url);
    return r.json();
  });
  const [lib, meta] = await Promise.all([get("../ingredient-finder/data/library.json"), get("data/map.json"), I18N.ready]);
  const n = lib.molecules.length;
  const nFit = meta.n_fit || n;   // molecules of the UMAP fit; later ones were placed with UMAP.transform
  const labelIndex = Object.fromEntries(lib.labels.map((l, j) => [l.id, j]));
  const labelName = j => I18N.pick(lib.labels[j]);
  const nCat = meta.colours.length;

  const f3 = x => Number(x).toFixed(3);
  const pct = x => Math.round(100 * x) + "%";

  // counts written the same way everywhere on the page (5,094)
  const fmtN = x => Number(x).toLocaleString(I18N.lang === "zh" ? "zh-CN" : "en");
  function renderText() {
    $("hero-intro").textContent = I18N.t("hero.intro", { n: fmtN(n) }) +
      (n > nFit ? " " + I18N.t("hero.added", { m: n - nFit }) : ""); I18N.nobr($("hero-intro"));
    $("desc-odor").textContent = I18N.t("map.desc.odor", { n: meta.k });
    $("desc-structure").textContent = I18N.t("map.desc.structure", { n: meta.k });
    const fr = meta.top1_counts.fruity || 0;
    $("colour-note").textContent = I18N.t("colour.note", { k: nCat, fruity: labelName(labelIndex.fruity), p: pct(fr / nFit) });
    I18N.nobr($("colour-note"));   // keep the last words together (tools/check_orphans.py)
    $("region-note").textContent = I18N.t("region.note", { o: meta.regions.odor.length, s: meta.regions.structure.length, k: meta.region_rule.k_clusters });

    const P = meta.params, V = meta.eval.valid;
    $("params-table").innerHTML = "<thead><tr><th></th><th>" + esc(I18N.t("ctl.odor")) + "</th><th>" + esc(I18N.t("ctl.structure")) + "</th></tr></thead><tbody>" +
      [["params.input", I18N.t("params.input.odor"), I18N.t("params.input.structure")],
       ["params.metric", I18N.t("params.metric.cosine"), I18N.t("params.metric.jaccard")],
       ["params.nn", P.odor.n_neighbors, P.structure.n_neighbors],
       ["params.md", P.odor.min_dist, P.structure.min_dist],
       ["params.seed", meta.seed, meta.seed],
       ["params.valid", f3(V.odor_map.share_common_label) + " / " + f3(V.odor_map.mean_jaccard),
        f3(V.structure_map.share_common_label) + " / " + f3(V.structure_map.mean_jaccard)]]
        .map(([k, a, b]) => "<tr><th>" + esc(I18N.t(k)) + "</th><td>" + esc(a) + "</td><td>" + esc(b) + "</td></tr>").join("") + "</tbody>";

    const T = meta.eval.test;
    $("res-intro").textContent = I18N.t("results.intro", { n: T.n, k: meta.k }); I18N.nobr($("res-intro"));
    const row = (key, r, cls) => '<tr class="' + (cls || "") + '"><td>' + esc(I18N.t(key)) + '</td><td class="num">' + f3(r.share_common_label) +
      '</td><td class="num">' + f3(r.mean_jaccard) + "</td></tr>";
    const ci = T.map_diff_ci95;
    $("res-table").innerHTML = "<thead><tr><th></th><th class=\"num\">" + esc(I18N.t("res.share")) + "</th><th class=\"num\">" + esc(I18N.t("res.jaccard")) + "</th></tr></thead><tbody>" +
      row("res.odor_map", T.odor_map, "highlight") + row("res.structure_map", T.structure_map) +
      '<tr><td>' + esc(I18N.t("res.diff")) + '</td><td class="num">' + f3(T.odor_map.share_common_label - T.structure_map.share_common_label) +
      " [" + f3(ci.share_common_label[0]) + ", " + f3(ci.share_common_label[1]) + ']</td><td class="num">' +
      f3(T.odor_map.mean_jaccard - T.structure_map.mean_jaccard) + " [" + f3(ci.mean_jaccard[0]) + ", " + f3(ci.mean_jaccard[1]) + "]</td></tr>" +
      row("res.random", T.random) + row("res.odor_hd", T.odor_highdim) + row("res.structure_hd", T.structure_highdim) + "</tbody>";
    $("res-take").textContent = I18N.t("results.take", {
      oh: f3(T.odor_highdim.share_common_label), om: f3(T.odor_map.share_common_label),
      sh: f3(T.structure_highdim.share_common_label), sm: f3(T.structure_map.share_common_label),
      rnd: f3(T.random.share_common_label) });
    const sup = meta.eval.supplementary_top1_agreement;
    $("supp-text").textContent = I18N.t("supp.text", { n: fmtN(nFit), k: meta.k, o: f3(sup.odor), s: f3(sup.structure) });

    const ex = lib.excluded || [], by = {};
    ex.forEach(e => { (by[e.category] = by[e.category] || []).push(e); });
    $("excluded-note").textContent = I18N.t("excluded.note", { n: ex.length, total: fmtN(n) });
    I18N.nobr($("excluded-note"));
    // English lists end with "and <last name>" kept on one line, so no list ends with a lone name on its last line
    const nameList = names => {
      const e = names.map(esc);
      if (I18N.lang === "zh" || e.length < 2) return e.join(", ");
      return e.slice(0, -1).join(", ") + " <span class=\"nobr\">and " + e[e.length - 1] + "</span>";
    };
    $("excluded-list").innerHTML = Object.keys(by).map(c => "<li><b>" + esc(I18N.t("excluded.cat." + c)) + "</b> (" + by[c].length + "): " +
      nameList(by[c].map(e => e.name || e.smiles)) + "</li>").join("");
  }

  // ---------- 5.2.2 training animation (odor-map/media, training/odormap/make_training_video.py) ----------
  // The video loads only when played (preload="none"). It plays once by itself when it first scrolls
  // into view, unless the system asks for reduced motion (then the poster stays until the visitor plays it).
  // The epoch is page text (not burnt into the video), so it follows the language.
  const video = $("train-video"), epochEl = $("train-epoch");
  const frames = await get("data/training_frames.json");
  const epochAt = t => {
    let e = frames.keyframes[0].epoch;
    for (const k of frames.keyframes) if (t >= k.t) e = k.epoch;
    return e;
  };
  let shown = null;
  function showEpoch() {
    // before playing, the poster is the last frame (the model used on the site)
    const e = video.currentTime > 0 || !video.paused ? epochAt(video.currentTime) : frames.best_epoch;
    const key = e === frames.best_epoch ? "train.epoch_final" : "train.epoch";
    const text = I18N.t(key, { n: e });
    if (text !== shown) { epochEl.textContent = text; shown = text; }
    curveAt(e, false);
  }
  let ticking = false;
  function tick() {
    showEpoch();
    if (!video.paused && !video.ended) requestAnimationFrame(tick); else ticking = false;
  }
  video.addEventListener("play", () => { if (!ticking) { ticking = true; requestAnimationFrame(tick); } });
  ["seeked", "pause", "ended", "loadedmetadata"].forEach(ev => video.addEventListener(ev, showEpoch));
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(entries => {
      if (entries.some(en => en.isIntersecting)) {
        io.disconnect();
        video.play().catch(() => {});   // muted, so autoplay is allowed; if refused, the controls remain
      }
    }, { threshold: 0.6 });
    io.observe(video);
  }

  // colour legend under the video: the 10 colours of map.json + other, same colours as the map page.
  // Swatch colours are set through element.style (the page CSP does not allow style attributes).
  function renderLegend() {
    const ul = $("train-legend");
    ul.textContent = "";
    const items = meta.colours.map(id => [labelName(labelIndex[id]), meta.colour_hex[id]]).concat([[I18N.t("legend.other"), "#adb5bd"]]);
    for (const [name, hex] of items) {
      const li = document.createElement("li"), sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = hex;
      li.append(sw, document.createTextNode(name));
      ul.append(li);
    }
  }

  // ---------- curves under the video (data/training_frames.json "curve", make_training_video.py curve) ----------
  // Two panels on one epoch axis (no second y-axis): validation macro AUROC for every epoch, and the change
  // in predictions per epoch between saved checkpoints. Epoch 1 (from the untrained model) is far above the
  // others and is written as text instead of stretching the scale. A cursor follows the video's epoch;
  // pointer / touch on the chart shows the values of the nearest epoch.
  const C = frames.curve, NS = "http://www.w3.org/2000/svg", ACC = "#0f6e6e", MUT = "#6b6f76", GRID = "#e4e1da";
  const aucOf = new Map(C.auroc), lastEpoch = C.stopped;
  const changeOf = e => { for (const [b, v] of C.change) if (e <= b) return e === 0 ? null : v; return null; };
  const svg = $("train-curve-svg"), readout = $("train-readout");
  let geo = null, cursor = null, hovering = false, videoEpoch = frames.best_epoch;
  const mk = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const txt = (parent, x, y, str, attrs) => { const n = mk("text", Object.assign({ x, y }, attrs || {}), parent); n.textContent = str; return n; };
  const fmtA = v => v.toFixed(3), fmtC = v => v.toFixed(4);
  function renderCurve() {
    svg.textContent = "";
    const W = Math.max(280, Math.min(560, svg.parentElement.clientWidth || 560));
    // rows above the first panel: its title, then the epoch-marker labels (two rows on narrow screens)
    const narrow = W < 420, L = 40, R = 10, top = narrow ? 66 : 48, ph = 96, gap = 62, H = top + 2 * ph + gap + 34;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    const x = e => L + (W - L - R) * e / lastEpoch;
    const panels = [
      { y0: top, title: I18N.t("train.curve_auc"), lo: 0.45, hi: 0.9, ticks: [0.5, 0.6, 0.7, 0.8, 0.9], fmt: v => v.toFixed(1),
        pts: C.auroc, from: 0 },
      { y0: top + ph + gap, title: I18N.t("train.curve_change"), lo: 0, hi: 0.03, ticks: [0, 0.01, 0.02, 0.03], fmt: v => v === 0 ? "0" : v.toFixed(2),
        pts: C.change.filter(([e]) => e >= 2), from: 2 },
    ];
    // epoch markers: best (26) and early stopping (46), labels on two rows above the first panel
    [[C.best, I18N.t("train.curve_best", { n: C.best }), 0], [lastEpoch, I18N.t("train.curve_stop", { n: lastEpoch }), 1]].forEach(([e, label, row]) => {
      const ly = narrow ? (row ? top - 8 : top - 26) : top - 8;
      mk("line", { x1: x(e), x2: x(e), y1: ly - 10, y2: top + 2 * ph + gap, stroke: MUT, "stroke-width": 1, "stroke-dasharray": "3 3" }, svg);
      txt(svg, x(e) - 4, ly, label, { "text-anchor": "end", class: "tc-mark" });
    });
    for (const P of panels) {
      const y = v => P.y0 + ph * (1 - (Math.min(v, P.hi) - P.lo) / (P.hi - P.lo));
      txt(svg, L, P === panels[0] ? 14 : P.y0 - 28, P.title, { class: "tc-title" });
      for (const tv of P.ticks) {
        mk("line", { x1: L, x2: W - R, y1: y(tv), y2: y(tv), stroke: GRID, "stroke-width": 1 }, svg);
        txt(svg, L - 6, y(tv) + 4, P.fmt(tv), { "text-anchor": "end", class: "tc-tick" });
      }
      mk("polyline", { points: P.pts.map(([e, v]) => x(e).toFixed(1) + "," + y(v).toFixed(1)).join(" "), fill: "none", stroke: ACC,
        "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      if (P === panels[1]) {
        P.pts.forEach(([e, v]) => mk("circle", { cx: x(e), cy: y(v), r: 2.5, fill: ACC }, svg));
        txt(svg, L, P.y0 - 10, I18N.t("train.curve_first", { v: fmtC(C.change[0][1]).replace(/0+$/, "") }), { class: "tc-tick" });
      }
      P.y = y;
    }
    // shared epoch axis under the second panel
    const yAxis = top + 2 * ph + gap;
    [0, 10, 20, C.best, 30, 40, lastEpoch].forEach(e => txt(svg, x(e), yAxis + 16, String(e), { "text-anchor": "middle", class: "tc-tick" + (e === C.best ? " tc-best" : "") }));
    txt(svg, W - R, yAxis + 32, I18N.t("train.curve_x"), { "text-anchor": "end", class: "tc-tick" });
    cursor = mk("line", { y1: top, y2: yAxis, stroke: ACC, "stroke-width": 1, opacity: 0.6 }, svg);
    const hitR = mk("rect", { x: L, y: top, width: W - L - R, height: yAxis - top, fill: "transparent" }, svg);
    geo = { x, L, W, R, panels };
    const pick = ev => {
      const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * W / r.width;
      return Math.max(0, Math.min(lastEpoch, Math.round((px - L) / (W - L - R) * lastEpoch)));
    };
    hitR.addEventListener("pointermove", ev => { hovering = true; curveAt(pick(ev), true); });
    hitR.addEventListener("pointerdown", ev => { hovering = true; curveAt(pick(ev), true); });
    hitR.addEventListener("pointerleave", () => { hovering = false; curveAt(videoEpoch, false); });
    // the same numbers as a table for screen readers
    const tb = $("train-curve-table");
    tb.textContent = "";
    const head = tb.insertRow();
    [I18N.t("train.curve_epoch"), I18N.t("train.curve_auc"), I18N.t("train.curve_change")].forEach(h => { const th = document.createElement("th"); th.textContent = h; head.appendChild(th); });
    C.auroc.forEach(([e, a]) => { const row = tb.insertRow(); const c = changeOf(e); [e, fmtA(a), c == null ? "" : fmtC(c)].forEach(v => { row.insertCell().textContent = v; }); });
    curveAt(videoEpoch, false);
  }
  function curveAt(e, fromPointer) {
    if (!fromPointer) { videoEpoch = e; if (hovering) return; }
    if (!geo || !cursor) return;
    cursor.setAttribute("x1", geo.x(e));
    cursor.setAttribute("x2", geo.x(e));
    const c = changeOf(e);
    readout.textContent = I18N.t("train.curve_read", { n: e, a: fmtA(aucOf.get(e)), c: c == null ? "–" : fmtC(c) });
  }
  let cw = 0;
  window.addEventListener("resize", () => { const w = svg.parentElement.clientWidth; if (w !== cw) { cw = w; renderCurve(); } });

  function renderAll() {
    renderText();
    renderLegend();
    renderCurve();
    shown = null;
    showEpoch();
  }
  renderAll();
  I18N.onChange(renderAll);
})();
