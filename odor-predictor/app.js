/* Odor predictor page, version 1: shows precomputed predictions from data/presets.json. */
(async function () {
  const RDKIT_WASM = "https://cdn.jsdelivr.net/npm/@rdkit/rdkit@2026.3.6/dist/RDKit_minimal.wasm";
  const ACCENT = "#0f6e6e";

  const $ = id => document.getElementById(id);

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load " + url);
    return res.json();
  }

  // Start RDKit (large WASM) in parallel with the data; the page works without it.
  let rdkit = null;
  let rdkitFailed = false;
  const rdkitReady = (typeof initRDKitModule === "function"
    ? initRDKitModule({ locateFile: () => RDKIT_WASM })
    : Promise.reject(new Error("RDKit script not loaded")))
    .then(mod => { rdkit = mod; })
    .catch(err => { rdkitFailed = true; console.error(err); });

  const [presets, labels, metrics] = await Promise.all([
    getJson("data/presets.json"),
    getJson("model/labels.json"),
    getJson("data/metrics.json"),
    I18N.ready,
  ]);
  const labelById = Object.fromEntries(labels.map(l => [l.id, l]));
  const labelName = id => (labelById[id] ? I18N.pick(labelById[id]) : id);

  let current = presets[0];
  let chart = null;

  // ---------- Demo ----------
  function renderSelect() {
    const sel = $("preset");
    sel.innerHTML = "";
    presets.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = I18N.lang === "zh" ? p.name_zh + " (" + p.name_en + ")" : p.name_en;
      sel.appendChild(opt);
    });
    sel.value = current.id;
  }

  function renderStructure() {
    const box = $("mol-svg");
    if (rdkit) {
      const mol = rdkit.get_mol(current.smiles);
      if (mol) {
        try {
          box.innerHTML = mol.get_svg_with_highlights(JSON.stringify({
            width: 360, height: 270, bondLineWidth: 1.6, clearBackground: false, addStereoAnnotation: false,
          }));
        } finally {
          mol.delete();
        }
        return;
      }
    }
    box.textContent = rdkitFailed ? I18N.t("demo.rdkit_failed") : I18N.t("demo.loading_rdkit");
  }

  function renderChart() {
    const names = current.top.map(t => labelName(t.label));
    const values = current.top.map(t => Math.round(t.prob * 1000) / 10);
    if (!chart) {
      chart = new Chart($("pred-chart"), {
        type: "bar",
        data: { labels: names, datasets: [{ data: values, backgroundColor: ACCENT, borderRadius: 4, maxBarThickness: 26 }] },
        options: {
          indexAxis: "y",
          maintainAspectRatio: false,
          animation: { duration: 300 },
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
      chart.update();
    }
  }

  function renderInfo() {
    $("mol-name").textContent = I18N.lang === "zh" ? current.name_zh + "  " + current.name_en : current.name_en;
    $("mol-smiles").textContent = current.smiles;
    $("mol-pubchem").href = "https://pubchem.ncbi.nlm.nih.gov/compound/" + current.pubchem_cid;

    const status = $("mol-status");
    status.innerHTML = "";
    const split = current.dataset_split;
    const msg = document.createElement("div");
    msg.textContent = I18N.t(split ? "status." + split : "status.none");
    status.appendChild(msg);
    status.classList.toggle("warn", split === "train");

    if (current.true_labels && current.true_labels.length) {
      const top = new Set(current.top.map(t => t.label));
      const chips = document.createElement("div");
      chips.className = "chips";
      current.true_labels.forEach(id => {
        const c = document.createElement("span");
        c.className = "chip" + (top.has(id) ? " hit" : "");
        c.textContent = labelName(id);
        chips.appendChild(c);
      });
      status.appendChild(chips);
      const hint = document.createElement("div");
      hint.className = "small muted";
      hint.style.marginTop = "6px";
      hint.textContent = I18N.t("status.match_hint");
      status.appendChild(hint);
    }
  }

  function renderDemo() {
    renderInfo();
    renderStructure();
    renderChart();
  }

  $("preset").addEventListener("change", e => {
    current = presets.find(p => p.id === e.target.value) || presets[0];
    renderDemo();
  });

  // ---------- Results ----------
  const fmt = x => (x == null ? "" : x.toFixed(3));

  function renderResults() {
    const rows = [
      ["results.model.gnn", metrics.gnn, true],
      ["results.model.rf", metrics.morgan_rf, false],
      ["results.model.lr", metrics.morgan_logreg, false],
    ];
    $("results-body").innerHTML = rows.map(([key, m, hl]) =>
      '<tr' + (hl ? ' class="highlight"' : "") + "><td>" + I18N.t(key) + '</td><td class="num">' + fmt(m.macro_auroc) +
      '</td><td class="num">' + fmt(m.macro_auroc_cyclic) + '</td><td class="num">' + fmt(m.macro_auroc_acyclic) + "</td></tr>"
    ).join("");
    $("seed-note").textContent = I18N.t("results.seed_note", {
      mean: fmt(metrics.gnn.test_macro_auroc_mean),
      std: metrics.gnn.test_macro_auroc_std.toFixed(4),
    });

    const robust = Object.entries(metrics.gnn.per_label)
      .filter(([, v]) => v.auroc != null && v.test_positives >= 10)
      .sort((a, b) => b[1].auroc - a[1].auroc);
    const item = ([id, v]) => "<li>" + labelName(id) + " <span class=\"muted\">" + fmt(v.auroc) + "</span></li>";
    $("best-labels").innerHTML = robust.slice(0, 5).map(item).join("");
    $("worst-labels").innerHTML = robust.slice(-5).reverse().map(item).join("");
  }

  // ---------- Init ----------
  function renderAll() {
    renderSelect();
    renderDemo();
    renderResults();
  }
  renderAll();
  I18N.onChange(renderAll);
  rdkitReady.then(renderStructure);
})();
