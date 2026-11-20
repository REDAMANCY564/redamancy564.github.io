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
  const PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/";
  const ACCENT = "#0f6e6e";
  const HELDOUT = "#9cc9c4";

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

  // ---------- Training data lookup (lazy: loaded on first search) ----------
  let domain = null;
  let datasetPromise = null;
  function getDataset() {
    if (!datasetPromise) {
      datasetPromise = Promise.all([
        getJson("data/dataset.json"),
        fetch("data/fps.bin").then(r => { if (!r.ok) throw new Error("fps.bin"); return r.arrayBuffer(); }),
        getJson("data/domain.json"),
      ]).then(([json, buf, dom]) => { domain = dom; return TasteEngine.parseDataset(json, buf); });
      datasetPromise.catch(() => { datasetPromise = null; });
    }
    return datasetPromise;
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

  // The first view (first preset, its top taste) is drawn in advance (tools/snapshot.py, key
  // snap.mol-svg), so RDKit is only loaded when the visitor shows another molecule or taste.
  const firstView = current.id + "|" + selected;
  function renderStructure() {
    const box = $("mol-svg");
    if (rdkit) {
      const svg = ContribView.drawSvg(rdkit, drawn(), current.contrib && current.contrib[selected]);
      if (svg) { box.innerHTML = svg; return; }
    }
    const snap = I18N.snap("mol-svg");
    if (current.id + "|" + selected === firstView && snap !== undefined) { box.innerHTML = snap; return; }
    box.textContent = rdkitFailed ? I18N.t("demo.rdkit_failed") : I18N.t("demo.loading_rdkit");
    if (!rdkitFailed) rdkitReady().catch(() => {});
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
    // Judgement thresholds (feature_spec.json thresholds: Youden J on the validation split) as a
    // short vertical line across each taste's bars
    const thr = spec.thresholds || null;
    const thresholdLines = {
      id: "thresholdLines",
      afterDatasetsDraw(c) {
        if (!thr) return;
        const { ctx, scales: { x, y } } = c;
        const band = y.height / ids.length;
        ctx.save();
        ctx.strokeStyle = "#1f2328";
        ctx.lineWidth = 2;
        ids.forEach((id, j) => {
          const px = x.getPixelForValue(thr[id] * 100), py = y.getPixelForValue(j);
          ctx.beginPath();
          ctx.moveTo(px, py - band * 0.38);
          ctx.lineTo(px, py + band * 0.38);
          ctx.stroke();
        });
        ctx.restore();
      },
    };
    if (chart) chart.destroy();
    chart = new Chart($("pred-chart"), {
      type: "bar",
      data: { labels: names, datasets },
      plugins: [thresholdLines],
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
    renderThresholds(thr);
  }

  // One line per taste: probability of the page's model and whether it passes the judgement threshold
  function renderThresholds(thr) {
    const list = $("thr-list"), note = $("thr-note");
    list.innerHTML = "";
    list.hidden = note.hidden = !thr;
    if (!thr) return;
    const pctText = v => (v < 0.0005 ? "<0.1" : v < 0.1 ? (v * 100).toFixed(1) : String(Math.round(v * 100))) + "%";
    ids.forEach(id => {
      const p = current.probs[id], over = p >= thr[id];
      const li = document.createElement("li");
      const b = document.createElement("b");
      b.textContent = labelName(id) + " " + pctText(p);
      li.append(b, I18N.t(over ? "thr.over" : "thr.under", { t: pctText(thr[id]) }));
      if (over) li.className = "over";
      list.appendChild(li);
    });
    note.innerHTML = I18N.t("thr.note");
    I18N.nobr(note);
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
    // copy button after the SMILES (assets/i18n.js); on failure the SMILES text itself is selected
    const smilesText = $("mol-smiles").firstChild, smiles = drawn();
    $("mol-smiles").append(" ", UI.copyButton({ text: smiles, label: "copy.smiles", select: smilesText }));
    const rawForm = $("mol-raw");
    rawForm.hidden = drawn() === current.smiles;
    if (!rawForm.hidden) rawForm.textContent = I18N.t("demo.raw_form", { smiles: current.smiles });
    const link = $("mol-pubchem");
    link.hidden = !current.pubchem_cid;
    if (current.pubchem_cid) link.href = "https://pubchem.ncbi.nlm.nih.gov/compound/" + current.pubchem_cid;
    $("mol-odor").href = "../odor-predictor/?q=" + encodeURIComponent(drawn()) + "#demo";

    const status = $("mol-status");
    status.innerHTML = "";
    const line = (text, cls) => {
      const div = document.createElement("div");
      if (cls) div.className = cls;
      if (text !== undefined) div.textContent = text;
      status.appendChild(div);
      return div;
    };
    // Training-data records: presets carry them in presets.json, searches are matched by
    // InChIKey against data/dataset.json (TasteEngine.datasetMatch)
    let recs = null, exact = true;
    if (current.source === "search") {
      if (current.match) {
        recs = current.match.records;
        exact = current.match.exact;
      }
    } else if (current.dataset_labels) {
      recs = [{ labels: Object.assign({}, current.dataset_labels, current.dataset_sour_salty || {}),
                sources: current.dataset_sources, split: current.dataset_split, raw: current.dataset_raw_labels }];
    }
    const split = recs && recs.length ? recs[0].split : null;
    const sp = I18N.lang === "zh" ? "" : " ";  // space between sentences (none in Chinese)
    let head = current.source === "search" ? I18N.t("status.live") + sp : "";
    if (current.source === "search" && !current.match) head += I18N.t("status.search");
    else head += I18N.t(split ? "status." + split : "status.none");
    line(head);
    status.classList.toggle("warn", split === "train");
    (recs || []).forEach(r => renderRecord(line, r, recs.length > 1));
    if (recs && recs.length && !exact) line(I18N.t("status.no_stereo"), "small");

    // Applicability domain: similarity to the nearest training molecule
    if (typeof current.nn_tanimoto === "number" && domain && current.nn_tanimoto < domain.threshold) {
      line(I18N.t("status.far", { t: current.nn_tanimoto.toFixed(2), thr: domain.threshold.toFixed(2) }), "domain-warn");
      status.classList.add("warn");
    }
  }

  // One training record: recorded tastes (modeled ones in bold), sources, raw records
  function renderRecord(line, r, showName) {
    const lab = r.labels;
    const pos = ids.concat(["sour", "salty"]).filter(k => lab[k] === 1);
    const head = line();
    head.style.marginTop = "6px";
    if (pos.length) {
      head.append(I18N.t("status.labels"));
      // Recorded tastes as plain text; the four modeled tastes in bold
      pos.forEach((k, i) => {
        if (i) head.append(I18N.t("list.comma"));
        const c = document.createElement(ids.includes(k) ? "b" : "span");
        c.textContent = ids.includes(k) ? labelName(k) : I18N.t("taste." + k);
        head.appendChild(c);
      });
    } else {
      const neg = ids.filter(k => lab[k] === 0).map(labelName).join(I18N.t("list.comma"));
      const unk = ids.filter(k => lab[k] === null).map(labelName).join(I18N.t("list.comma"));
      head.append(I18N.t("status.labels_none", { neg: neg || "-" }) +
                  (unk ? I18N.t("status.labels_unknown", { unk }) : ""));
    }
    head.append(I18N.t("status.sources", { src: r.sources.join(" / ") }));
    if (showName && r.name) head.append((I18N.lang === "zh" ? "" : " ") + I18N.t("status.record_name", { name: r.name }));
    if (!pos.length && (r.raw || []).includes("Virt:Other")) line(I18N.t("status.virt_other"), "small");
    const raw = document.createElement("details");
    raw.className = "raw-labels small";
    const sum = document.createElement("summary");
    sum.textContent = I18N.t("status.raw");
    const ul = document.createElement("ul");
    if (r.name && !showName) {
      const li = document.createElement("li");
      li.textContent = I18N.t("status.record_name", { name: r.name });
      ul.appendChild(li);
    }
    (r.raw || []).forEach(x => {
      const li = document.createElement("li");
      li.textContent = x.replace(/^Chem:/, "ChemTastesDB: ").replace(/^Virt:/, "VirtuousMultiTaste: ");
      ul.appendChild(li);
    });
    raw.append(sum, ul);
    line().appendChild(raw);
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
          const looksLikeName = /[a-z]{3,}/.test(q) || /^\d{2,7}-\d{2}-\d$/.test(q);
          if (e.code === "not_found" && !looksLikeName) e.code = "invalid_smiles";
          throw e;
        }
      }

      setSearchStatus("search.predicting");
      const std = TasteEngine.standardizedFeatures(rd, smiles, spec);
      // whole-molecule descriptors (model input D) of the same standardized structure
      const D = TasteEngine.descriptorInput(rd, std.smiles, spec);
      const { probs: out, contrib } = await TasteEngine.occlusion(TasteEngine.withDescriptors(session, D), std.feats, spec);
      // Training records and nearest neighbour; the prediction is still shown if this fails
      let match = null, nn = null;
      try {
        const ds = await getDataset();
        const m = TasteEngine.datasetMatch(rd, std.smiles, ds);
        if (m) {
          match = { exact: m.matches.length ? m.matches[0].exact : true,
                    records: m.matches.map(x => TasteEngine.record(ds, x.index)) };
          nn = m.nn.tanimoto;
        }
      } catch (err) { console.error(err); }
      current = {
        source: "search", smiles: std.smiles, title, pubchem_cid: cid, match, nn_tanimoto: nn,
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
        history.replaceState(null, "", I18N.keepLang("q=" + encodeURIComponent(q)) + "#demo");
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
  // first use of the demo: start RDKit so the next drawing is quick
  ["pointerdown", "focusin", "keydown"].forEach(ev =>
    $("mol-svg").closest("section").addEventListener(ev, () => { if (!rdkitFailed) rdkitReady().catch(() => {}); }, { once: true, passive: true }));

  // Shareable links: ?q=<name|CAS|SMILES> runs a search on load (used by the odor page)
  const q0 = new URLSearchParams(location.search).get("q");
  if (q0) {
    $("search-input").value = q0;
    runSearch(q0);
  }
})();
