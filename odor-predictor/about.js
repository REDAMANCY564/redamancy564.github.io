/*
 * Odor predictor: about page (method, results, ablation, limitations, data).
 * Fills the results and ablation tables from data/metrics.json; moved here from app.js
 * so the tool page holds only input and results.
 */
(async function () {
  const $ = id => document.getElementById(id);

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load " + url);
    return res.json();
  }

  const [labels, metrics] = await Promise.all([
    getJson("model/labels.json"),
    getJson("data/metrics.json"),
    I18N.ready,
  ]);
  const labelById = Object.fromEntries(labels.map(l => [l.id, l]));
  const labelName = id => (labelById[id] ? I18N.pick(labelById[id]) : id);

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

    // Ablation of the PharmaGNN ideas (training/ablation.py); A is the deployed model
    const ab = metrics.ablation_pharmagnn;
    $("ablation-body").innerHTML = ["A", "B", "C", "D"].map(k => {
      const c = ab.configs[k];
      return "<tr" + (k === "A" ? ' class="highlight"' : "") + "><td>" + I18N.t("ablation.cfg." + k) +
        '</td><td class="num">' + fmt(c.test_mean) + " ± " + c.test_std.toFixed(4) +
        '</td><td class="num">' + fmt(c.test_rare_mean) + "</td></tr>";
    }).join("");
    $("ablation-note").textContent = I18N.t("ablation.note", { n: ab.n_rare_labels });
  }

  function renderAll() {
    renderResults();
  }
  renderAll();
  I18N.onChange(renderAll);
})();
