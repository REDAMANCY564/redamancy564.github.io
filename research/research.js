/*
 * Research overview (research/): an overview diagram plus a four-step animation.
 * - Every point, curve and bar is schematic, generated from fixed seeds (mulberry32); no paper or sample data.
 * - Animations are attribute tweens on one requestAnimationFrame clock, so they can be paused
 *   (stage out of view) and no inline style attributes are needed (strict CSP).
 * - One thing moves at a time; each change 0.6-1 s, ease-in-out; only move, fade and line drawing.
 * - prefers-reduced-motion: every step is drawn in its final state at once.
 * - The stage plays step 1 when it first comes into view; later steps start only when the visitor asks.
 */
(async function () {
  "use strict";
  await I18N.ready;
  const t = I18N.t;
  const NS = "http://www.w3.org/2000/svg";
  const C = { hm: "#0f6e6e", fm: "#c2410c", line: "#9aa0a6", faint: "#d9d6cf", fill: "#efede8",
              text: "#1f2328", muted: "#5f6670", soft: "#e3f1ef", star: "#5f6670" };
  const CITY = ["#3b6fd6", "#d99a1e", "#8e4ec6", "#3a9d5d", "#d64d6b", "#7a5a3a"];
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- helpers ----------
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, x, y, s, attrs) {
    const e = el("text", Object.assign({ x, y }, attrs || {}), parent);
    e.textContent = s;
    return e;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let r = Math.imul(a ^ a >>> 15, 1 | a);
      r = r + Math.imul(r ^ r >>> 7, 61 | r) ^ r;
      return ((r ^ r >>> 14) >>> 0) / 4294967296;
    };
  }
  function gauss(rnd) {
    let u = 0;
    while (!u) u = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  }
  const lerp = (a, b, e) => a + (b - a) * e;
  function hex(c) { return [1, 3, 5].map(i => parseInt(c.slice(i, i + 3 - 1), 16)); }
  function mix(a, b, e) {
    const A = hex(a), B = hex(b);
    return "rgb(" + A.map((v, i) => Math.round(lerp(v, B[i], e))).join(",") + ")";
  }
  const op = (n, v) => n.setAttribute("opacity", v);
  function arrowHead(parent, x, y, deg, colour) {
    return el("path", { d: "M-6,-4 L0,0 L-6,4", fill: "none", stroke: colour || C.line, "stroke-width": 1.2,
      transform: "translate(" + x + "," + y + ") rotate(" + deg + ")" }, parent);
  }
  function starPath(cx, cy, r) {
    let d = "";
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
      d += (i ? "L" : "M") + (cx + rr * Math.cos(a)).toFixed(2) + "," + (cy + rr * Math.sin(a)).toFixed(2);
    }
    return d + "Z";
  }

  // ---------- clock and tweens ----------
  let vt = 0, last = null, paused = true, tweens = [];
  const ease = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  function frame(ts) {
    if (last != null && !paused) vt += Math.min(ts - last, 100);
    last = ts;
    for (const tw of tweens.slice()) {
      const p = Math.min(1, Math.max(0, (vt - tw.t0) / tw.d));
      tw.fn(ease(p));
      if (p >= 1) { tweens.splice(tweens.indexOf(tw), 1); tw.res(); }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  // A tweener for one run. Instant runs jump to the end. Cancelled runs simply never resume.
  function tweener(instant) {
    return function (sec, fn) {
      if (instant) { if (fn) fn(1); return Promise.resolve(); }
      return new Promise(res => tweens.push({ t0: vt, d: sec * 1000, fn: fn || (() => {}), res }));
    };
  }
  function prepDraw(path) {
    const len = path.getTotalLength();
    path.setAttribute("stroke-dasharray", len + " " + len);
    path.setAttribute("stroke-dashoffset", len);
    return e => path.setAttribute("stroke-dashoffset", len * (1 - e));
  }
  function drawAll(paths) {
    const fns = paths.map(prepDraw);
    return e => fns.forEach(f => f(e));
  }

  // ---------- DOM ----------
  const stage = document.getElementById("rs-stage");
  const ov = document.getElementById("rs-ov");
  const detail = document.getElementById("rs-detail");
  const canvas = document.getElementById("rs-canvas");
  const prevBtn = document.getElementById("rs-prev"), nextBtn = document.getElementById("rs-next");
  const pos = document.getElementById("rs-pos");
  const steps = [...document.querySelectorAll(".rs-step")];
  stage.classList.add("rs-live");
  ov.hidden = false; detail.hidden = false;
  document.getElementById("rs-ctrl").hidden = false;

  function stepParts(n) {
    const a = steps[n - 1];
    return { a, lede: a.querySelector(".rs-lede"), cap: a.querySelector(".rs-cap"), go: a.querySelector(".rs-go") };
  }
  function showText(n, state) {   // state: "none" | "lede" | "all"
    steps.forEach((a, i) => { a.hidden = i !== n - 1; });
    const p = stepParts(n);
    p.lede.style.opacity = state === "none" ? 0 : 1;
    p.cap.style.opacity = state === "all" ? 1 : 0;
    if (p.go) p.go.style.opacity = state === "all" ? 1 : 0;
  }

  // ---------- overview diagram ----------
  // Four nodes (1 smell, 2 identify, 3 the bridge between them, 4 adjust), each with a small icon drawn
  // like its detail picture. The current node is framed; when the step changes a small teal dot travels
  // along the lines to the next node. Steps already watched get a tick.
  let OV = null;
  const visited = new Set();
  const HM_LIGHT = "#9fcac5";
  function miniSensors(g, x, cy) {
    const shades = [0.25, 0.6, 0.35, 0.5, 0.55, 0.3, 0.45, 0.2];
    for (let i = 0; i < 8; i++)
      el("rect", { x: x + (i % 4) * 7, y: cy - 6 + Math.floor(i / 4) * 7, width: 5, height: 5,
        fill: mix("#ffffff", C.line, shades[i]), stroke: C.line, "stroke-width": 0.8 }, g);
    return 26;
  }
  function miniPeaks(g, x, cy) {
    const b = cy + 6;
    el("path", { d: `M${x},${b} L${x + 6},${b} L${x + 8.5},${cy - 2} L${x + 11},${b} L${x + 15},${b} L${x + 17.5},${cy - 8} L${x + 20},${b} L${x + 24},${b} L${x + 26},${cy + 1} L${x + 28},${b} L${x + 32},${b}`,
      fill: "none", stroke: C.muted, "stroke-width": 1.1, "stroke-linejoin": "round" }, g);
    return 32;
  }
  function miniChainBottle(g, x, cy) {
    el("path", { d: `M${x},${cy + 3} l4,-6 l4,6 l4,-6 l4,6`, fill: "none", stroke: C.muted, "stroke-width": 1.1, "stroke-linejoin": "round" }, g);
    el("path", { d: `M${x + 20},${cy} L${x + 28},${cy}`, fill: "none", stroke: C.line, "stroke-width": 1 }, g);
    el("path", { d: `M${x + 25},${cy - 3} L${x + 29},${cy} L${x + 25},${cy + 3}`, fill: "none", stroke: C.line, "stroke-width": 1 }, g);
    const b = el("g", { fill: "none", stroke: C.fm, "stroke-width": 1.1 }, g);
    el("path", { d: `M${x + 36},${cy - 7} Q${x + 36},${cy - 10} ${x + 38},${cy - 11} Q${x + 40},${cy - 10} ${x + 40},${cy - 7}` }, b);
    el("rect", { x: x + 33.5, y: cy - 7, width: 9, height: 2.5 }, b);
    el("rect", { x: x + 34, y: cy - 4.5, width: 8, height: 12, rx: 2 }, b);
    return 43;
  }
  function tickMark(g, k, x, y) {
    return el("path", { d: `M${x - 4},${y} L${x - 1},${y + 3} L${x + 4},${y - 3}`, fill: "none", stroke: C.hm, "stroke-width": 1.6,
      "stroke-linecap": "round", "stroke-linejoin": "round", opacity: visited.has(k) && k !== cur ? 1 : 0 }, g);   // ticks only on steps already left
  }
  function buildOverview() {
    ov.textContent = "";
    const W = Math.max(300, ov.parentNode.clientWidth);
    const narrow = W < 600;
    const bw = narrow ? 122 : Math.round(Math.min(320, (W - 170) / 2)), bh = narrow ? 46 : 58;
    const gap = narrow ? W - 2 * bw : Math.round(Math.min(160, W - 2 * bw - 10));
    const left = narrow ? 0 : Math.round((W - 2 * bw - gap) / 2);
    const y1 = narrow ? 70 : 78;
    const n1 = { x: left, y: y1, w: bw, h: bh };
    const n2 = { x: left + bw + gap, y: y1, w: bw, h: bh };
    const w4 = narrow ? 150 : bw;
    const n4 = { x: Math.min(n2.x + bw / 2 - w4 / 2, W - w4 - 1), y: y1 + bh + (narrow ? 34 : 40), w: w4, h: bh };
    const H = n4.y + bh + 4;
    ov.setAttribute("viewBox", "0 0 " + W + " " + H);
    ov.setAttribute("width", W); ov.setAttribute("height", H);

    const hl = el("rect", { rx: 6, fill: C.soft, stroke: C.hm, "stroke-width": 1.5, opacity: 0 }, ov);
    // drop of human milk and its two branches (light teal)
    const cx = W / 2, cy = 28;
    const bx1 = n1.x + bw / 2, bx2 = n2.x + bw / 2;
    el("path", { d: `M${cx - 14},${cy + 8} C${bx1},${cy + 8} ${bx1},${cy + 18} ${bx1},${y1 - 4}`, fill: "none", stroke: HM_LIGHT, "stroke-width": 1.2 }, ov);
    arrowHead(ov, bx1, y1 - 3, 90, HM_LIGHT);
    el("path", { d: `M${cx + 14},${cy + 8} C${bx2},${cy + 8} ${bx2},${cy + 18} ${bx2},${y1 - 4}`, fill: "none", stroke: HM_LIGHT, "stroke-width": 1.2 }, ov);
    arrowHead(ov, bx2, y1 - 3, 90, HM_LIGHT);
    el("path", { d: `M${cx},${cy - 22} C${cx + 6},${cy - 11} ${cx + 13},${cy - 3} ${cx + 13},${cy + 4} A13,13 0 0 1 ${cx - 13},${cy + 4} C${cx - 13},${cy - 3} ${cx - 6},${cy - 11} ${cx},${cy - 22}Z`,
      fill: C.hm, stroke: C.hm, "stroke-width": 1 }, ov);
    text(ov, cx + 20, cy - 4, t("rs.ov.milk"), { class: "t-hm" });

    // 2 -> 4 (under the boxes)
    el("path", { d: `M${bx2},${y1 + bh + 3} L${bx2},${n4.y - 4}`, fill: "none", stroke: C.line, "stroke-width": 1 }, ov);
    arrowHead(ov, bx2, n4.y - 3, 90);

    const groups = {}, ticks = {};
    function node(k, b, icon, desc) {
      const g = el("g", { class: "ov-g" }, ov);
      el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 4, fill: "#fbfaf7", stroke: C.line, "stroke-width": 1 }, g);
      const pad = narrow ? 9 : 14, mid = b.y + b.h / 2;
      const iw = icon(g, b.x + pad, mid);
      const tx = b.x + pad + iw + (narrow ? 7 : 12);
      const title = text(g, tx, narrow ? mid + 5 : mid - 4, k + " " + t("rs.s" + k + ".name"), { class: "t-strong" });
      if (!narrow) {   // on phones only the icon and the step name
        const d = text(g, tx, mid + 15, desc, {});
        const avail = b.x + b.w - 18 - tx;
        if (d.getComputedTextLength() > avail) d.style.fontSize = "12px";
        if (d.getComputedTextLength() > avail) { d.remove(); title.setAttribute("y", mid + 5); }
      }
      g.addEventListener("click", () => userGo(k));
      ticks[k] = tickMark(g, k, b.x + b.w - 10, b.y + 10);
      groups[k] = g;
    }
    node(1, n1, miniSensors, t("rs.ov.s1"));
    node(2, n2, miniPeaks, t("rs.ov.s2"));
    node(4, n4, miniChainBottle, t("rs.ov.s4"));
    // 3: the bridge from 1 to 2, with three small model dots on the arrow
    const g3 = el("g", { class: "ov-g" }, ov);
    g3.addEventListener("click", () => userGo(3));
    groups[3] = g3;
    const ay = y1 + bh / 2, ax0 = n1.x + bw + 6, ax1 = n2.x - 6, am = (ax0 + ax1) / 2;
    el("rect", { x: ax0, y: ay - 30, width: ax1 - ax0, height: 54, fill: "transparent" }, g3);   // click area
    const lab3 = text(g3, am, ay - 10, "3 " + t("rs.s3.name"), { class: "t-strong", "text-anchor": "middle" });
    const arrow3 = el("path", { d: `M${ax0},${ay} L${ax1 - 1},${ay}`, fill: "none", stroke: C.text, "stroke-width": 1.2 }, g3);
    const head3 = arrowHead(g3, ax1, ay, 0, C.text);
    [-9, 0, 9].forEach(dx => el("circle", { cx: am + dx, cy: ay, r: 2.6, fill: "#fbfaf7", stroke: C.text, "stroke-width": 1.1 }, g3));
    if (!narrow) {
      const d3 = text(g3, am, ay + 20, t("rs.ov.s3"), { "text-anchor": "middle" });
      if (d3.getComputedTextLength() > ax1 - ax0) d3.style.fontSize = "12px";
      if (d3.getComputedTextLength() > ax1 - ax0) d3.remove();
    }
    ticks[3] = tickMark(g3, 3, am + lab3.getComputedTextLength() / 2 + 10, ay - 15);
    const pad = 4;
    const box = b => ({ x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad });
    const targets = { 1: box(n1), 2: box(n2), 4: box(n4), 3: { x: ax0 - 2, y: ay - 28, w: ax1 - ax0 + 4, h: narrow ? 38 : 56 } };
    // route of the travelling dot: 1 -> 3 -> 2 -> (along the edge of box 2) -> 4
    const route = [[n1.x + bw, ay], [am, ay], [n2.x, ay], [n2.x, y1 + bh], [bx2, y1 + bh], [bx2, n4.y]];
    const stop = { 1: 0, 3: 1, 2: 2, 4: 5 };
    const dot = el("circle", { r: 4, fill: C.hm, opacity: 0 }, ov);
    OV = { hl, groups, ticks, targets, arrow3, head3, route, stop, dot, cur: null };
    return OV;
  }
  function setHl(r) {
    OV.hl.setAttribute("x", r.x); OV.hl.setAttribute("y", r.y);
    OV.hl.setAttribute("width", r.w); OV.hl.setAttribute("height", r.h);
  }
  function routePoint(a, b, e) {   // point at fraction e of the route between stops a and b
    const pts = a <= b ? OV.route.slice(a, b + 1) : OV.route.slice(b, a + 1).reverse();
    const seg = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); total += l; }
    let d = total * e;
    for (let i = 0; i < seg.length; i++) {
      if (d <= seg[i] || i === seg.length - 1) {
        const f = seg[i] ? Math.min(1, d / seg[i]) : 1;
        return [lerp(pts[i][0], pts[i + 1][0], f), lerp(pts[i][1], pts[i + 1][1], f)];
      }
      d -= seg[i];
    }
    return pts[0];
  }
  async function overviewTo(n, T, instant) {
    const prev = OV.cur;
    const ops = [1, 2, 3, 4].map(k => [OV.groups[k], +(OV.groups[k].getAttribute("opacity") || 1), k === n ? 1 : 0.6]);
    if (prev != null && prev !== n && !instant) {
      // a small dot travels from the current node to the next one while the old frame fades
      const a = OV.stop[prev], b = OV.stop[n];
      op(OV.dot, 1);
      await T(0.7, e => {
        const [x, y] = routePoint(a, b, e);
        OV.dot.setAttribute("cx", x); OV.dot.setAttribute("cy", y);
        op(OV.hl, 1 - e);
      });
      op(OV.dot, 0);
    }
    setHl(OV.targets[n]);
    const tks = [1, 2, 3, 4].map(k => [OV.ticks[k], +OV.ticks[k].getAttribute("opacity"), visited.has(k) && k !== n ? 1 : 0]);
    await T(0.6, e => {
      op(OV.hl, Math.max(+(OV.hl.getAttribute("opacity")), e));
      ops.forEach(([g, a, b]) => op(g, lerp(a, b, e)));
      tks.forEach(([tk, a, b]) => op(tk, lerp(a, b, e)));
    });
    OV.cur = n;
    if (n === 3 && !instant) {
      const d = prepDraw(OV.arrow3);
      op(OV.head3, 0);
      await T(0.8, e => { d(e); op(OV.head3, e > 0.9 ? (e - 0.9) * 10 : 0); });
    }
  }
  function markVisited(n) {   // the tick appears once the visitor moves on to another step
    visited.add(n);
  }

  // ---------- scenes ----------
  // Each scene draws into g (W x H user units = CSS pixels) and awaits T for every change.
  const SCENES = {};

  SCENES[1] = async function (g, W, H, T, staticView) {
    const rnd = mulberry32(1303);
    const x0 = 8, x1 = W - 8, y0 = 26;
    const y1 = staticView ? Math.round(H * 0.5) : H - 58;
    const pw = x1 - x0, ph = y1 - y0;
    const clipId = "rs-clip1";
    const defs = el("defs", {}, g);
    const cp = el("clipPath", { id: clipId }, defs);
    el("rect", { x: x0 + 6, y: y0, width: pw - 6, height: ph - 6 }, cp);   // zoomed points stay inside the axes
    const axes = el("path", { d: `M${x0},${y0} L${x0},${y1} L${x1},${y1}`, fill: "none", stroke: C.faint, "stroke-width": 1, opacity: 0 }, g);
    const clip = el("g", { "clip-path": "url(#" + clipId + ")" }, g);
    const pts = el("g", {}, clip);
    const hc = { x: x0 + pw * 0.27, y: y0 + ph * 0.55 }, ac = { x: x0 + pw * 0.72, y: y0 + ph * 0.5 };
    const human = el("g", { opacity: 0 }, pts), animal = el("g", { opacity: 0 }, pts), stars = el("g", { opacity: 0 }, pts);
    const hdots = [];
    for (let i = 0; i < 78; i++) {
      const x = hc.x + gauss(rnd) * pw * 0.075, y = hc.y + gauss(rnd) * ph * 0.14;
      hdots.push(el("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: 2.2, fill: C.hm }, human));
    }
    for (let k = 0; k < 19; k++) {
      const gx = ac.x + gauss(rnd) * pw * 0.08, gy = ac.y + gauss(rnd) * ph * 0.17;
      for (let j = 0; j < 3; j++)
        el("circle", { cx: (gx + gauss(rnd) * 4).toFixed(1), cy: (gy + gauss(rnd) * 4).toFixed(1), r: 2.2, fill: C.line }, animal);
    }
    // Alpine Holstein milk: a few small filled stars just inside the edge of the human milk cluster
    const sc = { x: hc.x + pw * 0.065, y: hc.y - ph * 0.12 };
    [[0, 0], [10, 4], [-9, 6], [3, -9]].forEach(([dx, dy]) =>
      el("path", { d: starPath(sc.x + dx, sc.y + dy, 5.2), fill: "#3d434a", stroke: "#fbfaf7", "stroke-width": 0.8 }, stars));
    const labels = el("g", {}, g);
    const lh = text(labels, hc.x, y0 + 10, t("rs.f.human"), { class: "t-hm", "text-anchor": "middle", opacity: 0 });
    const la = text(labels, ac.x, y0 + 10, t("rs.f.animal"), { "text-anchor": "middle", opacity: 0 });
    void lh; void la;
    const starLab = el("g", { opacity: 0 }, labels);
    el("path", { d: `M${sc.x},${sc.y - 16} L${sc.x},${y0 + 2}`, stroke: C.line, "stroke-width": 1, fill: "none" }, starLab);
    const sl = text(starLab, sc.x, y0 - 4, t("rs.f.alpine"), { class: "t-dark", "text-anchor": "middle" });
    // keep the star label inside the frame
    const slw = sl.getComputedTextLength();
    const slx = Math.min(Math.max(sc.x, x0 + slw / 2), x1 - slw / 2);
    sl.setAttribute("x", slx);
    // the human / animal labels would sit under the star label: move them below the clusters
    lh.setAttribute("y", y1 - 6); la.setAttribute("y", y1 - 6);

    // (a)
    await T(0.6, e => op(axes, e));
    await T(0.8, e => op(human, e));
    await T(0.8, e => op(animal, e));
    await T(0.6, e => { op(stars, e); op(lh, e); op(la, e); op(starLab, e); });

    if (staticView) {   // reduced motion: (a) on top, (c) below
      await bars(g, W, y1 + 22, H, T);
      return;
    }
    await T(0.6, () => {});
    // (b) zoom into human milk, colour by city
    // only human milk goes into the zoom: labels, stars and animal milk fade out first
    await T(0.6, e => { [lh, la, starLab, stars, animal].forEach(n => op(n, 1 - e)); });
    // zoom so that every human milk point stays whole inside the clipped plot area
    const xs = hdots.map(d => +d.getAttribute("cx")), ys = hdots.map(d => +d.getAttribute("cy"));
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const inner = { x0: x0 + 6, x1: x1, y0: y0, y1: y1 - 6 };
    let s = 2.1;
    for (let i = 0; i < 3; i++) {   // the dots grow with the zoom, so leave room for their radius
      const m = 2.2 * s + 3;
      s = Math.min(2.1, (inner.x1 - inner.x0 - 2 * m) / (bx1 - bx0), (inner.y1 - inner.y0 - 2 * m) / (by1 - by0));
    }
    const bc = { x: (bx0 + bx1) / 2, y: (by0 + by1) / 2 };
    const pc = { x: (inner.x0 + inner.x1) / 2, y: (inner.y0 + inner.y1) / 2 };
    const zoom = e => {
      const k = lerp(1, s, e), tx = lerp(0, pc.x - bc.x * s, e), ty = lerp(0, pc.y - bc.y * s, e);
      pts.setAttribute("transform", `translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${k.toFixed(4)})`);
    };
    await T(1.0, zoom);
    await T(0.8, e => hdots.forEach((d, i) => d.setAttribute("fill", mix(C.hm, CITY[i % 6], e))));
    const legend = el("g", { opacity: 0 }, g);
    const colW = (W - 16) / 3;
    for (let i = 0; i < 6; i++) {
      const lx = 8 + (i % 3) * colW, ly = H - 36 + Math.floor(i / 3) * 22;
      el("circle", { cx: lx + 5, cy: ly - 4, r: 4, fill: CITY[i] }, legend);
      text(legend, lx + 14, ly, t("rs.f.city", { n: i + 1 }), {});
    }
    await T(0.6, e => op(legend, e));
    await T(1.4, () => {});
    // back to one colour, zoom out
    await T(0.6, e => op(legend, 1 - e));
    await T(0.8, e => hdots.forEach((d, i) => d.setAttribute("fill", mix(CITY[i % 6], C.hm, e))));
    await T(1.0, e => zoom(1 - e));
    await T(0.6, () => {});
    // (c) association bars
    await T(0.6, e => { op(pts, 1 - e); op(axes, 1 - e); });
    legend.remove();
    await bars(g, W, 26, H, T);
  };

  async function bars(g, W, top, H, T) {
    const items = [["rs.f.fat", 32], ["rs.f.protein", 26], ["rs.f.carb", 22], ["rs.f.region", 12], ["rs.f.mood", 8]];
    const title = text(g, 8, top, t("rs.f.assoc"), { class: "t-dark", opacity: 0 });
    const labs = items.map(([k], i) => text(g, 8, 0, t(k), { opacity: 0 }));
    const lw = Math.max(...labs.map(l => l.getComputedTextLength())) + 16;
    const avail = H - top - 18, rh = Math.min(40, avail / items.length);
    const maxL = W - 16 - lw - 8;
    const rects = items.map(([, v], i) => {
      const y = top + 14 + i * rh + (rh - 14) / 2;
      labs[i].setAttribute("y", y + 11);
      const top1 = i === 0;   // the highest bar (lipid) is drawn darker
      return { r: el("rect", { x: 8 + lw, y, width: 0, height: 14, fill: top1 ? "#d3d0c8" : C.fill, stroke: top1 ? C.muted : C.line, "stroke-width": 1 }, g), L: maxL * v / 32 };
    });
    await T(0.6, e => op(title, e));
    for (let i = 0; i < rects.length; i++) {
      await T(0.6, e => { rects[i].r.setAttribute("width", (rects[i].L * e).toFixed(1)); op(labs[i], e); });
    }
  }

  SCENES[2] = async function (g, W, H, T) {
    const rnd = mulberry32(2026);
    const xL = 8, xR = W - 8, axisY = H - 44;
    const xa = xL + (xR - xL) * 0.36;
    const keys = [0.22, 0.52, 0.83].map(f => xa + (xR - xa) * f);
    const others = Array.from({ length: 6 }, () => xa + (xR - xa) * (0.05 + rnd() * 0.9));
    const top = 58, step = (axisY - 22 - top) / 6;
    const colours = [C.hm, C.fm, C.line, C.line, C.line, C.line, C.line];
    const names = { 0: ["rs.f.hm", "t-hm"], 1: ["rs.f.formula", "t-fm"], 4: ["rs.f.animals", ""] };
    const axis = el("path", { d: `M${xL},${axisY} L${xR},${axisY}`, stroke: C.faint, "stroke-width": 1, fill: "none", opacity: 0 }, g);
    const axisLab = text(g, xL, H - 8, t("rs.f.time"), { opacity: 0 });
    const lines = [], labs = [];
    for (let i = 0; i < 7; i++) {
      const base = top + i * step;
      const peaks = keys.map(x => [x, 10 + rnd() * 16, 4 + rnd() * 2])
        .concat(others.map(x => [x, rnd() < 0.6 ? 3 + rnd() * 12 : 0, 3 + rnd() * 3]));
      let d = "";
      for (let k = 0; k <= 160; k++) {
        const x = xL + (xR - xL) * k / 160;
        let y = base - Math.abs(gauss(rnd)) * 0.5;
        for (const [px, ph, pwid] of peaks) y -= ph * Math.exp(-Math.pow((x - px) / pwid, 2));
        d += (k ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1);
      }
      lines.push(el("path", { d, fill: "none", stroke: colours[i], "stroke-width": i < 2 ? 1.4 : 1, opacity: 0 }, g));
      labs.push(names[i] ? text(g, xL, base - 5, t(names[i][0]), { class: names[i][1], opacity: 0 }) : null);
    }
    await T(0.6, e => { op(axis, e); op(axisLab, e); });
    for (let i = 0; i < 7; i++) {
      const d = prepDraw(lines[i]);
      op(lines[i], 1);
      await T(0.6, e => { d(e); if (labs[i]) op(labs[i], e); });
    }
    // the nose walks along the time axis and lights the key peaks
    const nose = el("g", { opacity: 0 }, g);
    el("path", { d: `M0,${axisY + 1} L0,${axisY + 7}`, stroke: C.text, "stroke-width": 1.2, fill: "none" }, nose);
    const sniff = text(nose, 0, axisY + 21, t("rs.f.sniff"), { class: "t-dark", "text-anchor": "middle" });
    const sw = sniff.getComputedTextLength();
    let nx = Math.max(xa - 26, xL + sw / 2);
    const xEnd = xR - sw / 2;
    const place = x => nose.setAttribute("transform", `translate(${x.toFixed(1)},0)`);
    place(nx);
    await T(0.6, e => op(nose, e));
    const keyLab = text(g, (keys[0] + keys[2]) / 2, 16, t("rs.f.key"), { class: "t-dark", "text-anchor": "middle", opacity: 0 });
    const kw = keyLab.getComputedTextLength();
    keyLab.setAttribute("x", Math.min(Math.max((keys[0] + keys[2]) / 2, xL + kw / 2), xR - kw / 2));
    const kx = +keyLab.getAttribute("x");
    for (let k = 0; k < keys.length; k++) {
      const from = nx, to = keys[k];
      await T(0.8, e => place(lerp(from, to, e)));
      nx = to;
      const v = el("path", { d: `M${to},${axisY - 2} L${to},${top - 20}`, stroke: C.text, "stroke-width": 1, fill: "none" }, g);
      const dv = prepDraw(v);
      await T(0.6, dv);
      const lead = el("g", { opacity: 0 }, g);
      el("path", { d: `M${kx + (k - 1) * Math.min(24, kw / 3)},22 L${to},${top - 20}`, stroke: C.text, "stroke-width": 1, fill: "none" }, lead);
      el("circle", { cx: to, cy: top - 20, r: 2.5, fill: C.text }, lead);
      await T(0.6, e => { op(lead, e); if (k === 0) op(keyLab, e); });
    }
    const from = nx;
    await T(0.6, e => place(lerp(from, xEnd, e)));
  };

  SCENES[3] = async function (g, W, H, T) {
    const rnd = mulberry32(14);
    const narrow = W < 480;
    const models = [1, 2, 3, 4, 5, 6].map(i => t("rs.f.m" + i));
    const L = { cells: [], points: [], boxes: [] };
    let gcBox, gcLab, onlyLab, sensLab, compLab, mergeP, weightLab, barBase, barX0, keyLab;
    const wires = el("g", {}, g);   // all connecting lines sit behind the boxes
    const lineEl = (x1, y1, x2, y2, w) => el("path", { d: `M${x1},${y1} L${x2},${y2}`, stroke: C.line, "stroke-width": w || 1, fill: "none", opacity: 0 }, wires);
    if (narrow) {
      sensLab = [8, 16];
      for (let r = 0; r < 2; r++) for (let c = 0; c < 7; c++) L.cells.push([8 + c * 16, 26 + r * 16]);
      L.points = [[40, 86], [64, 86], [88, 86]];
      compLab = [100, 87, "start"];
      const bw = (W - 24) / 2;
      for (let i = 0; i < 6; i++) L.boxes.push([8 + (i % 2) * (bw + 8), 116 + Math.floor(i / 2) * 32, bw, 26]);
      mergeP = [60, 250]; weightLab = [8, 276, "start"];
      barBase = 273; barX0 = 160; keyLab = [187, 296, "middle"];
      gcBox = [W - 80, 8, 72, 28]; onlyLab = [W - 8, 56, "end"];
    } else {
      sensLab = [8, 78];
      for (let r = 0; r < 7; r++) for (let c = 0; c < 2; c++) L.cells.push([12 + c * 16, 92 + r * 16]);
      L.points = [[86, 132], [86, 152], [86, 172]];
      compLab = [56, 232, "middle"];
      const bw = Math.min(126, W * 0.26);
      for (let i = 0; i < 6; i++) L.boxes.push([118, 40 + i * 44, bw, 28]);
      mergeP = [118 + bw + 44, 166]; weightLab = [118 + bw + 56, 156, "start"];
      barBase = 206; barX0 = null; keyLab = null;   // set once the label width is known
      gcBox = [W - 82, 52, 76, 30]; onlyLab = [W - 6, 106, "end"];
    }
    // GC-O-MS: the reference method
    const gc = el("g", { opacity: 0 }, g);
    const gcRect = el("rect", { x: gcBox[0], y: gcBox[1], width: gcBox[2], height: gcBox[3], rx: 4, fill: "none", stroke: C.text, "stroke-width": 1.2 }, gc);
    gcLab = text(gc, gcBox[0] + gcBox[2] / 2, gcBox[1] + gcBox[3] / 2 + 4.5, "GC-O-MS", { class: "t-dark", "text-anchor": "middle" });
    await T(0.6, e => op(gc, e));
    // sensors
    const sens = el("g", { opacity: 0 }, g);
    L.cells.forEach(([x, y]) => el("rect", { x, y, width: 12, height: 12, fill: mix("#ffffff", C.line, 0.15 + rnd() * 0.6), stroke: C.line, "stroke-width": 1 }, sens));
    text(sens, sensLab[0], sensLab[1], t("rs.f.sensors"), {});
    await T(0.6, e => op(sens, e));
    // compress
    const cl = [];
    if (narrow) {
      for (let c = 0; c < 7; c++) L.points.forEach(([px, py]) => cl.push(lineEl(14 + c * 16, 58, px, py - 4, 0.6)));
    } else {
      for (let r = 0; r < 7; r++) L.points.forEach(([px, py]) => cl.push(lineEl(42, 98 + r * 16, px - 4, py, 0.6)));
    }
    const pg = el("g", { opacity: 0 }, g);
    L.points.forEach(([x, y]) => el("circle", { cx: x, cy: y, r: 3.5, fill: C.text }, pg));
    text(pg, compLab[0], compLab[1], t("rs.f.compress"), { "text-anchor": compLab[2] });
    const dc = drawAll(cl);
    cl.forEach(p => op(p, 0.7));
    await T(0.8, e => { dc(e); op(pg, e); });
    // six models
    const ml = [], bg = el("g", { opacity: 0 }, g);
    L.boxes.forEach(([x, y, w, h], i) => {
      el("rect", { x, y, width: w, height: h, rx: 3, fill: "#fbfaf7", stroke: C.line, "stroke-width": 1 }, bg);
      text(bg, x + w / 2, y + h / 2 + 4.5, models[i], { class: "t-dark", "text-anchor": "middle" });
      L.points.forEach(([px, py]) => ml.push(narrow ? lineEl(px, py + 4, x + w / 2, y, 0.6) : lineEl(px + 4, py, x, y + h / 2, 0.6)));
    });
    const dm = drawAll(ml);
    ml.forEach(p => op(p, 0.7));
    await T(0.8, e => { dm(e); op(bg, e); });
    // weighted merge
    const mg = [];
    L.boxes.forEach(([x, y, w, h]) => mg.push(narrow ? lineEl(x + w / 2, y + h, mergeP[0], mergeP[1] - 5) : lineEl(x + w, y + h / 2, mergeP[0] - 5, mergeP[1])));
    const mn = el("g", { opacity: 0 }, g);
    el("circle", { cx: mergeP[0], cy: mergeP[1], r: 5, fill: "none", stroke: C.text, "stroke-width": 1.3 }, mn);
    const wl = text(mn, weightLab[0], weightLab[1], t("rs.f.weight"), { class: "t-dark", "text-anchor": weightLab[2] });
    if (barX0 == null) {
      barX0 = Math.min(weightLab[0] + wl.getComputedTextLength() + 14, W - 72);
      keyLab = [barX0 + 27, barBase + 22, "middle"];
    }
    const dg = drawAll(mg);
    mg.forEach(p => op(p, 1));
    await T(0.8, e => { dg(e); op(mn, e); });
    // output bars: key flavor compounds
    const heights = narrow ? [34, 22, 46, 28] : [62, 38, 80, 48];
    const out = lineEl(mergeP[0] + 5, mergeP[1], barX0 - 6, mergeP[1]);   // one line flowing left to right
    const kl = text(g, keyLab[0], keyLab[1], t("rs.f.key"), { class: "t-dark", "text-anchor": keyLab[2], opacity: 0 });
    if (keyLab[2] === "middle") kl.setAttribute("x", Math.min(keyLab[0], W - 4 - kl.getComputedTextLength() / 2));   // keep inside
    const dout = prepDraw(out);
    op(out, 1);
    await T(0.6, e => { dout(e); op(kl, e); });
    for (let i = 0; i < 4; i++) {
      const x = barX0 + i * 16;
      const r = el("rect", { x, y: barBase, width: 10, height: 0, fill: C.fill, stroke: C.text, "stroke-width": 1 }, g);
      await T(0.6, e => { const h = heights[i] * e; r.setAttribute("y", barBase - h); r.setAttribute("height", h); });
    }
    // GC-O-MS is no longer needed for new samples
    await T(0.8, e => {
      gcRect.setAttribute("stroke", mix(C.text, C.faint, e));
      gcLab.style.fill = mix(C.text, "#b8b4ab", e);
    });
    const ol = text(g, onlyLab[0], onlyLab[1], t("rs.f.enose_only"), { class: "t-dark", "text-anchor": onlyLab[2], opacity: 0 });
    await T(0.6, e => op(ol, e));
  };

  SCENES[4] = async function (g, W, H, T) {
    const rnd = mulberry32(162);
    const fa = ["rs.f.oa", "rs.f.la", "rs.f.pa", "rs.f.ala"];          // order before ranking
    const faSorted = ["rs.f.la", "rs.f.ala", "rs.f.oa", "rs.f.pa"];
    const aa = ["rs.f.glu", "rs.f.ala2", "rs.f.gly"];
    const rh = 30, faTop = 50, aaHead = faTop + 4 * rh + 6, aaTop = aaHead + 26;
    const rowY = i => faTop + i * rh;
    const hFa = text(g, 8, faTop - 22, t("rs.f.fa"), { opacity: 0 });
    const hAa = text(g, 8, aaHead, t("rs.f.aa"), { opacity: 0 });
    const labs = {};
    fa.forEach((k, i) => { labs[k] = text(g, 8, rowY(i), t(k), { class: "t-dark", opacity: 0 }); });
    aa.forEach((k, i) => { labs[k] = text(g, 8, aaTop + i * rh, t(k), { class: "t-dark", opacity: 0 }); });
    const lw = Math.max(...Object.values(labs).map(l => l.getComputedTextLength())) + 22;   // room for bold
    const iconX = W - 24, iconY = 140;
    const nodeX = Math.round(lw + (iconX - 40 - lw) * 0.62);
    const nodeYs = [72, 122, 172, 222];
    const hKey = text(g, nodeX, faTop - 22, t("rs.f.key"), { class: "t-dark", "text-anchor": "middle", opacity: 0 });
    const hkw = hKey.getComputedTextLength();
    hKey.setAttribute("x", Math.min(nodeX, W - 6 - hkw / 2));
    const nodes = el("g", { opacity: 0 }, g);
    nodeYs.forEach(y => el("circle", { cx: nodeX, cy: y, r: 5, fill: "none", stroke: C.text, "stroke-width": 1.2 }, nodes));
    // links
    const links = {};
    const linkG = el("g", {}, g);
    Object.keys(labs).forEach(k => {
      const y = +labs[k].getAttribute("y") - 4;
      links[k] = nodeYs.map(ny => el("line", { x1: lw, y1: y, x2: nodeX - 6, y2: ny, stroke: C.line, "stroke-width": (0.6 + rnd() * 0.6).toFixed(2), opacity: 0 }, linkG));
    });
    await T(0.6, e => { [hFa, hAa, hKey, nodes].concat(Object.values(labs)).forEach(n => op(n, e)); });
    const all = [].concat(...Object.values(links));
    const lens = all.map(l => Math.hypot(l.x2.baseVal.value - l.x1.baseVal.value, l.y2.baseVal.value - l.y1.baseVal.value));
    all.forEach((l, i) => { l.setAttribute("stroke-dasharray", lens[i] + " " + lens[i]); l.setAttribute("stroke-dashoffset", lens[i]); op(l, 0.8); });
    await T(1.0, e => all.forEach((l, i) => l.setAttribute("stroke-dashoffset", lens[i] * (1 - e))));
    all.forEach(l => l.removeAttribute("stroke-dasharray"));
    // ranking: linoleic and alpha-linolenic acid move to the top
    const moves = fa.map(k => [k, rowY(fa.indexOf(k)), rowY(faSorted.indexOf(k))]);
    await T(1.0, e => moves.forEach(([k, a, b]) => {
      const y = lerp(a, b, e);
      labs[k].setAttribute("y", y);
      links[k].forEach(l => l.setAttribute("y1", y - 4));
    }));
    const top2 = ["rs.f.la", "rs.f.ala"];
    const w0 = {};
    all.forEach(l => { w0[all.indexOf(l)] = +l.getAttribute("stroke-width"); });
    await T(0.6, e => top2.forEach(k => {
      links[k].forEach(l => { l.setAttribute("stroke-width", lerp(w0[all.indexOf(l)], 2.4, e)); l.setAttribute("stroke", mix(C.line, C.text, e)); });
      labs[k].setAttribute("font-weight", e > 0.5 ? 600 : 400);
    }));
    await T(0.6, e => aa.forEach(k => {
      links[k].forEach(l => { l.setAttribute("stroke-width", lerp(w0[all.indexOf(l)], 0.4, e)); op(l, lerp(0.8, 0.25, e)); });
      labs[k].style.fill = mix(C.text, "#9aa0a6", e);
    }));
    // arrow to infant formula, which then takes the colour of human milk
    const icon = el("g", { stroke: C.fm, "stroke-width": 1.5, fill: "none", opacity: 0, transform: `translate(${iconX},${iconY})` }, g);
    el("path", { d: "M-4,-16 Q-4,-24 0,-26 Q4,-24 4,-16" }, icon);
    el("rect", { x: -10, y: -16, width: 20, height: 5, rx: 1 }, icon);
    el("rect", { x: -9, y: -11, width: 18, height: 30, rx: 4 }, icon);
    el("path", { d: "M-9,-1 L-4,-1 M-9,7 L-4,7" }, icon);
    const fl = text(g, W - 4, iconY + 40, t("rs.f.formula"), { class: "t-fm", "text-anchor": "end", opacity: 0 });
    await T(0.6, e => { op(icon, e); op(fl, e); });
    const ar = el("path", { d: `M${nodeX + 12},${iconY} L${iconX - 18},${iconY}`, fill: "none", stroke: C.text, "stroke-width": 1.2 }, g);
    const head = arrowHead(g, iconX - 16, iconY, 0, C.text);
    op(head, 0);
    const da = prepDraw(ar);
    await T(0.8, e => { da(e); op(head, e > 0.9 ? (e - 0.9) * 10 : 0); });
    await T(0.8, e => { const c = mix(C.fm, C.hm, e); icon.setAttribute("stroke", c); fl.style.fill = c; });
  };

  // ---------- player ----------
  const H_DETAIL = 340;
  let cur = 1, gen = 0, started = false, visible = false;
  function detailSize() {
    const W = Math.max(300, canvas.clientWidth);
    detail.setAttribute("viewBox", "0 0 " + W + " " + H_DETAIL);
    detail.setAttribute("width", W); detail.setAttribute("height", H_DETAIL);
    return W;
  }
  function updateControls() {
    prevBtn.disabled = cur <= 1;
    nextBtn.disabled = cur >= 4;
    pos.textContent = t("rs.pos", { n: cur }) + " · " + t("rs.s" + cur + ".name");
  }
  async function go(n, instant) {
    const my = ++gen;
    tweens.length = 0;
    const inst = reduced || !!instant;
    const T = tweener(inst);
    const prev = cur;
    cur = n;
    updateControls();
    nextBtn.style.boxShadow = "";
    // fade out the previous picture and text
    if (!inst && started) {
      const p = stepParts(prev);
      const o0 = +(detail.getAttribute("opacity") || 1);
      await T(0.4, e => { op(detail, lerp(o0, 0, e)); p.a.style.opacity = 1 - e; });
      p.a.style.opacity = "";
    }
    started = true;
    detail.textContent = "";
    op(detail, 1);
    const W = detailSize();
    const g = el("g", {}, detail);
    showText(n, "none");
    await overviewTo(n, T, inst);
    const parts = stepParts(n);
    await T(0.6, e => { parts.lede.style.opacity = e; });
    await SCENES[n](g, W, H_DETAIL, T, reduced && n === 1);
    await T(0.6, e => { parts.cap.style.opacity = e; });
    if (parts.go) await T(0.6, e => { parts.go.style.opacity = e; });
    markVisited(n);
    if (my !== gen || inst || n >= 4) return;
    // one gentle hint on "Next" (no loop)
    await T(1.2, e => { nextBtn.style.boxShadow = "0 0 0 2px rgba(15,110,110," + (0.55 * Math.sin(Math.PI * e)).toFixed(3) + ")"; });
    nextBtn.style.boxShadow = "";
  }
  function userGo(n) {
    if (n < 1 || n > 4) return;
    paused = false;
    go(n);
  }
  prevBtn.addEventListener("click", () => userGo(cur - 1));
  nextBtn.addEventListener("click", () => userGo(cur + 1));

  function rebuild() {   // new width or language: redraw the current step in its final state
    buildOverview();
    if (started) go(cur, true);
    else { detailSize(); showText(1, "none"); updateControls(); }
  }
  buildOverview();
  detailSize();
  showText(1, "none");
  updateControls();
  if (reduced) go(1, true);

  // play step 1 when the stage first comes into view; pause while it is out of view
  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (en.intersectionRatio >= 0.5) {
        visible = true; paused = false;
        if (!started) go(1);
      } else if (!en.isIntersecting) {
        visible = false; paused = true;
      }
    }
  }, { threshold: [0, 0.5] });
  io.observe(canvas);
  void visible;

  let lastW = canvas.clientWidth, rt = null;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (Math.abs(canvas.clientWidth - lastW) < 2) return;
      lastW = canvas.clientWidth;
      rebuild();
    }, 150);
  });
  I18N.onChange(rebuild);
})();
