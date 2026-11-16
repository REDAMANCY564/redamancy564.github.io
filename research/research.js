/*
 * Research overview (research/): two stages, each an overview diagram plus a step-by-step animation:
 * the PhD research (four steps) and the master's research (three steps). The stages play independently.
 * - Every point, curve and bar is schematic, generated from fixed seeds (mulberry32); no paper or sample data.
 * - Animations are attribute tweens on one requestAnimationFrame clock, so they can be paused
 *   (stage out of view) and no inline style attributes are needed (strict CSP).
 * - One thing moves at a time; each change 0.6-1 s (PhD steps 1-3: 1.0-1.2 s), ease-in-out; only move, fade and line drawing.
 * - Choosing a step shows its heading, first explanation line and opening picture at once; the picture starts
 *   moving 0.5 s later. PhD steps 1-3 play in segments: before each later one the next line fades in above the
 *   picture and stays 1.5 s before the picture moves; segments are 1.5 s apart. Pause / Resume holds the stage clock.
 * - prefers-reduced-motion: every step is drawn in its final state at once, with its explanation lines as a list.
 * - Each stage plays its step 1 when it first comes into view; later steps start only when the visitor asks.
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

  // ---------- clocks and tweens ----------
  // One requestAnimationFrame loop drives every stage; each stage has its own clock, so one can be
  // paused (out of view) while the other plays.
  const STAGES = [];
  const ease = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  function makeClock() {
    let vt = 0, last = null;
    const c = { paused: true, held: false, tweens: [] };   // paused: out of view; held: the visitor pressed Pause
    c.tick = function (ts) {
      if (last != null && !c.paused && !c.held) vt += Math.min(ts - last, 100);
      last = ts;
      for (const tw of c.tweens.slice()) {
        const p = Math.min(1, Math.max(0, (vt - tw.t0) / tw.d));
        tw.fn(ease(p));
        if (p >= 1) { c.tweens.splice(c.tweens.indexOf(tw), 1); tw.res(); }
      }
    };
    // A tweener for one run. Instant runs jump to the end. Cancelled runs simply never resume.
    c.tweener = function (instant) {
      return function (sec, fn) {
        if (instant) { if (fn) fn(1); return Promise.resolve(); }
        return new Promise(res => c.tweens.push({ t0: vt, d: sec * 1000, fn: fn || (() => {}), res }));
      };
    };
    return c;
  }
  function frame(ts) {
    for (const S of STAGES) S.clock.tick(ts);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
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

  // ---------- overview diagram: shared parts ----------
  // The current node is framed; when the step changes a small dot travels along the lines to the next
  // node. Steps already watched (and left) get a tick.
  function tickMark(S, g, k, x, y) {
    return el("path", { d: `M${x - 4},${y} L${x - 1},${y + 3} L${x + 4},${y - 3}`, fill: "none", stroke: S.cfg.accent, "stroke-width": 1.6,
      "stroke-linecap": "round", "stroke-linejoin": "round", opacity: S.visited.has(k) && k !== S.cur ? 1 : 0 }, g);   // ticks only on steps already left
  }
  function setHl(OV, r) {
    OV.hl.setAttribute("x", r.x); OV.hl.setAttribute("y", r.y);
    OV.hl.setAttribute("width", r.w); OV.hl.setAttribute("height", r.h);
  }
  function routePoint(OV, a, b, e) {   // point at fraction e of the route between stops a and b
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
  async function overviewTo(S, n, T, instant) {
    const OV = S.OV, keys = Object.keys(OV.groups).map(Number);
    const prev = OV.cur;
    const ops = keys.map(k => [OV.groups[k], +(OV.groups[k].getAttribute("opacity") || 1), k === n ? 1 : 0.6]);
    if (prev != null && prev !== n && !instant) {
      // a small dot travels from the current node to the next one while the old frame fades
      const a = OV.stop[prev], b = OV.stop[n];
      op(OV.dot, 1);
      await T(0.7, e => {
        const [x, y] = routePoint(OV, a, b, e);
        OV.dot.setAttribute("cx", x); OV.dot.setAttribute("cy", y);
        op(OV.hl, 1 - e);
      });
      op(OV.dot, 0);
    }
    setHl(OV, OV.targets[n]);
    const tks = keys.map(k => [OV.ticks[k], +OV.ticks[k].getAttribute("opacity"), S.visited.has(k) && k !== n ? 1 : 0]);
    await T(0.6, e => {
      op(OV.hl, Math.max(+(OV.hl.getAttribute("opacity")), e));
      ops.forEach(([g, a, b]) => op(g, lerp(a, b, e)));
      tks.forEach(([tk, a, b]) => op(tk, lerp(a, b, e)));
    });
    OV.cur = n;
    if (OV.arrive) await OV.arrive(n, T, instant);
  }


  // ---------- overview diagram ----------
  // Four nodes (1 smell, 2 identify, 3 the bridge between them, 4 adjust), each with a small icon drawn
  // like its detail picture. The current node is framed; when the step changes a small teal dot travels
  // along the lines to the next node. Steps already watched get a tick.
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
  function buildOverview(S) {
    const ov = S.ov;
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
      g.addEventListener("click", () => S.userGo(k));
      ticks[k] = tickMark(S, g, k, b.x + b.w - 10, b.y + 10);
      groups[k] = g;
    }
    node(1, n1, miniSensors, t("rs.ov.s1"));
    node(2, n2, miniPeaks, t("rs.ov.s2"));
    node(4, n4, miniChainBottle, t("rs.ov.s4"));
    // 3: the bridge from 1 to 2, with three small model dots on the arrow
    const g3 = el("g", { class: "ov-g" }, ov);
    g3.addEventListener("click", () => S.userGo(3));
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
    ticks[3] = tickMark(S, g3, 3, am + lab3.getComputedTextLength() / 2 + 10, ay - 15);
    const pad = 4;
    const box = b => ({ x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad });
    const targets = { 1: box(n1), 2: box(n2), 4: box(n4), 3: { x: ax0 - 2, y: ay - 28, w: ax1 - ax0 + 4, h: narrow ? 38 : 56 } };
    // route of the travelling dot: 1 -> 3 -> 2 -> (along the edge of box 2) -> 4
    const route = [[n1.x + bw, ay], [am, ay], [n2.x, ay], [n2.x, y1 + bh], [bx2, y1 + bh], [bx2, n4.y]];
    const stop = { 1: 0, 3: 1, 2: 2, 4: 5 };
    const dot = el("circle", { r: 4, fill: C.hm, opacity: 0 }, ov);
    // arriving at 3, its arrow is drawn again
    const arrive = async (n, T, instant) => {
      if (n !== 3 || instant) return;
      const d = prepDraw(arrow3);
      op(head3, 0);
      await T(0.8, e => { d(e); op(head3, e > 0.9 ? (e - 0.9) * 10 : 0); });
    };
    S.OV = { hl, groups, ticks, targets, route, stop, dot, arrive, cur: null };
    return S.OV;
  }

  // ---------- scenes ----------
  // Each scene draws into g (W x H user units = CSS pixels) and awaits T for every change.
  const SCENES = {};

  // Three cluster colours (shared by steps 1 and 2): distinct from formula orange, the master's brown and human milk teal.
  const CL = ["#2f6fd0", "#8e4ec6", "#5a9a2e"];
  const CL_C = [[0.24, 0.36], [0.72, 0.34], [0.47, 0.74]];   // cluster centres as fractions of their box
  // A dashed ellipse drawn dash by dash (stroke-dasharray is taken by line drawing, so the dashes are subpaths).
  function dashEllipse(parent, cx, cy, rx, ry, colour) {
    const p = el("path", { fill: "none", stroke: mix(colour, "#ffffff", 0.4), "stroke-width": 1.4, "stroke-linecap": "round" }, parent);
    const N = Math.max(16, Math.round(Math.PI * (rx + ry) / 7));
    return e => {
      let d = "";
      const n = Math.floor(e * N + 1e-6);
      for (let i = 0; i < n; i++) {
        const a0 = -Math.PI / 2 + i * 2 * Math.PI / N, a1 = a0 + 2 * Math.PI / N * 0.55;
        d += `M${(cx + rx * Math.cos(a0)).toFixed(1)},${(cy + ry * Math.sin(a0)).toFixed(1)} A${rx.toFixed(1)},${ry.toFixed(1)} 0 0 1 ${(cx + rx * Math.cos(a1)).toFixed(1)},${(cy + ry * Math.sin(a1)).toFixed(1)} `;
      }
      p.setAttribute("d", d);
    };
  }
  // Layout of three clusters inside box {x, y, w, h}: centres, ellipse radii and point positions (uniform in each ellipse).
  function clusterLayout(box, rnd, counts) {
    return CL_C.map(([fx, fy], k) => {
      const cx = box.x + fx * box.w, cy = box.y + fy * box.h;
      const rx = box.w * 0.14 + 6, ry = box.h * 0.16 + 6;
      const pts = [];
      for (let i = 0; i < counts[k]; i++) {
        const a = rnd() * 2 * Math.PI, r = 0.92 * Math.pow(rnd(), 0.7);
        pts.push([cx + (rx - 7) * r * Math.cos(a), cy + (ry - 7) * r * Math.sin(a)]);
      }
      return { k, cx, cy, rx, ry, pts };
    });
  }
  // Ellipses and cluster letters for a layout; returns { draws: [fn(e)], labs: [text] } (labels start hidden).
  function clusterMarks(parent, lay, box) {
    const draws = lay.map(c => dashEllipse(parent, c.cx, c.cy, c.rx, c.ry, CL[c.k]));
    const labs = lay.map(c => {
      const s = t("rs.f.cluster", { k: "ABC"[c.k] });
      const l = text(parent, 0, 0, s, { "text-anchor": c.k === 2 ? "start" : "middle", opacity: 0 });
      l.style.fill = CL[c.k];
      const w = l.getComputedTextLength();
      if (c.k === 2) {   // C sits low in the middle: its letter goes to its right (or left if there is no room)
        let x = c.cx + c.rx + 6;
        if (x + w > box.x + box.w) { x = c.cx - c.rx - 6; l.setAttribute("text-anchor", "end"); }
        l.setAttribute("x", x); l.setAttribute("y", c.cy + 4);
      } else {           // A and B: above their ellipses
        l.setAttribute("x", Math.min(Math.max(c.cx, box.x + w / 2), box.x + box.w - w / 2));
        l.setAttribute("y", c.cy - c.ry - 6);
      }
      return l;
    });
    const bb = labs.map(l => l.getBBox());
    if (bb[0].x + bb[0].width + 4 > bb[1].x) {   // too tight: letters only, re-centred
      labs.forEach((l, k) => { l.textContent = "ABC"[k]; });
      labs.slice(0, 2).forEach((l, k) => { const c = lay[k], w = l.getComputedTextLength(); l.setAttribute("x", Math.min(Math.max(c.cx, box.x + w / 2), box.x + box.w - w / 2)); });
    }
    return { draws, labs };
  }

  // PhD steps 1-3 are slower: every change takes 1.1 s; plain waits (no function) keep their length
  const slow = T => (sec, fn) => T(fn && sec < 1.0 ? 1.1 : sec, fn);

  SCENES[1] = async function (g, W, H, T0, staticView, say) {
    const T = slow(T0);
    const rnd = mulberry32(1303);
    const x0 = 8, y0 = 26;
    const x1 = staticView ? Math.round(W * 0.58) : W - 8;   // reduced motion: the three clusters sit to the right
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
    const human = el("g", {}, pts), animal = el("g", {}, pts), stars = el("g", { opacity: 0 }, pts);
    const hdots = [], adots = [];   // every dot starts grey and hidden; they fall onto the plane in step (a)
    for (let i = 0; i < 78; i++) {
      const x = hc.x + gauss(rnd) * pw * 0.075, y = hc.y + gauss(rnd) * ph * 0.14;
      hdots.push(el("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: 2.2, fill: C.line, opacity: 0 }, human));
    }
    for (let k = 0; k < 19; k++) {
      const gx = ac.x + gauss(rnd) * pw * 0.08, gy = ac.y + gauss(rnd) * ph * 0.17;
      for (let j = 0; j < 3; j++)
        adots.push(el("circle", { cx: (gx + gauss(rnd) * 4).toFixed(1), cy: (gy + gauss(rnd) * 4).toFixed(1), r: 2.2, fill: C.line, opacity: 0 }, animal));
    }
    // Alpine Holstein milk: a few small filled stars just inside the edge of the human milk cluster
    const sc = { x: hc.x + pw * 0.065, y: hc.y - ph * 0.12 };
    [[0, 0], [10, 4], [-9, 6], [3, -9]].forEach(([dx, dy]) =>
      el("path", { d: starPath(sc.x + dx, sc.y + dy, 5.2), fill: "#3d434a", stroke: "#fbfaf7", "stroke-width": 0.8 }, stars));
    const labels = el("g", {}, g);
    const lh = text(labels, hc.x, y0 + 10, t("rs.f.human"), { class: "t-hm", "text-anchor": "middle", opacity: 0 });
    const la = text(labels, ac.x, y0 + 10, t("rs.f.animal"), { "text-anchor": "middle", opacity: 0 });
    const starLab = el("g", { opacity: 0 }, labels);
    el("path", { d: `M${sc.x},${sc.y - 21} L${sc.x},${y0 + 2}`, stroke: C.line, "stroke-width": 1, fill: "none" }, starLab);
    const sl = text(starLab, sc.x, y0 - 4, t("rs.f.alpine"), { class: "t-dark", "text-anchor": "middle" });
    // keep the star label inside the frame
    const slw = sl.getComputedTextLength();
    const slx = Math.min(Math.max(sc.x, x0 + slw / 2), x1 - slw / 2);
    sl.setAttribute("x", slx);
    // the human / animal labels would sit under the star label: move them below the clusters
    lh.setAttribute("y", y1 - 6); la.setAttribute("y", y1 - 6);
    // a teal halo round the stars (white underlay so it reads on top of teal points)
    const rc = { x: sc.x + 0.5, y: sc.y - 0.5 };
    const halo = el("g", { opacity: 0 }, labels);
    el("circle", { cx: rc.x, cy: rc.y, r: 18, fill: "none", stroke: "#fbfaf7", "stroke-width": 4 }, halo);
    el("circle", { cx: rc.x, cy: rc.y, r: 18, fill: "none", stroke: C.hm, "stroke-width": 1.6 }, halo);
    const haloScale = k => halo.setAttribute("transform", `translate(${rc.x},${rc.y}) scale(${k.toFixed(3)}) translate(${-rc.x},${-rc.y})`);

    // opening, segment 1: a drop of human milk goes into the e-nose; 14 sensor cells light up and become
    // 14 thin bars, the odor fingerprint
    const intro = el("g", {}, g);
    const nbw = 136, nbh = 70, nbx = Math.round(W / 2 - nbw / 2), nby = 50, ncx = nbx + nbw / 2;
    const nose = el("g", { opacity: 0 }, intro);
    el("rect", { x: nbx, y: nby, width: nbw, height: nbh, rx: 6, fill: "#fbfaf7", stroke: C.text, "stroke-width": 1.2 }, nose);
    text(nose, ncx, nby + 18, t("rs.f.enose"), { class: "t-dark", "text-anchor": "middle" });
    const lv = Array.from({ length: 14 }, () => 0.12 + rnd() * 0.78);   // sensor responses: shade and bar height
    const fpBase = nby + nbh + 96, fpX0 = ncx - (14 * 7 - 3) / 2;
    const cells = lv.map((v, i) => {
      const c = { x: nbx + (nbw - 7 * 16 + 4) / 2 + (i % 7) * 16, y: nby + 28 + Math.floor(i / 7) * 16, w: 12, h: 12 };
      const b = { x: fpX0 + i * 7, y: fpBase - (8 + v * 46), w: 4, h: 8 + v * 46 };
      return { r: el("rect", { x: c.x, y: c.y, width: 12, height: 12, fill: "#ffffff", stroke: C.line, "stroke-width": 1 }, nose), c, b, v };
    });
    const setRect = (r, a) => { r.setAttribute("x", a.x.toFixed(2)); r.setAttribute("y", a.y.toFixed(2)); r.setAttribute("width", a.w.toFixed(2)); r.setAttribute("height", a.h.toFixed(2)); };
    const rlerp = (a, b, e) => ({ x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e), w: lerp(a.w, b.w, e), h: lerp(a.h, b.h, e) });
    const drop = el("path", { d: `M0,-9 C6,-1 7,3 7,5 A7,7 0 0 1 -7,5 C-7,3 -6,-1 0,-9 Z`, fill: C.hm, opacity: 0 }, intro);
    const dropAt = y => drop.setAttribute("transform", `translate(${ncx},${y.toFixed(1)})`);
    const fpLab = text(intro, ncx, fpBase + 20, t("rs.f.fp"), { class: "t-dark", "text-anchor": "middle", opacity: 0 });
    dropAt(14);
    await say(1);
    await T(1.1, e => { op(drop, e); op(nose, e); });
    await T(1.1, e => { dropAt(lerp(14, nby + nbh / 2, e)); op(drop, 1 - e); });
    await T(1.1, e => cells.forEach(c => c.r.setAttribute("fill", mix("#ffffff", "#5f6670", c.v * e))));
    const bg = el("g", {}, intro);   // the cells leave the (soon fading) box
    cells.forEach(c => bg.appendChild(c.r));
    await T(1.1, e => { cells.forEach(c => setRect(c.r, rlerp(c.c, c.b, e))); op(fpLab, e); });
    // segment 2: the fingerprint shrinks to one dot, which lands on the plane; the other samples follow
    await say(2);
    await T(1.1, e => { op(nose, 1 - e); op(fpLab, 1 - e); op(axes, e); });
    const fc = { x: ncx, y: fpBase - 18 };
    const dot = el("circle", { cx: fc.x, cy: fc.y, r: 0, fill: C.text }, intro);
    await T(1.1, e => {
      cells.forEach(c => { setRect(c.r, rlerp(c.b, { x: fc.x - 1, y: fc.y - 1, w: 2, h: 2 }, e)); op(c.r, 1 - e); });
      dot.setAttribute("r", (3.5 * e).toFixed(2));
    });
    const first = hdots[5], fx = +first.getAttribute("cx"), fy = +first.getAttribute("cy");
    await T(1.1, e => { dot.setAttribute("cx", lerp(fc.x, fx, e).toFixed(1)); dot.setAttribute("cy", lerp(fc.y, fy, e).toFixed(1)); dot.setAttribute("r", lerp(3.5, 2.2, e).toFixed(2)); dot.setAttribute("fill", mix(C.text, C.line, e)); });
    op(first, 1);
    intro.remove();
    const rest = hdots.concat(adots).filter(d => d !== first);
    const order = rest.map(() => rnd()), batches = [[], [], []];
    rest.forEach((d, i) => batches[Math.min(2, Math.floor(order[i] * 3))].push([d, +d.getAttribute("cy")]));
    for (const b of batches)
      await T(1.1, e => b.forEach(([d, y]) => { op(d, Math.min(1, e * 2)); d.setAttribute("cy", (y - 22 * (1 - e)).toFixed(1)); }));
    // (a) segment 3: human milk and animal milk on opposite sides; Alpine Holstein milk on the human side
    await say(3);
    await T(1.1, e => hdots.forEach(d => d.setAttribute("fill", mix(C.line, C.hm, e))));
    await T(0.6, e => { op(stars, e); op(lh, e); op(la, e); op(starLab, e); });
    await T(0.6, e => op(halo, e));
    for (let i = 0; i < 2; i++) await T(0.6, e => haloScale(1 + 0.15 * Math.sin(Math.PI * e)));
    haloScale(1);

    if (staticView) {   // reduced motion: (a) and the three clusters on top, (c) below
      const box = { x: x1 + 14, y: y0 + 14, w: W - 8 - (x1 + 14), h: y1 - y0 - 14 };
      const cg = el("g", {}, g);
      const cl = text(cg, box.x, y0 - 4, t("rs.f.clustered"), {});
      cl.style.fontSize = "12px";
      if (cl.getComputedTextLength() > box.w) {   // narrow: two lines, and the clusters move down a little
        const words = cl.textContent.split(" "), half = Math.ceil(words.length / 2);
        cl.textContent = "";
        [words.slice(0, half).join(" "), words.slice(half).join(" ")].forEach((w, i) => {
          const ts = el("tspan", { x: box.x, y: y0 - 8 + i * 14 }, cl); ts.textContent = w;
        });
        box.y += 8; box.h -= 8;
      }
      const lay = clusterLayout(box, mulberry32(31), [14, 12, 12]);
      lay.forEach(c => c.pts.forEach(([x, y]) => el("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: 2.2, fill: CL[c.k] }, cg)));
      const mk = clusterMarks(cg, lay, box);
      mk.draws.forEach(f => f(1)); mk.labs.forEach(l => op(l, 1));
      await bars(g, W, y1 + 22, H, T);
      return;
    }
    await T(3.0);   // let the halo stay
    // (b) segment 4: zoom into human milk, colour by city
    await say(4);
    // only human milk goes into the zoom: labels, stars, halo and animal milk fade out first
    await T(0.6, e => { [lh, la, starLab, stars, animal, halo].forEach(n => op(n, 1 - e)); });
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
    await T(1.4);
    // (b2) segment 5: the same points, clustered by e-nose signals: three colours, three groups
    await say(5);
    await T(0.6, e => op(legend, 1 - e));
    const box = { x: inner.x0 + 4, y: inner.y0 + 4, w: inner.x1 - inner.x0 - 8, h: inner.y1 - inner.y0 - 8 };
    const crnd = mulberry32(31);
    const ks = hdots.map(() => Math.floor(crnd() * 3));
    const counts = [0, 1, 2].map(k => ks.filter(x => x === k).length);
    const lay = clusterLayout(box, crnd, counts);
    const used = [0, 0, 0];
    const tx = pc.x - bc.x * s, ty = pc.y - bc.y * s;
    const moves = hdots.map((d, i) => {   // targets are in screen units; the points live in the zoomed group
      const [X, Y] = lay[ks[i]].pts[used[ks[i]]++];
      return [+d.getAttribute("cx"), +d.getAttribute("cy"), (X - tx) / s, (Y - ty) / s];
    });
    await T(0.8, e => hdots.forEach((d, i) => d.setAttribute("fill", mix(CITY[i % 6], CL[ks[i]], e))));
    await T(1.0, e => hdots.forEach((d, i) => {
      const [a, b, c, dd] = moves[i];
      d.setAttribute("cx", lerp(a, c, e).toFixed(2)); d.setAttribute("cy", lerp(b, dd, e).toFixed(2));
    }));
    const cg = el("g", {}, g);
    const mk = clusterMarks(cg, lay, box);
    await T(0.6, e => mk.draws.forEach(f => f(e)));
    const cl = text(g, x0 + 2, 14, t("rs.f.clustered"), { class: "t-dark", opacity: 0 });
    await T(0.6, e => { mk.labs.forEach(l => op(l, e)); op(cl, e); });
    // (c) segment 6: association bars
    await say(6);
    await T(0.6, e => { op(pts, 1 - e); op(axes, 1 - e); op(cg, 1 - e); op(cl, 1 - e); });
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

  // Key flavor compounds in step 2: a darker step of the human milk teal (#0f6e6e)
  const KEY = "#0a5252";
  SCENES[2] = async function (root, W, Hfull, T0, staticView, say) {
    const T = slow(T0);
    const rnd = mulberry32(2026);
    const H = staticView ? 206 : Hfull;   // reduced motion: spectra on top, ROAV scatter below
    const g = el("g", {}, root);
    const xL = 8, xR = W - 8, axisY = H - 44;
    const xa = xL + (xR - xL) * 0.36;
    // ten peak positions (retention times). Half are shared by every milk (same place, different heights),
    // the rest appear only in some of them.
    const NP = 10;
    const px = Array.from({ length: NP }, (_, k) => xa + (xR - xa) * ((k + 0.5) / NP + (rnd() - 0.5) * 0.03));
    const SHARED = [1, 2, 4, 5, 8];
    const ODOR = [1, 3, 4, 7, 8];     // peaks with an odor, marked on the human milk trace while sniffing
    const KEYP = [1, 4, 7];           // the key flavor compounds among them
    const SAME = [2, 5];              // two shared peaks joined by dashed lines: the same compound
                                      // (clear in every trace, human milk included, with different heights)
    const ALL = [0, 1, 2, 3, 4, 5, 6];
    const has = px.map((_, k) => {
      if (SHARED.includes(k)) return ALL;
      let set = ALL.filter(() => rnd() < 0.45);
      if (ODOR.includes(k)) { if (!set.includes(0)) set.push(0); }
      else set = set.filter(i => i !== 0);
      while (set.length < 2) { const j = 1 + Math.floor(rnd() * 6); if (!set.includes(j)) set.push(j); }
      return set;
    });
    const big = px.map(() => 12 + rnd() * 16);   // typical size of each peak
    const hs = staticView ? 0.55 : 1;
    const top = staticView ? 62 : 72, step = (axisY - 22 - top) / 6;
    const colours = [C.hm, C.fm, C.line, C.line, C.line, C.line, C.line];
    const names = { 0: ["rs.f.hm", "t-hm"], 1: ["rs.f.formula", "t-fm"], 4: ["rs.f.animals", ""] };
    const axis = el("path", { d: `M${xL},${axisY} L${xR},${axisY}`, stroke: C.faint, "stroke-width": 1, fill: "none", opacity: 0 }, g);
    const axisLab = text(g, xL, H - 8, t("rs.f.time"), { opacity: 0 });
    const lines = [], labs = [], humanTop = [];
    for (let i = 0; i < 7; i++) {
      const base = top + i * step;
      // every trace has its own heights (0.12-1.3 of the typical size, times a scale for the whole trace)
      // and widths, so no two traces look alike
      const sc = 0.7 + rnd() * 0.6, wsc = 0.7 + rnd() * 0.8;
      const peaks = px.map((x, k) => has[k].includes(i)
        ? [x, (SAME.includes(k) ? (i ? 12 : 16) + rnd() * (i ? 14 : 8) : Math.max(3, Math.min(i ? 30 : 26, sc * big[k] * (0.12 + 1.18 * Math.pow(rnd(), 1.4))))) * hs, wsc * (2 + rnd() * 4)] : [x, 0, 3]);
      const yAt = x => peaks.reduce((y, [p, h, w]) => y - h * Math.exp(-Math.pow((x - p) / w, 2)), base);
      if (i === 0) px.forEach((x, k) => humanTop.push(yAt(x)));
      let d = "";
      for (let k = 0; k <= 200; k++) {
        const x = xL + (xR - xL) * k / 200;
        d += (k ? "L" : "M") + x.toFixed(1) + "," + (yAt(x) - Math.abs(gauss(rnd)) * 0.4).toFixed(1);
      }
      lines.push(el("path", { d, fill: "none", stroke: colours[i], "stroke-width": i < 2 ? 1.4 : 1, opacity: 0 }, g));
      labs.push(names[i] ? text(g, xL, base - 5, t(names[i][0]), { class: names[i][1], opacity: 0 }) : null);
    }
    // segment 1: the axis and the human milk trace only
    await say(1);
    await T(0.6, e => { op(axis, e); op(axisLab, e); });
    const drawTrace = async (i, sec) => { const d = prepDraw(lines[i]); op(lines[i], 1); await T(sec, e => { d(e); if (labs[i]) op(labs[i], e); }); };
    await drawTrace(0, 1.1);
    // segment 2: the other six traces, then two shared peaks joined by dashed lines
    await say(2);
    for (let i = 1; i < 7; i++) await drawTrace(i, 1.0);
    // each dashed line gets its own label; if the two labels would touch, the second one sits a line lower
    const same = el("g", { opacity: 0 }, g), dashes = el("g", {}, same), sameLabs = el("g", {}, same);
    let prevR = -1e9;
    SAME.forEach(k => {
      const lab = text(sameLabs, px[k], 14, t("rs.f.same"), { class: "t-dark", "text-anchor": "middle" });
      const w = lab.getComputedTextLength(), x = Math.min(Math.max(px[k], xL + w / 2), xR - w / 2);
      let y = 14;
      if (x - w / 2 < prevR + 6) y = 28;
      lab.setAttribute("x", x); lab.setAttribute("y", y);
      prevR = x + w / 2;
      el("path", { d: `M${px[k]},${y + 5} L${px[k]},${axisY - 2}`, fill: "none", stroke: C.muted, "stroke-width": 1, "stroke-dasharray": "3 3" }, dashes);
    });
    await T(1.1, e => op(same, e));
    // segment 3 (GC-O): "Sniffing" walks along the time axis and marks the human milk peaks that have an odor
    await say(3);
    const sn = el("g", { opacity: 0 }, g);
    el("path", { d: `M0,${axisY + 1} L0,${axisY + 7}`, stroke: C.text, "stroke-width": 1.2, fill: "none" }, sn);
    const sniff = text(sn, 0, axisY + 21, t("rs.f.sniff"), { class: "t-dark", "text-anchor": "middle" });
    const sw = sniff.getComputedTextLength();
    let nx = Math.max(xa - 26, xL + sw / 2);
    const xEnd = xR - sw / 2;
    const place = x => sn.setAttribute("transform", `translate(${x.toFixed(1)},0)`);
    place(nx);
    // the "same compound" label gives way; its dashed lines stay, lighter
    await T(1.1, e => { op(sn, e); op(sameLabs, 1 - e); op(dashes, lerp(1, 0.45, e)); });
    const marks = {};
    for (const k of ODOR) {
      const from = nx, to = Math.min(Math.max(px[k], xL + sw / 2), xEnd);
      await T(1.1, e => place(lerp(from, to, e)));
      nx = to;
      const yt = humanTop[k] - 3;
      const m = el("path", { d: `M${px[k] - 4},${yt - 7} L${px[k] + 4},${yt - 7} L${px[k]},${yt} Z`, fill: C.text, stroke: C.text, "stroke-width": 1, "stroke-linejoin": "round", opacity: 0 }, g);
      marks[k] = { m, x: px[k], y: yt };
      await T(1.0, e => op(m, e));
    }
    const from = nx;
    await T(1.1, e => place(lerp(from, xEnd, e)));
    // segment 4: ROAV picks out the key flavor compounds: three of the marked peaks become filled darker teal
    // and larger; the other two become light grey outlines
    await say(4);
    await T(1.1, e => ODOR.forEach(k => {
      const { m, x, y } = marks[k];
      if (KEYP.includes(k)) {
        const s = lerp(1, 1.4, e);
        m.setAttribute("fill", mix(C.text, KEY, e)); m.setAttribute("stroke", mix(C.text, KEY, e));
        m.setAttribute("transform", `translate(${x},${y}) scale(${s.toFixed(3)}) translate(${-x},${-y})`);
      } else {
        m.setAttribute("fill", mix(C.text, "#fbfaf7", e)); m.setAttribute("stroke", mix(C.text, "#b8b4ab", e));
      }
    }));
    const kg = el("g", { opacity: 0 }, g);
    const keyLab = text(kg, (marks[KEYP[0]].x + marks[KEYP[2]].x) / 2, 14, t("rs.f.key"), { "text-anchor": "middle" });
    keyLab.style.fill = KEY; keyLab.style.fontWeight = "600";
    const kw = keyLab.getComputedTextLength();
    const kx = Math.min(Math.max(+keyLab.getAttribute("x"), xL + kw / 2), xR - kw / 2);
    keyLab.setAttribute("x", kx);
    KEYP.forEach(k => { const { x, y } = marks[k]; el("path", { d: `M${kx},19 L${x},${(y - 7 * 1.4 - 2).toFixed(1)}`, fill: "none", stroke: KEY, "stroke-width": 1 }, kg); });
    await T(1.1, e => op(kg, e));
    // segment 5
    await say(5);
    // human milk ROAV data, using the three e-nose cluster labels from step 1
    let box;
    if (staticView) box = { x: 14, y: H + 26, w: W - 22, h: Hfull - H - 50 };
    else {
      await T(0.6, e => op(g, 1 - e));
      g.remove();
      box = { x: 14, y: 40, w: W - 22, h: Hfull - 90 };
    }
    const rg = el("g", {}, root);
    const head = el("g", { opacity: 0 }, rg);
    text(head, 8, box.y - 14, t("rs.f.roav"), { class: "t-dark" });
    el("path", { d: `M${box.x - 6},${box.y - 4} L${box.x - 6},${box.y + box.h + 4} L${box.x + box.w},${box.y + box.h + 4}`, fill: "none", stroke: C.faint, "stroke-width": 1 }, head);
    await T(0.6, e => op(head, e));
    const lay = clusterLayout(box, mulberry32(57), [10, 9, 9]);
    for (const c of lay) {
      const cg = el("g", { opacity: 0 }, rg);
      c.pts.forEach(([x, y]) => el("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: 2.6, fill: CL[c.k] }, cg));
      await T(0.6, e => op(cg, e));
    }
    const mk = clusterMarks(rg, lay, box);
    await T(0.6, e => mk.draws.forEach(f => f(e)));
    const ul = text(rg, W - 8, box.y + box.h + 22, t("rs.f.roav_labels"), { class: "t-dark", "text-anchor": "end", opacity: 0 });
    await T(0.6, e => { mk.labs.forEach(l => op(l, e)); op(ul, e); });
  };

  SCENES[3] = async function (g, W, H, T0, staticView, say) {
    const T = slow(T0);
    const rnd = mulberry32(14);
    // segments 1-2, the question: the e-nose is fast, GC-O-MS slow; can the first stand in for the second?
    await say(1);
    const pr = el("g", {}, g);
    const pbw = Math.min(170, Math.round((W - 16) * 0.36)), pbh = 44, pby = 96;
    const plx = 8, prx = W - 8 - pbw;
    const probBox = (x, name, sub) => {
      const b = el("g", { opacity: 0 }, pr);
      el("rect", { x, y: pby, width: pbw, height: pbh, rx: 5, fill: "#fbfaf7", stroke: C.text, "stroke-width": 1.2 }, b);
      text(b, x + pbw / 2, pby + pbh / 2 + 5, name, { class: "t-strong", "text-anchor": "middle" });
      const sl = text(b, x + pbw / 2, pby + pbh + 22, sub, { class: "t-dark", "text-anchor": "middle" });
      const w = sl.getComputedTextLength();
      sl.setAttribute("x", Math.min(Math.max(x + pbw / 2, 4 + w / 2), W - 4 - w / 2));
      return b;
    };
    const pL = probBox(plx, t("rs.f.enose"), t("rs.f.fast")), pR = probBox(prx, "GC-O-MS", t("rs.f.slow"));
    await T(1.1, e => op(pL, e));
    await T(1.1, e => op(pR, e));
    await say(2);
    const ay = pby + pbh / 2, ax0 = plx + pbw + 6, ax1 = prx - 4;
    const arrow = el("path", { d: `M${ax0},${ay} L${ax0},${ay}`, fill: "none", stroke: C.text, "stroke-width": 1.2, "stroke-dasharray": "4 3" }, pr);
    const ah = el("g", { opacity: 0 }, pr);
    arrowHead(ah, ax1, ay, 0, C.text);
    const q = text(pr, (ax0 + ax1) / 2, ay - 10, "?", { class: "t-strong", "text-anchor": "middle", opacity: 0 });
    q.style.fontSize = "20px";
    await T(1.1, e => { arrow.setAttribute("d", `M${ax0},${ay} L${lerp(ax0, ax1 - 1, e).toFixed(1)},${ay}`); op(ah, Math.max(0, 3 * e - 2)); });
    await T(1.1, e => op(q, e));
    // segment 3: the boxes give way to the method
    await say(3);
    await T(1.1, e => op(pr, 1 - e));
    pr.remove();
    const narrow = W < 480;
    const models = [1, 2, 3, 4, 5, 6].map(i => t("rs.f.m" + i));
    const L = { cells: [], points: [], boxes: [] };
    let gcBox, gcLab, onlyLab, sensLab, compLab, mergeP, weightLab, barBase, barX0, keyLab, frame;
    const wires = el("g", {}, g);   // all connecting lines sit behind the boxes
    const lineEl = (x1, y1, x2, y2, w) => el("path", { d: `M${x1},${y1} L${x2},${y2}`, stroke: C.line, "stroke-width": w || 1, fill: "none", opacity: 0 }, wires);
    if (narrow) {
      // phones: the three compressed points join into one line into the frame round the six models, and the
      // frame sends one line on to the weighting; no line crosses a model box. A free strip on the right
      // carries the GC-O-MS arrow down to the bars.
      sensLab = [8, 16];
      for (let r = 0; r < 2; r++) for (let c = 0; c < 7; c++) L.cells.push([8 + c * 16, 26 + r * 16]);
      L.points = [[40, 82], [64, 82], [88, 82]];
      compLab = [100, 83, "start"];
      const bw = Math.floor((W - 38) / 2);
      for (let i = 0; i < 6; i++) L.boxes.push([8 + (i % 2) * (bw + 8), 116 + Math.floor(i / 2) * 32, bw, 26]);
      frame = { x: 4, y: 110, w: 2 * bw + 16, h: 102 };
      mergeP = [64, 240]; weightLab = [8, 266, "start"];
      barBase = 286; barX0 = 160; keyLab = [187, 306, "middle"];
      gcBox = [W - 80, 8, 72, 28]; onlyLab = [W - 18, 99, "end"];
    } else {
      sensLab = [8, 78];
      for (let r = 0; r < 7; r++) for (let c = 0; c < 2; c++) L.cells.push([12 + c * 16, 92 + r * 16]);
      L.points = [[86, 132], [86, 152], [86, 172]];
      compLab = [56, 232, "middle"];
      const bw = Math.min(126, W * 0.26);
      for (let i = 0; i < 6; i++) L.boxes.push([118, 40 + i * 44, bw, 28]);
      mergeP = [118 + bw + 44, 166]; weightLab = [118 + bw + 56, 156, "start"];
      barBase = 206; barX0 = null; keyLab = null;   // set once the label width is known
      gcBox = [W - 82, 52, 76, 30]; onlyLab = [W - 6, 40, "end"];
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
    // segment 4: six models
    await say(4);
    const ml = [], bg = el("g", { opacity: 0 }, g);
    if (narrow) {   // one bundle into the frame round the six models
      el("rect", { x: frame.x, y: frame.y, width: frame.w, height: frame.h, rx: 5, fill: "none", stroke: C.faint, "stroke-width": 1 }, bg);
      const jx = L.points[1][0], jy = frame.y - 12;
      L.points.forEach(([px, py]) => ml.push(lineEl(px, py + 4, jx, jy, 0.8)));
      ml.push(lineEl(jx, jy, jx, frame.y - 1, 1.4));
    }
    L.boxes.forEach(([x, y, w, h], i) => {
      el("rect", { x, y, width: w, height: h, rx: 3, fill: "#fbfaf7", stroke: C.line, "stroke-width": 1 }, bg);
      text(bg, x + w / 2, y + h / 2 + 4.5, models[i], { class: "t-dark", "text-anchor": "middle" });
      if (!narrow) L.points.forEach(([px, py]) => ml.push(lineEl(px + 4, py, x, y + h / 2, 0.6)));
    });
    const dm = drawAll(ml);
    ml.forEach(p => op(p, narrow ? 1 : 0.7));
    await T(0.8, e => { dm(e); op(bg, e); });
    // weighted merge (phones: one line from the bottom of the model frame)
    const mg = [];
    if (narrow) mg.push(lineEl(mergeP[0], frame.y + frame.h + 1, mergeP[0], mergeP[1] - 5, 1.4));
    else L.boxes.forEach(([x, y, w, h]) => mg.push(lineEl(x + w, y + h / 2, mergeP[0] - 5, mergeP[1])));
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
    // GC-O-MS supplies the measured values the models are trained on: a dashed arrow from its box to the bars
    const barsR = barX0 + 3 * 16 + 10;
    const route = narrow
      ? [[W - 12, gcBox[1] + gcBox[3] + 2], [W - 12, barBase - 20], [barsR + 7, barBase - 20]]
      : [[gcBox[0] + gcBox[2] / 2, gcBox[1] + gcBox[3] + 3], [barsR + 6, barBase - Math.max(...heights) - 4]];
    const tg = el("g", {}, g);
    const tLine = el("path", { fill: "none", stroke: C.text, "stroke-width": 1.2, "stroke-dasharray": "4 3" }, tg);
    const last = route[route.length - 1], prev = route[route.length - 2];
    const tHead = arrowHead(tg, last[0], last[1], Math.atan2(last[1] - prev[1], last[0] - prev[0]) * 180 / Math.PI, C.text);
    op(tHead, 0);
    const segLen = route.slice(1).map((q, i) => Math.hypot(q[0] - route[i][0], q[1] - route[i][1]));
    const total = segLen.reduce((x, y) => x + y, 0);
    const partial = e => {   // the route up to fraction e of its length (the dashes stay fixed)
      let d = `M${route[0][0]},${route[0][1]}`, left = total * e;
      for (let i = 0; i < segLen.length && left > 0; i++) {
        const f = Math.min(1, left / segLen[i]);
        d += ` L${lerp(route[i][0], route[i + 1][0], f).toFixed(1)},${lerp(route[i][1], route[i + 1][1], f).toFixed(1)}`;
        left -= segLen[i];
      }
      tLine.setAttribute("d", d);
    };
    partial(0);
    // its label sits left of the box (wide screens) or left of the arrow's first stretch (phones);
    // it breaks into two lines when one does not fit
    const tLab = text(tg, 0, 0, t("rs.f.measured_train"), { class: "t-dark", "text-anchor": "end", opacity: 0 });
    const tx = narrow ? W - 20 : gcBox[0] - 8, ty = narrow ? 56 : gcBox[1] + 20;
    const room = narrow ? tx - 124 : tx - (L.boxes[0][0] + L.boxes[0][2] + 10);
    if (tLab.getComputedTextLength() > room && tLab.textContent.includes(" ")) {
      const words = tLab.textContent.split(" "), half = Math.ceil(words.length / 2);
      tLab.textContent = "";
      [words.slice(0, half).join(" "), words.slice(half).join(" ")].forEach((w, i) => {
        const ts = el("tspan", { x: tx, y: (narrow ? ty : ty - 8) + i * 16 }, tLab); ts.textContent = w;
      });
    } else { tLab.setAttribute("x", tx); tLab.setAttribute("y", ty); }
    await T(1.1, e => { partial(e); op(tHead, e > 0.9 ? (e - 0.9) * 10 : 0); op(tLab, e); });
    // segment 5: GC-O-MS (box and arrow) is no longer needed for new samples
    await say(5);
    await T(0.8, e => {
      gcRect.setAttribute("stroke", mix(C.text, C.faint, e));
      gcLab.style.fill = mix(C.text, "#b8b4ab", e);
      tLine.setAttribute("stroke", mix(C.text, C.faint, e)); tHead.setAttribute("stroke", mix(C.text, C.faint, e));
      tLab.style.fill = mix(C.text, "#b8b4ab", e);
    });
    const ol = text(g, onlyLab[0], onlyLab[1], t("rs.f.enose_only"), { class: "t-dark", "text-anchor": onlyLab[2], opacity: 0 });
    await T(0.6, e => op(ol, e));
    // segment 6: how accuracy is judged. Reduced motion keeps the method picture and adds this below it.
    await say(6);
    if (staticView) {
      await accuracy(el("g", { transform: `translate(0,${H})` }, g), W, H, T);
      return;
    }
    await T(0.6, e => op(g, 1 - e));
    while (g.firstChild) g.removeChild(g.firstChild);
    op(g, 1);
    await accuracy(g, W, H, T);
  };

  // Step 3, second scene: how accuracy is assessed. (a) rank consistency, (b) numerical deviation in bands.
  // Scores are schematic (10, 8, 9, 6, 7); no result from the paper is shown.
  async function accuracy(g, W, H, T) {
    const title = text(g, 8, 18, t("rs.f.acc"), { class: "t-strong", opacity: 0 });
    await T(0.6, e => op(title, e));
    // (a) rank consistency
    const a = el("g", { opacity: 0 }, g);
    text(a, 8, 46, t("rs.f.rank"), { class: "t-dark" });
    const cxM = Math.round(W * 0.34), cxP = Math.round(W * 0.66), rowY = i => 78 + i * 14;
    text(a, cxM, 64, t("rs.f.measured"), { "text-anchor": "middle" });
    text(a, cxP, 64, t("rs.f.predicted"), { "text-anchor": "middle" });
    for (let i = 0; i < 6; i++) {
      el("circle", { cx: cxM, cy: rowY(i), r: 3.5, fill: C.text }, a);
      el("circle", { cx: cxP, cy: rowY(i), r: 3.5, fill: C.text }, a);
    }
    await T(0.6, e => op(a, e));
    const prank = [0, 1, 3, 2, 4, 5];   // samples 3 and 4 swap places in the prediction
    const links = prank.map((p, i) => el("path", { d: `M${cxM + 6},${rowY(i)} L${cxP - 6},${rowY(p)}`, fill: "none", stroke: C.line, "stroke-width": 1 }, g));
    const dl = drawAll(links);
    await T(0.8, dl);
    links.forEach(l => l.removeAttribute("stroke-dasharray"));
    await T(0.6, e => [2, 3].forEach(i => { links[i].setAttribute("stroke", mix(C.line, "#e0897e", e)); links[i].setAttribute("stroke-width", lerp(1, 1.5, e)); }));
    // (b) numerical deviation: a ruler with symmetric bands, dark at the centre (the measured value)
    const ry = 252, half = (W - 32) / 2, cx = W / 2, NB = 7;
    const b = el("g", { opacity: 0 }, g);
    text(b, 8, 180, t("rs.f.dev"), { class: "t-dark" });
    for (let k = NB - 1; k >= 0; k--) {
      const w = half * (k + 1) / NB;
      el("rect", { x: cx - w, y: ry - 6, width: 2 * w, height: 12, fill: mix("#80868d", "#eeebe5", k / (NB - 1)) }, b);
    }
    el("circle", { cx, cy: ry, r: 5, fill: "#fbfaf7", stroke: C.text, "stroke-width": 1.4 }, b);
    await T(0.8, e => op(b, e));
    const ends = el("g", { opacity: 0 }, g);
    text(ends, cx, ry - 32, t("rs.f.small"), { class: "t-dark", "text-anchor": "middle" });
    el("path", { d: `M${cx + half - 2},${ry + 8} L${cx + half - 2},${ry + 14}`, fill: "none", stroke: C.line, "stroke-width": 1 }, ends);
    text(ends, cx + half, ry + 28, t("rs.f.large"), { class: "t-dark", "text-anchor": "end" });
    await T(0.6, e => op(ends, e));
    // five predictions fall into different bands; each shows a schematic score
    const preds = [[0, 1, 10], [2, -1, 8], [1, 1, 9], [4, -1, 6], [3, 1, 7]];   // band, side, score
    for (const [k, side, score] of preds) {
      const x = cx + side * half * (k + 0.5) / NB;
      const p = el("circle", { cx: x, cy: ry - 20, r: 4.5, fill: C.hm, stroke: "#fbfaf7", "stroke-width": 1, opacity: 0 }, g);
      const sl = text(g, x, ry - 12, String(score), { class: "t-hm", "text-anchor": "middle", opacity: 0 });
      await T(0.6, e => { op(p, Math.min(1, e * 3)); p.setAttribute("cy", lerp(ry - 20, ry, e)); op(sl, Math.max(0, 2 * e - 1)); });
    }
    // mean score: one short bar on a faint 0-10 track, no number
    const my = 304;
    const ml = text(g, 16, my + 9, t("rs.f.mean"), { class: "t-dark", opacity: 0 });
    const bx = 16 + ml.getComputedTextLength() + 12, maxW = Math.min(180, W - 16 - bx);
    const track = el("rect", { x: bx, y: my, width: maxW, height: 10, fill: "none", stroke: C.faint, "stroke-width": 1, opacity: 0 }, g);
    const bar = el("rect", { x: bx, y: my, width: 0, height: 10, fill: "#cfe3e0", stroke: C.hm, "stroke-width": 1 }, g);
    const mean = preds.reduce((s, p) => s + p[2], 0) / preds.length / 10;
    await T(0.8, e => { op(ml, Math.min(1, e * 2)); op(track, Math.min(1, e * 2)); bar.setAttribute("width", (maxW * mean * e).toFixed(1)); });
  }


  SCENES[4] = async function (g, W, H, T) {
    const rnd = mulberry32(162);
    const fa = ["rs.f.oa", "rs.f.la", "rs.f.pa", "rs.f.ala"];          // order before ranking
    const faSorted = ["rs.f.la", "rs.f.ala", "rs.f.oa", "rs.f.pa"];
    const aa = ["rs.f.glu", "rs.f.ala2", "rs.f.gly"];
    const rh = 30, faTop = 68, aaHead = faTop + 4 * rh + 6, aaTop = aaHead + 26;
    const rowY = i => faTop + i * rh;
    const hFa = text(g, 8, faTop - 22, t("rs.f.fa"), { opacity: 0 });
    const hAa = text(g, 8, aaHead, t("rs.f.aa"), { opacity: 0 });
    const labs = {};
    fa.forEach((k, i) => { labs[k] = text(g, 8, rowY(i), t(k), { class: "t-dark", opacity: 0 }); });
    aa.forEach((k, i) => { labs[k] = text(g, 8, aaTop + i * rh, t(k), { class: "t-dark", opacity: 0 }); });
    const lw = Math.max(...Object.values(labs).map(l => l.getComputedTextLength())) + 22;   // room for bold
    const iconX = W - 24, iconY = 158;
    const nodeX = Math.round(lw + (iconX - 40 - lw) * 0.62);
    const nodeYs = [90, 140, 190, 240];
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
    // once ranked: what the left column shows
    const infl = text(g, 8, faTop - 44, t("rs.f.influence"), { class: "t-strong", opacity: 0 });
    await T(0.6, e => op(infl, e));
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

  // =====================================================================
  // Master's research: point -> line -> surface. Warm brown accent (beef tallow residue).
  // =====================================================================
  const M = "#8a5a2b", ML = "#d8c2a6", MS = "#f4ece2", NEG = "#f6d3cf";

  function miniPoint(g, x, cy) { el("circle", { cx: x + 5, cy, r: 4.5, fill: M }, g); return 10; }
  function miniCurve(g, x, cy) {
    el("path", { d: `M${x},${cy + 6} C${x + 7},${cy + 6} ${x + 9},${cy - 7} ${x + 15},${cy - 7} S${x + 23},${cy + 2} ${x + 28},${cy + 1}`,
      fill: "none", stroke: C.muted, "stroke-width": 1.1 }, g);
    [[0, 6], [15, -7], [28, 1]].forEach(([dx, dy]) => el("circle", { cx: x + dx, cy: cy + dy, r: 1.8, fill: C.muted }, g));
    return 28;
  }
  function miniGrid(g, x, cy) {
    const shades = [0.15, 0.35, 0.6, 0.3, 0.55, 0.9, 0.2, 0.45, 0.7];
    for (let i = 0; i < 9; i++)
      el("rect", { x: x + (i % 3) * 7, y: cy - 10 + Math.floor(i / 3) * 7, width: 6, height: 6, fill: mix(MS, M, shades[i]) }, g);
    return 20;
  }
  function buildOverviewM(S) {
    const ov = S.ov;
    ov.textContent = "";
    const W = Math.max(300, ov.parentNode.clientWidth);
    const narrow = W < 600;
    const gap = narrow ? 18 : Math.round(Math.min(80, W * 0.08));
    const bw = Math.floor(narrow ? (W - 2 * gap) / 3 : Math.min(250, (W - 2 * gap) / 3)), bh = narrow ? 46 : 58;
    const left = Math.round((W - 3 * bw - 2 * gap) / 2);
    const y1 = 6, H = y1 + bh + 6;
    ov.setAttribute("viewBox", "0 0 " + W + " " + H);
    ov.setAttribute("width", W); ov.setAttribute("height", H);
    const hl = el("rect", { rx: 6, fill: MS, stroke: M, "stroke-width": 1.5, opacity: 0 }, ov);
    const nb = [0, 1, 2].map(i => ({ x: left + i * (bw + gap), y: y1, w: bw, h: bh }));
    const ay = y1 + bh / 2;
    for (let i = 0; i < 2; i++) {   // linear: 1 -> 2 -> 3
      el("path", { d: `M${nb[i].x + bw + 3},${ay} L${nb[i + 1].x - 4},${ay}`, fill: "none", stroke: C.line, "stroke-width": 1 }, ov);
      arrowHead(ov, nb[i + 1].x - 3, ay, 0);
    }
    const groups = {}, ticks = {};
    const icons = [miniPoint, miniCurve, miniGrid];
    nb.forEach((b, i) => {
      const k = i + 1;
      const g = el("g", { class: "ov-g" }, ov);
      el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 4, fill: "#fbfaf7", stroke: C.line, "stroke-width": 1 }, g);
      const pad = narrow ? 8 : 14, mid = b.y + b.h / 2;
      const iw = icons[i](g, b.x + pad, mid);
      const tx = b.x + pad + iw + (narrow ? 6 : 12);
      const title = text(g, tx, narrow ? mid + 5 : mid - 4, k + " " + t("rs.m" + k + ".name"), { class: "t-strong" });
      if (title.getComputedTextLength() > b.x + b.w - 4 - tx) title.style.fontSize = "12px";
      if (!narrow) {   // on phones only the icon and the step name
        const d = text(g, tx, mid + 15, t("rs.mov.s" + k), {});
        const avail = b.x + b.w - 8 - tx;
        if (d.getComputedTextLength() > avail) d.style.fontSize = "12px";
        if (d.getComputedTextLength() > avail) { d.remove(); title.setAttribute("y", mid + 5); }
      }
      g.addEventListener("click", () => S.userGo(k));
      ticks[k] = tickMark(S, g, k, b.x + b.w - 10, b.y + 10);
      groups[k] = g;
    });
    const pad = 4;
    const targets = {};
    nb.forEach((b, i) => { targets[i + 1] = { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }; });
    // the travelling dot runs along the arrows and round the bottom edge of box 2
    const route = [[nb[0].x + bw, ay], [nb[1].x, ay], [nb[1].x, y1 + bh], [nb[1].x + bw, y1 + bh], [nb[1].x + bw, ay], [nb[2].x, ay]];
    const stop = { 1: 0, 2: 1, 3: 5 };
    const dot = el("circle", { r: 4, fill: M, opacity: 0 }, ov);
    S.OV = { hl, groups, ticks, targets, route, stop, dot, cur: null };
    return S.OV;
  }

  // a small network ball: dots on a circle joined by thin lines
  function netBall(parent, cx, cy, r, rnd) {
    const g = el("g", {}, parent);
    const lines = el("g", {}, g), dots = el("g", { opacity: 0 }, g);
    const P = [];
    for (let i = 0; i < 12; i++) { const a = Math.PI + i * Math.PI / 6; P.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    for (let i = 0; i < 4; i++) { const a = Math.PI / 4 + i * Math.PI / 2; P.push([cx + r * 0.42 * Math.cos(a), cy + r * 0.42 * Math.sin(a)]); }
    const segs = [];
    for (let i = 0; i < 12; i++) { segs.push([i, (i + 1) % 12]); segs.push([i, 12 + Math.floor(rnd() * 4)]); }
    for (let i = 12; i < 16; i++) segs.push([i, 12 + (i - 11) % 4]);
    const ls = segs.map(([a, b]) => el("path", { d: `M${P[a][0].toFixed(1)},${P[a][1].toFixed(1)} L${P[b][0].toFixed(1)},${P[b][1].toFixed(1)}`,
      fill: "none", stroke: C.line, "stroke-width": 0.7 }, lines));
    P.forEach(([x, y]) => el("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: Math.max(1.8, r * 0.05), fill: C.muted }, dots));
    return { g, ls, dots, P };
  }

  const SCENES_M = {};

  // 1 point: five enzymes -> compound contents -> neural network -> one sensory score; with and without interactions
  SCENES_M[1] = async function (g, W, H, T) {
    const rnd = mulberry32(447);
    const colW = (W - 16) / 5, base = 100;
    const lab5 = text(g, 8, 16, t("rs.mf.enzymes"), { class: "t-dark", opacity: 0 });
    const vials = [], groups = [];
    for (let i = 0; i < 5; i++) {
      const cx = 8 + colW * (i + 0.5);
      const v = el("g", { opacity: 0 }, g);
      el("rect", { x: cx - 8, y: base - 12, width: 16, height: 11, fill: ML }, v);   // liquid
      el("path", { d: `M${cx - 5},${base - 32} L${cx - 5},${base - 24} L${cx - 9},${base - 17} L${cx - 9},${base - 2} Q${cx - 9},${base} ${cx - 7},${base} L${cx + 7},${base} Q${cx + 9},${base} ${cx + 9},${base - 2} L${cx + 9},${base - 17} L${cx + 5},${base - 24} L${cx + 5},${base - 32}`,
        fill: "none", stroke: C.muted, "stroke-width": 1.1, "stroke-linejoin": "round" }, v);
      el("rect", { x: cx - 7, y: base - 36, width: 14, height: 4, rx: 1, fill: "none", stroke: C.muted, "stroke-width": 1.1 }, v);
      vials.push(v);
      const grp = el("g", {}, g);
      const bars = [];
      for (let j = 0; j < 5; j++)
        bars.push({ r: el("rect", { x: cx - 21 + j * 9, y: base, width: 6, height: 0, fill: C.fill, stroke: C.muted, "stroke-width": 1 }, grp), h: 8 + rnd() * 30, x: cx - 21 + j * 9 + 3 });
      groups.push({ g: grp, bars, cx });
    }
    // the two labels next to the predicted point; wrapped onto two lines if one line leaves too little room
    const yTop = 146, yBot = 316, yTrue = 196, ySingle = 290, yNear = 204;
    const mkLab = (k, cls) => { const e = text(g, 0, 0, t(k), { class: cls, opacity: 0 }); return e; };
    const l1 = mkLab("rs.mf.without", "t-dark"), l2 = mkLab("rs.mf.with", "t-m");
    // "large error" / "small error" sit left of the two labels, by the gap between predicted and measured;
    // on narrow screens there is no room for that, so they go on a line just above the label
    const e1 = mkLab("rs.mf.err_large", ""), e2 = mkLab("rs.mf.err_small", "");
    const ew = Math.max(e1.getComputedTextLength(), e2.getComputedTextLength()) + 8;
    let lw = Math.max(l1.getComputedTextLength(), l2.getComputedTextLength());
    const side = W - 26 - ew - lw >= W * 0.62;
    const wrap = !side && W - 26 - lw < W * 0.62;
    if (wrap) {
      [l1, l2].forEach(l => {
        const words = l.textContent.split(" "), half = Math.ceil(words.length / 2);
        l.textContent = "";
        [words.slice(0, half).join(" "), words.slice(half).join(" ")].forEach((s, i) => {
          const ts = el("tspan", { x: 0, dy: i ? 16 : 0 }, l); ts.textContent = s;
        });
      });
      lw = Math.max(...[l1, l2].map(l => Math.max(...[...l.childNodes].map(ts => ts.getComputedTextLength()))));
    }
    if (!side) lw = Math.max(lw, ew - 8);
    const axisX = Math.round(W - 26 - (side ? ew : 0) - lw);
    const placeLab = (l, er, y) => {
      const x0 = axisX + 22, x = side ? x0 + ew : x0, dy = l.childNodes.length > 1 ? -4 : 4;
      l.setAttribute("x", x); l.setAttribute("y", y + dy);
      [...l.querySelectorAll("tspan")].forEach(ts => ts.setAttribute("x", x));
      er.setAttribute("x", x0); er.setAttribute("y", side ? y + dy : y + dy - 16);
    };
    placeLab(l1, e1, ySingle); placeLab(l2, e2, yNear);

    await T(0.6, e => { vials.forEach(v => op(v, e)); op(lab5, e); });
    // each vial becomes a group of thin bars (compound contents)
    for (let i = 0; i < 5; i++)
      await T(0.6, e => { op(vials[i], 1 - e); groups[i].bars.forEach(b => { b.r.setAttribute("y", base - b.h * e); b.r.setAttribute("height", b.h * e); }); });
    await T(0.6, e => { for (let i = 1; i < 5; i++) op(groups[i].g, lerp(1, 0.25, e)); });
    // the first group moves down, to the left of the network
    const by = 226, lowBase = by + 24;
    const g0 = groups[0], dx = 8 - (g0.cx - 21), dy = lowBase - base;
    const contLab = text(g, 8, by + 62, t("rs.mf.contents"), { opacity: 0 });   // below the bars, clear of the input column
    await T(0.8, e => { g0.g.setAttribute("transform", `translate(${(dx * e).toFixed(1)},${(dy * e).toFixed(1)})`); op(contLab, e); });
    // a generic neural network: one input column, two hidden layers, one output
    const nx0 = 76, nx3 = axisX - 40, cols = [0, 1, 2, 3].map(i => lerp(nx0, nx3, i / 3));
    const layers = [[-36, -18, 0, 18, 36], [-27, -9, 9, 27], [-27, -9, 9, 27], [0]].map((ys, i) => ys.map(y => [cols[i], by + y]));
    const wireG = el("g", {}, g), netG = el("g", {}, g), nodeG = el("g", { opacity: 0 }, g);
    const links = [];
    for (let i = 0; i < 3; i++)
      layers[i].forEach(([x1, y1]) => layers[i + 1].forEach(([x2, y2]) =>
        links.push(el("path", { d: `M${x1},${y1} L${x2},${y2}`, fill: "none", stroke: C.line, "stroke-width": 0.6 }, netG))));
    layers.forEach((L, i) => L.forEach(([x, y]) => el("circle", { cx: x, cy: y, r: i === 3 ? 4 : 3.2, fill: "#fbfaf7", stroke: C.muted, "stroke-width": 1.1 }, nodeG)));
    const nnLab = text(g, (nx0 + nx3) / 2, by - 50, t("rs.mf.nn"), { "text-anchor": "middle", opacity: 0 });   // above the network
    const dl = drawAll(links);
    await T(0.8, e => { dl(e); op(nodeG, e); op(nnLab, e); });
    // first only a few bars are connected to the inputs
    const wires = g0.bars.map((b, j) => el("path", { d: `M${(b.x + dx).toFixed(1)},${(lowBase - b.h).toFixed(1)} L${layers[0][j][0] - 4},${layers[0][j][1]}`,
      fill: "none", stroke: C.line, "stroke-width": 0.9, opacity: 0 }, wireG));
    const few = [1, 3];
    const dfew = drawAll(few.map(j => wires[j]));
    few.forEach(j => op(wires[j], 1));
    await T(0.6, dfew);
    // sensory score axis
    const axis = el("g", { opacity: 0 }, g);
    el("path", { d: `M${axisX},${yTop} L${axisX},${yBot}`, fill: "none", stroke: C.line, "stroke-width": 1 }, axis);
    [yTop, yBot].forEach(y => el("path", { d: `M${axisX - 3},${y} L${axisX + 3},${y}`, fill: "none", stroke: C.line, "stroke-width": 1 }, axis));
    const al = text(axis, axisX, yTop - 10, t("rs.mf.score"), { class: "t-dark", "text-anchor": "middle" });
    al.setAttribute("x", Math.min(axisX, W - 4 - al.getComputedTextLength() / 2));
    await T(0.6, e => op(axis, e));
    // output: one filled point travels from the output node onto the axis
    const ox = nx3 + 5;
    const outLine = el("path", { d: `M${ox},${by} L${axisX - 6},${ySingle}`, fill: "none", stroke: ML, "stroke-width": 1.2 }, g);
    const dout = prepDraw(outLine);
    const pred = el("circle", { cx: ox, cy: by, r: 5, fill: M, opacity: 0 }, g);
    await T(0.8, e => { dout(e); op(pred, Math.min(1, e * 3)); pred.setAttribute("cx", lerp(ox, axisX, e)); pred.setAttribute("cy", lerp(by, ySingle, e)); });
    outLine.removeAttribute("stroke-dasharray");
    // compare with the measured value (hollow point): far without interactions
    const cmp = el("g", { opacity: 0 }, g);
    el("circle", { cx: axisX, cy: yTrue, r: 5.5, fill: "#fbfaf7", stroke: C.text, "stroke-width": 1.3 }, cmp);
    const gapLine = el("path", { fill: "none", stroke: C.text, "stroke-width": 1 }, cmp);
    const setGap = y => gapLine.setAttribute("d", `M${axisX + 9},${yTrue} L${axisX + 13},${yTrue} M${axisX + 11},${yTrue} L${axisX + 11},${y} M${axisX + 9},${y} L${axisX + 13},${y}`);
    setGap(ySingle);
    await T(0.6, e => { op(cmp, e); op(l1, e); op(e1, e); });
    // connect the remaining bars: with interactions the prediction moves next to the measured value
    const rest = wires.filter((w, j) => !few.includes(j));
    const dr = drawAll(rest);
    rest.forEach(w => op(w, 1));
    await T(0.8, dr);
    await T(0.8, e => {
      const y = lerp(ySingle, yNear, e);
      pred.setAttribute("cy", y); setGap(y);
      outLine.setAttribute("d", `M${ox},${by} L${axisX - 6},${y}`);
      op(l1, 1 - e); op(e1, 1 - e); op(gapLine, 1 - e);
    });
    await T(0.6, e => { op(l2, e); op(e2, e); });
  };

  // 2 line: five time points, three ways to join them, checked against a validation point
  SCENES_M[2] = async function (g, W, H, T) {
    const hrs = [0, 2, 4, 6, 8], ys = [0.15, 0.42, 0.92, 0.58, 0.42];
    // monotone cubic through the points (smooth, never negative): the curve prediction model
    const d = [], m = [];
    for (let i = 0; i < 4; i++) d.push((ys[i + 1] - ys[i]) / 2);
    m[0] = d[0]; m[4] = d[3];
    for (let i = 1; i < 4; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    const model = h => {
      const i = Math.min(3, Math.floor(h / 2)), s = (h - hrs[i]) / 2, s2 = s * s, s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * ys[i] + (s3 - 2 * s2 + s) * 2 * m[i] + (-2 * s3 + 3 * s2) * ys[i + 1] + (s3 - s2) * 2 * m[i + 1];
    };
    const poly = h => 0.11514 + 0.27786 * h - 0.030357 * h * h;                           // least-squares quadratic
    const spline = h => model(h) - Math.sin(Math.PI * h / 2) * (0.12 + 0.9 * Math.pow((h - 4) / 4, 4));   // wiggles, most at the ends
    const val = model(5) + 0.06;   // a measured value sits a little off the curve
    // legend: one row if it fits, otherwise three rows under the plot
    const names = ["rs.mf.poly", "rs.mf.spline", "rs.mf.model"], greys = ["#9aa0a6", "#6b7178", "#3d434a"];
    const leg = names.map(k => { const gg = el("g", { opacity: 0 }, g); return { g: gg, tx: text(gg, 0, 0, t(k), {}) }; });
    const lw = leg.map(l => l.tx.getComputedTextLength() + 24);
    const oneRow = lw.reduce((a, b) => a + b, 0) + 32 <= W - 16;
    let lx = 8;
    leg.forEach((l, i) => {
      const y = oneRow ? H - 8 : H - 8 - 18 * (2 - i);
      const x = oneRow ? lx : 8;
      l.sw = el("path", { d: `M${x},${y - 4} L${x + 18},${y - 4}`, fill: "none", stroke: greys[i], "stroke-width": i === 2 ? 1.6 : 1.2 }, l.g);
      l.tx.setAttribute("x", x + 24); l.tx.setAttribute("y", y);
      lx += lw[i] + 16;
    });
    const firstY = oneRow ? H - 8 : H - 44;
    const axLabY = firstY - 22, tickY = axLabY - 18, yB = tickY - 14, top = 40;
    const xL = 26, xR = W - 12, vmin = -0.3, vmax = 1.0;
    const X = h => xL + (xR - xL) * h / 8, Y = v => yB - (v - vmin) / (vmax - vmin) * (yB - top);
    const frameG = el("g", { opacity: 0 }, g);
    el("path", { d: `M${xL},${top - 8} L${xL},${yB} L${xR},${yB}`, fill: "none", stroke: C.faint, "stroke-width": 1 }, frameG);
    el("path", { d: `M${xL},${Y(0)} L${xR},${Y(0)}`, fill: "none", stroke: C.faint, "stroke-width": 1, "stroke-dasharray": "3 3" }, frameG);
    text(frameG, xL - 6, Y(0) + 4, "0", { "text-anchor": "end" });
    hrs.forEach(h => {
      el("path", { d: `M${X(h)},${yB} L${X(h)},${yB + 4}`, fill: "none", stroke: C.line, "stroke-width": 1 }, frameG);
      text(frameG, X(h), tickY, String(h), { "text-anchor": "middle" });
    });
    text(frameG, xL, axLabY, t("rs.mf.time"), { class: "t-dark" });
    await T(0.6, e => op(frameG, e));
    const curveG = el("g", {}, g), ptG = el("g", {}, g);
    const pts = hrs.map((h, i) => el("circle", { cx: X(h), cy: top - 20, r: 4, fill: C.text, opacity: 0 }, ptG));
    for (let i = 0; i < 5; i++)
      await T(0.6, e => { op(pts[i], e); pts[i].setAttribute("cy", lerp(top - 20, Y(ys[i]), e)); });
    const roast = text(g, X(4), Y(ys[2]) - 12, t("rs.mf.roast"), { class: "t-m", "text-anchor": "middle", opacity: 0 });
    const rw = roast.getComputedTextLength();
    roast.setAttribute("x", Math.min(Math.max(X(4), 4 + rw / 2), W - 4 - rw / 2));
    await T(0.6, e => op(roast, e));
    // three curves, drawn one by one
    const pathOf = (f, n) => { let s = ""; for (let k = 0; k <= n; k++) { const h = 8 * k / n; s += (k ? "L" : "M") + X(h).toFixed(1) + "," + Y(f(h)).toFixed(1); } return s; };
    const curves = [pathOf(poly, 8), pathOf(spline, 160), pathOf(model, 160)].map((dd, i) =>
      el("path", { d: dd, fill: "none", stroke: greys[i], "stroke-width": i === 2 ? 1.6 : 1.2, "stroke-linejoin": "miter", opacity: 0 }, curveG));
    // the part of the spline below zero is filled light red
    let negD = "", run = null;
    for (let k = 0; k <= 160; k++) {
      const h = 8 * k / 160, v = spline(h);
      if (v < 0) { negD += (run ? "L" : "M" + X(h).toFixed(1) + "," + Y(0) + " L") + X(h).toFixed(1) + "," + Y(v).toFixed(1) + " "; run = h; }
      else if (run != null) { negD += "L" + X(run).toFixed(1) + "," + Y(0) + " Z "; run = null; }
    }
    if (run != null) negD += "L" + X(run).toFixed(1) + "," + Y(0) + " Z";
    const neg = el("path", { d: negD, fill: NEG, stroke: "none", opacity: 0 }, curveG);
    curveG.insertBefore(neg, curveG.firstChild);
    for (let i = 0; i < 3; i++) {
      const dc = prepDraw(curves[i]);
      op(curves[i], 1);
      await T(0.8, e => { dc(e); op(leg[i].g, e); });
      curves[i].removeAttribute("stroke-dasharray");
      if (i === 1) await T(0.6, e => op(neg, e));
    }
    // validation point at 5 h and the distance from each curve to it
    const vx = X(5), vy = Y(val);
    const vg = el("g", { opacity: 0 }, g);
    el("circle", { cx: vx, cy: vy, r: 5, fill: "#fbfaf7", stroke: C.text, "stroke-width": 1.3 }, vg);
    text(vg, vx + 9, vy - 8, t("rs.mf.valid"), { class: "t-dark" });
    await T(0.6, e => op(vg, e));
    const fs = [poly, spline, model];
    const dists = fs.map((f, i) => {
      const x = vx + 10 + i * 8, y = Y(f(5));
      return el("path", { d: `M${x - 3},${vy} L${x + 3},${vy} M${x},${vy} L${x},${y} M${x - 3},${y} L${x + 3},${y}`, fill: "none", stroke: greys[i], "stroke-width": 1.3, opacity: 0 }, g);
    });
    for (let i = 0; i < 3; i++) await T(0.6, e => op(dists[i], e));
    // the curve prediction model takes the accent colour; the other two fade
    await T(0.8, e => {
      const c = mix(greys[2], M, e);
      curves[2].setAttribute("stroke", c); curves[2].setAttribute("stroke-width", lerp(1.6, 2.2, e));
      leg[2].sw.setAttribute("stroke", c); leg[2].tx.style.fill = mix(C.muted, M, e);
      [curves[0], curves[1], neg, leg[0].g, leg[1].g].concat(dists).forEach(n => op(n, 1 - e));   // the distance marks go too
    });
  };

  // 3 surface: 17 amino acids -> 9, Latin hypercube design, network, heat map of the whole space, flavor vs cost
  SCENES_M[3] = async function (g, W, H, T) {
    const rnd = mulberry32(25);
    const s = Math.min(24, (W - 16) / 17), rowY = 38;
    const keep = [0, 2, 3, 5, 8, 9, 11, 14, 16];
    const labA = text(g, 8, 18, t("rs.mf.aa17"), { class: "t-dark", opacity: 0 });
    const labB = text(g, 8, 18, t("rs.mf.aa9"), { class: "t-m", opacity: 0 });
    const dots = Array.from({ length: 17 }, (_, i) => el("circle", { cx: 8 + s / 2 + i * s, cy: rowY, r: 4, fill: "#fbfaf7", stroke: C.line, "stroke-width": 1, opacity: 0 }, g));
    await T(0.6, e => { op(labA, e); dots.forEach(dd => op(dd, e)); });
    await T(1.0, e => dots.forEach((dd, i) => {   // light up from left to right
      const p = Math.min(1, Math.max(0, e * 1.6 - i * 0.6 / 16));
      dd.setAttribute("fill", mix("#fbfaf7", ML, p)); dd.setAttribute("stroke", mix(C.line, M, p));
    }));
    await T(0.8, e => {
      dots.forEach((dd, i) => { if (keep.includes(i)) dd.setAttribute("fill", mix(ML, M, e)); else op(dd, 1 - e); });
      op(labA, 1 - e); op(labB, e);
    });
    await T(0.8, e => keep.forEach((i, k) => dots[i].setAttribute("cx", lerp(8 + s / 2 + i * s, 8 + s / 2 + k * s, e))));
    // the formulation space: a 10 x 10 grid
    const gridTop = 108, G = Math.min(200, H - gridTop - 44, W - 16), cell = G / 10, gx0 = Math.round((W - G) / 2);
    const gcx = gx0 + G / 2, gcy = gridTop + G / 2;
    const heatG = el("g", {}, g), gridG = el("g", { opacity: 0 }, g);
    let gd = "";
    for (let i = 0; i <= 10; i++) gd += `M${gx0 + i * cell},${gridTop} L${gx0 + i * cell},${gridTop + G} M${gx0},${gridTop + i * cell} L${gx0 + G},${gridTop + i * cell} `;
    el("path", { d: gd, fill: "none", stroke: C.faint, "stroke-width": 1 }, gridG);
    await T(0.6, e => op(gridG, e));
    // Latin hypercube: one point in every row and every column
    const perm = [...Array(10).keys()];
    for (let i = 9; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    const lhs = perm.map((r, c) => ({ x: gx0 + (c + 0.5) * cell, y: gridTop + (r + 0.5) * cell }));
    const lp = lhs.map(p => el("circle", { cx: p.x, cy: gridTop - 10, r: 3.2, fill: C.text, opacity: 0 }, g));
    await T(1.0, e => lp.forEach((c, i) => {
      const q = Math.min(1, Math.max(0, (e - i * 0.08) / 0.28));
      op(c, q); c.setAttribute("cy", lerp(gridTop - 10, lhs[i].y, q));
    }));
    const labL = text(g, W / 2, gridTop + G + 34, t("rs.mf.lhs"), { class: "t-dark", "text-anchor": "middle", opacity: 0 });
    const labCover = text(g, W / 2, gridTop + G + 34, t("rs.mf.cover"), { class: "t-dark", "text-anchor": "middle", opacity: 0 });
    await T(0.6, e => op(labL, e));
    // the points flow into a network ball at the centre of the grid
    const bwrap = el("g", { opacity: 0 }, g);
    const ball = netBall(bwrap, gcx, gcy, G * 0.2, rnd);
    op(ball.dots, 1);
    await T(0.6, e => op(bwrap, e));
    await T(0.8, e => lp.forEach((c, i) => { c.setAttribute("cx", lerp(lhs[i].x, gcx, e)); c.setAttribute("cy", lerp(lhs[i].y, gcy, e)); op(c, 1 - e); }));
    // the ball opens out and the heat map fills the grid from the centre
    const cells = [];
    for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
      const x = (c + 0.5) / 10, y = (r + 0.5) / 10;
      cells.push({ r, c, flav: Math.exp(-((x - 0.25) ** 2 + (y - 0.4) ** 2) / 0.18), cost: 1 - x,   // cost falls to the right
        d: Math.hypot(c - 4.5, r - 4.5) / Math.hypot(4.5, 4.5),
        el: el("rect", { x: gx0 + c * cell, y: gridTop + r * cell, width: cell, height: cell, opacity: 0 }, heatG) });
    }
    const WMAX = 3.9;   // total = flavor x exp(-w x cost): the best region moves four cells towards lower cost
    const paint = w => {
      const v = cells.map(q => q.flav * Math.exp(-w * q.cost)), lo = Math.min(...v), hi = Math.max(...v);
      cells.forEach((q, i) => q.el.setAttribute("fill", mix(MS, M, Math.pow((v[i] - lo) / (hi - lo), 1.8))));
      return v;
    };
    paint(0);
    await T(1.0, e => {
      bwrap.setAttribute("transform", `translate(${gcx},${gcy}) scale(${lerp(1, 2.6, e).toFixed(3)}) translate(${-gcx},${-gcy})`);
      op(bwrap, 1 - e);
      cells.forEach(q => op(q.el, Math.min(1, Math.max(0, (e * 1.3 - q.d) / 0.3))));
    });
    // flavor <-> cost weight: from flavor only to flavor with cost
    const tx0 = gx0, tx1 = gx0 + G, ty = 78, pos1 = tx0 + (tx1 - tx0) * 0.6;
    const ind = el("g", { opacity: 0 }, g);
    text(ind, tx0, 62, t("rs.mf.fc"), { class: "t-dark" });
    el("path", { d: `M${tx0},${ty} L${tx1},${ty} M${tx0},${ty - 4} L${tx0},${ty + 4} M${tx1},${ty - 4} L${tx1},${ty + 4}`, fill: "none", stroke: C.line, "stroke-width": 1 }, ind);
    text(ind, tx0, ty + 18, t("rs.mf.flavor_only"), { "text-anchor": "start" });
    const wc = text(ind, pos1, ty + 18, t("rs.mf.with_cost"), { "text-anchor": "middle" });
    wc.setAttribute("x", Math.min(pos1, tx1 - wc.getComputedTextLength() / 2));
    const knob = el("circle", { cx: tx0, cy: ty, r: 5, fill: M }, ind);
    await T(0.6, e => { op(labL, Math.max(0, 1 - 2 * e)); op(labCover, Math.max(0, 2 * e - 1)); });   // out, then in
    await T(0.6, e => op(ind, e));
    // dashed box round the best cells when only flavor counts, and the direction of lower cost
    const top3 = vals => vals.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(b => cells[b[1]]);
    const b0 = top3(paint(0));
    const bx0 = Math.min(...b0.map(q => q.c)), bx1 = Math.max(...b0.map(q => q.c)) + 1, by0 = Math.min(...b0.map(q => q.r)), by1 = Math.max(...b0.map(q => q.r)) + 1;
    const mark = el("g", { opacity: 0 }, g);
    el("rect", { x: gx0 + bx0 * cell - 1.5, y: gridTop + by0 * cell - 1.5, width: (bx1 - bx0) * cell + 3, height: (by1 - by0) * cell + 3,
      fill: "none", stroke: C.text, "stroke-width": 1.4, "stroke-dasharray": "4 3" }, mark);
    text(mark, gx0 + G, gridTop + G + 15, t("rs.mf.lowcost"), { class: "t-m", "text-anchor": "end" });
    await T(0.6, e => op(mark, e));
    let v = null;
    await T(1.0, e => { knob.setAttribute("cx", lerp(tx0, pos1, e)); v = paint(WMAX * e); });
    // tick the best cells
    const best = v.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).slice(0, 3);
    const tk = el("g", { opacity: 0 }, g);
    best.forEach(([, i]) => {
      const q = cells[i], x = gx0 + (q.c + 0.5) * cell, y = gridTop + (q.r + 0.5) * cell, k = cell / 20;
      el("path", { d: `M${x - 5 * k},${y} L${x - 1.5 * k},${y + 3.5 * k} L${x + 5 * k},${y - 3.5 * k}`, fill: "none", stroke: "#fff", "stroke-width": 1.8,
        "stroke-linecap": "round", "stroke-linejoin": "round" }, tk);
    });
    await T(0.6, e => op(tk, e));
  };

  // ---------- player (one per stage) ----------
  // cfg: n steps, buildOverview(S), scenes, accent, hint (rgb of the accent), pos(n), name(n).
  const H_DETAIL = 340;
  function createStage(root, cfg) {
    const S = { cfg, clock: makeClock(), visited: new Set(), cur: 1, OV: null };
    S.ov = root.querySelector(".rs-ov");
    const detail = root.querySelector(".rs-detail");
    const canvas = root.querySelector(".rs-canvas");
    const prevBtn = root.querySelector(".rs-prev"), nextBtn = root.querySelector(".rs-next");
    const pos = root.querySelector(".rs-pos");
    const steps = [...root.querySelectorAll(".rs-step")];
    const sayEl = root.querySelector(".rs-say"), sayList = root.querySelector(".rs-saylist");
    const pauseBtn = root.querySelector(".rs-pause");
    const nSay = n => (cfg.says && cfg.says[n]) || 0;
    root.classList.add("rs-live");
    S.ov.hidden = false; detail.hidden = false;
    root.querySelector(".rs-ctrl").hidden = false;
    STAGES.push(S);

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
    let gen = 0, started = false;
    // explanation lines (PhD steps 1-3). The line keeps the height of the step's tallest line, so the picture
    // does not jump between segments. Under reduced motion they are listed in order below the picture.
    function prepSay(n, inst) {
      const k = nSay(n);
      sayEl.hidden = reduced || !k; sayList.hidden = !reduced || !k;
      sayEl.style.minHeight = ""; sayEl.style.opacity = 0; sayList.textContent = "";
      if (!k) return;
      if (reduced) {
        for (let i = 1; i <= k; i++) setLine(el2("li", sayList), t(cfg.sayKey(n, i)));
        return;
      }
      let h = 0;
      for (let i = 1; i <= k; i++) { setLine(sayEl, t(cfg.sayKey(n, i))); h = Math.max(h, sayEl.offsetHeight); }
      sayEl.style.minHeight = h + "px";
      if (inst) sayEl.style.opacity = 1;   // final state: the last line stays
      else sayEl.textContent = "";
    }
    function el2(tag, parent) { return parent.appendChild(document.createElement(tag)); }
    // write a line, keeping hyphenated names such as GC-O-MS on one line
    function setLine(node, s) {
      node.textContent = "";
      s.split(/(GC-O-MS|GC-MS|GC-O|electronic-nose|24 h|24-h)/).forEach((part, i) => {
        if (!part) return;
        if (i % 2) { const sp = el2("span", node); sp.className = "rs-nw"; sp.textContent = part; }
        else node.appendChild(document.createTextNode(part));
      });
    }
    // The first line appears at once, with the step's opening picture (see openAtOnce): the picture then
    // waits 0.5 s. Later segments: the previous line stays 1.5 s more, fades out; the new one fades in and stays 1.5 s.
    function makeSay(n, T, inst) {
      let shown = false;
      return async function (i) {
        if (inst || !nSay(n)) return;
        if (!shown) { setLine(sayEl, t(cfg.sayKey(n, i))); sayEl.style.opacity = 1; shown = true; return; }
        await T(1.5); await T(0.4, e => { sayEl.style.opacity = 1 - e; });
        setLine(sayEl, t(cfg.sayKey(n, i)));
        await T(0.6, e => { sayEl.style.opacity = e; });
        await T(1.5);
      };
    }
    // Every scene opens by fading in its starting picture (its first tween with a function). That tween runs
    // at once, so the picture is there as soon as the step is chosen; then a 0.5 s pause before anything moves.
    function openAtOnce(T, inst) {
      let first = !inst;
      return function (sec, fn) {
        if (first && fn) { first = false; fn(1); return T(0.5); }
        return T(sec, fn);
      };
    }
    function setPauseLabel() { pauseBtn.textContent = t(S.clock.held ? "rs.resume" : "rs.pause"); }
    // under reduced motion some steps (cfg.tallStatic) show two pictures, one above the other
    function detailSize(n) {
      const W = Math.max(300, canvas.clientWidth);
      const H = reduced && n && cfg.tallStatic && cfg.tallStatic.includes(n) ? 2 * H_DETAIL : H_DETAIL;
      detail.setAttribute("viewBox", "0 0 " + W + " " + H);
      detail.setAttribute("width", W); detail.setAttribute("height", H);
      return W;
    }
    function updateControls() {
      prevBtn.disabled = S.cur <= 1;
      nextBtn.disabled = S.cur >= cfg.n;
      pos.textContent = cfg.pos(S.cur) + " · " + cfg.name(S.cur);
    }
    async function go(n, instant) {
      const my = ++gen;
      S.clock.tweens.length = 0;
      const inst = reduced || !!instant;
      const T = S.clock.tweener(inst);
      const prev = S.cur;
      S.cur = n;
      S.clock.held = false;
      setPauseLabel();
      pauseBtn.disabled = inst;
      updateControls();
      nextBtn.style.boxShadow = "";
      // the new step replaces the previous one at once: its heading, first line and opening picture show
      // straight away, while the overview diagram moves its frame to the new node at the same time
      if (started && prev) stepParts(prev).a.style.opacity = "";
      started = true;
      detail.textContent = "";
      op(detail, 1);
      const W = detailSize(n);
      const g = el("g", {}, detail);
      showText(n, "lede");
      prepSay(n, inst);
      const ovDone = overviewTo(S, n, T, inst);
      const parts = stepParts(n);
      await cfg.scenes[n](g, W, H_DETAIL, openAtOnce(T, inst), reduced, makeSay(n, T, inst));
      await ovDone;
      await T(0.6, e => { parts.cap.style.opacity = e; });
      if (parts.go) await T(0.6, e => { parts.go.style.opacity = e; });
      if (my === gen) pauseBtn.disabled = true;   // nothing left to pause
      S.visited.add(n);   // the tick appears once the visitor moves on to another step
      if (my !== gen || inst || n >= cfg.n) return;
      // one gentle hint on "Next" (no loop)
      await T(1.2, e => { nextBtn.style.boxShadow = "0 0 0 2px rgba(" + cfg.hint + "," + (0.55 * Math.sin(Math.PI * e)).toFixed(3) + ")"; });
      nextBtn.style.boxShadow = "";
    }
    S.userGo = function (n) {
      if (n < 1 || n > cfg.n) return;
      S.clock.paused = false;
      go(n);
    };
    // replay the current step only (hidden under reduced motion, where every picture is already final)
    const replay = root.querySelector(".rs-replay");
    if (reduced) { replay.hidden = true; pauseBtn.hidden = true; }
    pauseBtn.disabled = true;
    setPauseLabel();
    pauseBtn.addEventListener("click", () => { S.clock.held = !S.clock.held; setPauseLabel(); });
    replay.addEventListener("click", () => { S.clock.paused = false; go(S.cur); });
    prevBtn.addEventListener("click", () => S.userGo(S.cur - 1));
    nextBtn.addEventListener("click", () => S.userGo(S.cur + 1));

    function rebuild() {   // new width or language: redraw the current step in its final state
      cfg.buildOverview(S);
      setPauseLabel();
      if (started) go(S.cur, true);
      else { detailSize(); showText(1, "none"); prepSay(1, false); updateControls(); }
    }
    cfg.buildOverview(S);
    detailSize();
    showText(1, "none");
    updateControls();
    prepSay(1, false);   // reserve the line's height before step 1 starts
    if (reduced) go(1, true);

    // play step 1 when this stage first comes into view; pause while it is out of view
    const io = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (en.intersectionRatio >= 0.5) {
          S.clock.paused = false;
          if (!started) go(1);
        } else if (!en.isIntersecting) {
          S.clock.paused = true;
        }
      }
    }, { threshold: [0, 0.5] });
    io.observe(canvas);

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
    return S;
  }

  createStage(document.getElementById("rs-stage"), {
    n: 4, buildOverview, scenes: SCENES, accent: C.hm, hint: "15,110,110",
    says: { 1: 6, 2: 5, 3: 6 }, tallStatic: [3], sayKey: (n, i) => "rs.s" + n + ".say" + i,
    pos: n => t("rs.pos", { n }), name: n => t("rs.s" + n + ".name") });
  createStage(document.getElementById("rs-stage-m"), {
    n: 3, buildOverview: buildOverviewM, scenes: SCENES_M, accent: M, hint: "138,90,43",
    pos: n => t("rs.m.pos", { n }), name: n => t("rs.m" + n + ".name") });
  // research/#master: the diagrams only get their height from the script, so scroll again once drawn
  if (location.hash === "#master") document.getElementById("master").scrollIntoView();
})();
