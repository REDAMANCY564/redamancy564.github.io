/*
 * Odor predictor page.
 * - Preset molecules: precomputed predictions from data/presets.json (+ literature thresholds)
 * - Search: name / CAS (resolved via PubChem) or SMILES, predicted live in the browser
 *   with engine.js (RDKit.js features + onnxruntime-web). Parity with Python is checked
 *   by tests/parity.html.
 * - Atom contributions (occlusion): precomputed for presets, computed live for searches;
 *   the selected descriptor's contributions color the structure drawing.
 */
(async function () {
  const PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/";
  const ACCENT = "#0f6e6e";
  const ACCENT_LIGHT = "#9cc9c4";
  const TOP_K = 8;
  const CONTRIB = window.ContribView;

  const $ = id => document.getElementById(id);

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load " + url);
    return res.json();
  }

  // RDKit (large WASM) loads when a structure is first needed: the structure box comes into view or
  // a molecule is entered. The preset view (text and chart) works without it.
  let rdkit = null;
  let rdkitFailed = false;
  let rdkitPromise = null;
  function rdkitReady() {
    if (!rdkitPromise) {
      rdkitPromise = Libs.rdkit()
        .then(mod => { rdkit = mod; return mod; })
        .catch(err => { rdkitFailed = true; rdkitPromise = null; console.error(err); throw err; });
      rdkitPromise.then(renderStructure, renderStructure);
    }
    return rdkitPromise;
  }

  const [presets, labels, spec] = await Promise.all([
    getJson("data/presets.json"),
    getJson("model/labels.json"),
    getJson("model/feature_spec.json"),
    I18N.ready,
  ]);
  const labelById = Object.fromEntries(labels.map(l => [l.id, l]));
  const labelName = id => (labelById[id] ? I18N.pick(labelById[id]) : id);

  // The molecule currently shown. Presets come straight from presets.json;
  // search results have the same shape with source: "search".
  let current = presets[0];
  let chart = null;
  let selected = current.top[0].label;  // descriptor whose atom contributions are shown

  // ---------- Model (lazy: loaded on first search) ----------
  let sessionPromise = null;
  function getSession() {
    if (!sessionPromise) {
      sessionPromise = OdorEngine.loadModel("model/" + spec.model_file);
      sessionPromise.catch(() => { sessionPromise = null; });
    }
    return sessionPromise;
  }

  // ---------- Demo rendering ----------
  function renderSelect() {
    const sel = $("preset");
    sel.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = "";
    ph.disabled = true;
    ph.hidden = true;
    ph.textContent = I18N.t("demo.select_placeholder");
    sel.appendChild(ph);
    presets.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = I18N.lang === "zh" ? p.name_zh + " (" + p.name_en + ")" : p.name_en;
      sel.appendChild(opt);
    });
    sel.value = current.source === "search" ? "" : current.id;
  }

  // The first view (first preset, its top descriptor) is drawn in advance (tools/snapshot.py, key
  // snap.mol-svg), so RDKit is only loaded when the visitor shows another molecule or descriptor.
  const firstView = current.id + "|" + selected;
  function renderStructure() {
    const box = $("mol-svg");
    const contrib = current.contrib && current.contrib[selected];
    if (rdkit) {
      const svg = CONTRIB.drawSvg(rdkit, current.smiles, contrib);
      if (svg) { box.innerHTML = svg; return; }
    }
    const snap = I18N.snap("mol-svg");
    if (current.id + "|" + selected === firstView && snap !== undefined) { box.innerHTML = snap; return; }
    box.textContent = rdkitFailed ? I18N.t("demo.rdkit_failed") : I18N.t("demo.loading_rdkit");
    if (!rdkitFailed) rdkitReady().catch(() => {});
  }

  function renderContrib() {
    CONTRIB.renderPicker($("contrib-picker"), current.top.map(t => t.label), selected, labelName, id => {
      selected = id;
      renderStructure();
      renderContrib();
      renderChart();
    });
    CONTRIB.renderLegend($("contrib-legend"), current.contrib && current.contrib[selected], labelName(selected));
  }

  function renderChart() {
    const names = current.top.map(t => labelName(t.label));
    const values = current.top.map(t => Math.round(t.prob * 1000) / 10);
    const colors = current.top.map(t => (t.label === selected ? ACCENT : ACCENT_LIGHT));
    if (!chart) {
      chart = new Chart($("pred-chart"), {
        type: "bar",
        data: { labels: names, datasets: [{ data: values, backgroundColor: colors, borderRadius: 4, maxBarThickness: 26 }] },
        options: {
          indexAxis: "y",
          maintainAspectRatio: false,
          animation: { duration: 300 },
          onClick: (evt, els) => {
            if (!els.length) return;
            selected = current.top[els[0].index].label;
            renderStructure();
            renderContrib();
            renderChart();
          },
          onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? "pointer" : "default"; },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => ctx.parsed.x.toFixed(1) + "%" } },
          },
          scales: {
            x: { min: 0, max: 100, ticks: { callback: v => v + "%" }, grid: { color: "#eee" } },
            y: { grid: { display: false }, ticks: { font: { size: 13 } } },
          },
        },
      });
    } else {
      chart.data.labels = names;
      chart.data.datasets[0].data = values;
      chart.data.datasets[0].backgroundColor = colors;
      chart.update();
    }
  }

  function fmtNum(v) {
    return new Intl.NumberFormat(I18N.lang === "zh" ? "zh-CN" : "en-US", { maximumSignificantDigits: 3 }).format(v);
  }

  function renderThreshold() {
    const box = $("mol-threshold");
    const t = current.threshold_water;
    if (!t) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = "";
    const title = document.createElement("div");
    title.className = "thr-title";
    title.textContent = I18N.t("thr.title");
    const value = document.createElement("div");
    value.className = "thr-value";
    value.textContent = I18N.t("thr.value", { v: fmtNum(t.rep_ug_kg), src: t.rep_source });
    const range = document.createElement("div");
    range.className = "small muted";
    range.textContent = I18N.t("thr.range", { min: fmtNum(t.range_ug_kg[0]), max: fmtNum(t.range_ug_kg[1]) });
    box.append(title, value, range);
  }

  function renderInfo() {
    let name;
    if (current.source === "search") {
      name = current.title || current.smiles;
    } else {
      name = I18N.lang === "zh" ? current.name_zh + "  " + current.name_en : current.name_en;
    }
    $("mol-name").textContent = name;
    $("mol-smiles").textContent = current.smiles;
    const link = $("mol-pubchem");
    link.hidden = !current.pubchem_cid;
    if (current.pubchem_cid) link.href = "https://pubchem.ncbi.nlm.nih.gov/compound/" + current.pubchem_cid;
    $("mol-taste").href = "../taste-predictor/?q=" + encodeURIComponent(current.smiles) + "#demo";
    $("mol-finder").href = "../ingredient-finder/?mode=b&smiles=" + encodeURIComponent(current.smiles);
    renderThreshold();

    const status = $("mol-status");
    status.innerHTML = "";
    const msg = document.createElement("div");
    if (current.source === "search") {
      msg.textContent = I18N.t("status.search");
      status.classList.remove("warn");
      status.appendChild(msg);
      return;
    }
    const split = current.dataset_split;
    msg.textContent = I18N.t(split ? "status." + split : "status.none");
    status.appendChild(msg);
    status.classList.toggle("warn", split === "train");

    // Raw dataset labels are not shown (no license allows it): the flavor knowledge base's
    // odor description with its source is shown instead (user decision 2026-10-18)
    const kb = current.kb_odor;
    if (kb && kb.terms && kb.terms.length) {
      const head = document.createElement("div");
      head.style.marginTop = "6px";
      head.textContent = I18N.t("status.kb_" + kb.source, { page: kb.page }) + " " + kb.terms.join(I18N.lang === "zh" ? "、" : ", ");
      status.appendChild(head);
    }
  }

  // ---------- Flavor knowledge base: typical sources + literature ----------
  let kbSeq = 0;
  async function renderKbSources() {
    const my = ++kbSeq;
    const box = $("kb-body");
    box.textContent = I18N.t("kb.loading");
    const fallbackName = current.source === "search" ? current.title : current.name_en;
    try {
      const [rd, kb] = await Promise.all([rdkitReady(), FlavorKB.load()]);
      const mol = rd.get_mol(current.smiles);
      let id = null;
      try { id = mol ? await FlavorKB.findByMol(mol) : null; } finally { if (mol) mol.delete(); }
      if (my !== kbSeq) return;
      box.innerHTML = "";
      if (id) {
        box.append(FlavorKBUI.sourcesSummary(kb, id));
        box.append(FlavorKBUI.literature(FlavorKB.compoundNames(kb.compounds[id]), FlavorKBUI.litFoods(kb, kb.compounds[id])));
      } else {
        box.append(FlavorKBUI.el("p", { text: I18N.t("kb.not_in_kb") }));
        if (fallbackName) box.append(FlavorKBUI.literature([fallbackName], FlavorKBUI.litFoods(kb, null)));
      }
    } catch (e) {
      if (my !== kbSeq) return;
      box.textContent = I18N.t("kb.failed");
    }
  }

  // ---------- Regulatory status (EU, China; assets/regulatory.js) ----------
  // Matched to the site's molecule library by the first block of the InChIKey (no stereo), like the KB panel
  let regSeq = 0;
  async function renderReg() {
    const my = ++regSeq;
    const box = $("reg-body");
    box.textContent = I18N.t("reg.loading");
    try {
      const [rd] = await Promise.all([rdkitReady(), Reg.load()]);
      const mol = rd.get_mol(current.smiles);
      let ik = null;
      try { if (mol) ik = rd.get_inchikey_for_inchi(mol.get_inchi()); } finally { if (mol) mol.delete(); }
      if (my !== regSeq) return;
      box.innerHTML = Reg.html(ik ? Reg.byIk(ik) : null, { outside: true });
    } catch (e) {
      if (my !== regSeq) return;
      box.textContent = I18N.t("reg.load_failed");
    }
  }

  function renderDemo() {
    if (!current.top.some(t => t.label === selected)) selected = current.top[0].label;
    renderInfo();
    renderStructure();
    renderContrib();
    renderChart();
    if (kbSeen) renderKbSources(); else kbPending = true;
    if (regSeen) renderReg(); else regPending = true;
  }
  // The sources and literature panel needs RDKit (to match the molecule) and the knowledge base:
  // filled when it first comes into view, then kept up to date
  let kbSeen = false, kbPending = false, regSeen = false, regPending = false;
  new IntersectionObserver((entries, obs) => {
    if (!entries.some(e => e.isIntersecting)) return;
    obs.disconnect();
    kbSeen = true;
    if (kbPending) renderKbSources();
  }).observe($("kb-body"));
  new IntersectionObserver((entries, obs) => {
    if (!entries.some(e => e.isIntersecting)) return;
    obs.disconnect();
    regSeen = true;
    if (regPending) renderReg();
  }).observe($("reg-body"));

  $("preset").addEventListener("change", e => {
    current = presets.find(p => p.id === e.target.value) || presets[0];
    selected = current.top[0].label;
    setSearchStatus("");
    renderDemo();
  });

  // ---------- Search ----------
  // The last status message is kept as {key, vars, error} so it can be re-translated.
  let searchMsg = null;
  function setSearchStatus(key, vars, isError) {
    searchMsg = key ? { key, vars, isError } : null;
    renderSearchStatus();
  }
  function renderSearchStatus() {
    const el = $("search-status");
    if (!searchMsg) { el.textContent = ""; el.classList.remove("error"); return; }
    el.textContent = [].concat(searchMsg.key).map(k => I18N.t(k, searchMsg.vars)).join(" ");
    el.classList.toggle("error", !!searchMsg.isError);
  }

  async function resolveName(q) {
    let res;
    try {
      res = await fetch(PUBCHEM + encodeURIComponent(q) + "/property/SMILES,Title/JSON");
    } catch (e) {
      throw Object.assign(new Error("network"), { code: "network" });
    }
    if (res.status === 404 || res.status === 400) throw Object.assign(new Error("not_found"), { code: "not_found" });
    if (!res.ok) throw Object.assign(new Error("network"), { code: "network" });
    const p = (await res.json()).PropertyTable.Properties[0];
    return { smiles: p.SMILES, title: p.Title, cid: p.CID };
  }

  function isLikelySmiles(rd, q) {
    if (/\s/.test(q) || !/^[A-Za-z0-9@+\-\[\]()=#$:.\/\\%*]+$/.test(q)) return false;
    const mol = rd.get_mol(q);
    const ok = !!mol && mol.is_valid();
    if (mol) mol.delete();
    return ok;
  }

  async function runSearch(raw) {
    const q = raw.trim();
    if (!q) { setSearchStatus("err.empty", null, true); return; }
    const btn = $("search-btn");
    btn.disabled = true;
    try {
      setSearchStatus("search.loading_model");
      const [rd, session] = await Promise.all([rdkitReady(), getSession()]).catch(e => {
        console.error(e);
        throw Object.assign(new Error("engine"), { code: "engine" });
      });

      let smiles = q, title = null, cid = null;
      const asSmiles = isLikelySmiles(rd, q);
      if (!asSmiles) {
        setSearchStatus("search.resolving", { q });
        try {
          ({ smiles, title, cid } = await resolveName(q));
        } catch (e) {
          // Unknown input that looks like a (broken) SMILES rather than a name or CAS number
          const looksLikeName = /[a-z]{3,}/.test(q) || /^\d{2,7}-\d{2}-\d$/.test(q);
          if (e.code === "not_found" && !looksLikeName) e.code = "invalid_smiles";
          throw e;
        }
      }

      setSearchStatus("search.predicting");
      const { mol, fragmentsRemoved } = OdorEngine.parseLargestFragment(rd, smiles);
      try {
        smiles = mol.get_smiles();
      } finally {
        mol.delete();
      }
      // Featurize the canonical SMILES that is also drawn, so atom indices of the
      // contributions match the drawing (predictions do not depend on atom order)
      const canon = rd.get_mol(smiles);
      let feats;
      try {
        feats = OdorEngine.featurizeMol(canon, spec);
      } finally {
        canon.delete();
      }
      const { probs, contrib } = await OdorEngine.occlusion(session, feats, spec);
      const order = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]).slice(0, TOP_K);

      current = {
        source: "search", smiles, title, pubchem_cid: cid,
        top: order.map(j => ({ label: labels[j].id, prob: probs[j] })),
        contrib: Object.fromEntries(order.map(j => [labels[j].id, contrib.map(c => c[j])])),
      };
      selected = current.top[0].label;
      const keys = [asSmiles ? "search.done_smiles" : "search.done_name"];
      if (fragmentsRemoved) keys.push("search.fragments");
      setSearchStatus(keys, { title, cid });
      renderSelect();
      renderDemo();
      try {
        history.replaceState(null, "", "?q=" + encodeURIComponent(q) + "#demo");
      } catch (err) { /* sandboxed frames may block history: ignore */ }
    } catch (e) {
      const code = e.code || "invalid_smiles";
      const vars = Object.assign({ q }, e.details || {});
      if (code === "unsupported_element" && vars.z) {
        vars.el = vars.z.map(z => (rdkit ? elementSymbol(z) : z)).join(", ");
      }
      setSearchStatus("err." + code, vars, true);
      if (!e.code) console.error(e);
    } finally {
      btn.disabled = false;
    }
  }

  function elementSymbol(z) {
    const mol = rdkit.get_mol("[#" + z + "]");
    if (!mol) return String(z);
    const s = mol.get_smiles().replace(/[\[\]]/g, "");
    mol.delete();
    return s;
  }

  $("search-form").addEventListener("submit", e => {
    e.preventDefault();
    runSearch($("search-input").value);
  });
  document.querySelectorAll("button[data-q]").forEach(b => b.addEventListener("click", () => {
    $("search-input").value = b.dataset.q;
    runSearch(b.dataset.q);
  }));

  // ---------- Init ----------
  function renderAll() {
    renderSelect();
    renderDemo();
    renderSearchStatus();
  }
  renderAll();
  I18N.onChange(renderAll);
  // first use of the demo: start RDKit so the next drawing is quick
  ["pointerdown", "focusin", "keydown"].forEach(ev =>
    $("mol-svg").closest("section").addEventListener(ev, () => { if (!rdkitFailed) rdkitReady().catch(() => {}); }, { once: true, passive: true }));

  // Shareable links: ?q=<name|CAS|SMILES> runs a search on load
  const q0 = new URLSearchParams(location.search).get("q");
  if (q0) {
    $("search-input").value = q0;
    runSearch(q0);
  }
})();
