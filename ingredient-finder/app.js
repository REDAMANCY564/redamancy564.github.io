/*
 * ingredient-finder page (PLAN-ingredient-finder.md).
 * Mode A: rank library molecules by wanted / unwanted predicted odor descriptors (finder.js).
 * Mode B: substitutes by odor similarity vs structure similarity (next stage).
 * Structures are drawn with RDKit.js (MinimalLib, CDN), loaded in parallel with the data.
 */
(async function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const VERSION = new URL(document.currentScript.src).search;   // data of a new version bypasses the cache
  const RDKIT_WASM = "https://cdn.jsdelivr.net/npm/@rdkit/rdkit@2026.3.6/dist/RDKit_minimal.wasm";
  const PAGE = 20, MAX_SHOWN = 200, TOP_PRED = 5, FOODS_SHOWN = 3;
  const F = window.FinderCore;

  // RDKit is only needed for drawing: start it now, draw when ready
  let rdkit = null;
  const rdkitReady = (typeof initRDKitModule === "function" ? initRDKitModule({ locateFile: () => RDKIT_WASM })
    : Promise.reject(new Error("RDKit script not loaded"))).then(m => { rdkit = m; return m; });
  rdkitReady.catch(err => console.error(err));

  let D, presets;
  try {
    [D, presets] = await Promise.all([
      F.load("data/", VERSION),
      fetch("data/presets.json" + VERSION).then(r => r.json()),
      I18N.ready,
    ]);
  } catch (e) {
    console.error(e);
    $("load-status").textContent = I18N.t("load_error");
    return;
  }
  $("load-status").classList.add("hidden");

  const labelName = j => I18N.pick(D.lib.labels[j]);
  const labelById = id => D.labelIndex[id];
  const nUnseen = D.lib.molecules.filter(m => m[2] !== 0).length;

  // ---------- Tabs ----------
  function showTab(which) {
    ["a", "b"].forEach(k => {
      $("tab-" + k).setAttribute("aria-selected", String(k === which));
      $("panel-" + k).classList.toggle("hidden", k !== which);
    });
  }
  $("tab-a").addEventListener("click", () => showTab("a"));
  $("tab-b").addEventListener("click", () => showTab("b"));
  showTab(new URLSearchParams(location.search).get("mode") === "b" ? "b" : "a");

  // ---------- Mode A state ----------
  const A = { want: [], avoid: [], addTo: "want", shown: PAGE, filters: { natural: false, unseen: false } };

  // Training status as small muted text (no colored badge)
  const trainNote = used => '<span class="muted">' + esc(I18N.lang === "zh" ? "（" + I18N.t(used ? "g.train" : "g.unseen") + "）"
    : "(" + I18N.t(used ? "g.train" : "g.unseen") + ")") + "</span>";
  // Predicted descriptors as comma-separated text; bold where bold(j) is true
  const predText = (list, bold) => list.map(([j, p]) => {
    const s = esc(labelName(j)) + " " + Math.round(100 * p) + "%";
    return bold && bold(j) ? "<b>" + s + "</b>" : s;
  }).join(I18N.lang === "zh" ? "、" : ", ");

  function renderPresets() {
    const box = $("presets-a");
    box.querySelectorAll("button").forEach(b => b.remove());
    presets.mode_a.forEach(p => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "linklike";
      b.textContent = I18N.t("preset." + p.id);
      b.addEventListener("click", () => {
        A.want = p.want.map(x => x.slice());
        A.avoid = [];
        A.shown = PAGE;
        renderA();
      });
      box.appendChild(b);
    });
  }

  function renderLabelList() {
    const q = $("label-filter").value.trim().toLowerCase();
    const used = new Set(A.want.concat(A.avoid).map(x => x[0]));
    const items = D.lib.labels.map((l, j) => ({ l, j }))
      .filter(({ l }) => !used.has(l.id) && (!q || l.id.includes(q) || l.en.toLowerCase().includes(q) || l.zh.includes(q)))
      .sort((a, b) => labelName(a.j).localeCompare(labelName(b.j), I18N.lang === "zh" ? "zh" : "en"));
    $("label-list").innerHTML = items.map(({ l, j }) =>
      '<button type="button" class="chip-btn" data-add="' + esc(l.id) + '">' + esc(labelName(j)) + "</button>").join("");
  }
  $("label-list").addEventListener("click", e => {
    const b = e.target.closest("[data-add]");
    if (!b) return;
    A[A.addTo].push([b.dataset.add, "high"]);
    A.shown = PAGE;
    renderA();
  });
  $("label-filter").addEventListener("input", renderLabelList);
  ["want", "avoid"].forEach(k => $("add-" + k).addEventListener("click", () => {
    A.addTo = k;
    $("add-want").setAttribute("aria-pressed", String(k === "want"));
    $("add-avoid").setAttribute("aria-pressed", String(k === "avoid"));
  }));

  function renderSel(kind) {
    const list = A[kind];
    $(kind + "-list").innerHTML = !list.length ? '<span class="small muted">' + esc(I18N.t("a.none_selected")) + "</span>"
      : list.map(([id, w], k) => '<span class="sel-item' + (kind === "avoid" ? " avoid" : "") + '">' + esc(labelName(labelById(id))) +
        ' <select data-w="' + kind + ":" + k + '" aria-label="weight">' +
        ["high", "mid", "low"].map(x => '<option value="' + x + '"' + (x === w ? " selected" : "") + ">" + esc(I18N.t("w." + x)) + "</option>").join("") +
        '</select><button type="button" class="x" data-rm="' + kind + ":" + k + '" aria-label="' + esc(I18N.t("a.remove")) + '">×</button></span>').join("");
  }
  ["want-list", "avoid-list"].forEach(id => {
    $(id).addEventListener("change", e => {
      const s = e.target.closest("[data-w]");
      if (!s) return;
      const [kind, k] = s.dataset.w.split(":");
      A[kind][+k][1] = s.value;
      runA();
    });
    $(id).addEventListener("click", e => {
      const b = e.target.closest("[data-rm]");
      if (!b) return;
      const [kind, k] = b.dataset.rm.split(":");
      A[kind].splice(+k, 1);
      A.shown = PAGE;
      renderA();
    });
  });
  $("clear-sel").addEventListener("click", () => { A.want = []; A.avoid = []; A.shown = PAGE; renderA(); });
  ["natural", "unseen"].forEach(k => $("f-" + k).addEventListener("change", e => {
    A.filters[k] = e.target.checked;
    A.shown = PAGE;
    runA();
  }));
  $("a-more").addEventListener("click", () => { A.shown = Math.min(MAX_SHOWN, A.shown + PAGE); runA(); });

  // ---------- Results ----------
  const svgCache = new Map();
  function drawInto(el, smiles, big) {
    const key = (big ? "L:" : "S:") + smiles;
    if (svgCache.has(key)) { el.innerHTML = svgCache.get(key); return; }
    if (!rdkit) { el.textContent = I18N.t("r.drawing"); rdkitReady.then(() => drawInto(el, smiles, big), () => { el.textContent = I18N.t("r.no_draw"); }); return; }
    let svg = null;
    const mol = rdkit.get_mol(smiles);
    if (mol) {
      const size = big ? { width: 280, height: 210, bondLineWidth: 1.6 } : { width: 120, height: 90, bondLineWidth: 1.2 };
      try { svg = mol.get_svg_with_highlights(JSON.stringify(Object.assign(size, { clearBackground: false, addStereoAnnotation: false }))); }
      finally { mol.delete(); }
    }
    if (svg) svgCache.set(key, svg);
    el.innerHTML = svg || esc(I18N.t("r.no_draw"));
  }

  function resultCard(rank, hit, wantIds) {
    const m = F.molecule(D, hit.index);
    const top = F.topLabels(D, hit.index, TOP_PRED);
    const foods = m.foods.length
      ? esc(I18N.t("r.foods")) + ": " + esc(m.foods.slice(0, FOODS_SHOWN).join(", ")) +
        (m.foods.length > FOODS_SHOWN ? " " + esc(I18N.t("r.foods_more", { n: m.foods.length - FOODS_SHOWN })) : "")
      : '<span class="muted">' + esc(I18N.t("r.no_foods")) + "</span>";
    const badge = trainNote(m.group === 0);
    return '<div class="card res"><div class="svg" data-smiles="' + esc(m.smiles) + '"></div><div>' +
      '<p class="small muted" style="margin:0">' + esc(I18N.t("r.rank", { n: rank })) + " · " + esc(I18N.t("r.score")) + " <b>" + (100 * hit.score).toFixed(1) + "</b> " + badge + "</p>" +
      '<p class="name">' + esc(m.name || m.smiles) + "</p>" +
      (m.name ? '<p class="smi mono">' + esc(m.smiles) + "</p>" : "") +
      '<div class="meta"><span class="muted">' + esc(I18N.t("r.top")) + '</span><div class="preds">' +
      predText(top, j => wantIds.has(D.lib.labels[j].id)) +
      "</div>" + foods + "</div></div></div>";
  }

  const LOW_SCORE = 0.1;

  function runA() {
    if (!A.want.length) {
      $("a-summary").textContent = I18N.t("a.need_want");
      $("a-results").innerHTML = "";
      $("a-low").classList.add("hidden");
      $("a-more").classList.add("hidden");
      return;
    }
    const hits = F.scoreA(D, A.want, A.avoid, A.filters);
    const shown = Math.min(A.shown, hits.length);
    $("a-summary").textContent = I18N.t("a.summary", { n: hits.length, shown });
    // best score below 10 (of 100): no molecule has all the wanted descriptors
    $("a-low").classList.toggle("hidden", !(hits.length && hits[0].score < LOW_SCORE));
    const wantIds = new Set(A.want.map(x => x[0]));
    $("a-results").innerHTML = hits.slice(0, shown).map((h, k) => resultCard(k + 1, h, wantIds)).join("");
    $("a-results").querySelectorAll(".svg").forEach(el => drawInto(el, el.dataset.smiles));
    $("a-more").classList.toggle("hidden", shown >= hits.length || shown >= MAX_SHOWN);
  }

  function renderA() {
    renderPresets();
    renderLabelList();
    renderSel("want");
    renderSel("avoid");
    $("f-unseen-label").title = I18N.t("f.unseen_help", { n: nUnseen });
    runA();
  }

  // ---------- Mode B: substitutes ----------
  const HI_COLOR = "#c2410c";   // = --hi in style.css
  const B = { query: null, result: null, open: new Set(), preset: null, suggest: [], active: -1 };
  const nameIndex = D.lib.molecules.map((m, i) => ({ i, name: (m[1] || "").toLowerCase(), smiles: m[0] }));
  let engine = null;   // {spec, session} for SMILES input, loaded on first use

  function renderPresetsB() {
    const box = $("presets-b");
    box.querySelectorAll("button").forEach(b => b.remove());
    presets.mode_b.forEach(p => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "linklike" + (B.preset === p.id ? " on" : "");
      b.textContent = I18N.t("presetb." + p.id);
      b.addEventListener("click", () => { B.preset = p.id; $("b-input").value = D.lib.molecules[p.index][1]; queryLibrary(p.index); });
      box.appendChild(b);
    });
    $("b-bg").classList.toggle("hidden", !B.preset);
    if (B.preset) {
      $("b-bg-text").textContent = I18N.t("bg." + B.preset);
      $("b-bg-src").innerHTML = I18N.t("src." + B.preset);   // own trusted strings (links)
    }
  }

  function setStatusB(key, vars, isError) {
    $("b-status").textContent = key ? I18N.t(key, vars) : "";
    $("b-status").classList.toggle("error", !!isError);
  }

  // name suggestions from the library
  function suggest() {
    const q = $("b-input").value.trim().toLowerCase();
    B.suggest = q.length < 2 ? [] : nameIndex.filter(x => x.name.includes(q) || x.smiles === $("b-input").value.trim())
      .sort((a, b) => (b.name.startsWith(q) - a.name.startsWith(q)) || a.name.length - b.name.length).slice(0, 8);
    B.active = -1;
    renderSuggest();
  }
  function renderSuggest() {
    const box = $("b-suggest");
    box.classList.toggle("hidden", !B.suggest.length);
    $("b-input").setAttribute("aria-expanded", String(!!B.suggest.length));
    box.innerHTML = B.suggest.map((x, k) => '<button type="button" role="option" data-pick="' + x.i + '" class="' + (k === B.active ? "active" : "") + '">' +
      esc(D.lib.molecules[x.i][1] || x.smiles) + '<span class="smi mono">' + esc(x.smiles) + "</span></button>").join("");
  }
  $("b-input").addEventListener("input", suggest);
  $("b-input").addEventListener("keydown", e => {
    if (!B.suggest.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      B.active = (B.active + (e.key === "ArrowDown" ? 1 : -1) + B.suggest.length) % B.suggest.length;
      renderSuggest();
    } else if (e.key === "Escape") { B.suggest = []; renderSuggest(); }
  });
  $("b-suggest").addEventListener("click", e => {
    const b = e.target.closest("[data-pick]");
    if (!b) return;
    B.preset = null;
    $("b-input").value = D.lib.molecules[+b.dataset.pick][1] || D.lib.molecules[+b.dataset.pick][0];
    queryLibrary(+b.dataset.pick);
  });
  document.addEventListener("click", e => { if (!e.target.closest("#b-form")) { B.suggest = []; renderSuggest(); } });

  $("b-form").addEventListener("submit", async e => {
    e.preventDefault();
    const q = $("b-input").value.trim();
    if (!q) return;
    B.preset = null;
    if (B.active >= 0 && B.suggest[B.active]) return queryLibrary(B.suggest[B.active].i);
    const exact = nameIndex.find(x => x.name === q.toLowerCase() || x.smiles === q);
    if (exact) return queryLibrary(exact.i);
    await querySmiles(q);
  });

  function queryLibrary(i) {
    B.suggest = [];
    renderSuggest();
    setStatusB(null);
    B.query = { index: i, smiles: D.lib.molecules[i][0], name: D.lib.molecules[i][1], vec: F.vector(D, i), note: null };
    B.result = F.neighbours(D, B.query.vec, F.fpBits(D, i), i);
    B.open = new Set();
    renderB();
    $("b-out").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** SMILES not in the library: RDKit.js fingerprint + the odor-predictor model in the browser. */
  async function querySmiles(q) {
    B.suggest = [];
    renderSuggest();
    $("b-go").disabled = true;
    try {
      setStatusB("b.loading_model");
      let rd;
      try { rd = await rdkitReady; } catch (err) { setStatusB("b.need_rdkit", null, true); return; }
      const probe = rd.get_mol(q);
      const valid = probe && probe.is_valid();
      if (probe) probe.delete();
      if (!valid || /\s/.test(q)) { setStatusB(/[a-z]{3,}/i.test(q) && !/[=#()\[\]]/.test(q) ? "b.not_found" : "b.invalid", { q }, true); return; }
      if (!engine) {
        const spec = await fetch("../odor-predictor/model/feature_spec.json" + VERSION).then(r => r.json());
        engine = { spec, session: await OdorEngine.loadModel("../odor-predictor/model/" + spec.model_file) };
      }
      setStatusB("b.computing");
      const { mol, fragmentsRemoved } = OdorEngine.parseLargestFragment(rd, q);
      let smiles, bits, probs;
      try {
        smiles = mol.get_smiles();
        bits = F.bitsFromString(mol.get_morgan_fp(JSON.stringify({ radius: 2, nBits: 2048 })));
        probs = await OdorEngine.predict(engine.session, OdorEngine.featurizeMol(mol, engine.spec), engine.spec);
      } finally { mol.delete(); }
      // same structure already in the library (identical fingerprint and canonical SMILES): use its data
      const libHit = D.lib.molecules.findIndex((m, i) => F.tanimoto(bits, F.fpBits(D, i)) === 1 && canonicalIs(rd, m[0], smiles));
      if (libHit >= 0) {
        queryLibrary(libHit);
        setStatusB("b.query_lib_match");
        return;
      }
      B.query = { index: -1, smiles, name: null, vec: Float64Array.from(probs), note: fragmentsRemoved ? "b.fragments" : null };
      B.result = F.neighbours(D, B.query.vec, bits, -1);
      B.open = new Set();
      setStatusB(null);
      renderB();
      $("b-out").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      console.error(err);
      const code = err && err.code;
      setStatusB(code === "too_many_atoms" ? "b.too_big" : code === "unsupported_element" ? "b.unsupported" : "b.invalid",
        { q, n: engine ? engine.spec.max_atoms : 64 }, true);
    } finally {
      $("b-go").disabled = false;
    }
  }
  function canonicalIs(rd, libSmiles, smiles) {
    const m = rd.get_mol(libSmiles);
    if (!m) return false;
    try { return m.get_smiles() === smiles; } finally { m.delete(); }
  }

  function scatterSvg(res, exclude) {
    const W = 560, H = 370, l = 58, r = 14, t = 12, b = 52;
    const x = v => l + v * (W - l - r), y = v => t + (1 - v) * (H - t - b);
    const thr = D.lib.odor_threshold, tmax = D.lib.tanimoto_max_for_highlight;
    const top = new Map(res.top.map(h => [h.index, h]));
    let s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(I18N.t("b.scatter_title")) + '">';
    s += '<rect x="' + x(0) + '" y="' + y(1) + '" width="' + (x(tmax) - x(0)) + '" height="' + (y(thr) - y(1)) + '" fill="' + HI_COLOR + '" fill-opacity=".08"/>';
    for (let v = 0; v <= 1.0001; v += 0.2) {
      s += '<line x1="' + x(0) + '" x2="' + x(1) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--border)"/>' +
        '<text x="' + (l - 6) + '" y="' + (y(v) + 4) + '" font-size="13" text-anchor="end" fill="var(--muted)">' + v.toFixed(1) + "</text>" +
        '<text x="' + x(v) + '" y="' + (H - b + 18) + '" font-size="13" text-anchor="middle" fill="var(--muted)">' + v.toFixed(1) + "</text>";
    }
    s += '<line x1="' + x(0) + '" x2="' + x(1) + '" y1="' + y(thr) + '" y2="' + y(thr) + '" stroke="' + HI_COLOR + '" stroke-dasharray="4 3"/>' +
      '<line x1="' + x(tmax) + '" x2="' + x(tmax) + '" y1="' + y(0) + '" y2="' + y(1) + '" stroke="' + HI_COLOR + '" stroke-dasharray="4 3"/>';
    let pts = "";
    for (let i = 0; i < D.n; i++) {
      if (i === exclude || top.has(i)) continue;
      pts += '<circle cx="' + x(res.struct[i]).toFixed(1) + '" cy="' + y(Math.max(0, res.odor[i])).toFixed(1) + '" r="1.6"/>';
    }
    s += '<g fill="var(--muted)" fill-opacity=".28">' + pts + "</g>";
    res.top.slice().reverse().forEach(h => {
      const nm = D.lib.molecules[h.index][1] || D.lib.molecules[h.index][0];
      s += '<circle cx="' + x(h.tanimoto).toFixed(1) + '" cy="' + y(h.odor).toFixed(1) + '" r="' + (h.highlight ? 6 : 4.5) + '" fill="' + (h.highlight ? HI_COLOR : "var(--accent)") +
        '" stroke="#fff" stroke-width="1"><title>' + esc(nm + " · " + I18N.t("b.odor") + " " + h.odor.toFixed(3) + " · " + I18N.t("b.struct") + " " + h.tanimoto.toFixed(2)) + "</title></circle>";
    });
    s += '<text x="' + ((l + W - r) / 2) + '" y="' + (H - 6) + '" font-size="15" text-anchor="middle" fill="var(--text)">' + esc(I18N.t("b.axis_x")) + "</text>" +
      '<text transform="translate(14 ' + ((t + H - b) / 2) + ') rotate(-90)" font-size="15" text-anchor="middle" fill="var(--text)">' + esc(I18N.t("b.axis_y")) + "</text>";
    return s + "</svg>";
  }

  /** Two-series radar: dims = union of each molecule's top 6 descriptors; scale 0 to the larger value, rounded up to 20%. */
  function radarSvg(qv, cv, qName, cName) {
    const dims = [...new Set(F.topLabelsOf(qv, 6).concat(F.topLabelsOf(cv, 6)).map(x => x[0]))];
    const top = Math.max(0.2, Math.ceil(5 * Math.max(...dims.map(j => Math.max(qv[j], cv[j]))) - 1e-9) / 5);
    const n = dims.length, size = 320, c = size / 2, rad = c - 70;
    const pt = (k, f) => { const a = -Math.PI / 2 + (2 * Math.PI * k) / n; return [c + rad * f * Math.cos(a), c + rad * f * Math.sin(a)]; };
    const poly = v => dims.map((j, k) => pt(k, v[j] / top).map(z => z.toFixed(1)).join(",")).join(" ");
    let s = '<svg viewBox="0 0 ' + size + " " + size + '" role="img">';
    for (let g = 1; g <= 4; g++) s += '<polygon points="' + dims.map((_, k) => pt(k, g / 4).join(",")).join(" ") + '" fill="none" stroke="var(--border)"/>';
    dims.forEach((j, k) => {
      const [lx, ly] = pt(k, 1.14);
      s += '<text x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" font-size="11" text-anchor="' + (Math.abs(lx - c) < 4 ? "middle" : lx > c ? "start" : "end") +
        '" dominant-baseline="middle" fill="var(--text)">' + esc(labelName(j)) + "</text>";
    });
    s += '<polygon points="' + poly(qv) + '" fill="var(--accent)" fill-opacity=".18" stroke="var(--accent)" stroke-width="2"/>';
    s += '<polygon points="' + poly(cv) + '" fill="' + HI_COLOR + '" fill-opacity=".14" stroke="' + HI_COLOR + '" stroke-width="2" stroke-dasharray="5 3"/>';
    return s + '</svg><div class="legend small"><span><i style="background:var(--accent)"></i>' + esc(qName) + '</span><span><i style="background:' + HI_COLOR + '"></i>' +
      esc(cName) + '</span></div><p class="small muted" style="margin:4px 0 0">' + esc(I18N.t("b.radar_note", { max: Math.round(100 * top) })) + "</p>";
  }

  function renderB() {
    renderPresetsB();
    const out = $("b-out");
    out.classList.toggle("hidden", !B.query);
    if (!B.query) return;
    const q = B.query, res = B.result;
    const qName = q.name || I18N.t("b.query_new");
    const top = F.topLabelsOf(q.vec, TOP_PRED);
    const qBadge = q.index < 0 ? "" : " " + trainNote(D.lib.molecules[q.index][2] === 0);
    $("b-query").innerHTML = '<h3 style="margin-top:0">' + esc(I18N.t("b.query")) + '</h3><div class="qsvg svg" data-smiles="' + esc(q.smiles) + '" data-big="1"></div>' +
      '<p class="name" style="font-weight:700;margin:6px 0 0">' + esc(qName) + qBadge + '</p><p class="smi mono small muted" style="word-break:break-all;margin:2px 0 6px">' + esc(q.smiles) + "</p>" +
      '<div class="preds">' + predText(top) + "</div>" +
      (q.note ? '<p class="small muted">' + esc(I18N.t(q.note)) + "</p>" : "");
    drawInto($("b-query").querySelector(".svg"), q.smiles, true);
    $("b-scatter").innerHTML = scatterSvg(res, q.index);
    $("b-legend").innerHTML = '<span><i style="background:var(--muted);opacity:.4"></i>' + esc(I18N.t("b.legend_all")) + '</span><span><i style="background:var(--accent)"></i>' +
      esc(I18N.t("b.legend_top")) + '</span><span><i style="background:' + HI_COLOR + '"></i>' + esc(I18N.t("b.legend_hi")) + "</span>";
    const thr = D.lib.odor_threshold.toFixed(3);
    $("b-rule").textContent = I18N.t("b.rule", { thr });
    const nHi = res.top.filter(h => h.highlight).length;
    $("b-hi-summary").textContent = nHi ? I18N.t("b.hi_count", { n: nHi }) : I18N.t("b.hi_none", { thr });
    $("b-results").innerHTML = res.top.map((h, k) => {
      const m = F.molecule(D, h.index);
      const preds = F.topLabels(D, h.index, TOP_PRED);
      const foods = m.foods.length
        ? esc(I18N.t("r.foods")) + ": " + esc(m.foods.slice(0, FOODS_SHOWN).join(", ")) + (m.foods.length > FOODS_SHOWN ? " " + esc(I18N.t("r.foods_more", { n: m.foods.length - FOODS_SHOWN })) : "")
        : '<span class="muted">' + esc(I18N.t("r.no_foods")) + "</span>";
      const badge = trainNote(m.group === 0);
      const open = B.open.has(h.index);
      return '<div class="card res' + (h.highlight ? " hi" : "") + '"><div class="svg" data-smiles="' + esc(m.smiles) + '"></div><div>' +
        '<p class="small muted" style="margin:0">' + esc(I18N.t("r.rank", { n: k + 1 })) + " · " + esc(I18N.t("b.odor")) + " <b>" + h.odor.toFixed(3) + "</b> · " +
        esc(I18N.t("b.struct")) + " <b>" + h.tanimoto.toFixed(2) + "</b></p>" +
        (h.highlight ? '<span class="hi-text">' + esc(I18N.t("b.hi_badge")) + "</span> " : "") + badge +
        '<p class="name">' + esc(m.name || m.smiles) + "</p>" + (m.name ? '<p class="smi mono">' + esc(m.smiles) + "</p>" : "") +
        '<div class="meta"><div class="preds">' + predText(preds) + "</div>" + foods +
        '<div><button type="button" class="linklike small" data-cmp="' + h.index + '" style="margin-top:6px">' + esc(I18N.t(open ? "b.compare_hide" : "b.compare")) + "</button></div></div></div>" +
        (open ? '<div class="radar">' + radarSvg(q.vec, F.vector(D, h.index), qName, m.name || m.smiles) + "</div>" : "") + "</div>";
    }).join("");
    $("b-results").querySelectorAll(".svg").forEach(el => drawInto(el, el.dataset.smiles));
  }
  $("b-results").addEventListener("click", e => {
    const b = e.target.closest("[data-cmp]");
    if (!b) return;
    const i = +b.dataset.cmp;
    if (B.open.has(i)) B.open.delete(i); else B.open.add(i);
    renderB();
  });

  // deep link from other pages: ?mode=b&smiles=... (stage 6)
  const linkSmiles = new URLSearchParams(location.search).get("smiles");
  if (linkSmiles) {
    $("b-input").value = linkSmiles;
    const hit = nameIndex.find(x => x.smiles === linkSmiles);
    if (hit) queryLibrary(hit.i); else querySmiles(linkSmiles);
  }

  function renderAll() { renderA(); renderB(); }
  renderAll();
  I18N.onChange(renderAll);
  window.__finder = { D, A, B, runA, queryLibrary, querySmiles };   // tests and checks
})();
