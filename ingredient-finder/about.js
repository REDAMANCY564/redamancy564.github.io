/*
 * Flavor ingredient finder: about page (method, evaluation, limitations, data).
 * Renders the evaluation tables and the list of removed molecules; moved here from app.js
 * so the tool page holds only the two search modes.
 */
(async function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const VERSION = new URL(document.currentScript.src).search;

  const [lib, metrics] = await Promise.all([
    fetch("data/library.json" + VERSION).then(r => r.json()),
    fetch("data/metrics.json" + VERSION).then(r => r.json()),
    I18N.ready,
  ]);
  const D = { lib, n: lib.molecules.length };
  const nUnseen = lib.molecules.filter(m => m[2] !== 0).length;

  // ---------- Results section (stage 3 evaluation) ----------
  function renderMetrics() {
    const a = metrics.mode_a_test.all_labels_with_positives;
    const pct = v => (100 * v).toFixed(1) + "%";
    $("res-a").innerHTML = "<thead><tr><th>" + esc(I18N.t("results.col.method")) + '</th><th class="num">precision@10</th><th class="num">precision@50</th></tr></thead><tbody>' +
      [["results.random", a.random_expected, a.random_expected], ["results.gnn", a["gnn@10"], a["gnn@50"]], ["results.lr", a["lr@10"], a["lr@50"]]]
        .map(([k, p10, p50]) => "<tr><td>" + esc(I18N.t(k)) + '</td><td class="num">' + pct(p10) + '</td><td class="num">' + pct(p50) + "</td></tr>").join("") + "</tbody>";
    const b = metrics.mode_b_test;
    $("res-intro").textContent = I18N.t("results.intro", { n: b.all.n });
    $("res-b").innerHTML = "<thead><tr><th>" + esc(I18N.t("results.col.queries")) + '</th><th class="num">' + esc(I18N.t("results.col.odor")) +
      '</th><th class="num">' + esc(I18N.t("results.col.struct")) + '</th><th class="num">' + esc(I18N.t("results.col.random")) + "</th></tr></thead><tbody>" +
      ["all", "cyclic", "acyclic"].map(k => "<tr><td>" + esc(I18N.t("results.q." + k)) + " (" + b[k].n + ')</td><td class="num"><b>' + b[k].gnn.toFixed(3) +
        '</b></td><td class="num">' + b[k].tanimoto.toFixed(3) + '</td><td class="num">' + b[k].random.toFixed(3) + "</td></tr>").join("") + "</tbody>";
    const ci = b.all.gnn_minus_tanimoto_ci95;
    $("res-b-take").textContent = I18N.t("results.b_take", {
      lo: "+" + ci[0].toFixed(3), hi: "+" + ci[1].toFixed(3), share: (100 * b.all.gnn_better_share).toFixed(0), mean: b.all.gnn.toFixed(2),
    });
  }

  // molecules removed from the library, with reasons (training/ingredient/build_library.py)
  function renderExcluded() {
    const ex = D.lib.excluded || [];
    const by = {};
    ex.forEach(e => { (by[e.category] = by[e.category] || []).push(e); });
    $("excluded-note").textContent = I18N.t("excluded.note", { n: ex.length, total: D.n });
    $("excluded-list").innerHTML = Object.keys(by).map(cat => "<li><b>" + esc(I18N.t("excluded.cat." + cat)) + "</b> (" + by[cat].length + "): " +
      esc(by[cat].map(e => e.name || e.smiles).join(", ")) + "</li>").join("");
  }

  function renderAll() {
    renderMetrics();
    renderExcluded();
    $("unseen-note").textContent = I18N.t("f.unseen_help", { n: nUnseen });
    document.title = I18N.t("about.page_title");
  }
  renderAll();
  I18N.onChange(renderAll);
})();
