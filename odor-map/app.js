/*
 * odor-map page (PLAN-odor-map.md, stages 3 and 4).
 * Library, names, groups and predicted probabilities: ../ingredient-finder/data/ (same library).
 * Coordinates, region labels, parameters and evaluation: data/ (training/odormap/make_site_data.py).
 * Foods for highlighting: data/foods.json, loaded on first use (flavor knowledge base: Dunkel 2014 key
 * odorants, FlavorDB detected compounds).
 * Drawing: Canvas 2D; pan and zoom: d3-zoom; hover lookup: d3-quadtree; structures: RDKit.js, loaded
 * when the first detail card opens.
 */
(async function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const VERSION = new URL(document.currentScript.src).search;
  const FINDER = "../ingredient-finder/data/";
  const PAD = 18, SWITCH_MS = 900, HOVER_PX = 6;
  const QUICK_HEAT = ["milky", "creamy", "buttery", "cheesy", "caramellic", "coffee", "roasted"];
  // colour categories in map.json order (most frequent top-1 descriptors), then "other"
  const PALETTE = ["#e8590c", "#d6336c", "#37b24d", "#6f4518", "#f59f00", "#7048e8", "#1c7ed6", "#b08968", "#15aabf", "#a61e4d"];
  const OTHER = "#adb5bd";
  const HEAT = ["#dee2e6", "#ffe8cc", "#ffa94d", "#e8590c", "#a61e1e", "#4a0b0b"];
  const HEAT_BINS = 24;
  const FOOD_COLOURS = ["#1864ab", "#c2255c"];   // food A, food B
  const RDKIT_JS = "https://cdn.jsdelivr.net/npm/@rdkit/rdkit@2026.3.6/dist/RDKit_minimal.js";
  const RDKIT_WASM = "https://cdn.jsdelivr.net/npm/@rdkit/rdkit@2026.3.6/dist/RDKit_minimal.wasm";
  const TOP_BARS = 8, FOOD_CHIPS = 30;

  let lib, probs, coords, meta;
  try {
    const get = (url, kind) => fetch(url + VERSION).then(r => {
      if (!r.ok) throw new Error("Failed to load " + url);
      return kind === "json" ? r.json() : r.arrayBuffer();
    });
    [lib, probs, coords, meta] = await Promise.all([
      get(FINDER + "library.json", "json"), get(FINDER + "probs.bin"), get("data/coords.bin"), get("data/map.json", "json"), I18N.ready]);
  } catch (e) {
    console.error(e);
    $("load-status").textContent = I18N.t("load_error");
    return;
  }
  const n = lib.molecules.length, L = lib.labels.length;
  probs = new Uint8Array(probs);
  coords = new Uint16Array(coords);
  if (probs.length !== n * L || coords.length !== 4 * n || meta.n !== n) {
    $("load-status").textContent = I18N.t("load_error");
    return;
  }
  $("load-status").classList.add("hidden");

  const labelIndex = Object.fromEntries(lib.labels.map((l, j) => [l.id, j]));
  const labelName = j => I18N.pick(lib.labels[j]);
  const MAPS = meta.maps;                                   // ["odor", "structure"]
  const pos = MAPS.map((_, m) => {                          // data space [0, 1] x [0, 1]
    const a = new Float32Array(2 * n);
    for (let k = 0; k < 2 * n; k++) a[k] = coords[m * 2 * n + k] / 65535;
    return a;
  });
  const cur = Float32Array.from(pos[0]);
  const allIdx = Array.from({ length: n }, (_, i) => i);

  // top-1 descriptor and colour category of each molecule
  const top1 = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let b = 0;
    for (let j = 1; j < L; j++) if (probs[i * L + j] > probs[i * L + b]) b = j;
    top1[i] = b;
  }
  const catOfLabel = new Map(meta.colours.map((id, c) => [labelIndex[id], c]));
  const cat = Int8Array.from(top1, j => catOfLabel.has(j) ? catOfLabel.get(j) : -1);
  const nCat = meta.colours.length;
  const catMembers = Array.from({ length: nCat + 1 }, () => []);  // last = other
  for (let i = 0; i < n; i++) catMembers[cat[i] < 0 ? nCat : cat[i]].push(i);

  function topLabels(i, k) {
    const row = [];
    for (let j = 0; j < L; j++) row.push([j, probs[i * L + j] / 255]);
    return row.sort((a, b) => b[1] - a[1]).slice(0, k);
  }

  // ---------- State ----------
  const S = { map: 0, colour: "top1", isolate: null, showRegions: true, hover: -1, pinned: -1, anim: null,
              selected: -1, foods: [null, null] };
  const usp = new URLSearchParams(location.search);
  if (usp.get("map") === "structure") { S.map = 1; cur.set(pos[1]); }
  if (usp.get("colour") && labelIndex[usp.get("colour")] != null) S.colour = usp.get("colour");

  // ---------- Canvas, zoom ----------
  const canvas = $("map"), ctx = canvas.getContext("2d"), wrap = $("map-wrap");
  let W = 0, H = 0, dpr = 1, tr = d3.zoomIdentity, raf = 0;
  const zoom = d3.zoom().scaleExtent([1, 40]).on("zoom", e => { tr = e.transform; hideTip(); request(); });
  const sel = d3.select(canvas).call(zoom);

  function base() {
    const size = Math.min(W, H) - 2 * PAD;
    return { size, ox: (W - size) / 2, oy: (H - size) / 2 };
  }
  const toScreen = (b, x, y) => [tr.x + tr.k * (b.ox + x * b.size), tr.y + tr.k * (b.oy + y * b.size)];

  function resize() {
    const r = wrap.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    zoom.extent([[0, 0], [W, H]]).translateExtent([[0, 0], [W, H]]);
    request();
  }
  new ResizeObserver(resize).observe(wrap);

  function request() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

  // heat mode: molecules in colour bins of probability, scaled to the largest probability of that
  // descriptor on the map (the legend shows the real range); high values are drawn last
  const heatCache = new Map();
  const heatColour = d3.interpolateRgbBasis(HEAT);
  function heatBins(j) {
    if (heatCache.has(j)) return heatCache.get(j);
    let max = 1;
    for (let i = 0; i < n; i++) max = Math.max(max, probs[i * L + j]);
    const bins = Array.from({ length: HEAT_BINS }, () => []);
    for (let i = 0; i < n; i++) bins[Math.min(HEAT_BINS - 1, Math.floor(probs[i * L + j] / max * HEAT_BINS))].push(i);
    bins.max = max / 255;
    heatCache.set(j, bins);
    return bins;
  }

  function drawSet(members, colour, alpha, b, r) {
    if (!members.length) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour;
    ctx.beginPath();
    for (const i of members) {
      const x = tr.x + tr.k * (b.ox + cur[2 * i] * b.size), y = tr.y + tr.k * (b.oy + cur[2 * i + 1] * b.size);
      if (x < -r || y < -r || x > W + r || y > H + r) continue;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, 2 * Math.PI);
    }
    ctx.fill();
  }

  function draw() {
    const b = base();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const r = Math.min(6, 2.3 * Math.pow(tr.k, 0.35));
    const foodsOn = S.foods.filter(Boolean);
    if (foodsOn.length) {
      drawSet(allIdx, OTHER, 0.35, b, r);
      S.foods.forEach((f, k) => { if (f) drawSet(f.det, FOOD_COLOURS[k], 0.9, b, r * 1.25); });
      S.foods.forEach((f, k) => {
        if (!f || !f.key.length) return;
        drawSet(f.key, FOOD_COLOURS[k], 1, b, r * 2.6);
        ringSet(f.key, "#1f2328", 1.5, b, r * 2.6);
      });
    } else if (S.colour === "top1") {
      const iso = S.isolate;
      drawSet(catMembers[nCat], OTHER, iso == null ? 0.55 : (iso === nCat ? 0.9 : 0.12), b, r);
      for (let c = 0; c < nCat; c++) if (c !== iso) drawSet(catMembers[c], PALETTE[c], iso == null ? 0.82 : 0.12, b, r);
      if (iso != null && iso < nCat) drawSet(catMembers[iso], PALETTE[iso], 0.95, b, r);
    } else {
      heatBins(labelIndex[S.colour]).forEach((m, k) => drawSet(m, heatColour((k + 0.5) / HEAT_BINS), 0.9, b, r));
    }
    ctx.globalAlpha = 1;
    if (S.showRegions) drawRegions(b);
    if (S.selected >= 0) {
      const [x, y] = toScreen(b, cur[2 * S.selected], cur[2 * S.selected + 1]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#e03131";
      ctx.stroke();
    }
    const h = S.pinned >= 0 ? S.pinned : S.hover;
    if (h >= 0) {
      const [x, y] = toScreen(b, cur[2 * h], cur[2 * h + 1]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#1f2328";
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
      ctx.stroke();
    }
  }

  function ringSet(members, colour, width, b, r) {
    ctx.lineWidth = width;
    ctx.strokeStyle = colour;
    ctx.beginPath();
    for (const i of members) {
      const x = tr.x + tr.k * (b.ox + cur[2 * i] * b.size), y = tr.y + tr.k * (b.oy + cur[2 * i + 1] * b.size);
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, 2 * Math.PI);
    }
    ctx.stroke();
  }

  // region labels: larger regions first; smaller ones appear when zoomed in; no overlaps
  function drawRegions(b) {
    let alpha = 1, m = S.map;
    if (S.anim) {
      const t = S.anim.t;
      m = t < 0.5 ? S.anim.from : S.anim.to;
      alpha = Math.abs(1 - 2 * t);
    }
    const minN = tr.k < 1.5 ? 120 : tr.k < 3 ? 60 : 0;
    const boxes = [];
    ctx.font = "700 13px system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.globalAlpha = alpha;
    for (const reg of meta.regions[MAPS[m]]) {
      if (reg.n < minN) continue;
      const [x, y] = toScreen(b, reg.x, reg.y);
      const text = I18N.t("region.name", { label: labelName(labelIndex[reg.label]) });
      const w = ctx.measureText(text).width + 8, hgt = 20;
      const box = [x - w / 2, y - hgt / 2, x + w / 2, y + hgt / 2];
      if (box[2] < 0 || box[3] < 0 || box[0] > W || box[1] > H) continue;
      if (boxes.some(o => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
      boxes.push(box);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(255, 255, 255, .92)";
      ctx.strokeText(text, x, y);
      ctx.fillStyle = "#1f2328";
      ctx.fillText(text, x, y);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- Hover ----------
  let qt = null;
  function buildQuadtree() {
    qt = d3.quadtree().x(i => cur[2 * i]).y(i => cur[2 * i + 1]).addAll(Array.from({ length: n }, (_, i) => i));
  }
  buildQuadtree();

  function pick(px, py) {
    if (!qt || S.anim) return -1;
    const b = base();
    const x = ((px - tr.x) / tr.k - b.ox) / b.size, y = ((py - tr.y) / tr.k - b.oy) / b.size;
    const i = qt.find(x, y, (HOVER_PX + 3) / (tr.k * b.size));
    return i == null ? -1 : i;
  }

  const tip = $("tip");
  function showTip(i, px, py) {
    const m = lib.molecules[i];
    tip.innerHTML = "<b>" + esc(m[1] || m[0]) + "</b>" +
      topLabels(i, 3).map(([j, p]) => esc(labelName(j)) + " " + Math.round(100 * p) + "%").join(" · ") +
      '<div class="muted">' + esc(I18N.t(m[2] === 0 ? "g.train" : "g.unseen")) + "</div>";
    tip.classList.remove("hidden");
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(4, Math.min(W - tw - 4, px + 12)) + "px";
    tip.style.top = (py + 14 + th > H ? Math.max(4, py - th - 10) : py + 14) + "px";
  }
  function hideTip() {
    if (S.hover < 0 && S.pinned < 0) return;
    S.hover = -1;
    S.pinned = -1;
    tip.classList.add("hidden");
    request();
  }

  canvas.addEventListener("pointermove", e => {
    if (e.pointerType !== "mouse" || e.buttons) return;
    const i = pick(e.offsetX, e.offsetY);
    if (i === S.hover) return;
    S.hover = i;
    if (S.pinned < 0) {
      if (i >= 0) showTip(i, e.offsetX, e.offsetY); else tip.classList.add("hidden");
    }
    request();
  });
  canvas.addEventListener("pointerleave", () => { if (S.pinned < 0) hideTip(); });
  // tap or click: open the detail card; touch screens have no hover, so the tooltip stays open
  canvas.addEventListener("click", e => {
    const i = pick(e.offsetX, e.offsetY);
    if (e.pointerType === "touch" || (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents)) {
      S.pinned = i;
      if (i >= 0) showTip(i, e.offsetX, e.offsetY); else tip.classList.add("hidden");
    }
    if (i >= 0) openCard(i);
    request();
  });

  // ---------- Map switching ----------
  function switchMap(m) {
    if (m === S.map && !S.anim) return;
    hideTip();
    const from = Float32Array.from(cur), to = pos[m];
    const fromMap = S.map;
    S.map = m;
    renderControls();
    const start = performance.now();
    const ease = d3.easeCubicInOut;
    S.anim = { from: fromMap, to: m, t: 0 };
    qt = null;
    const step = () => {
      const t = Math.min(1, Math.max(0, (performance.now() - start) / SWITCH_MS)), e = ease(t);
      for (let k = 0; k < 2 * n; k++) cur[k] = from[k] + (to[k] - from[k]) * e;
      S.anim.t = t;
      draw();
      if (t < 1) requestAnimationFrame(step);
      else { S.anim = null; buildQuadtree(); draw(); }
    };
    requestAnimationFrame(step);
  }
  $("btn-odor").addEventListener("click", () => switchMap(0));
  $("btn-structure").addEventListener("click", () => switchMap(1));
  $("zoom-in").addEventListener("click", () => sel.transition().duration(250).call(zoom.scaleBy, 1.6));
  $("zoom-out").addEventListener("click", () => sel.transition().duration(250).call(zoom.scaleBy, 1 / 1.6));
  $("zoom-reset").addEventListener("click", () => sel.transition().duration(350).call(zoom.transform, d3.zoomIdentity));

  // ---------- Colour controls, legend ----------
  function setColour(c) {
    S.colour = c;
    S.isolate = null;
    S.foods = [null, null];          // a colour choice ends the food highlight
    renderFoodSelects();
    renderFoodNote();
    renderControls();
    request();
  }
  $("colour-by").addEventListener("change", e => setColour(e.target.value));
  $("quick-heat").addEventListener("click", e => {
    const b = e.target.closest("[data-heat]");
    if (b) setColour(S.colour === b.dataset.heat ? "top1" : b.dataset.heat);
  });
  $("legend").addEventListener("click", e => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    S.isolate = S.isolate === +b.dataset.cat ? null : +b.dataset.cat;
    renderLegend();
    request();
  });
  $("show-regions").addEventListener("change", e => { S.showRegions = e.target.checked; request(); });

  function renderLegend() {
    const top = S.colour === "top1", foodMode = S.foods.some(Boolean);
    $("legend").classList.toggle("hidden", !top || foodMode);
    $("heat-legend").classList.toggle("hidden", top || foodMode);
    if (top) {
      $("legend").innerHTML = catMembers.map((mem, c) => {
        const name = c < nCat ? labelName(labelIndex[meta.colours[c]]) : I18N.t("legend.other");
        const cls = S.isolate == null ? "" : S.isolate === c ? "on" : "off";
        return '<button type="button" data-cat="' + c + '" class="' + cls + '" aria-pressed="' + (S.isolate === c) + '"><i style="background:' +
          (c < nCat ? PALETTE[c] : OTHER) + '"></i>' + esc(name) + ' <span class="muted">' + mem.length + "</span></button>";
      }).join("");
    } else {
      $("heat-title").textContent = I18N.t("legend.heat", { label: labelName(labelIndex[S.colour]) });
      $("heat-bar").style.background = "linear-gradient(to right, " + HEAT.join(", ") + ")";
      const max = heatBins(labelIndex[S.colour]).max;
      $("heat-scale").innerHTML = "<span>0%</span><span>" + Math.round(50 * max) + "%</span><span>" + Math.round(100 * max) + "%</span>";
      $("heat-note").textContent = I18N.t("legend.heat_note", { max: Math.round(100 * max) + "%" });
    }
  }

  function renderControls() {
    $("btn-odor").setAttribute("aria-pressed", String(S.map === 0));
    $("btn-structure").setAttribute("aria-pressed", String(S.map === 1));
    $("map-name").textContent = I18N.t("ctl." + MAPS[S.map]);
    const opts = lib.labels.map((l, j) => j).sort((a, b) => labelName(a).localeCompare(labelName(b), I18N.lang === "zh" ? "zh" : "en"));
    $("colour-by").innerHTML = '<option value="top1">' + esc(I18N.t("ctl.colour_top1")) + '</option><optgroup label="' + esc(I18N.t("ctl.colour_heat")) + '">' +
      opts.map(j => '<option value="' + esc(lib.labels[j].id) + '">' + esc(labelName(j)) + "</option>").join("") + "</optgroup>";
    $("colour-by").value = S.colour;
    $("quick-heat").querySelectorAll("button").forEach(b => b.remove());
    QUICK_HEAT.filter(id => labelIndex[id] != null).forEach(id => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip-btn" + (S.colour === id ? " on" : "");
      b.dataset.heat = id;
      b.setAttribute("aria-pressed", String(S.colour === id));
      b.textContent = labelName(labelIndex[id]);
      $("quick-heat").appendChild(b);
    });
    renderLegend();
  }

  // ---------- Detail card ----------
  let rdkitPromise = null;
  function getRdkit() {
    if (!rdkitPromise) {
      rdkitPromise = new Promise((resolve, reject) => {
        const sc = document.createElement("script");
        sc.src = RDKIT_JS;
        sc.onload = () => initRDKitModule({ locateFile: () => RDKIT_WASM }).then(resolve, reject);
        sc.onerror = () => reject(new Error("RDKit script not loaded"));
        document.head.appendChild(sc);
      });
      rdkitPromise.catch(err => { console.error(err); });
    }
    return rdkitPromise;
  }
  const svgCache = new Map();
  function drawStructure(el, smiles) {
    if (svgCache.has(smiles)) { el.innerHTML = svgCache.get(smiles); return; }
    el.textContent = I18N.t("card.drawing");
    getRdkit().then(rd => {
      if (el.dataset.smiles !== smiles) return;
      let svg = null;
      const mol = rd.get_mol(smiles);
      if (mol) {
        try { svg = mol.get_svg_with_highlights(JSON.stringify({ width: 260, height: 200, bondLineWidth: 1.5, clearBackground: false, addStereoAnnotation: false })); }
        finally { mol.delete(); }
      }
      if (svg) svgCache.set(smiles, svg);
      el.innerHTML = svg || esc(I18N.t("card.no_draw"));
    }, () => { el.textContent = I18N.t("card.no_draw"); });
  }

  function openCard(i) {
    S.selected = i;
    renderCard();
    request();
  }
  function renderCard() {
    const box = $("detail");
    const i = S.selected;
    if (i < 0) { box.innerHTML = ""; return; }
    const m = lib.molecules[i];
    const smiles = m[0], kb = m[3];
    const tops = topLabels(i, TOP_BARS);
    const foods = m[4].map(k => lib.foods[k]);
    const enc = encodeURIComponent(smiles);
    box.innerHTML = '<div class="card det-card"><button type="button" class="close" id="card-close" aria-label="' + esc(I18N.t("card.close")) + '">×</button>' +
      '<div class="det"><div class="svg" id="card-svg" data-smiles="' + esc(smiles) + '"></div><div>' +
      "<h3>" + esc(m[1] || smiles) + "</h3>" + '<p class="smi mono">' + esc(smiles) + "</p>" +
      '<p class="small muted" style="margin:0">' + esc(I18N.t(m[2] === 0 ? "card.train_help" : "card.unseen_help")) + "</p>" +
      '<p class="small" style="margin:10px 0 0"><b>' + esc(I18N.t("card.profile")) + "</b></p>" +
      '<div class="bars">' + tops.map(([j, p]) => "<span>" + esc(labelName(j)) + '</span><span><span class="bar" style="display:block;width:' +
        Math.max(1, Math.round(100 * p)) + '%"></span></span><span class="v">' + Math.round(100 * p) + "%</span>").join("") + "</div>" +
      '<p class="small" style="margin:0">' + (foods.length ? esc(I18N.t("card.foods", { n: foods.length })) + esc(foods.slice(0, 6).join(", ")) + (foods.length > 6 ? " …" : "")
        : '<span class="muted">' + esc(I18N.t("card.no_foods")) + "</span>") + "</p>" +
      '<div class="links">' +
      '<a href="../odor-predictor/?q=' + enc + '">' + esc(I18N.t("card.to_predictor")) + "</a>" +
      '<a href="../ingredient-finder/?mode=b&amp;smiles=' + enc + '">' + esc(I18N.t("card.to_finder")) + "</a>" +
      (kb ? '<a href="../flavor-kb/?compound=' + encodeURIComponent(kb) + '">' + esc(I18N.t("card.to_kb")) + "</a>"
        : "<span>" + esc(I18N.t("card.no_kb")) + "</span>") +
      "</div></div></div></div>";
    $("card-close").addEventListener("click", () => { S.selected = -1; renderCard(); request(); });
    drawStructure($("card-svg"), smiles);
  }

  // centre the map on molecule i (zooming in if needed), then open its card
  function focus(i) {
    const b = base(), k = Math.max(tr.k, 5);
    const bx = b.ox + cur[2 * i] * b.size, by = b.oy + cur[2 * i + 1] * b.size;
    sel.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(W / 2 - k * bx, H / 2 - k * by).scale(k));
    openCard(i);
  }

  // ---------- Search ----------
  const nameIndex = lib.molecules.map((m, i) => ({ i, name: (m[1] || "").toLowerCase(), smiles: m[0] }));
  const F = { list: [], active: -1 };
  function suggest() {
    const raw = $("search").value.trim(), q = raw.toLowerCase();
    F.list = q.length < 2 ? [] : nameIndex.filter(x => x.name.includes(q) || x.smiles === raw)
      .sort((a, b) => (b.name.startsWith(q) - a.name.startsWith(q)) || a.name.length - b.name.length).slice(0, 8);
    F.active = -1;
    renderSuggest();
  }
  function renderSuggest() {
    const box = $("suggest");
    box.classList.toggle("hidden", !F.list.length);
    $("search").setAttribute("aria-expanded", String(!!F.list.length));
    box.innerHTML = F.list.map((x, k) => '<button type="button" role="option" data-pick="' + x.i + '" class="' + (k === F.active ? "active" : "") + '">' +
      esc(lib.molecules[x.i][1] || x.smiles) + '<span class="smi mono">' + esc(x.smiles) + "</span></button>").join("");
  }
  function choose(i) {
    $("search").value = lib.molecules[i][1] || lib.molecules[i][0];
    F.list = [];
    renderSuggest();
    focus(i);
  }
  $("search").addEventListener("input", suggest);
  $("search").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!F.list.length) suggest();
      if (F.list.length) choose(F.list[Math.max(0, F.active)].i);
      else if ($("search").value.trim()) $("suggest").classList.add("hidden");
      return;
    }
    if (!F.list.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      F.active = (F.active + (e.key === "ArrowDown" ? 1 : -1) + F.list.length) % F.list.length;
      renderSuggest();
    } else if (e.key === "Escape") { F.list = []; renderSuggest(); }
  });
  $("suggest").addEventListener("click", e => {
    const b = e.target.closest("[data-pick]");
    if (b) choose(+b.dataset.pick);
  });
  document.addEventListener("click", e => { if (!e.target.closest(".find .box")) { F.list = []; renderSuggest(); } });

  // ---------- Food highlight ----------
  let foods = null, foodsPromise = null;
  function loadFoods() {
    if (!foodsPromise) {
      foodsPromise = fetch("data/foods.json" + VERSION).then(r => {
        if (!r.ok) throw new Error("Failed to load foods.json");
        return r.json();
      }).then(f => { foods = f; renderFoodSelects(); return f; });
      foodsPromise.catch(err => { console.error(err); foodsPromise = null; });
    }
    return foodsPromise;
  }
  function renderFoodSelects() {
    ["a", "b"].forEach((slot, k) => {
      const el = $("food-" + slot), cur = S.foods[k] ? S.foods[k].id : "";
      const none = '<option value="">' + esc(I18N.t(k ? "find.food_none_b" : "find.food_none")) + "</option>";
      if (!foods) { el.innerHTML = none + '<option value="" disabled>' + esc(I18N.t("find.food_loading")) + "</option>"; return; }
      const opt = f => '<option value="' + esc(f.id) + '">' + esc(f.name) + " (" + (f.key.length + f.det.length) + ")</option>";
      el.innerHTML = none + '<optgroup label="' + esc(I18N.t("find.group_key")) + '">' + foods.filter(f => f.src === "dunkel").map(opt).join("") + "</optgroup>" +
        '<optgroup label="' + esc(I18N.t("find.group_det")) + '">' + foods.filter(f => f.src !== "dunkel").map(opt).join("") + "</optgroup>";
      el.value = cur;
      $("food-" + slot + "-dot").style.background = S.foods[k] ? FOOD_COLOURS[k] : "transparent";
    });
  }
  ["a", "b"].forEach((slot, k) => {
    const el = $("food-" + slot);
    el.addEventListener("focus", loadFoods);
    el.addEventListener("pointerdown", loadFoods);
    el.addEventListener("change", () => {
      S.foods[k] = (foods || []).find(f => f.id === el.value) || null;
      renderFoodSelects();
      renderFoodNote();
      request();
    });
  });

  function renderFoodNote() {
    const box = $("food-note");
    const on = S.foods.map((f, k) => [f, k]).filter(([f]) => f);
    box.classList.toggle("hidden", !on.length);
    $("legend").classList.toggle("hidden", !!on.length || S.colour !== "top1");
    $("heat-legend").classList.toggle("hidden", !!on.length || S.colour === "top1");
    if (!on.length) { box.innerHTML = ""; return; }
    box.innerHTML = on.map(([f, k]) => {
      const dunkel = f.src === "dunkel";
      const ids = f.key.concat(f.det);
      const head = dunkel ? I18N.t("food.key_note", { food: f.name, n: f.key.length, m: f.n_kb })
        : I18N.t("food.det_note", { food: f.name, n: f.det.length, m: f.n_kb });
      return '<div style="margin-top:8px"><b style="color:' + FOOD_COLOURS[k] + '">● </b>' + esc(head) +
        ' <a href="../flavor-kb/?food=' + encodeURIComponent(f.id) + '">' + esc(I18N.t("food.to_kb")) + "</a>" +
        '<span class="ex-list">' + ids.slice(0, FOOD_CHIPS).map(i => '<button type="button" data-mol="' + i + '" class="linklike' + (f.key.includes(i) ? " key" : "") + '">' +
          esc(lib.molecules[i][1] || lib.molecules[i][0]) + "</button>").join("") + "</span>" +
        (ids.length > FOOD_CHIPS ? ' <span class="muted">' + esc(I18N.t("food.more", { n: ids.length - FOOD_CHIPS })) + "</span>" : "") + "</div>";
    }).join("") + '<p class="muted" style="margin:8px 0 0">' + esc(I18N.t("food.legend")) + "</p>";
  }
  $("food-note").addEventListener("click", e => {
    const b = e.target.closest("[data-mol]");
    if (b) focus(+b.dataset.mol);
  });

  // ---------- Subtitle ----------
  function renderText() {
    $("hero-sub").textContent = I18N.t("hero.sub", { n: n.toLocaleString(I18N.lang === "zh" ? "zh-CN" : "en") });
  }

  function renderAll() { renderControls(); renderText(); renderFoodSelects(); renderFoodNote(); renderCard(); request(); }
  I18N.onChange(renderAll);
  renderAll();
  resize();

  // deep links: ?smiles=<library SMILES> opens that molecule; ?food=<kb food id>[&food2=...] highlights foods
  const linkSmiles = usp.get("smiles");
  if (linkSmiles) {
    const hit = nameIndex.find(x => x.smiles === linkSmiles);
    if (hit) requestAnimationFrame(() => focus(hit.i));
  }
  // the food list is not needed for the first view: fetch it once the page is idle
  setTimeout(() => { loadFoods().catch(() => {}); }, 2500);
  if (usp.get("food") || usp.get("food2")) {
    loadFoods().then(() => {
      [usp.get("food"), usp.get("food2")].forEach((id, k) => { S.foods[k] = foods.find(f => f.id === id) || null; });
      renderFoodSelects();
      renderFoodNote();
      request();
    }, () => {});
  }
})();
