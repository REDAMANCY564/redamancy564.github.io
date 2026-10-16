/*
 * Flavor improver page.
 * - Default thresholds: plays the precomputed Bayesian optimization run in data/bo_traces.json
 *   (Python/botorch, training/flavor_improver/), with the mean random-search curve for comparison.
 * - Visitors can edit any odor threshold. Profiles are then recomputed with mixture.js (checked
 *   against Python by tests/parity.html) and the precomputed run no longer applies; instead the
 *   visitor can re-run a simplified optimization in the browser (bo.js) plus a random search.
 */
(async function () {
  const ACCENT = "#0f6e6e";
  const ACCENT_FILL = "rgba(15, 110, 110, .12)";
  const BASE_GRAY = "#8c939d";
  const INK = "#1f2328";
  const GRID = "#e4e1da";
  const LIVE_BUDGET = 60;
  const DISPLAY_MIN_OAV = 1;   // recipe rows below 1x threshold are hidden (same rule as analyze.py)

  const $ = id => document.getElementById(id);
  const getJson = url => fetch(url).then(r => { if (!r.ok) throw new Error("Failed to load " + url); return r.json(); });
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const [palette, bases, presets, spec, traces, metrics, jsCheck] = await Promise.all([
    "data/palette.json", "data/bases.json", "data/presets.json", "data/mixture_spec.json",
    "data/bo_traces.json", "data/bo_metrics.json", "data/bo_js_check.json"].map(getJson));
  await I18N.ready;
  const t = (k, v) => I18N.t(k, v);

  const comps = palette.compounds;
  const baseById = Object.fromEntries(bases.map(b => [b.id, b]));
  const candidates = Object.keys(comps).filter(n => comps[n].role === "palette");
  const defaultThr = n => comps[n].threshold_mg_kg * 1000;   // ug/kg

  // ---- state ----
  const thrOverride = {};              // compound -> ug/kg (only modified ones)
  let preset = presets[0];
  let problem = null;
  let player = { mode: "pre", steps: [], compare: null, pos: -1, timer: null, playing: false, done: false };
  let liveRunning = false;

  const thresholds = () => {
    const out = {};
    for (const n of Object.keys(comps)) out[n] = thrOverride[n] != null ? thrOverride[n] : defaultThr(n);
    return out;
  };
  const isModified = () => Object.keys(thrOverride).length > 0;

  // ---- number formatting ----
  const locale = () => (I18N.lang === "zh" ? "zh-CN" : "en-US");
  function fmt(v, sig = 3) {
    if (v == null || !isFinite(v)) return "";
    if (v === 0) return "0";
    const a = Math.abs(v);
    if (a >= 100) return Math.round(v).toLocaleString(locale());
    return Number(v.toPrecision(sig)).toLocaleString(locale(), { maximumSignificantDigits: sig });
  }
  const fmtInput = v => String(Number(v.toPrecision(4)));
  const nameOf = n => (I18N.lang === "zh" ? comps[n].name_zh : comps[n].name_en);
  const dimName = d => t("dim." + d);
  const baseName = b => (I18N.lang === "zh" ? b.name_zh : b.name_en);
  const unitOf = b => (/dry/.test(b.unit) ? t("base.unit_dm") : t("base.unit"));

  // ---- preset select ----
  function renderPresetOptions() {
    $("preset").innerHTML = presets.map(p => `<option value="${p.id}">${esc(baseName(baseById[p.base]))}</option>`).join("");
    $("preset").value = preset.id;
  }
  $("preset").addEventListener("change", e => {
    preset = presets.find(p => p.id === e.target.value);
    stopPlayer();
    renderAll();
  });

  // ---- threshold tables ----
  function thrCell(n) {
    const v = thresholds()[n];
    return `<input class="thr" type="number" inputmode="decimal" min="0" step="any" data-c="${esc(n)}" value="${fmtInput(v)}" aria-label="${esc(nameOf(n))}: ${esc(t("col.threshold"))} (µg/kg)">`;
  }
  function sourceCell(n) {
    const c = comps[n];
    const mod = thrOverride[n] != null;
    return esc(c.threshold_source) +
      (mod ? `<span class="sub">${esc(t("thr.default", { v: fmt(defaultThr(n)) }))} <button type="button" class="btn-sm" data-reset="${esc(n)}">${esc(t("thr.reset"))}</button></span>` : "");
  }
  const rangeCell = n => {
    const r = comps[n].threshold_range_mg_kg;
    return r ? `${fmt(r[0] * 1000)} - ${fmt(r[1] * 1000)}` : "";
  };

  function renderThresholdTables() {
    const base = baseById[preset.base];
    const thr = thresholds();
    const comp = base.composition_ug_kg;
    // order by default OAV so rows do not jump while the visitor edits values
    const names = Object.keys(comp).sort((a, b) => comp[b] / defaultThr(b) - comp[a] / defaultThr(a));
    $("conc-unit").textContent = unitOf(base);
    $("add-unit").textContent = unitOf(base);
    $("base-body").innerHTML = names.map(n => `<tr class="${thrOverride[n] != null ? "modified" : ""}" data-row="${esc(n)}">
        <td>${esc(nameOf(n))}</td>
        <td class="num">${fmt(comp[n])}</td>
        <td class="num">${thrCell(n)}</td>
        <td class="num" data-oav="${esc(n)}">${fmt(comp[n] / thr[n])}</td>
        <td class="small">${sourceCell(n)}</td>
        <td class="num small">${rangeCell(n)}</td>
      </tr>`).join("");
    $("palette-body").innerHTML = candidates.slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b), locale())).map(n => `<tr class="${thrOverride[n] != null ? "modified" : ""}" data-row="${esc(n)}">
        <td>${esc(nameOf(n))}</td>
        <td class="num">${thrCell(n)}</td>
        <td class="small">${sourceCell(n)}</td>
        <td class="num small">${rangeCell(n)}</td>
        <td class="num">${fmt(thr[n] * Math.pow(10, spec.x_bounds[1]))}</td>
      </tr>`).join("");
    const nMod = Object.keys(thrOverride).length;
    $("thr-count").textContent = nMod ? t("thr.modified_count", { n: nMod }) : t("thr.none_modified");
    $("thr-reset-all").disabled = !nMod;
  }

  function setThreshold(n, v) {
    const d = defaultThr(n);
    if (Math.abs(v - d) <= 1e-9 * d) delete thrOverride[n]; else thrOverride[n] = v;
    stopPlayer();
    renderAll();
  }

  document.addEventListener("change", e => {
    const el = e.target;
    if (!el.matches || !el.matches("input.thr")) return;
    const n = el.dataset.c;
    const v = Number(el.value);
    if (!(v > 0) || !isFinite(v)) {
      el.setCustomValidity(t("thr.invalid"));
      el.reportValidity();
      el.value = fmtInput(thresholds()[n]);
      el.setCustomValidity("");
      return;
    }
    setThreshold(n, v);
  });
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("[data-reset]");
    if (b) setThreshold(b.dataset.reset, defaultThr(b.dataset.reset));
  });
  $("thr-reset-all").addEventListener("click", () => {
    for (const k of Object.keys(thrOverride)) delete thrOverride[k];
    stopPlayer();
    renderAll();
  });

  // ---- direction ----
  function renderDirection() {
    const dirs = palette.profile_dims.map(d => {
      const v = preset.direction[d] || 0;
      if (!v) return "";
      return `<span class="dir ${v > 0 ? "up" : "down"}">${v > 0 ? "↑" : "↓"} ${esc(dimName(d))} ${esc(t(v > 0 ? "dir.up" : "dir.down"))}</span>`;
    }).join("");
    $("dirs").innerHTML = dirs;
    $("dir-rationale").textContent = t("dir.rationale", { text: I18N.pick({ zh: preset.rationale_zh, en: preset.rationale_en }) }) + " " + t("dir.note");
  }

  function renderBaseMeta() {
    const b = baseById[preset.base];
    const s = b.source;
    $("base-meta").innerHTML = esc(t("base.meta", { citation: s.citation, table: s.table, method: s.method })) +
      ` <a href="https://doi.org/${esc(s.doi)}" target="_blank" rel="noopener">doi:${esc(s.doi)}</a>` +
      (b.note ? `<br>${esc(t("base.note_label"))} ${esc(b.note)}` : "");
  }

  // ---- charts ----
  let radar = null, line = null;
  function makeCharts() {
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = "#5f6670";
    radar = new Chart($("radar"), {
      type: "radar",
      data: { labels: [], datasets: [
        { label: "", data: [], borderColor: BASE_GRAY, backgroundColor: "transparent", borderWidth: 2, pointRadius: 2, pointBackgroundColor: BASE_GRAY },
        { label: "", data: [], borderColor: INK, backgroundColor: "transparent", borderWidth: 2, borderDash: [6, 4], pointRadius: 0 },
        { label: "", data: [], borderColor: ACCENT, backgroundColor: ACCENT_FILL, borderWidth: 2, pointRadius: 3, pointBackgroundColor: ACCENT },
      ] },
      options: {
        maintainAspectRatio: false, animation: { duration: 250 },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 18, boxHeight: 2, padding: 12 } },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.raw.toFixed(3)}` } },
        },
        scales: { r: { beginAtZero: true, grid: { color: GRID }, angleLines: { color: GRID },
                       ticks: { display: false, maxTicksLimit: 4 }, pointLabels: { font: { size: 12 } } } },
      },
    });
    line = new Chart($("line"), {
      type: "line",
      data: { labels: [], datasets: [
        { label: "", data: [], borderColor: ACCENT, backgroundColor: ACCENT, borderWidth: 2, pointRadius: 0, stepped: true },
        { label: "", data: [], borderColor: BASE_GRAY, backgroundColor: BASE_GRAY, borderWidth: 2, pointRadius: 0 },
        { label: "", data: [], borderColor: "#b9bec5", backgroundColor: "#b9bec5", borderWidth: 1, borderDash: [3, 3], pointRadius: 0 },
      ] },
      options: {
        maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 18, boxHeight: 2, padding: 12 } },
          tooltip: { callbacks: { title: items => `${t("chart.x")}: ${items[0].label}`, label: c => (c.raw == null ? null : `${c.dataset.label}: ${c.raw.toFixed(4)}`) } },
        },
        scales: {
          x: { title: { display: true, text: "" }, grid: { display: false }, ticks: { maxTicksLimit: 6 } },
          y: { title: { display: true, text: "" }, grid: { color: GRID }, ticks: { maxTicksLimit: 5, callback: v => Number(v).toFixed(3) } },
        },
      },
    });
  }

  function updateChartLabels() {
    radar.data.labels = palette.profile_dims.map(dimName);
    radar.data.datasets[0].label = t("chart.base");
    radar.data.datasets[1].label = t("chart.target");
    radar.data.datasets[2].label = t("chart.best");
    line.data.datasets[0].label = t("chart.bo");
    line.data.datasets[1].label = t(player.mode === "live" ? "chart.random_live" : "chart.random_mean");
    line.data.datasets[2].label = t("chart.no_add");
    line.options.scales.x.title.text = t("chart.x");
    line.options.scales.y.title.text = t("chart.y");
  }

  // ---- player ----
  function precomputedSteps() {
    return traces[preset.id].steps.map(s => ({ score: s.score, cos: s.cos, nAdded: s.n_added, profile: s.profile, recipe: s.recipe, nHidden: s.n_hidden }));
  }
  function stepFromEval(x, ev) {
    const full = problem.recipe(x);
    const shown = full.filter(r => r.added_oav >= DISPLAY_MIN_OAV);
    return { score: ev.score, cos: ev.cos, nAdded: ev.nAdded, profile: ev.profile, recipe: shown, nHidden: full.length - shown.length };
  }

  function resetPlayer() {
    const live = isModified();
    player = { mode: live ? "live" : "pre", steps: live ? [] : precomputedSteps(), compare: null, pos: -1, timer: null, playing: false, done: false };
    if (!live) player.compare = metrics.presets[preset.id].methods.random_sparse.mean_best_curve;
    renderPlayer();
  }
  function stopPlayer() {
    if (player.timer) clearTimeout(player.timer);
    player.timer = null;
    player.playing = false;
  }
  function bestIndex(upto) {
    let bi = -1;
    for (let i = 0; i <= upto; i++) if (bi < 0 || player.steps[i].score > player.steps[bi].score) bi = i;
    return bi;
  }

  function renderPlayer() {
    const live = player.mode === "live";
    const n = player.steps.length;
    const noAdd = problem.evaluate(new Array(problem.dim).fill(spec.x_bounds[0])).score;
    // mode note
    const note = $("mode-note");
    if (live) {
      note.hidden = false;
      note.textContent = player.done || n ? t("mode.live_done") : t("mode.modified", { n: LIVE_BUDGET });
    } else note.hidden = true;
    $("line-cap").textContent = t(live ? "chart.line_cap_live" : "chart.line_cap");

    // buttons
    const btn = $("btn-run");
    if (liveRunning) { btn.textContent = t("ctl.running"); btn.disabled = true; }
    else if (live && !n) { btn.textContent = t("ctl.run_live"); btn.disabled = false; }
    else {
      btn.disabled = false;
      btn.textContent = t(player.playing ? "ctl.pause" : player.pos >= n - 1 && n ? "ctl.replay" : player.pos >= 0 ? "ctl.resume" : "ctl.start");
    }
    $("btn-skip").disabled = liveRunning || !n || player.pos >= n - 1;

    // radar
    radar.data.datasets[0].data = problem.baseProfile;
    radar.data.datasets[1].data = problem.target;
    const bi = player.pos >= 0 ? bestIndex(player.pos) : -1;
    radar.data.datasets[2].data = bi >= 0 ? player.steps[bi].profile : [];
    radar.data.datasets[2].hidden = bi < 0;
    updateChartLabels();
    radar.update();

    // line
    const total = live ? LIVE_BUDGET : n;
    line.data.labels = Array.from({ length: total }, (_, i) => i + 1);
    let run = -Infinity;
    line.data.datasets[0].data = Array.from({ length: total }, (_, i) => {
      if (i > player.pos || i >= n) return null;
      run = Math.max(run, player.steps[i].score);
      return run;
    });
    line.data.datasets[1].data = player.compare ? player.compare.slice(0, total) : [];
    line.data.datasets[2].data = Array(total).fill(noAdd);
    const vals = [noAdd, ...(player.compare || []), ...player.steps.map(s => s.score)].filter(v => v > noAdd - 0.05);
    line.options.scales.y.min = Math.min(...vals) - 0.002;
    line.options.scales.y.max = Math.max(...vals) + 0.002;
    line.update();

    // step info + recipe
    if (bi >= 0) {
      const b = player.steps[bi];
      $("step-info").innerHTML = t("step.info", { n: player.pos + 1, total: n, score: b.score.toFixed(4), cos: b.cos.toFixed(4) });
      $("recipe-body").innerHTML = b.recipe.length
        ? b.recipe.map(r => `<tr><td>${esc(nameOf(r.compound))}</td><td class="num">${fmt(r.added_ug_kg)}</td><td class="num">${fmt(r.added_oav)}</td><td class="num">${fmt(r.oav_after)}</td></tr>`).join("")
        : `<tr><td colspan="4" class="muted">${esc(t("recipe.none"))}</td></tr>`;
      $("recipe-note").textContent = (b.nHidden ? t("recipe.hidden", { n: b.nHidden }) + " " : "") + t("recipe.unit_note");
    } else {
      $("step-info").textContent = live ? t("step.ready_live", { total: LIVE_BUDGET }).replace(/<[^>]+>/g, "") : t("step.ready", { total: n });
      $("recipe-body").innerHTML = `<tr><td colspan="4" class="muted">${esc(t("recipe.empty"))}</td></tr>`;
      $("recipe-note").textContent = "";
    }
  }

  function tick() {
    if (!player.playing) return;
    if (player.pos >= player.steps.length - 1) { player.playing = false; renderPlayer(); return; }
    player.pos++;
    renderPlayer();
    player.timer = setTimeout(tick, Number($("speed").value));
  }

  async function runLive() {
    liveRunning = true;
    renderPlayer();
    const seed = Math.floor(Math.random() * 1e6);
    const steps = [];
    const hist = await BO.runBO(problem, { budget: LIVE_BUDGET, seed, onStep: ({ x, ev }) => {
      steps.push(stepFromEval(x, ev));
      $("step-info").textContent = `${t("ctl.running")} ${steps.length} / ${LIVE_BUDGET}`;
    } });
    player.steps = steps;
    player.compare = BO.bestCurve(BO.runRandomSparse(problem, { budget: LIVE_BUDGET, seed }));
    player.done = true;
    liveRunning = false;
    player.pos = -1;
    player.playing = true;
    renderPlayer();
    tick();
    return hist;
  }

  $("btn-run").addEventListener("click", () => {
    if (liveRunning) return;
    if (player.mode === "live" && !player.steps.length) { runLive(); return; }
    if (player.playing) { stopPlayer(); renderPlayer(); return; }
    if (player.pos >= player.steps.length - 1) player.pos = -1;
    player.playing = true;
    tick();
  });
  $("btn-skip").addEventListener("click", () => {
    stopPlayer();
    player.pos = player.steps.length - 1;
    renderPlayer();
  });

  // ---- results ----
  const METHODS = ["bo_sparse_init", "bo", "random_sparse", "random_uniform"];
  function renderResults() {
    const ids = presets.map(p => p.id);
    $("res-head").innerHTML = `<tr><th>${esc(t("results.col.method"))}</th>${presets.map(p => `<th class="num">${esc(t("short." + p.id))}</th>`).join("")}</tr>`;
    const best = Object.fromEntries(ids.map(id => [id, METHODS.reduce((a, m) => (metrics.presets[id].methods[m].best_score.mean > metrics.presets[id].methods[a].best_score.mean ? m : a), METHODS[0])]));
    const rows = [`<tr><td>${esc(t("results.no_add"))}</td>${ids.map(id => `<td class="num">${metrics.presets[id].no_addition.score.toFixed(4)}</td>`).join("")}</tr>`];
    for (const m of METHODS) {
      rows.push(`<tr><td>${esc(t("results.m." + m))}</td>${ids.map(id => {
        const e = metrics.presets[id].methods[m];
        const cell = `${e.best_score.mean.toFixed(4)} ± ${e.best_score.std.toFixed(4)} (${e.n_added.mean.toFixed(1)})`;
        return `<td class="num">${best[id] === m ? `<b>${cell}</b>` : cell}</td>`;
      }).join("")}</tr>`);
    }
    $("res-body").innerHTML = rows.join("");

    const krows = [];
    for (const [baseId, ks] of Object.entries(metrics.known_answer)) {
      for (const [k, row] of Object.entries(ks)) {
        const e = row.bo;
        krows.push(`<tr><td>${esc(t("known.case", { base: t("short." + baseId), k }))}</td>
          <td>${e.true.map(n => esc(nameOf(n))).join(I18N.lang === "zh" ? "、" : ", ")}</td>
          <td class="num">${e.cos.mean.toFixed(4)}</td>
          <td class="num">${e.exact_recovery}/${e.of}</td>
          <td class="num">${e.jaccard.mean.toFixed(2)}</td></tr>`);
      }
    }
    $("known-body").innerHTML = krows.join("");
    const wins = Object.values(jsCheck.presets).reduce((a, p) => a + p.bo_wins, 0);
    $("jsbo-text").innerHTML = t("jsbo.text", { wins });

    const seen = new Set();
    $("footer-bases").innerHTML = bases.filter(b => { const k = b.source.doi; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(b => `<li>${esc(b.source.citation)} <a href="https://doi.org/${esc(b.source.doi)}" target="_blank" rel="noopener">doi:${esc(b.source.doi)}</a> (${esc(b.source.license)})</li>`).join("");
  }

  // ---- render all ----
  function renderAll() {
    problem = new Mixture.Problem({ palette, base: baseById[preset.base], direction: preset.direction, spec, thresholdsUg: thresholds() });
    renderPresetOptions();
    renderBaseMeta();
    renderThresholdTables();
    renderDirection();
    resetPlayer();
  }

  makeCharts();
  renderAll();
  renderResults();
  I18N.onChange(() => {
    renderPresetOptions();
    renderBaseMeta();
    renderThresholdTables();
    renderDirection();
    renderPlayer();
    renderResults();
  });
})();
