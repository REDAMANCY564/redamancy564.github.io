/*
 * Odor intensity curves in air (curves.html): search, up to 4 curves on one SVG chart, concentration conversion.
 * Data and formula: assets/intensity.js (Wakayama et al. 2019). No external library, no external request.
 * ?cas=<CAS> opens one compound.
 * The concentration slider (X = log10 concentration, -5 to 5) and the text box stay in step (concentration = 10^X);
 * while it is dragged only the dashed line moves and the conversion table is redrawn, once per animation frame.
 */
(function () {
  const $ = id => document.getElementById(id);
  const I = window.Intensity;
  const t = (k, v) => I18N.t(k, v);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MAX = 4;
  // categorical slots 1-4 of the validated default palette, in fixed order; each curve also has its own dash pattern
  const COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];
  const DASH = ["", "7 4", "2 3", "10 3 2 3"];
  const S = { list: [], conc: "", suggest: [], msg: null };   // list: [{e, slot}]

  const sig = (v, n = 3) => (v >= 1e-3 && v < 1e5 ? Number(v.toPrecision(n)).toString() : v.toExponential(n - 1).replace("e", "e"));
  const fmtX = x => (Math.round(x * 100) / 100).toFixed(2);
  const dispName = e => I.name(e);
  const subName = e => (I18N.lang === "zh" && e.zh ? e.en : "");

  function freeSlot() {
    for (let s = 0; s < MAX; s++) if (!S.list.some(x => x.slot === s)) return s;
    return -1;
  }
  function add(e) {
    if (!e) return;
    if (S.list.some(x => x.e === e)) { S.msg = null; render(); return; }
    const slot = freeSlot();
    if (slot < 0) { S.msg = { key: "curve.full" }; renderStatus(); return; }
    S.list.push({ e, slot });
    S.msg = null;
    $("q").value = "";
    S.suggest = [];
    render();
  }
  function remove(cas) {
    S.list = S.list.filter(x => x.e.cas !== cas);
    render();
  }

  // ---------- search ----------
  function onInput() {
    const q = $("q").value;
    S.suggest = I.search(q, 8);
    S.msg = q.trim() && !S.suggest.length ? { key: "curve.none" } : null;
    renderSuggest(); renderStatus();
  }
  function renderSuggest() {
    $("suggest").innerHTML = S.suggest.map((e, i) =>
      '<button type="button" class="chip-btn" data-pick="' + i + '">' + esc(dispName(e)) +
      (subName(e) ? ' <span class="muted">' + esc(subName(e)) + "</span>" : "") + ' <span class="muted">' + esc(e.cas) + "</span></button>").join("");
  }
  function renderStatus() {
    const m = S.msg;
    $("status").textContent = m ? t(m.key, m.vars) : (S.list.length >= MAX ? t("curve.max") : "");
  }

  // ---------- chart ----------
  function niceTicks(plotW) { const step = plotW >= 300 ? 1 : 2; const a = []; for (let x = I.X_MIN; x <= I.X_MAX; x += step) a.push(x); return a; }
  function spread(items, minGap, top, bottom) {
    // items sorted by y (top to bottom on screen = large to small values); push apart, keep inside [top, bottom]
    items.sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) if (items[i].ly - items[i - 1].ly < minGap) items[i].ly = items[i - 1].ly + minGap;
    const over = items.length ? items[items.length - 1].ly - bottom : 0;
    if (over > 0) {
      items[items.length - 1].ly -= over;
      for (let i = items.length - 2; i >= 0; i--) if (items[i + 1].ly - items[i].ly < minGap) items[i].ly = items[i + 1].ly - minGap;
    }
    items.forEach(it => { it.ly = Math.max(top, it.ly); });
    return items;
  }

  let geo = null;
  function renderChart() {
    const box = $("chart");
    const drawn = S.list.filter(x => !x.e.step);
    if (!S.list.length) { box.innerHTML = '<p class="small muted chart-empty">' + esc(t("curve.empty")) + "</p>"; geo = null; return; }
    const W = Math.max(280, Math.floor(box.clientWidth || 600));
    const H = Math.round(Math.min(420, Math.max(260, W * 0.62)));
    // right margin: room for the longest level label (CJK about 12 px a character, Latin and digits about 6.6 px)
    const textW = s => [...s].reduce((w, ch) => w + (/[⺀-￿]/.test(ch) ? 12 : 6.6), 0);
    const lvW = Math.max(...I.LMS.map(([v, k]) => textW(t("int.lv." + k) + " " + v)));
    const m = { l: 40, r: Math.ceil(lvW) + 16, t: 12, b: 44 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const sx = x => m.l + (x - I.X_MIN) / (I.X_MAX - I.X_MIN) * pw;
    const sy = p => m.t + (1 - p / 100) * ph;
    geo = { W, H, m, pw, ph, sx, sy };
    let s = '<svg id="chart-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' +
      esc(t("curve.chart_aria", { list: S.list.map(x => dispName(x.e)).join(", ") })) + '">';
    // recessive grid at the LMS marks and the axes
    I.LMS.forEach(([v]) => { s += '<line class="grid" x1="' + m.l + '" x2="' + (m.l + pw) + '" y1="' + sy(v) + '" y2="' + sy(v) + '"/>'; });
    s += '<line class="axis" x1="' + m.l + '" x2="' + (m.l + pw) + '" y1="' + sy(0) + '" y2="' + sy(0) + '"/>';
    s += '<line class="axis" x1="' + m.l + '" x2="' + m.l + '" y1="' + m.t + '" y2="' + sy(0) + '"/>';
    niceTicks(pw).forEach(x => {
      s += '<line class="axis" x1="' + sx(x) + '" x2="' + sx(x) + '" y1="' + sy(0) + '" y2="' + (sy(0) + 4) + '"/>' +
        '<text class="tick" x="' + sx(x) + '" y="' + (sy(0) + 16) + '" text-anchor="middle">' + x + "</text>";
    });
    [0, 50, 100].forEach(v => { s += '<text class="tick" x="' + (m.l - 6) + '" y="' + (sy(v) + 4) + '" text-anchor="end">' + v + "</text>"; });
    s += '<text class="axis-title" x="' + (m.l + pw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(t("curve.x_axis")) + "</text>";
    // LMS levels as text marks on the right; labels pushed apart when the marks are close, with a short leader line
    const labels = spread(I.LMS.map(([v, k]) => ({ v, y: sy(v), ly: sy(v), text: t("int.lv." + k) + " " + v })), 13, m.t + 4, sy(0) + 4);
    labels.forEach(L => {
      const x0 = m.l + pw;
      s += '<line class="lead" x1="' + x0 + '" x2="' + (x0 + 6) + '" y1="' + L.y + '" y2="' + L.ly + '"/>' +
        '<text class="lv" x="' + (x0 + 9) + '" y="' + (L.ly + 4) + '">' + esc(L.text) + "</text>";
    });
    // concentration entered: dashed vertical line
    const cx = convX();
    if (cx != null) s += '<line class="conc" x1="' + sx(cx) + '" x2="' + sx(cx) + '" y1="' + m.t + '" y2="' + sy(0) + '"/>';
    // curves (200 points) and threshold points
    drawn.forEach(({ e, slot }) => {
      let d = "";
      for (let i = 0; i <= 200; i++) { const x = I.X_MIN + (I.X_MAX - I.X_MIN) * i / 200; d += (i ? "L" : "M") + sx(x).toFixed(1) + " " + sy(I.psi(e, x)).toFixed(1); }
      s += '<path class="curve" d="' + d + '" stroke="' + COLORS[slot] + '"' + (DASH[slot] ? ' stroke-dasharray="' + DASH[slot] + '"' : "") + "/>";
    });
    drawn.forEach(({ e, slot }) => {
      const tx = I.thresholdX(e);
      if (tx >= I.X_MIN && tx <= I.X_MAX) s += '<circle class="thr" cx="' + sx(tx) + '" cy="' + sy(1.4) + '" r="4.5" stroke="' + COLORS[slot] + '"/>';
    });
    s += '<line id="cross" class="cross" x1="0" x2="0" y1="' + m.t + '" y2="' + sy(0) + '" visibility="hidden"/>';
    s += '<rect id="hit" x="' + m.l + '" y="' + m.t + '" width="' + pw + '" height="' + ph + '" fill="transparent"/>';
    s += "</svg>";
    box.innerHTML = s + '<div id="tip" class="tip" hidden></div>';
    const hit = $("hit");
    hit.addEventListener("pointermove", onHover);
    hit.addEventListener("pointerdown", onHover);
    hit.addEventListener("pointerleave", () => { $("tip").hidden = true; $("cross").setAttribute("visibility", "hidden"); });
  }
  function onHover(ev) {
    if (!geo) return;
    const r = $("chart-svg").getBoundingClientRect();
    const px = ev.clientX - r.left;
    const x = Math.max(I.X_MIN, Math.min(I.X_MAX, I.X_MIN + (px - geo.m.l) / geo.pw * (I.X_MAX - I.X_MIN)));
    const cross = $("cross");
    cross.setAttribute("x1", geo.sx(x)); cross.setAttribute("x2", geo.sx(x)); cross.setAttribute("visibility", "visible");
    const rows = S.list.map(({ e, slot }) => {
      const p = I.psi(e, x);
      return '<div><span class="sw" style="border-color:' + COLORS[slot] + '"></span>' + esc(dispName(e)) + ": <b>" +
        (p == null ? esc(t("curve.step_short")) : (Math.round(p * 10) / 10).toFixed(1)) + "</b></div>";
    }).join("");
    const tip = $("tip");
    tip.innerHTML = "<div>" + esc(t("curve.tip_x", { x: fmtX(x), c: sig(10 ** x) })) + "</div>" + rows;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = geo.sx(x) + 12 + tw > geo.W ? geo.sx(x) - 12 - tw : geo.sx(x) + 12;
    tip.style.left = Math.max(0, left) + "px";
    tip.style.top = geo.m.t + "px";
  }

  // ---------- legend (also the table view of the parameters) ----------
  function renderLegend() {
    $("legend").innerHTML = S.list.map(({ e, slot }) => {
      const tx = I.thresholdX(e);
      const thr = e.step ? t("curve.step") : tx >= I.X_MIN && tx <= I.X_MAX ? t("curve.thr", { v: sig(10 ** tx), x: fmtX(tx) }) : t("curve.thr_out", { v: sig(10 ** tx) });
      const sw = '<svg class="sw-line" width="34" height="10" aria-hidden="true"><line x1="1" x2="33" y1="5" y2="5" stroke="' + COLORS[slot] +
        '" stroke-width="2.5"' + (DASH[slot] ? ' stroke-dasharray="' + DASH[slot] + '"' : "") + "/></svg>";
      return '<li>' + (e.step ? '<span class="sw-gap"></span>' : sw) + "<span><b>" + esc(dispName(e)) + "</b>" +
        (subName(e) ? " " + esc(subName(e)) : "") + ' <span class="muted">CAS <span class="cas-no">' + esc(e.cas) + "</span></span><br>" +
        '<span class="small">' + esc(thr) + "</span>" +
        (e.step ? "" : '<br><span class="small muted">' + esc(t("curve.params", { imax: e.Imax, c: e.C, d: e.D, table: t("curve.table_" + e.table) })) + "</span>") +
        (I.meta.notes && I.meta.notes[e.cas] ? '<br><span class="small muted">' + esc(t("curve.note_" + e.cas.replace(/-/g, "_"))) + "</span>" : "") +
        '</span><button type="button" class="linkbtn" data-remove="' + esc(e.cas) + '" aria-label="' + esc(t("curve.remove", { name: dispName(e) })) + '">' +
        esc(t("curve.remove_short")) + "</button></li>";
    }).join("");
    // copy button after each CAS number (assets/i18n.js); on failure the number is selected
    $("legend").querySelectorAll(".cas-no").forEach(n =>
      n.parentElement.after(UI.copyButton({ text: n.textContent, label: "copy.cas", select: n })));
  }

  // ---------- conversion ----------
  function convX() {
    const c = Number(String(S.conc).trim().replace(/,/g, ""));
    if (!(c > 0)) return null;
    const x = Math.log10(c);
    return x >= I.X_MIN && x <= I.X_MAX ? x : null;
  }
  function renderConv() {
    const raw = String(S.conc).trim();
    const out = $("conv-out");
    if (!raw) { out.innerHTML = ""; return; }
    if (!S.list.length) { out.innerHTML = '<p class="small muted">' + esc(t("curve.conv_none")) + "</p>"; return; }
    const first = I.convert(S.list[0].e, raw);
    if (first.error === "invalid") { out.innerHTML = '<p class="small error-text">' + esc(t("curve.invalid")) + "</p>"; return; }
    let h = "";
    const x = Math.log10(Number(raw.replace(/,/g, "")));
    h += '<p class="small">' + esc(t("curve.conv_x", { x: fmtX(x) })) + "</p>";
    if (x < I.X_MIN || x > I.X_MAX) { out.innerHTML = h + '<p class="warn-text">' + esc(t("curve.range")) + "</p>"; return; }
    h += '<div class="table-wrap"><table class="conv"><thead><tr><th>' + esc(t("curve.col.name")) + "</th><th>" + esc(t("curve.col.psi")) + "</th><th>" +
      esc(t("curve.col.level")) + "</th></tr></thead><tbody>";
    S.list.forEach(({ e }) => {
      const r = I.convert(e, raw);
      h += "<tr><td>" + esc(dispName(e)) + "</td>" + (r.error === "step"
        ? '<td colspan="2" class="muted">' + esc(t("curve.step")) + "</td>"
        : "<td><b>" + (Math.round(r.psi * 10) / 10).toFixed(1) + "</b></td><td>" + esc(I.levelText(r.level)) + "</td>") + "</tr>";
    });
    out.innerHTML = h + "</tbody></table></div>";
  }

  // ---------- concentration slider ----------
  const slider = $("conc-x"), sliderBox = $("conc-slider"), bubble = $("conc-bubble");
  let dragging = false, frame = 0;
  function sliderText(x) { return t("curve.slider_value", { x: fmtX(x), c: sig(10 ** x) }); }
  // from the text box (and after a compound is added or removed): position, state and spoken value
  function syncSlider() {
    const c = Number(String(S.conc).trim().replace(/,/g, ""));
    if (c > 0) slider.value = String(Math.max(I.X_MIN, Math.min(I.X_MAX, Math.log10(c))));
    slider.disabled = !S.list.length || $("conc").disabled;   // like the chart, it needs a compound
    if (slider.disabled) setActive(false);
    slider.setAttribute("aria-valuetext", sliderText(+slider.value));
  }
  function placeBubble() {
    const x = +slider.value;
    bubble.textContent = sliderText(x);
    const w = slider.clientWidth, thumb = 18, bw = bubble.offsetWidth;
    const at = thumb / 2 + (x - I.X_MIN) / (I.X_MAX - I.X_MIN) * (w - thumb);
    bubble.style.transform = "translateX(" + Math.round(Math.max(0, Math.min(w - bw, at - bw / 2))) + "px)";
  }
  function setActive(on) {
    sliderBox.classList.toggle("active", on);
    if (on) placeBubble();
  }
  // move only the dashed line of the drawn chart (the curves stay as they are)
  function moveConcLine() {
    const svg = $("chart-svg");
    if (!svg || !geo) return;
    let line = svg.querySelector("line.conc");
    const cx = convX();
    if (cx == null) { if (line) line.remove(); return; }
    if (!line) {
      line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "conc");
      line.setAttribute("y1", geo.m.t); line.setAttribute("y2", geo.sy(0));
      svg.insertBefore(line, svg.querySelector("path.curve, circle.thr, #cross"));
    }
    line.setAttribute("x1", geo.sx(cx)); line.setAttribute("x2", geo.sx(cx));
  }
  function fromSlider() {
    frame = 0;
    const x = +slider.value;
    S.conc = sig(10 ** x);
    $("conc").value = S.conc;
    slider.setAttribute("aria-valuetext", sliderText(x));
    moveConcLine();
    renderConv();
    if (sliderBox.classList.contains("active")) placeBubble();
  }
  slider.addEventListener("input", () => { if (!frame) frame = requestAnimationFrame(fromSlider); });
  slider.addEventListener("pointerdown", () => { dragging = true; setActive(true); });
  const endDrag = () => { if (!dragging) return; dragging = false; setActive(slider.matches(":focus-visible")); };
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  slider.addEventListener("focus", () => { if (slider.matches(":focus-visible")) setActive(true); });   // keyboard: arrows move it
  slider.addEventListener("blur", () => { if (!dragging) setActive(false); });

  function render() {
    renderSuggest(); renderStatus(); renderChart(); renderLegend(); renderConv(); syncSlider();
  }

  // ---------- events ----------
  $("q").addEventListener("input", onInput);
  $("q").addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); if (S.suggest.length) add(S.suggest[0]); } });
  $("suggest").addEventListener("click", ev => { const b = ev.target.closest("[data-pick]"); if (b) add(S.suggest[+b.dataset.pick]); });
  $("legend").addEventListener("click", ev => { const b = ev.target.closest("[data-remove]"); if (b) remove(b.dataset.remove); });
  $("conc").addEventListener("input", () => { S.conc = $("conc").value; renderConv(); renderChart(); syncSlider(); });
  let rz = 0;
  window.addEventListener("resize", () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(renderChart); });

  I18N.ready.then(() => I.load()).then(() => {
    $("load-status").textContent = "";
    $("q").disabled = false; $("conc").disabled = false;
    let cas = null;
    try { cas = new URLSearchParams(location.search).get("cas"); } catch (e) { /* ignore */ }
    if (cas) {
      const e = I.entry(cas);
      if (e) add(e); else S.msg = { key: "curve.cas_none", vars: { cas } };
    }
    render();
    I18N.onChange(render);
  }, () => { $("load-status").textContent = t("curve.load_failed"); $("load-status").classList.add("error-text"); });
})();
