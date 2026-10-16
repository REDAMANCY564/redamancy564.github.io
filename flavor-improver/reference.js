/*
 * Example 5: reference-food mode (infant formula vs human milk, Zhang et al. 2022).
 * - Both compositions start from one published sample each and can be edited by the visitor.
 * - Only key odorants (OAV >= cutoff) are analyzed. Profiles use the same mixture rule as examples 1-4
 *   (log10 OAV x lift vector, normalized) on the 12 dimensions of data/reference.json.
 * - Output: profile comparison, gap ranking (compounds with data on both sides), precursor directions
 *   from data/precursors.json. No addition amounts, except an optional simulation that is clearly
 *   labelled as a method demonstration and not applicable to infant formula.
 */
window.RefMode = (function () {
  const ACCENT = "#0f6e6e", ACCENT_FILL = "rgba(15, 110, 110, .12)", INK = "#1f2328", GRID = "#e4e1da";
  const SIM_BUDGET = 60;
  let ref, pre, spec, t, esc, fmt, pick, $;
  let radar = null;
  const state = { cutoff: 10, sides: {} };

  const SIDES = [
    { key: "hm", data: () => ref.human_milk, defaultId: () => ref.defaults.human_milk },
    { key: "if", data: () => ref.infant_formula, defaultId: () => ref.defaults.infant_formula },
  ];

  function init(opts) {
    ({ ref, pre, spec, t, esc, fmt, pick } = opts);
    $ = id => document.getElementById(id);
    for (const s of SIDES) loadSample(s.key, s.defaultId());
    $("ref-cutoff").addEventListener("change", e => { state.cutoff = Number(e.target.value); renderAnalysis(); });
    document.getElementById("ref-area").addEventListener("change", onChange);
    document.getElementById("ref-area").addEventListener("click", onClick);
    $("ref-sim-run").addEventListener("click", runSimulation);
  }

  // ---- helpers ----
  const comps = () => ref.compounds;
  const thrUg = n => comps()[n].threshold_mg_kg * 1000;
  const nameOf = n => pick({ zh: comps()[n].name_zh, en: comps()[n].name_en });
  const sideData = key => SIDES.find(s => s.key === key).data();

  function loadSample(key, id) {
    const sample = sideData(key).samples.find(s => s.id === id);
    state.sides[key] = { sample: id, edited: false, conc: Object.assign({}, sample.conc_ug_kg) };
  }

  function oavs(key) {
    const out = {};
    for (const [n, c] of Object.entries(state.sides[key].conc)) out[n] = c / thrUg(n);
    return out;
  }

  function keySet(key) {
    const o = oavs(key);
    return Object.keys(o).filter(n => o[n] >= state.cutoff);
  }

  /* Mixture rule of examples 1-4 (mixture.js, checked against Python), applied to the key odorants only. */
  function profile(key) {
    const conc = Object.fromEntries(keySet(key).map(n => [n, state.sides[key].conc[n]]));
    return profileOf(conc);
  }
  function profileOf(conc) {
    return new Mixture.Problem({ palette: { profile_dims: ref.profile_dims, compounds: comps() },
      base: { composition_ug_kg: conc }, spec, candidates: [], target: [] }).baseProfile;
  }

  // ---- input cards ----
  function renderSide(key) {
    const s = state.sides[key], d = sideData(key);
    const o = oavs(key);
    const names = Object.keys(s.conc).sort((a, b) => o[b] - o[a]);
    const missing = Object.keys(comps()).filter(n => !(n in s.conc)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const opts = d.samples.map(x => `<option value="${esc(x.id)}" ${!s.edited && s.sample === x.id ? "selected" : ""}>${esc(t("ref.sample_" + key, { id: x.id }))}</option>`).join("") +
      (s.edited ? `<option value="" selected>${esc(t("ref.custom"))}</option>` : "");
    $("ref-side-" + key).innerHTML = `
      <h3>${esc(t("ref.side_" + key))}</h3>
      <p class="small muted">${esc(t("ref.side_" + key + "_desc"))}</p>
      <label class="small"><span>${esc(t("ref.start_from"))}</span>
        <select data-side-sample="${key}" style="width:auto;padding:4px 8px;font-size:.875rem">${opts}</select></label>
      <div class="table-wrap" style="margin-top:8px">
        <table>
          <thead><tr><th>${esc(t("col.compound"))}</th><th class="num">${esc(t("ref.col.conc"))}<span class="sub">µg/kg</span></th>
            <th class="num">OAV</th><th></th></tr></thead>
          <tbody>${names.map(n => `<tr class="${o[n] >= state.cutoff ? "" : "muted"}">
            <td>${esc(nameOf(n))}</td>
            <td class="num"><input class="thr" type="number" inputmode="decimal" min="0" step="any" data-side="${key}" data-c="${esc(n)}"
                 value="${String(Number(s.conc[n].toPrecision(4)))}" aria-label="${esc(nameOf(n))} (µg/kg)"></td>
            <td class="num">${o[n] >= state.cutoff ? `<b>${fmt(o[n])}</b>` : fmt(o[n])}</td>
            <td><button type="button" class="btn-sm" data-remove="${esc(n)}" data-side="${key}" aria-label="${esc(t("ref.remove"))}">×</button></td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="thr-tools">
        <select data-add-select="${key}" style="width:auto;max-width:60%;padding:4px 8px;font-size:.875rem">
          ${missing.map(n => `<option value="${esc(n)}">${esc(nameOf(n))}</option>`).join("")}</select>
        <button type="button" class="btn-sm" data-add="${key}" ${missing.length ? "" : "disabled"}>${esc(t("ref.add"))}</button>
      </div>
      <p class="small muted">${esc(t("ref.side_note_" + key))}</p>`;
  }

  function onChange(e) {
    const el = e.target;
    e.stopPropagation();   // keep example-5 inputs away from the threshold handler of examples 1-4
    if (el.dataset.sideSample !== undefined) {
      if (el.value) { loadSample(el.dataset.sideSample, el.value); render(); }
      return;
    }
    if (el.matches("input.thr") && el.dataset.side) {
      const v = Number(el.value), s = state.sides[el.dataset.side];
      if (!(v > 0) || !isFinite(v)) { el.value = String(Number(s.conc[el.dataset.c].toPrecision(4))); return; }
      s.conc[el.dataset.c] = v;
      s.edited = true;
      render();
    }
  }

  function onClick(e) {
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      const s = state.sides[rm.dataset.side];
      delete s.conc[rm.dataset.remove];
      s.edited = true;
      render();
      return;
    }
    const add = e.target.closest("[data-add]");
    if (add) {
      const key = add.dataset.add, sel = document.querySelector(`[data-add-select="${key}"]`);
      if (!sel || !sel.value) return;
      const n = sel.value, s = state.sides[key];
      s.conc[n] = thrUg(n) * state.cutoff;   // start at the key-odorant cutoff; the visitor then enters the real value
      s.edited = true;
      render();
    }
  }

  // ---- analysis ----
  function gaps() {
    const oh = oavs("hm"), oi = oavs("if");
    const keys = new Set([...keySet("hm"), ...keySet("if")]);
    const both = [], onlyHm = [], onlyIf = [];
    for (const n of keys) {
      if (n in oh && n in oi) {
        const d = Math.log10(oi[n]) - Math.log10(oh[n]);
        both.push({ n, oh: oh[n], oi: oi[n], gap: Math.abs(d), higher: d > 0 ? "if" : "hm" });
      } else if (n in oh) onlyHm.push(n); else onlyIf.push(n);
    }
    both.sort((a, b) => b.gap - a.gap);
    return { both, onlyHm, onlyIf };
  }

  const preRow = n => pre.rows.find(r => r.compound === n);
  const precursorNames = n => {
    const r = preRow(n);
    return r ? r.precursors.map(p => pick({ zh: pre.precursors[p].zh, en: pre.precursors[p].en })).join(t("ref.list_sep")) : null;
  };

  function renderAnalysis() {
    for (const s of SIDES) renderSide(s.key);
    const ph = profile("hm"), pf = profile("if");
    radar.data.labels = ref.profile_dims.map(d => t("dim." + d));
    radar.data.datasets[0].label = t("ref.side_hm");
    radar.data.datasets[1].label = t("ref.side_if");
    radar.data.datasets[0].data = ph;
    radar.data.datasets[1].data = pf;
    radar.update();

    const g = gaps();
    $("ref-gap-body").innerHTML = g.both.length
      ? g.both.map(r => `<tr><td>${esc(nameOf(r.n))}</td><td class="num">${fmt(r.oh)}</td><td class="num">${fmt(r.oi)}</td>
          <td class="num">${r.gap.toFixed(2)}</td><td>${esc(t("ref.higher_" + r.higher))}</td></tr>`).join("")
      : `<tr><td colspan="5" class="muted">${esc(t("ref.no_gap"))}</td></tr>`;
    const notes = [t("ref.gap_def", { cutoff: state.cutoff })];
    if (g.onlyHm.length) notes.push(t("ref.only_hm", { list: g.onlyHm.map(nameOf).join(t("ref.list_sep")) }));
    if (g.onlyIf.length) notes.push(t("ref.only_if", { list: g.onlyIf.map(nameOf).join(t("ref.list_sep")) }));
    const cos = Mixture.cosine(ph, pf);
    notes.push(t("ref.cos", { cos: cos.toFixed(3) }));
    $("ref-gap-note").textContent = notes.join(" ");

    $("ref-dirs").innerHTML = g.both.map(r => {
      const p = precursorNames(r.n);
      const msg = p ? t(r.higher === "if" ? "ref.dir.if_higher" : "ref.dir.hm_higher", { compound: nameOf(r.n), precursor: p })
                    : t("ref.dir.none", { compound: nameOf(r.n) });
      return `<li>${esc(msg)}</li>`;
    }).join("") || `<li class="muted">${esc(t("ref.no_gap"))}</li>`;

    renderPrecursorTable(new Set([...keySet("hm"), ...keySet("if")]));
  }

  function renderPrecursorTable(active) {
    const refLink = ([id, where]) => {
      const r = pre.references[id];
      return `<a href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener">${esc(r.short)}</a>, ${esc(where)}`;
    };
    $("ref-pre-body").innerHTML = pre.rows.map(r => `<tr>
        <td>${active.has(r.compound) ? "<b>" : ""}${esc(nameOf(r.compound))}${active.has(r.compound) ? "</b>" : ""}${I18N.lang === "zh" ? `<span class="sub">${esc(r.compound)}</span>` : ""}</td>
        <td>${esc(pick({ zh: r.odor_zh, en: r.odor_en }))}</td>
        <td>${r.precursors.map(p => {
              const [name, code] = pick({ zh: pre.precursors[p].zh, en: pre.precursors[p].en }).split(/\s*[（(]/);
              return `${esc(name)}<span class="sub">${esc((code || "").replace(/[）)]$/, ""))}</span>`; }).join("")}</td>
        <td>${esc(pick({ zh: r.pathway_zh, en: r.pathway_en }))}</td>
        <td>${r.precursors.map(p => { const q = pre.precursors[p];
              return `${esc(pick({ zh: q.short_zh, en: q.short_en }))}<span class="sub">${esc(q.basis)}</span>`; }).join("<br>")}</td>
        <td class="small">${r.refs.map(refLink).join("<br>")}</td>
      </tr>`).join("");
    const full = Object.values(pre.precursors).map(q =>
      `<b>${esc(pick({ zh: q.zh, en: q.en }))}</b>${esc(t("ref.colon"))}${esc(pick({ zh: q.status_zh, en: q.status_en }))}（${esc(q.basis)}）`);
    const regs = [pre.regulations.gb2760, pre.regulations.gb10765_fortifier].map(g => esc(pick({ zh: g.zh, en: g.en })));
    const cites = Object.values(pre.references).map(r =>
      `${esc(r.citation)} <a href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener">doi:${esc(r.doi)}</a>`);
    $("ref-reg-notes").innerHTML = [...full, ...regs, esc(t("ref.reg_official"))].map(x => `<span style="display:block">${x}</span>`).join("") +
      `<span style="display:block;margin-top:8px"><b>${esc(t("ref.refs_title"))}</b></span>` +
      cites.map(x => `<span style="display:block">${x}</span>`).join("");
  }

  // ---- demo simulation (not applicable to infant formula) ----
  async function runSimulation() {
    const btn = $("ref-sim-run");
    btn.disabled = true;
    const keysIf = keySet("if");
    const base = { composition_ug_kg: Object.fromEntries(keysIf.map(n => [n, state.sides["if"].conc[n]])) };
    const problem = new Mixture.Problem({
      palette: { profile_dims: ref.profile_dims, compounds: comps() }, base, spec,
      candidates: Object.keys(comps()), target: profile("hm"),
    });
    const start = problem.evaluate(new Array(problem.dim).fill(spec.x_bounds[0]));
    const hist = await BO.runBO(problem, { budget: SIM_BUDGET, seed: Math.floor(Math.random() * 1e6), onStep: ({ step }) => {
      $("ref-sim-info").textContent = `${t("ctl.running")} ${step} / ${SIM_BUDGET}`;
    } });
    const best = hist.reduce((a, h) => (h.ev.score > a.ev.score ? h : a));
    const recipe = problem.recipe(best.x).filter(r => r.added_oav >= 1);
    $("ref-sim-body").innerHTML = recipe.length
      ? recipe.map(r => `<tr><td>${esc(nameOf(r.compound))}</td><td class="num">${fmt(r.added_ug_kg)}</td><td class="num">${fmt(r.added_oav)}</td><td class="num">${fmt(r.oav_after)}</td></tr>`).join("")
      : `<tr><td colspan="4" class="muted">${esc(t("recipe.none"))}</td></tr>`;
    $("ref-sim-info").textContent = t("ref.sim_result", { before: start.cos.toFixed(3), after: best.ev.cos.toFixed(3) });
    $("ref-sim-note").textContent = t("ref.sim_note");
    btn.disabled = false;
  }

  function makeChart() {
    radar = new Chart($("ref-radar"), {
      type: "radar",
      data: { labels: [], datasets: [
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
  }

  function render() {
    if (!radar) makeChart();
    const s = ref.source;
    $("ref-meta").innerHTML = esc(t("ref.meta", { citation: s.citation })) +
      ` <a href="https://doi.org/${esc(s.doi)}" target="_blank" rel="noopener">doi:${esc(s.doi)}</a>`;
    renderAnalysis();
    $("ref-sim-body").innerHTML = `<tr><td colspan="4" class="muted">${esc(t("recipe.empty"))}</td></tr>`;
    $("ref-sim-info").textContent = "";
    $("ref-sim-note").textContent = "";
  }

  return { init, render };
})();
