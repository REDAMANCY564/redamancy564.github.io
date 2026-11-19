/*
 * "How it predicts" page (odor-predictor/process.html): the odor MPNN step by step for one molecule.
 *
 * Steps: input -> input embedding h0 -> layers 1-3 (messages along the bonds, residual update) ->
 * pooling (mean + max) -> output (top 8 descriptors, as the tool page).
 * - Every number drawn is a real model value: precomputed molecules come from data/process/<id>.json
 *   (training/process_site_data.py, 4 decimals); molecules handed over from the tool page are computed
 *   here with ONNX Runtime from model/odor_mpnn.onnx (step 3 of the plan).
 * - Colours are display only: data/process_display.json gives the darkest value (99th percentile on the
 *   training set; one scale for h0-h3 since the residual update never lowers a value) and the column
 *   order of the 256 channels; colour depth = sqrt(min(v / scale, 1)).
 * - Animations run on one requestAnimationFrame clock (as research/research.js): paused while the stage
 *   is out of view, Pause holds it, prefers-reduced-motion draws every step in its final state.
 * - No inline styles (strict CSP): SVG attributes and canvas drawing only.
 */
(async function () {
  "use strict";
  await I18N.ready;
  const t = I18N.t;
  const $ = id => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const H = 256;
  const PICKER = ["diacetyl", "vanillin", "delta-decalactone", "2-acetyl-1-pyrroline", "methanethiol"];
  const STEPS = ["input", "embed", "layer1", "layer2", "layer3", "pool", "out"];
  const ELEMENTS = ["C", "N", "O", "S", "F", "Cl", "Br", "I", "P", "?"];
  const BOND_KEYS = ["single", "double", "triple", "aromatic", "other"];
  const BOND_COLOUR = ["#6b7078", "#2f67c7", "#8e4ec6", "#c98a12", "#3a9d5d"];
  const FLASH = [194, 65, 12];   // --hi: cells that grew in this layer flash in this colour

  async function getJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }
  const [display, index, labels] = await Promise.all([
    getJson("data/process_display.json"), getJson("data/process/index.json"), getJson("model/labels.json")]);
  const labelById = {};
  labels.forEach(l => { labelById[l.id] = l; });
  const labelName = id => (labelById[id] ? I18N.pick(labelById[id]) : id);
  const ORDER = display.order;
  const SCALE = display.scale;

  // ---------- colour ramps ----------
  function lut(stops) {   // 256 rgb triples, linear between stops [[pos, [r,g,b]], ...]
    const out = [];
    for (let k = 0; k < 256; k++) {
      const p = k / 255;
      let i = 0;
      while (i < stops.length - 2 && p > stops[i + 1][0]) i++;
      const [p0, c0] = stops[i], [p1, c1] = stops[i + 1];
      const e = (p - p0) / (p1 - p0);
      out.push(c0.map((v, j) => Math.round(v + (c1[j] - v) * e)));
    }
    return out;
  }
  const ZERO = [241, 239, 233];
  const SEQ = lut([[0, ZERO], [0.5, [111, 179, 171]], [1, [9, 69, 69]]]);
  const NEG = lut([[0, ZERO], [1, [176, 58, 10]]]);
  const depth = (v, s) => Math.sqrt(Math.min(Math.max(v, 0) / s, 1));
  function seqColour(v, s) { return SEQ[Math.round(depth(v, s) * 255)]; }
  function divColour(v, s) { const d = Math.round(depth(Math.abs(v), s) * 255); return v < 0 ? NEG[d] : SEQ[d]; }
  const rgb = c => "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";

  // ---------- molecule data ----------
  function decodeAtom(x) {
    let k = 0;
    const block = w => { const j = x.slice(k, k + w).indexOf(1); k += w; return j; };
    const el = ELEMENTS[block(10)];
    const deg = block(6), hs = block(5), chg = [-1, 0, 1][block(3)];
    return { el, deg, hs, chg, arom: x[k] === 1, ring: x[k + 1] === 1 };
  }
  function bondInfo(v) { const type = v.slice(0, 5).indexOf(1); return { type: type < 0 ? 4 : type, ring: v[5] === 1 }; }
  function distances(n, bonds) {
    const adj = Array.from({ length: n }, () => []);
    bonds.forEach(b => { adj[b.i].push(b.j); adj[b.j].push(b.i); });
    return adj.map((_, s) => {
      const d = new Array(n).fill(Infinity);
      d[s] = 0;
      const q = [s];
      while (q.length) { const u = q.shift(); for (const w of adj[u]) if (d[w] === Infinity) { d[w] = d[u] + 1; q.push(w); } }
      return d;
    });
  }
  /** Precomputed record (data/process/<id>.json) -> page molecule. */
  function fromRecord(r) {
    const flat = a => Float32Array.from(a.flat());
    const n = r.n;
    const X = r.X.map(row => row.slice());
    const bonds = r.bonds.map(([i, j, v]) => Object.assign({ i, j }, bondInfo(v)));
    return {
      id: r.id, smiles: r.smiles, name: { en: r.name_en, zh: r.name_zh }, n, X,
      atoms: X.map(decodeAtom), bonds, coords: r.coords,
      h: ["h0", "h1", "h2", "h3"].map(k => flat(r[k])),
      m: [null, flat(r.m1), flat(r.m2), flat(r.m3)],
      poolMean: Float32Array.from(r.pool_mean), poolMax: Float32Array.from(r.pool_max),
      top: r.top, dist: distances(n, bonds),
    };
  }
  const cache = {};
  async function loadPreset(id) {
    if (!cache[id]) cache[id] = getJson("data/process/" + id + ".json").then(fromRecord);
    return cache[id];
  }
  const atomName = (mol, i) => mol.atoms[i].el + (i + 1);

  // ---------- clock (as research/research.js) ----------
  const ease = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  const clock = { paused: true, held: false, tweens: [], vt: 0, last: null };
  function tick(ts) {
    if (clock.last != null && !clock.paused && !clock.held) clock.vt += Math.min(ts - clock.last, 100);
    clock.last = ts;
    for (const tw of clock.tweens.slice()) {
      const p = Math.min(1, Math.max(0, (clock.vt - tw.t0) / tw.d));
      tw.fn(tw.linear ? p : ease(p));
      if (p >= 1) { clock.tweens.splice(clock.tweens.indexOf(tw), 1); tw.res(); }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  let gen = 0;
  class Cancelled extends Error {}
  function tweener(instant, my) {
    return function (sec, fn, linear) {
      if (my !== gen) return Promise.reject(new Cancelled());
      if (instant) { if (fn) fn(1); return Promise.resolve(); }
      return new Promise(res => clock.tweens.push({ t0: clock.vt, d: sec * 1000, fn: fn || (() => {}), res, linear }))
        .then(() => { if (my !== gen) throw new Cancelled(); });
    };
  }

  // ---------- state ----------
  const S = { mol: null, step: 0, sel: 0, selBond: null, view: null };
  // view: what the strips show: {layer, prev, e, reveal, dim}
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };

  // ---------- structure drawing (own SVG from the 2D coordinates) ----------
  const molSvg = $("pp-mol");
  let MOL = null;   // {atoms: [{g, sel, field, x, y}], bonds: [...], dots, scaleXY}
  function drawMolecule(mol) {
    molSvg.textContent = "";
    const xs = mol.coords.map(c => c[0]), ys = mol.coords.map(c => -c[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    // px per coordinate unit: a median bond is drawn 55 px long, less when the molecule would not fit the
    // column, so the SVG is never scaled down and the atom letters keep their 14 px
    const lens = mol.bonds.map(b => Math.hypot(xs[b.i] - xs[b.j], ys[b.i] - ys[b.j])).sort((p, q) => p - q);
    const bondLen = lens.length ? lens[lens.length >> 1] : 1;
    const pad = 22, avail = Math.max(240, (molSvg.parentElement.clientWidth || 340) - 4);
    const k = Math.min(55 / bondLen, (avail - 2 * pad) / Math.max(maxX - minX, 0.01));
    const w = Math.max((maxX - minX) * k + 2 * pad, 120), h = Math.max((maxY - minY) * k + 2 * pad, 80);
    const ox = (w - (maxX - minX) * k) / 2 - minX * k, oy = (h - (maxY - minY) * k) / 2 - minY * k;
    molSvg.setAttribute("viewBox", "0 0 " + w.toFixed(1) + " " + h.toFixed(1));
    molSvg.setAttribute("width", Math.round(w));
    molSvg.setAttribute("height", Math.round(h));
    const P = mol.coords.map((c, i) => [xs[i] * k + ox, ys[i] * k + oy]);
    const gHalo = el("g", {}, molSvg), gSel = el("g", {}, molSvg), gBond = el("g", {}, molSvg);
    const gDots = el("g", {}, molSvg), gAtom = el("g", {}, molSvg), gHit = el("g", {}, molSvg);
    // ring centre per bond, so the inner line of double / aromatic ring bonds goes inside the ring
    const centre = [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length];
    const bonds = mol.bonds.map((b, bi) => {
      const [x1, y1] = P[b.i], [x2, y2] = P[b.j];
      const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
      let nx = -uy, ny = ux;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      if ((centre[0] - mx) * nx + (centre[1] - my) * ny < 0) { nx = -nx; ny = -ny; }
      const sh = 11;   // trim near labelled atoms
      const a = [x1 + ux * sh, y1 + uy * sh], c = [x2 - ux * sh, y2 - uy * sh];
      const col = BOND_COLOUR[b.type];
      if (b.ring) el("line", { x1: a[0], y1: a[1], x2: c[0], y2: c[1], class: "ring-halo" }, gHalo);
      const line = (o, dash) => el("line", Object.assign({ x1: a[0] + nx * o, y1: a[1] + ny * o, x2: c[0] + nx * o, y2: c[1] + ny * o,
        class: "bond", stroke: col }, dash ? { "stroke-dasharray": "3 3" } : {}), gBond);
      if (b.type === 0 || b.type === 4) line(0);
      else if (b.type === 1) { if (b.ring) { line(0); line(5); } else { line(-2.5); line(2.5); } }
      else if (b.type === 2) { line(-4); line(0); line(4); }
      else { line(0); line(5, true); }
      const sel = el("line", { x1: x1, y1: y1, x2: x2, y2: y2, class: "bsel", opacity: 0 }, gSel);
      const hit = el("line", { x1: x1, y1: y1, x2: x2, y2: y2, class: "bond-hit" }, gHit);
      hit.addEventListener("click", () => selectBond(bi));
      return { sel, p1: P[b.i], p2: P[b.j], col };
    });
    const atoms = mol.atoms.map((a, i) => {
      const [x, y] = P[i];
      const field = el("circle", { cx: x, cy: y, r: 13, class: "atom-field", opacity: 0 }, gAtom);
      el("circle", { cx: x, cy: y, r: 10, class: "atom-bg" }, gAtom);
      const tx = el("text", { x: x, y: y, class: "atom-t el-" + (["C", "O", "N", "S"].includes(a.el) ? a.el : "X") }, gAtom);
      tx.textContent = a.el;
      const sel = el("circle", { cx: x, cy: y, r: 13, class: "atom-sel", opacity: 0 }, gAtom);
      const hit = el("circle", { cx: x, cy: y, r: 16, class: "atom-hit" }, gHit);
      hit.addEventListener("click", () => selectAtom(i));
      return { field, sel, tx, x, y };
    });
    const dots = mol.bonds.flatMap(b => {
      const col = BOND_COLOUR[b.type];
      return [[b.j, b.i], [b.i, b.j]].map(([from, to]) => ({
        from: P[from], to: P[to], node: el("circle", { cx: P[from][0], cy: P[from][1], r: 4, class: "dot", fill: col, opacity: 0 }, gDots) }));
    });
    MOL = { atoms, bonds, dots };
    molSvg.setAttribute("aria-label", t("proc.mol_aria", { name: I18N.pick(mol.name), n: mol.n }));
  }
  function setField(layer, noRing) {   // receptive field of the selected atom after `layer` (null: none)
    const d = S.mol.dist[S.sel];
    MOL.atoms.forEach((a, i) => {
      a.sel.setAttribute("opacity", i === S.sel && !noRing ? 1 : 0);
      const inside = layer == null || d[i] <= layer;
      a.field.setAttribute("opacity", layer != null && inside ? 1 : 0);
      a.tx.setAttribute("opacity", inside ? 1 : 0.35);
    });
  }

  // ---------- strips (canvas) ----------
  const stripCanvas = $("pp-strip-canvas");
  const DPR = () => Math.min(window.devicePixelRatio || 1, 3);
  const narrow = () => window.matchMedia("(max-width: 599px)").matches;
  function sizeCanvas(cv, cssW, cssH) {
    const r = DPR();
    cv.width = Math.round(cssW * r);
    cv.height = Math.round(cssH * r);
    const ctx = cv.getContext("2d");
    ctx.setTransform(r, 0, 0, r, 0, 0);
    return ctx;
  }
  /** Draw 256 values (display order) into [x, x+w] x [y, y+h]; folded into `fold` rows. */
  function drawStrip(ctx, x, y, w, h, get, colour, fold, flash, reveal) {
    const cols = H / fold, cw = w / cols, rh = h / fold;
    for (let c = 0; c < H; c++) {
      const r = Math.floor(c / cols), cc = c % cols;
      let col = c < (reveal == null ? H : reveal) ? colour(get(ORDER[c])) : ZERO;
      if (flash && c < H) {
        const f = flash(ORDER[c]);
        if (f > 0) col = col.map((v, j) => Math.round(v + (FLASH[j] - v) * f));
      }
      ctx.fillStyle = rgb(col);
      ctx.fillRect(x + cc * cw, y + r * rh, Math.ceil(cw * 10) / 10 + 0.05, rh);
    }
  }
  function stripLayout() {
    const n = S.mol.n, fine = n > 20, fold = narrow() ? 2 : 1;
    const W = stripCanvas.parentElement.clientWidth || 600;
    const labelW = fine ? 0 : 40, rowH = fine ? 2 * fold : (fold === 2 ? 14 : 12), gap = fine ? 1 : 6;
    return { n, fine, fold, W, labelW, rowH, gap, H: n * (rowH + gap) };
  }
  function drawStrips() {
    const v = S.view;
    if (!v) return;
    const L = stripLayout();
    const ctx = sizeCanvas(stripCanvas, L.W, L.H);
    ctx.clearRect(0, 0, L.W, L.H);
    ctx.globalAlpha = v.dim == null ? 1 : 1 - 0.75 * v.dim;
    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const cur = S.mol.h[v.layer], prev = v.prev == null ? null : S.mol.h[v.prev];
    for (let i = 0; i < L.n; i++) {
      const y = i * (L.rowH + L.gap);
      if (!L.fine) {
        ctx.fillStyle = i === S.sel ? "#0f6e6e" : "#5f6670";
        ctx.fillText(atomName(S.mol, i), 0, y + L.rowH / 2);
      } else if (i === S.sel) {
        ctx.fillStyle = "#0f6e6e";
        ctx.fillRect(0, y - 1, 3, L.rowH + 2);
      }
      const off = i * H;
      const get = prev && v.e < 1 ? (c => prev[off + c] + (cur[off + c] - prev[off + c]) * v.e) : (c => cur[off + c]);
      const flash = prev && v.e > 0 && v.e < 1 ? (c => (cur[off + c] > prev[off + c] ? Math.sin(Math.PI * v.e) * 0.9 : 0)) : null;
      drawStrip(ctx, L.labelW + (L.fine ? 6 : 0), y, L.W - L.labelW - (L.fine ? 6 : 0), L.rowH, get, val => seqColour(val, SCALE.h), L.fold, flash,
        v.reveal == null ? null : Math.round(v.reveal * H));
    }
    stripCanvas.setAttribute("aria-label", t("proc.strip_aria", { n: L.n, layer: v.layer }));
    $("pp-strip-title").textContent = t(v.layer === 0 ? "proc.strips_h0" : "proc.strips_ht", { t: v.layer });
    setEndNobr($("pp-strip-hint"), t(L.fine ? "proc.hint_fine" : "proc.hint_rows"));
  }
  stripCanvas.addEventListener("click", ev => {
    if (!S.view) return;
    const L = stripLayout(), rect = stripCanvas.getBoundingClientRect();
    const y = (ev.clientY - rect.top) * (L.H / rect.height);
    const i = Math.floor(y / (L.rowH + L.gap));
    if (i >= 0 && i < L.n) selectAtom(i);
  });

  /** One labelled strip in a container (detail panel, pooling, bond terms). */
  function stripBlock(parent, label, values, colour) {
    const p = document.createElement("p");
    p.className = "pp-row-label";
    p.textContent = label;
    parent.appendChild(p);
    const cv = document.createElement("canvas");
    cv.className = "pp-canvas static";
    cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", label);
    parent.appendChild(cv);
    const fold = narrow() ? 2 : 1, W = parent.clientWidth || 600, h = 10 * fold;
    const ctx = sizeCanvas(cv, W, h);
    drawStrip(ctx, 0, 0, W, h, c => values[c], colour, fold);
    return cv;
  }

  // ---------- panels ----------
  const detail = $("pp-detail"), pool = $("pp-pool"), out = $("pp-out"), bondTerms = $("pp-bondterms");
  const yesNo = b => t(b ? "proc.yes" : "proc.no");
  function renderDetail() {
    const mol = S.mol, step = STEPS[S.step], body = $("pp-detail-body");
    body.textContent = "";
    detail.hidden = step === "pool" || step === "out";
    if (detail.hidden) return;
    if (step === "input") {
      if (S.selBond != null) {
        const b = mol.bonds[S.selBond];
        $("pp-detail-title").textContent = t("proc.bond_title", { a: atomName(mol, b.i), b: atomName(mol, b.j) });
        const ul = document.createElement("ul");
        ul.className = "pp-feat";
        [[t("proc.f.bond_type"), t("proc.bond." + BOND_KEYS[b.type])], [t("proc.f.in_ring"), yesNo(b.ring)]].forEach(([k, v]) => {
          const li = document.createElement("li");
          li.textContent = k + t("proc.colon");
          const s = document.createElement("b"); s.textContent = v; li.appendChild(s); ul.appendChild(li);
        });
        body.appendChild(ul);
        return;
      }
      const a = mol.atoms[S.sel];
      $("pp-detail-title").textContent = t("proc.atom_title", { a: atomName(mol, S.sel) });
      const ul = document.createElement("ul");
      ul.className = "pp-feat";
      [[t("proc.f.element"), a.el === "?" ? t("proc.f.other") : a.el], [t("proc.f.degree"), a.deg], [t("proc.f.hs"), a.hs],
       [t("proc.f.charge"), a.chg > 0 ? "+" + a.chg : String(a.chg)], [t("proc.f.aromatic"), yesNo(a.arom)], [t("proc.f.in_ring"), yesNo(a.ring)]]
        .forEach(([k, v]) => {
          const li = document.createElement("li");
          li.textContent = k + t("proc.colon");
          const s = document.createElement("b"); s.textContent = v; li.appendChild(s); ul.appendChild(li);
        });
      body.appendChild(ul);
      return;
    }
    const i = S.sel, off = i * H;
    const slice = arr => arr.subarray(off, off + H);
    if (step === "embed") {
      $("pp-detail-title").textContent = t("proc.atom_title", { a: atomName(mol, i) });
      stripBlock(body, t("proc.row_h0"), slice(mol.h[0]), v => seqColour(v, SCALE.h));
      return;
    }
    const L = +step.slice(5);
    const within = mol.dist[i].filter(d => d <= L).length;
    $("pp-detail-title").textContent = t("proc.layer_title", { a: atomName(mol, i), t: L, k: within });
    const prev = slice(mol.h[L - 1]), cur = slice(mol.h[L]), inc = new Float32Array(H);
    for (let c = 0; c < H; c++) inc[c] = cur[c] - prev[c];
    stripBlock(body, t("proc.row_prev", { t: L - 1 }), prev, v => seqColour(v, SCALE.h));
    stripBlock(body, t("proc.row_msg"), slice(mol.m[L]), v => seqColour(v, SCALE.m));
    stripBlock(body, t("proc.row_inc"), inc, v => seqColour(v, SCALE.h));
    stripBlock(body, t("proc.row_cur", { t: L }), cur, v => seqColour(v, SCALE.h));
  }
  function renderBondTerms() {
    const step = STEPS[S.step];
    bondTerms.hidden = !step.startsWith("layer");
    if (bondTerms.hidden) return;
    const L = +step.slice(5), body = $("pp-bondterms-body");
    body.textContent = "";
    const terms = display.bond_terms["layer" + L];
    const present = new Set(S.mol.bonds.map(b => BOND_KEYS[b.type] + "_" + (b.ring ? "ring" : "chain")));
    for (const c of display.bond_classes) {
      const [type, where] = c.split("_");
      const label = t("proc.bond." + type) + (where === "ring" ? t("proc.in_ring_suffix") : t("proc.in_chain_suffix")) +
        (present.has(c) ? t("proc.in_this_mol") : "");
      stripBlock(body, label, Float32Array.from(terms[c]), v => divColour(v, SCALE.bond));
    }
  }
  function renderPool(e) {
    pool.hidden = e == null;
    if (pool.hidden) return;
    const body = $("pp-pool-body");
    body.textContent = "";
    stripBlock(body, t("proc.row_mean"), S.mol.poolMean, v => seqColour(v, SCALE.pool_mean));
    stripBlock(body, t("proc.row_max"), S.mol.poolMax, v => seqColour(v, SCALE.pool_max));
    if (e === 0 && !reduced) {   // fade in through a CSS transition (process.css .pp-enter)
      pool.classList.add("pp-enter");
      requestAnimationFrame(() => requestAnimationFrame(() => pool.classList.remove("pp-enter")));
    }
  }
  function renderOut(e) {
    out.hidden = e == null;
    if (out.hidden) return;
    const svg = $("pp-bars");
    svg.textContent = "";
    const top = S.mol.top, W = Math.min(560, out.clientWidth || 320), nameW = Math.min(150, Math.round(W * 0.32)), barW = W - nameW - 56, rowH = 26;
    svg.setAttribute("viewBox", "0 0 " + W + " " + top.length * rowH);
    svg.setAttribute("width", W);
    svg.setAttribute("height", top.length * rowH);
    top.forEach((d, k) => {
      const y = k * rowH;
      const name = el("text", { x: 0, y: y + 17 }, svg);
      name.textContent = labelName(d.label);
      el("rect", { x: nameW, y: y + 6, width: barW, height: 14, rx: 2, class: "track" }, svg);
      el("rect", { x: nameW, y: y + 6, width: Math.max(0, barW * d.prob * e), height: 14, rx: 2, class: "bar" }, svg);
      const pct = el("text", { x: W, y: y + 17, "text-anchor": "end", class: "pct" }, svg);
      pct.textContent = (Math.round(d.prob * 1000) / 10).toFixed(1) + "%";
    });
    svg.setAttribute("aria-label", top.map(d => labelName(d.label) + " " + (Math.round(d.prob * 1000) / 10).toFixed(1) + "%").join(", "));
  }

  // ---------- captions ----------
  const say = $("pp-say"), sayList = $("pp-saylist");
  function stepLines(step) {
    if (step.startsWith("layer")) {
      const L = step.slice(5);
      return [t("proc.say.layer_a"), t("proc.say.layer_b"), t("proc.say.layer_c", { t: L, b: t(L === "1" ? "proc.bonds_1" : "proc.bonds_n", { t: L }) })];
    }
    return ({ input: ["input_a", "input_b"], embed: ["embed_a", "embed_b"], pool: ["pool_a"], out: ["out_a"] })[step]
      .map(k => t("proc.say." + k));
  }
  /** Chinese text: keep the last 4 characters (before closing punctuation) on one line, so no line ends
   *  with only one or two characters (tools/check_orphans.py). */
  function setEndNobr(node, text) {
    const m = I18N.lang === "zh" && /^(.*?)([^\s]{4}[。，；：）」”]*)$/u.exec(text);
    node.textContent = m ? m[1] : text;
    if (m) { const sp = document.createElement("span"); sp.className = "nobr"; sp.textContent = m[2]; node.appendChild(sp); }
  }
  function showLines(lines, upto) {
    if (reduced) {
      sayList.textContent = "";
      lines.forEach(s => { const li = document.createElement("li"); setEndNobr(li, s); sayList.appendChild(li); });
      return;
    }
    say.textContent = "";
    lines.slice(0, upto).forEach((s, k) => {
      const p = document.createElement("p");
      setEndNobr(p, s);
      if (k < upto - 1) p.className = "old";
      say.appendChild(p);
    });
  }

  // ---------- steps ----------
  async function play(step, T) {
    const name = STEPS[step], lines = stepLines(name);
    S.view = null;
    renderPool(null);
    renderOut(null);
    MOL.dots.forEach(d => d.node.setAttribute("opacity", 0));
    if (name === "input") {
      setField(null);
      showLines(lines, 1);
      $("pp-strips").hidden = true;
      renderDetail();
      await T(2.0);
      showLines(lines, 2);
      return;
    }
    $("pp-strips").hidden = false;
    if (name === "embed") {
      setField(0);
      showLines(lines, 1);
      S.view = { layer: 0, reveal: 0 };
      renderDetail();
      await T(1.0, e => { S.view.reveal = e; drawStrips(); });
      S.view.reveal = null;
      drawStrips();
      await T(1.2);
      showLines(lines, 2);
      return;
    }
    if (name.startsWith("layer")) {
      const L = +name.slice(5);
      setField(null);
      S.view = { layer: L, prev: L - 1, e: 0 };
      drawStrips();
      renderDetail();
      showLines(lines, 1);
      await T(0.8);
      // messages travel along every bond in both directions, coloured by bond type
      await T(1.4, e => MOL.dots.forEach(d => {
        d.node.setAttribute("cx", d.from[0] + (d.to[0] - d.from[0]) * e);
        d.node.setAttribute("cy", d.from[1] + (d.to[1] - d.from[1]) * e);
        d.node.setAttribute("opacity", e < 0.9 ? 1 : (1 - e) * 10);
      }));
      MOL.dots.forEach(d => d.node.setAttribute("opacity", 0));
      showLines(lines, 2);
      await T(0.6);
      await T(1.2, e => { S.view.e = e; drawStrips(); }, true);
      S.view.e = 1;
      drawStrips();
      showLines(lines, 3);
      await T(0.6);
      await T(0.6, () => setField(L));
      setField(L);
      return;
    }
    if (name === "pool") {
      setField(null, true);
      S.view = { layer: 3, dim: 0 };
      drawStrips();
      renderDetail();
      showLines(lines, 1);
      renderPool(0);
      await T(1.0, e => { S.view.dim = e; drawStrips(); });
      return;
    }
    // output
    setField(null, true);
    $("pp-strips").hidden = true;
    renderDetail();
    showLines(lines, 1);
    renderPool(1);
    renderOut(0);
    await T(1.0, e => renderOut(e));
  }

  // final state of a step, drawn at once (resize, language change, selection change)
  function redraw() {
    const name = STEPS[S.step];
    if (name !== "input" && name !== "out") drawStrips();
    renderDetail();
    renderBondTerms();
    if (!pool.hidden) renderPool(1);
    if (!out.hidden) renderOut(1);
  }

  // ---------- controls ----------
  const stepBtns = Array.from(document.querySelectorAll(".pp-steps button"));
  const prevBtn = $("pp-prev"), nextBtn = $("pp-next"), pauseBtn = $("pp-pause"), replayBtn = $("pp-replay");
  let autoplay = false;
  function markStep() {
    stepBtns.forEach((b, k) => { if (k === S.step) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current"); });
    prevBtn.disabled = S.step === 0;
    nextBtn.disabled = S.step === STEPS.length - 1;
    $("pp-pos").textContent = t("proc.pos", { k: S.step + 1, n: STEPS.length, name: stepBtns[S.step].textContent });
  }
  async function go(step, chain) {
    const my = ++gen;
    clock.tweens.length = 0;
    S.step = step;
    S.selBond = null;
    autoplay = !!chain;
    markStep();
    renderBondTerms();
    const T = tweener(reduced, my);
    pauseBtn.disabled = reduced;
    try {
      await play(step, T);
      if (reduced) showLines(stepLines(STEPS[step]));
      redraw();
      if (chain && step < STEPS.length - 1) {
        await T(1.5);
        return go(step + 1, true);
      }
      if (my === gen) { pauseBtn.disabled = true; autoplay = false; }
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
    }
  }
  function setPauseLabel() { pauseBtn.textContent = t(clock.held ? "proc.resume" : "proc.pause"); }
  stepBtns.forEach((b, k) => b.addEventListener("click", () => { clock.held = false; setPauseLabel(); go(k); }));
  prevBtn.addEventListener("click", () => { clock.held = false; setPauseLabel(); go(Math.max(0, S.step - 1)); });
  nextBtn.addEventListener("click", () => { clock.held = false; setPauseLabel(); go(Math.min(STEPS.length - 1, S.step + 1)); });
  pauseBtn.addEventListener("click", () => { clock.held = !clock.held; setPauseLabel(); });
  replayBtn.addEventListener("click", () => { clock.held = false; setPauseLabel(); go(S.step, autoplay); });
  if (reduced) { pauseBtn.hidden = true; replayBtn.hidden = true; }

  function selectAtom(i) {
    S.sel = i;
    S.selBond = null;
    MOL.bonds.forEach(b => b.sel.setAttribute("opacity", 0));
    const name = STEPS[S.step];
    const L = name === "embed" ? 0 : name.startsWith("layer") ? +name.slice(5) : null;
    if (L != null && !(S.view && S.view.prev != null && S.view.e < 1)) setField(L);
    else if (name === "pool" || name === "out") setField(null, true);
    else MOL.atoms.forEach((a, k) => a.sel.setAttribute("opacity", k === i ? 1 : 0));
    if (S.view) drawStrips();
    renderDetail();
  }
  function selectBond(bi) {
    if (STEPS[S.step] !== "input") return;
    S.selBond = bi;
    MOL.bonds.forEach((b, k) => b.sel.setAttribute("opacity", k === bi ? 0.25 : 0));
    MOL.atoms.forEach(a => a.sel.setAttribute("opacity", 0));
    renderDetail();
  }

  // ---------- molecule picker ----------
  const picker = $("pp-picker");
  function renderPicker() {
    picker.textContent = "";
    for (const id of PICKER) {
      const m = index.find(x => x.id === id);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip-btn";
      b.textContent = I18N.pick({ en: m.name_en, zh: m.name_zh });
      b.setAttribute("aria-pressed", S.mol && S.mol.id === id ? "true" : "false");
      b.addEventListener("click", () => show(id, false));
      picker.appendChild(b);
    }
  }
  async function show(id, chain) {
    S.mol = await loadPreset(id);
    S.sel = 0;
    drawMolecule(S.mol);
    renderPicker();
    $("pp-name").textContent = I18N.pick(S.mol.name);
    go(chain ? 0 : S.step, chain);
  }

  // ---------- start: play once when the stage first comes into view ----------
  await show("diacetyl", false);
  clock.held = false;
  let started = false;
  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      clock.paused = !en.isIntersecting;
      if (en.isIntersecting && !started) { started = true; go(0, true); }
    }
  }, { threshold: 0.2 });
  io.observe($("pp-stage-wrap"));
  $("pp-ctrl").hidden = false;

  let rw = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === rw) return;
    rw = window.innerWidth;
    drawMolecule(S.mol);
    const name = STEPS[S.step];
    if (name.startsWith("layer") || name === "embed") setField(name === "embed" ? 0 : +name.slice(5));
    else setField(null, name === "pool" || name === "out");
    redraw();
  });
  I18N.onChange(() => { renderPicker(); markStep(); setPauseLabel(); $("pp-name").textContent = I18N.pick(S.mol.name);
    showLines(stepLines(STEPS[S.step]), stepLines(STEPS[S.step]).length); redraw(); });
  window.__process = { S, go, show };   // for tests and screenshots
})();
