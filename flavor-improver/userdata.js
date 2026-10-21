/*
 * "Use my own data" mode of flavor-improver (PLAN-userdata.md). Stage 1: data in; stage 2: comparison;
 * stage 3: what to add (recommendations without amounts; user decision 2026-10-18).
 * - Two slots, "sample" and "target", filled by gcms-interpreter ("Send as ...", assets/flavor-handoff.js)
 *   or by uploading its ranking CSV; an example pair from Zhang et al. 2022 (data/reference.json).
 * - Merge table: amounts, thresholds (editable; target side first), odor vector source.
 * - Compounds outside the flavor knowledge base have no odor vector: they are listed, and the visitor
 *   can ask the odor-predictor model to predict one from a SMILES (typed, or looked up on PubChem by
 *   CAS / name after an explicit click; only the name or CAS is sent).
 * Everything else stays in the browser. Odor vectors and built-in thresholds: ../gcms-interpreter/data/flavor.json.
 */
window.UserMode = (function () {
  const PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/";
  const THR_KEY = "flavor-userdata-thr", PRED_KEY = "flavor-userdata-pred";
  const C = window.UserCore;
  let t, esc, fmt, pick, $;
  let FL = null, flPromise = null, namesIndex = null;
  const state = { recs: { sample: null, target: null }, thr: {}, pred: {}, predOpen: false, busy: false, msg: {}, view: "ref", rules: { fold: UserCore.FOLD, pp: 100 * UserCore.SHARE_PP } };
  const ACCENT = "#0f6e6e", ACCENT_FILL = "rgba(15, 110, 110, .12)", INK = "#1f2328", GRID = "#e4e1da";
  let radar = null;

  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") || d; } catch (e) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } };

  function init(opts) {
    ({ t, esc, fmt, pick } = opts);
    $ = id => document.getElementById(id);
    state.thr = load(THR_KEY, {});
    state.pred = load(PRED_KEY, {});
    try { const v = localStorage.getItem("flavor-userdata-view"); if (v && (v === "all" || UserCore.VIEWS[v])) state.view = v; } catch (e) { /* storage off */ }
    const rules = load("flavor-userdata-rules", null);
    if (rules && rules.fold > 1 && rules.pp > 0) state.rules = rules;
    $("user-rules-apply").addEventListener("click", applyRules);
    $("user-rules-reset").addEventListener("click", () => { setRuleInputs({ fold: C.FOLD, pp: 100 * C.SHARE_PP }); });
    $("user-rules-close").addEventListener("click", () => $("user-rules").close());
    const area = $("user-area");
    area.addEventListener("change", onChange);
    area.addEventListener("click", onClick);
    window.addEventListener("storage", e => { if (e.key === FlavorHandoff.KEY) { readSlots(); render(); } });
  }

  // ---------- data ----------
  function flavorData() {
    if (!flPromise) {
      flPromise = fetch("../gcms-interpreter/data/flavor.json").then(r => {
        if (!r.ok) throw new Error("flavor.json");
        return r.json();
      }).then(j => { FL = j; return j; });
      flPromise.catch(() => { flPromise = null; });
    }
    return flPromise;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some(s => s.src === src)) { resolve(); return; }
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("script " + src));
      document.head.appendChild(s);
    });
  }

  /** Knowledge-base ids for CSV compounds without one (name / CAS index of gcms-interpreter, loaded once). */
  async function resolveIds(rec) {
    const all = rec.compounds.concat(rec.notFound || []);
    if (all.every(c => c.kbId)) return rec;
    if (!namesIndex) {
      await loadScript(new URL("../gcms-interpreter/cas.js", location.href).href);
      await loadScript(new URL("../gcms-interpreter/names.js", location.href).href);
      const j = await fetch("../gcms-interpreter/data/names.json").then(r => r.json());
      namesIndex = GcmsNames.buildIndex(j);
    }
    all.forEach(c => {
      if (c.kbId) return;
      const id = GcmsNames.identify(namesIndex, c.label, c.cas, false, false);
      if (id.kbId) c.kbId = id.kbId;
      if (!c.cas && id.casNorm) c.cas = id.casNorm;
    });
    return rec;
  }

  function readSlots() {
    // records kept in memory only (local storage unavailable) are marked _local
    FlavorHandoff.SLOTS.forEach(s => {
      const r = state.recs[s];
      state.recs[s] = FlavorHandoff.get(s) || (r && r._local ? r : null);
    });
  }

  /** Odor probability vector (Float64Array over FL.labels) and its source, or null. */
  function vectorOf(row) {
    const c = row.kbId && FL.compounds[row.kbId];
    if (c && c.p) return { src: "kb", p: c.p };
    const pr = state.pred[row.key];
    if (pr && pr.p) return { src: "model", p: pr.p, smiles: pr.smiles };
    return null;
  }

  function thresholdOf(row) {
    if (state.thr[row.key] > 0) return { v: state.thr[row.key], from: "user" };
    if (row.thr) return { v: row.thr, from: row.thrFrom };
    const b = row.kbId && FL.thresholds[row.kbId];
    return b ? { v: b.mg_kg, from: "builtin" } : { v: null, from: null };
  }

  /** Merged rows with thresholds and vectors resolved (used by later stages as well). */
  function current() {
    const { sample, target } = state.recs;
    if (!sample || !target || !FL) return null;
    const m = C.merge(sample, target);
    m.rows.forEach(r => { r.thrUse = thresholdOf(r); r.vec = vectorOf(r); });
    return m;
  }

  // ---------- rendering ----------
  function render() {
    readSlots();
    renderSlots();
    if (!FL) {
      $("user-merge").innerHTML = '<p class="small muted">' + esc(t("user.loading")) + "</p>";
      flavorData().then(render, () => { $("user-merge").innerHTML = '<p class="small error">' + esc(t("user.load_error")) + "</p>"; });
      return;
    }
    renderMerge();
  }

  function renderSlots() {
    ["sample", "target"].forEach(slot => {
      const r = state.recs[slot];
      const el = $("user-slot-" + slot);
      const head = "<h4>" + esc(t("user.slot_" + slot)) + "</h4>";
      const body = r
        ? '<p class="small" style="margin:0"><b>' + esc(r.name) + "</b></p><p class=\"small muted\" style=\"margin:2px 0 8px\">" +
          esc(t("user.slot_info", { src: t("user.src_" + r.source), mode: r.mode === "oav" ? "OAV" : "ROAV", n: r.compounds.length,
            nf: (r.notFound || []).length, time: new Date(r.savedAt).toLocaleString(I18N.lang === "zh" ? "zh-CN" : "en") })) + "</p>"
        : '<p class="small muted" style="margin:0 0 8px">' + esc(t("user.slot_empty")) + "</p>";
      const msg = state.msg[slot] ? '<p class="small ' + (state.msg[slot].err ? "error" : "") + '" style="margin:6px 0 0">' + esc(state.msg[slot].text) + "</p>" : "";
      el.innerHTML = head + body +
        '<div class="thr-tools"><label class="btn-sm file-btn">' + esc(t("user.upload")) +
        '<input type="file" accept=".csv,text/csv" data-upload="' + slot + '" hidden></label>' +
        (r ? '<button type="button" class="btn-sm" data-clear="' + slot + '">' + esc(t("user.clear")) + "</button>" : "") + "</div>" + msg;
    });
  }

  function renderMerge() {
    const m = current();
    const box = $("user-merge");
    if (!m) { box.innerHTML = '<p class="small muted">' + esc(t("user.need_both")) + "</p>"; renderAnalysis(null); return; }
    const { sample, target } = state.recs;
    const modeNote = m.mode === "oav" ? t("user.mode_oav")
      : t("user.mode_roav", { s: sample.mode.toUpperCase(), t: target.mode.toUpperCase() });
    const unit = side => {
      const b = state.recs[side].basis;
      return b === "oav" ? t("user.unit_oav") : b === "roav" ? t("user.unit_roav") : state.recs[side].mode === "oav" ? "µg/kg" : t("user.rel_unit");
    };
    let h = '<p class="small"><b>' + esc(t("user.mode_title")) + "</b> " + esc(modeNote) + "</p>";
    h += '<div class="table-wrap"><table class="user-table"><thead><tr><th>' + esc(t("col.compound")) + "</th><th>CAS</th>" +
      '<th class="num">' + esc(t("user.slot_sample")) + '<span class="sub">' + esc(unit("sample")) + "</span></th>" +
      '<th class="num">' + esc(t("user.slot_target")) + '<span class="sub">' + esc(unit("target")) + "</span></th>" +
      '<th class="num">' + esc(t("col.threshold")) + '<span class="sub">mg/kg</span></th><th>' + esc(t("user.col.vec")) + "</th><th>" +
      esc(t("user.col.note")) + "</th></tr></thead><tbody>";
    m.rows.forEach(r => {
      const notes = [];
      if (!r.s) notes.push(t(r.sNotFound ? "user.note_s_nd" : "user.note_s_missing"));
      if (!r.t) notes.push(t(r.tNotFound ? "user.note_t_nd" : "user.note_t_missing"));
      if (r.thrConflict) notes.push(t("user.note_thr_conflict", { s: fmt(r.s.thr_mg_kg), t: fmt(r.t.thr_mg_kg) }));
      const givenS = r.s && r.s.given, givenT = r.t && r.t.given;
      if (givenS || givenT) notes.push(t(givenS && givenT ? "user.note_given_both" : givenS ? "user.note_given_s" : "user.note_given_t"));
      if (!(givenS && givenT || givenS && !r.t || givenT && !r.s)) {
        if (!r.thrUse.v) notes.push(t("user.note_no_thr"));
        else if (r.thrUse.from === "builtin") notes.push(t("user.note_thr_builtin"));
      }
      const vec = r.vec ? (r.vec.src === "kb" ? t("user.vec_kb") : t("user.vec_model")) : '<span class="error">' + esc(t("user.vec_none")) + "</span>";
      h += "<tr><td>" + esc(r.label) + '</td><td class="nw">' + esc(r.cas) + '</td><td class="num nw">' + (r.s ? fmt(r.s.value) : "-") +
        '</td><td class="num nw">' + (r.t ? fmt(r.t.value) : "-") + '</td><td class="num"><input class="thr" type="number" min="0" step="any" data-uthr="' +
        esc(r.key) + '" value="' + (r.thrUse.v ? r.thrUse.v : "") + '" aria-label="' + esc(r.label) + '"></td><td class="nw">' +
        (r.vec ? esc(vec) : vec) + '</td><td class="small">' + esc(notes.join("; ")) + "</td></tr>";
    });
    h += "</tbody></table></div>";
    h += '<p class="small muted">' + esc(t("user.table_note")) + "</p>";

    // compounds without an odor vector: list them and offer the odor-predictor model
    const miss = m.rows.filter(r => !r.vec);
    if (miss.length) {
      h += '<div class="note warn" style="margin-top:12px"><p style="margin:0 0 6px">' + esc(t("user.novec", { n: miss.length, list: miss.map(r => r.label).join(t("ref.list_sep")) })) + "</p>";
      if (!state.predOpen) {
        h += '<button type="button" class="btn-sm" id="user-pred-open">' + esc(t("user.pred_ask")) + "</button>";
      } else {
        h += '<p class="small" style="margin:6px 0">' + esc(t("user.pred_intro")) + '</p><div class="table-wrap"><table class="user-table"><thead><tr><th>' +
          esc(t("col.compound")) + "</th><th>CAS</th><th>SMILES</th></tr></thead><tbody>" +
          miss.map(r => "<tr><td>" + esc(r.label) + "</td><td>" + esc(r.cas) + '</td><td><input type="text" class="smiles-in" data-smiles="' + esc(r.key) +
            '" value="' + esc((state.pred[r.key] && state.pred[r.key].smiles) || "") + '" spellcheck="false" autocapitalize="off" aria-label="SMILES: ' + esc(r.label) + '"></td></tr>').join("") +
          '</tbody></table></div><div class="thr-tools"><button type="button" class="btn-sm" id="user-pubchem">' + esc(t("user.pubchem")) +
          '</button><button type="button" class="btn-sm" id="user-predict">' + esc(t("user.predict")) + "</button></div>" +
          '<p class="small muted" style="margin:4px 0 0">' + esc(t("user.pubchem_note")) + "</p>";
      }
      h += '<p class="small" id="user-pred-status" aria-live="polite" style="margin:6px 0 0">' + esc(state.predMsg || "") + "</p></div>";
    }
    const predicted = m.rows.filter(r => r.vec && r.vec.src === "model");
    if (predicted.length) {
      h += '<p class="small" style="margin-top:10px">' + esc(t("user.predicted", { list: predicted.map(r => r.label + " (" + topLabels(r.vec.p, 3) + ")").join("; ") })) +
        ' <button type="button" class="btn-sm" id="user-pred-clear">' + esc(t("user.pred_clear")) + "</button></p>";
    }
    box.innerHTML = h;
    renderAnalysis(m);
  }

  // ---------- stage 2: comparison ----------
  const dimLabel = (id, i) => (state.view === "all" ? pick(FL.labels[i]) : t("dim." + id));

  function renderAnalysis(m) {
    const area = $("user-cmp");
    area.hidden = !m;
    if (!m) return;
    const A = C.analyze(m.rows, m.mode, state.view, FL.labels, FL.prevalence, { fold: state.rules.fold, pp: state.rules.pp / 100 });
    $("user-rules-now").textContent = t("user.rules_now", { fold: fmt(A.fold), pp: fmt(100 * A.pp) });
    $("user-view").value = state.view;
    const sc = A.mode === "oav" ? "OAV" : "ROAV";

    // radar: the view's 12 dimensions, or the 10 largest of either profile among all labels
    let idx, labels;
    if (state.view === "all") {
      const both = (A.profiles.s || []).map((v, i) => [i, Math.max(v, (A.profiles.t || [])[i] || 0)]);
      idx = both.sort((a, b) => b[1] - a[1]).slice(0, 10).map(x => x[0]);
      labels = idx.map(i => dimLabel(null, i));
    } else {
      idx = C.VIEWS[state.view].map((_, k) => k);
      labels = C.VIEWS[state.view].map(id => dimLabel(id));
    }
    const pick2 = p => (p ? idx.map(i => p[i]) : []);
    if (!radar) {
      radar = new Chart($("user-radar"), {
        type: "radar",
        data: { labels: [], datasets: [
          { label: "", data: [], borderColor: INK, backgroundColor: "transparent", borderWidth: 2, borderDash: [6, 4], pointRadius: 0 },
          { label: "", data: [], borderColor: ACCENT, backgroundColor: ACCENT_FILL, borderWidth: 2, pointRadius: 3, pointBackgroundColor: ACCENT },
        ] },
        options: {
          maintainAspectRatio: false, animation: { duration: 250 },
          plugins: { legend: { position: "bottom", labels: { boxWidth: 18, boxHeight: 2, padding: 12 } },
                     tooltip: { callbacks: { label: c => `${c.dataset.label}: ${(100 * c.raw).toFixed(1)}%` } } },
          scales: { r: { beginAtZero: true, grid: { color: GRID }, angleLines: { color: GRID },
                         ticks: { display: false, maxTicksLimit: 4 }, pointLabels: { font: { size: 12 } } } },
        },
      });
    }
    radar.data.labels = labels;
    radar.data.datasets[0].label = t("user.slot_target") + ": " + state.recs.target.name;
    radar.data.datasets[1].label = t("user.slot_sample") + ": " + state.recs.sample.name;
    radar.data.datasets[0].data = pick2(A.profiles.t);
    radar.data.datasets[1].data = pick2(A.profiles.s);
    radar.update();
    $("user-radar-note").textContent = t(state.view === "all" ? "user.radar_note_all" : "user.radar_note", { n: A.used, score: sc }) +
      (A.cos != null ? " " + t("user.cos", { cos: A.cos.toFixed(3) }) : " " + t("user.cos_none"));

    // gap table
    const vecText = r => (r.vec ? topLabels(r.vec.p, 3) : t("user.vec_none"));
    const val = x => (x.value === 0 ? t("user.nd") : x.score == null ? "-" : fmt(x.score));
    const gapText = g => (A.mode === "oav" ? (g.gap >= 0 ? "×" + fmt(Math.pow(10, g.gap)) : "÷" + fmt(Math.pow(10, -g.gap)))
      : (g.gap >= 0 ? "+" : "−") + (100 * Math.abs(g.gap)).toFixed(1) + t("user.pp"));
    const higher = g => (g.gap >= A.lim ? t("user.higher_t") : g.gap <= -A.lim ? t("user.higher_s") : t("user.similar"));
    $("user-gap-head").innerHTML = "<tr><th>" + esc(t("col.compound")) + '</th><th class="num">' + esc(t("user.slot_sample")) + " " + sc +
      '</th><th class="num">' + esc(t("user.slot_target")) + " " + sc + '</th><th class="num">' + esc(t(A.mode === "oav" ? "user.col.ratio" : "user.col.share")) +
      "</th><th>" + esc(t("user.col.higher")) + "</th><th>" + esc(t("user.col.odor")) + "</th></tr>";
    $("user-gap-body").innerHTML = A.gaps.length ? A.gaps.map(g => '<tr><td>' + esc(g.row.label) + '</td><td class="num nw">' + esc(val(g.s)) +
      '</td><td class="num nw">' + esc(val(g.t)) + '</td><td class="num nw">' + esc(gapText(g)) + '</td><td class="nw">' + esc(higher(g)) +
      '</td><td class="small">' + esc(vecText(g.row)) + "</td></tr>").join("")
      : '<tr><td colspan="6" class="muted">' + esc(t("user.no_gaps")) + "</td></tr>";
    const notes = [t(A.mode === "oav" ? "user.gap_def_oav" : "user.gap_def_roav", { fold: fmt(A.fold), pp: fmt(100 * A.pp) })];
    const unk = side => A.unknown.filter(u => u.side === side).map(u => u.row.label);
    if (unk("s").length) notes.push(t("user.unknown_s", { list: unk("s").join(t("ref.list_sep")) }));
    if (unk("t").length) notes.push(t("user.unknown_t", { list: unk("t").join(t("ref.list_sep")) }));
    $("user-gap-note").textContent = notes.join(" ");

    // the two lists
    $("user-list-t-intro").textContent = t("user.list_t_intro");
    const li = (g, key) => "<li>" + esc(t(key, { name: g.row.label, gap: gapText(g), odor: vecText(g.row) })) + "</li>";
    $("user-higher-s").innerHTML = A.higherSample.map(g => li(g, "user.li_s")).join("") || '<li class="muted">' + esc(t("user.none")) + "</li>";
    $("user-higher-t").innerHTML = A.higherTarget.map(g => li(g, g.row.vec && g.row.thrUse.v ? "user.li_t" : "user.li_t_novec")).join("") ||
      '<li class="muted">' + esc(t("user.none")) + "</li>";

    // stage 3: what to add (no amounts)
    const R = A.rec;
    let h = '<p class="small">' + esc(t(A.mode === "oav" ? "user.rec_intro_oav" : "user.rec_intro_roav")) + "</p>";
    if (R.items.length) {
      h += "<ol class=\"small rec-list\">" + R.items.map(g => {
        const effect = A.mode === "oav" && g.cosAfter != null && A.cos != null
          ? t("user.rec_effect", { from: A.cos.toFixed(3), to: g.cosAfter.toFixed(3), d: (g.cosAfter - A.cos >= 0 ? "+" : "") + (g.cosAfter - A.cos).toFixed(3) }) : "";
        return "<li><b>" + esc(g.row.label) + "</b>" + (g.row.cas ? ' <span class="muted">' + esc(g.row.cas) + "</span>" : "") + esc(t("ref.colon")) +
          esc(t("user.rec_item", { gap: gapText(g), odor: vecText(g.row) })) + (effect ? " " + esc(effect) : "") +
          (g.row.vec.src === "model" ? ' <span class="muted">' + esc(t("user.rec_model")) + "</span>" : "") + "</li>";
      }).join("") + "</ol>";
      if (R.cosAll != null && A.cos != null) h += '<p class="small">' + esc(t("user.rec_all", { from: A.cos.toFixed(3), to: R.cosAll.toFixed(3), n: R.items.length })) + "</p>";
    } else {
      h += '<p class="small muted">' + esc(t("user.rec_none")) + "</p>";
    }
    if (R.noVec.length) h += '<p class="small">' + esc(t("user.rec_novec", { list: R.noVec.map(g => g.row.label).join(t("ref.list_sep")) })) + "</p>";
    if (R.unmeasured.length) h += '<p class="small">' + esc(t("user.rec_unmeasured", { list: R.unmeasured.map(u => u.row.label).join(t("ref.list_sep")) })) + "</p>";
    if (A.higherSample.length) h += '<p class="small">' + esc(t("user.rec_lower", { list: A.higherSample.map(g => g.row.label).join(t("ref.list_sep")) })) + "</p>";
    $("user-rec").innerHTML = h;
  }

  // ---------- settings dialog: the "higher on one side" rule ----------
  function setRuleInputs(r) {
    $("user-rule-fold").value = r.fold;
    $("user-rule-pp").value = r.pp;
    $("user-rules-msg").textContent = "";
  }
  function openRules() {
    setRuleInputs(state.rules);
    $("user-rules").showModal();
  }
  function applyRules() {
    const fold = Number($("user-rule-fold").value), pp = Number($("user-rule-pp").value);
    if (!(fold > 1 && fold <= 100) || !(pp > 0 && pp <= 50)) { $("user-rules-msg").textContent = t("user.rules_invalid"); return; }
    state.rules = { fold, pp };
    store("flavor-userdata-rules", state.rules);
    $("user-rules").close();
    renderMerge();
  }

  const topLabels = (p, k) => p.slice().sort((a, b) => b[1] - a[1]).slice(0, k).map(([i, v]) => pick(FL.labels[i]) + " " + Math.round(100 * v) + "%").join(", ");

  // ---------- events ----------
  async function onChange(e) {
    const up = e.target.closest("[data-upload]");
    if (up && up.files && up.files[0]) {
      const slot = up.dataset.upload, file = up.files[0];
      const { rec, error } = C.recordFromCsv(await file.text(), file.name.replace(/\.[^.]+$/, ""));
      if (error) { state.msg[slot] = { text: t("user.csv_" + error), err: true }; renderSlots(); return; }
      try { await resolveIds(rec); } catch (err) { /* names index unavailable: keep names / CAS only */ }
      const ok = FlavorHandoff.save(slot, rec);
      state.msg[slot] = ok ? { text: t("user.csv_ok", { n: rec.compounds.length }) } : { text: t("user.storage_off"), err: true };
      if (!ok) state.recs[slot] = Object.assign(rec, { _local: true });
      render();
      return;
    }
    if (e.target.id === "user-view") {
      state.view = e.target.value;
      try { localStorage.setItem("flavor-userdata-view", state.view); } catch (err) { /* storage off */ }
      renderMerge();
      return;
    }
    const th = e.target.closest("[data-uthr]");
    if (th) {
      const v = th.value.trim() === "" ? null : Number(th.value);
      if (v > 0) state.thr[th.dataset.uthr] = v; else delete state.thr[th.dataset.uthr];
      store(THR_KEY, state.thr);
      renderMerge();
    }
  }

  async function onClick(e) {
    const id = e.target.id;
    const cl = e.target.closest("[data-clear]");
    if (cl) { FlavorHandoff.clear(cl.dataset.clear); state.recs[cl.dataset.clear] = null; state.msg = {}; render(); return; }
    if (id === "user-example") { await loadExample(); return; }
    if (id === "user-pred-open") { state.predOpen = true; renderMerge(); return; }
    if (id === "user-rules-open") { openRules(); return; }
    if (id === "user-pred-clear") { state.pred = {}; store(PRED_KEY, state.pred); state.predMsg = ""; renderMerge(); return; }
    if (id === "user-pubchem") { await lookupPubchem(); return; }
    if (id === "user-predict") { await predictMissing(); }
  }

  async function loadExample() {
    const files = { sample: "examples/userdata_sample_formula1.csv", target: "examples/userdata_target_humanmilk_A1.csv" };
    for (const slot of ["sample", "target"]) {
      const text = await fetch(files[slot]).then(r => r.text());
      const { rec } = C.recordFromCsv(text, t("user.example_" + slot));
      rec.source = "example";
      await resolveIds(rec);
      if (!FlavorHandoff.save(slot, rec)) state.recs[slot] = Object.assign(rec, { _local: true });
    }
    state.msg = {};
    render();
  }

  function smilesInputs() {
    const out = {};
    document.querySelectorAll("#user-area [data-smiles]").forEach(el => { out[el.dataset.smiles] = el.value.trim(); });
    return out;
  }

  function setPredMsg(key, vars, err) {
    state.predMsg = key ? t(key, vars) : "";
    const el = $("user-pred-status");
    if (el) { el.textContent = state.predMsg; el.classList.toggle("error", !!err); }
  }

  /** PubChem lookup by CAS (else name) for compounds without a SMILES; only the CAS or name is sent. */
  async function lookupPubchem() {
    const m = current();
    const typed = smilesInputs();
    const todo = m.rows.filter(r => !r.vec && !typed[r.key]);
    let found = 0;
    for (const r of todo) {
      setPredMsg("user.pubchem_busy", { name: r.label });
      try {
        const q = encodeURIComponent(r.cas || r.label);
        const j = await fetch(PUBCHEM + q + "/property/SMILES/JSON").then(x => (x.ok ? x.json() : null));
        const smi = j && j.PropertyTable && j.PropertyTable.Properties[0] && j.PropertyTable.Properties[0].SMILES;
        if (smi) {
          const el = document.querySelector('#user-area [data-smiles="' + CSS.escape(r.key) + '"]');
          if (el) el.value = smi;
          found++;
        }
      } catch (err) { /* network or not found: leave empty */ }
    }
    setPredMsg("user.pubchem_done", { n: found, m: todo.length });
  }

  let engine = null;
  async function getEngine() {
    if (engine) return engine;
    // RDKit and ONNX Runtime are self-hosted (assets/libs.js); the engine loads ONNX Runtime itself
    await loadScript(new URL("../odor-predictor/engine.js", location.href).href);
    const rdkit = await Libs.rdkit();
    const spec = await fetch("../odor-predictor/model/feature_spec.json").then(r => r.json());
    const labels = await fetch("../odor-predictor/model/labels.json").then(r => r.json());
    if (labels.length !== FL.labels.length || labels.some((l, i) => l.id !== FL.labels[i].id)) throw new Error("label order");
    const session = await OdorEngine.loadModel("../odor-predictor/model/" + spec.model_file);
    engine = { rdkit, spec, session };
    return engine;
  }

  /** Predict odor vectors with the odor-predictor model; stored sparsely like flavor.json (p >= prob_min). */
  async function predictMissing() {
    const typed = smilesInputs();
    const keys = Object.keys(typed).filter(k => typed[k]);
    if (!keys.length) { setPredMsg("user.pred_none", null, true); return; }
    setPredMsg("user.pred_loading");
    let eng;
    try { eng = await getEngine(); } catch (err) { console.error(err); setPredMsg("user.pred_engine_error", null, true); return; }
    const bad = [];
    for (const k of keys) {
      try {
        const { mol } = OdorEngine.parseLargestFragment(eng.rdkit, typed[k]);
        let probs;
        try { probs = await OdorEngine.predict(eng.session, OdorEngine.featurizeMol(mol, eng.spec), eng.spec); } finally { mol.delete(); }
        const p = [];
        Array.from(probs).forEach((v, i) => { if (v >= FL.prob_min) p.push([i, Math.round(v * 1000) / 1000]); });
        state.pred[k] = { smiles: typed[k], p };
      } catch (err) {
        bad.push(k);
      }
    }
    store(PRED_KEY, state.pred);
    const names = current().rows.filter(r => bad.includes(r.key)).map(r => r.label);
    state.predMsg = bad.length ? t("user.pred_bad", { list: names.join(t("ref.list_sep")) }) : t("user.pred_done", { n: keys.length });
    renderMerge();
  }

  return { init, render, current };
})();
