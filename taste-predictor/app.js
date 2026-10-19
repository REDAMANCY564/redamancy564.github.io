/*
 * Taste predictor page.
 * - Presets: precomputed predictions from data/presets.json (deployed model, plus the
 *   train-split-only model for molecules held out during evaluation) and dataset labels
 * - Search: name / CAS (resolved via PubChem) or SMILES, standardized and predicted live in
 *   the browser with engine.js. Parity with Python is checked by tests/parity.html.
 * - Atom contributions (occlusion, assets/contrib.js): precomputed for presets on the
 *   standardized structure, computed live for searches; drawn on that structure.
 */
(async function () {
  const RDKIT_WASM = "https://cdn.jsdelivr.net/npm/@rdkit/rdkit@2026.3.6/dist/RDKit_minimal.wasm";
  const PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/";
  const ACCENT = "#0f6e6e";
  const HELDOUT = "#9cc9c4";

  const $ = id => document.getElementById(id);

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load " + url);
    return res.json();
  }

  // Start RDKit (large WASM) in parallel with the data; the preset view works without it.
  let rdkit = null;
  let rdkitFailed = false;
  const rdkitReady = (typeof initRDKitModule === "function"
    ? initRDKitModule({ locateFile: () => RDKIT_WASM })
    : Promise.reject(new Error("RDKit script not loaded")))
    .then(mod => { rdkit = mod; return mod; })
    .catch(err => { rdkitFailed = true; console.error(err); throw err; });
  rdkitReady.catch(() => {});

  const [presets, labels, spec] = await Promise.all([
    getJson("data/presets.json"),
    getJson("model/labels.json"),
    getJson("model/feature_spec.json"),
    I18N.ready,
  ]);
  const ids = labels.map(l => l.id);
  const labelName = id => {
    const l = labels.find(x => x.id === id);
    return l ? I18N.pick(l) : I18N.t("taste." + id);
  };

  // The molecule currently shown. Presets come straight from presets.json;
  // search results have {source: "search", smiles, title, pubchem_cid, probs}.
  let current = presets[0];
  let chart = null;
  const topTaste = () => ids.reduce((a, b) => (current.probs[b] > current.probs[a] ? b : a));
  let selected = topTaste();  // taste whose atom contributions are shown
  // The structure that was featurized: standardized for presets, as returned by the engine for searches
  const drawn = () => current.std_smiles || current.smiles;

  // ---------- Model (lazy: loaded on first search) ----------
  let sessionPromise = null;
  function getSession() {
    if (!sessionPromise) {
      sessionPromise = TasteEngine.loadModel("model/" + spec.model_file);
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

  function renderStructure() {
    const box = $("mol-svg");
    if (rdkit) {
      const svg = ContribView.drawSvg(rdkit, drawn(), current.contrib && current.contrib[selected]);
      if (svg) { box.innerHTML = svg; return; }
    }
    box.textContent = rdkitFailed ? I18N.t("demo.rdkit_failed") : I18N.t("demo.loading_rdkit");
  }

  function selectTaste(id) {
    selected = id;
    renderStructure();
    renderContrib();
  }

  function renderContrib() {
    ContribView.renderPicker($("contrib-picker"), ids, selected, labelName, selectTaste);
    ContribView.renderLegend($("contrib-legend"), current.contrib && current.contrib[selected], labelName(selected));
  }

  // A held-out comparison is shown only when the train-split-only model never saw the molecule
  const heldOut = () => current.source !== "search" && ["valid", "test"].includes(current.dataset_split);

  function renderChart() {
    const pct = obj => ids.map(id => Math.round(obj[id] * 1000) / 10);
    const datasets = [{ label: I18N.t("chart.deployed"), data: pct(current.probs), backgroundColor: ACCENT,
                        borderRadius: 4, maxBarThickness: 26 }];
    if (heldOut()) {
      datasets.push({ label: I18N.t("chart.heldout"), data: pct(current.probs_train_only),
                      backgroundColor: HELDOUT, borderRadius: 4, maxBarThickness: 26 });
    }
    const names = ids.map(labelName);
    if (chart) chart.destroy();
    chart = new Chart($("pred-chart"), {
      type: "bar",
      data: { labels: names, datasets },
      options: {
        indexAxis: "y",
        maintainAspectRatio: false,
        animation: { duration: 300 },
        onClick: (evt, els) => { if (els.length) selectTaste(ids[els[0].index]); },
        onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? "pointer" : "default"; },
        plugins: {
          legend: { display: datasets.length > 1, position: "bottom", labels: { boxWidth: 12 } },
          tooltip: { callbacks: { label: ctx => ctx.dataset.label + ": " + ctx.parsed.x.toFixed(1) + "%" } },
        },
        scales: {
          x: { min: 0, max: 100, ticks: { callback: v => v + "%" }, grid: { color: "#eee" } },
          y: { grid: { display: false }, ticks: { font: { size: 14 } } },
        },
      },
    });
    $("chart-note").textContent = I18N.t("demo.prob_note") + (heldOut() ? " " + I18N.t("demo.heldout_note") : "");
  }

  function renderSourNote() {
    const box = $("sour-note");
    const ss = current.source === "search" ? null : current.dataset_sour_salty;
    const found = ss ? ["sour", "salty"].filter(k => ss[k] === 1) : [];
    box.hidden = !found.length;
    if (found.length) {
      box.textContent = I18N.t("demo.sour_note", { tastes: found.map(k => I18N.t("taste." + k)).join(I18N.t("list.sep")) });
    }
  }

  function renderInfo() {
    const name = current.source === "search"
      ? (current.title || current.smiles)
      : (I18N.lang === "zh" ? current.name_zh + "  " + current.name_en : current.name_en);
    $("mol-name").textContent = name;
    $("mol-smiles").textContent = drawn();
    const rawForm = $("mol-raw");
    rawForm.hidden = drawn() === current.smiles;
    if (!rawForm.hidden) rawForm.textContent = I18N.t("demo.raw_form", { smiles: current.smiles });
    const link = $("mol-pubchem");
    link.hidden = !current.pubchem_cid;
    if (current.pubchem_cid) link.href = "https://pubchem.ncbi.nlm.nih.gov/compound/" + current.pubchem_cid;
    $("mol-odor").href = "../odor-predictor/?q=" + encodeURIComponent(drawn()) + "#demo";

    const status = $("mol-status");
    status.innerHTML = "";
    const msg = document.createElement("div");
    status.appendChild(msg);
    if (current.source === "search") {
      msg.textContent = I18N.t("status.search");
      status.classList.remove("warn");
      return;
    }
    const split = current.dataset_split;
    msg.textContent = I18N.t(split ? "status." + split : "status.none");
    status.classList.toggle("warn", split === "train");
    if (!current.dataset_labels) return;

    const lab = Object.assign({}, current.dataset_labels, current.dataset_sour_salty || {});
    const pos = ids.concat(["sour", "salty"]).filter(k => lab[k] === 1);
    const head = document.createElement("div");
    head.style.marginTop = "6px";
    head.textContent = I18N.t("status.labels");
    // Recorded tastes as plain text; the four modeled tastes in bold
    pos.forEach((k, i) => {
      if (i) head.append(I18N.t("list.comma"));
      else head.append(" ");
      const c = document.createElement(ids.includes(k) ? "b" : "span");
      c.textContent = ids.includes(k) ? labelName(k) : I18N.t("taste." + k);
      head.appendChild(c);
    });
    const raw = document.createElement("details");
    raw.className = "raw-labels small";
    const sum = document.createElement("summary");
    sum.textContent = I18N.t("status.raw");
    const ul = document.createElement("ul");
    current.dataset_raw_labels.forEach(r => {
      const li = document.createElement("li");
      li.textContent = r.replace(/^Chem:/, "ChemTastesDB: ").replace(/^Virt:/, "VirtuousMultiTaste: ");
      ul.appendChild(li);
    });
    raw.append(sum, ul);
    status.append(head, raw);
  }

  function renderDemo() {
    renderInfo();
    renderStructure();
    renderContrib();
    renderChart();
    renderSourNote();
  }

  $("preset").addEventListener("change", e => {
    current = presets.find(p => p.id === e.target.value) || presets[0];
    selected = topTaste();
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

  function elementSymbol(z) {
    const mol = rdkit.get_mol("[#" + z + "]");
    if (!mol) return String(z);
    const s = mol.get_smiles().replace(/[\[\]]/g, "");
    mol.delete();
    return s;
  }

  async function runSearch(raw) {
    const q = raw.trim();
    if (!q) { setSearchStatus("err.empty", null, true); return; }
    const btn = $("search-btn");
    btn.disabled = true;
    try {
      setSearchStatus("search.loading_model");
      const [rd, session] = await Promise.all([rdkitReady, getSession()]).catch(e => {
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
          const looksLikeName = /[a-z]{3,}/.test(q) || /^\d{2,7}-\d{2}-\d$/.test(q);
          if (e.code === "not_found" && !looksLikeName) e.code = "invalid_smiles";
          throw e;
        }
      }

      setSearchStatus("search.predicting");
      const std = TasteEngine.standardizedFeatures(rd, smiles, spec);
      const { probs: out, contrib } = await TasteEngine.occlusion(session, std.feats, spec);
      current = {
        source: "search", smiles: std.smiles, title, pubchem_cid: cid,
        probs: Object.fromEntries(ids.map((id, j) => [id, out[j]])),
        contrib: Object.fromEntries(ids.map((id, j) => [id, contrib.map(c => c[j])])),
      };
      selected = topTaste();
      const keys = [asSmiles ? "search.done_smiles" : "search.done_name"];
      if (std.fragmentsRemoved) keys.push("search.fragments");
      if (std.neutralized) keys.push("search.neutralized");
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
  rdkitReady.then(renderStructure, renderStructure);

  // Shareable links: ?q=<name|CAS|SMILES> runs a search on load (used by the odor page)
  const q0 = new URLSearchParams(location.search).get("q");
  if (q0) {
    $("search-input").value = q0;
    runSearch(q0);
  }
})();
