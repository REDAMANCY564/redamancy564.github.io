/*
 * Taste predictor: about page (method, results, limitations, data).
 * Fills the results table from data/metrics.json; moved here from app.js
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
  const ids = labels.map(l => l.id);
  const labelName = id => {
    const l = labels.find(x => x.id === id);
    return l ? I18N.pick(l) : I18N.t("taste." + id);
  };

  // ---------- Results ----------
  const fmt = x => (x == null ? "" : x.toFixed(3));

  function renderResults() {
    const g = metrics.gnn, lr = metrics.morgan_logreg;
    const rows = ids.map(id => {
      const pos = g.per_label[id].test_pos;
      if (id === "umami") {
        return "<tr><td>" + labelName(id) + '</td><td class="num">' + pos +
          '</td><td class="num na" colspan="2">' + I18N.t("results.umami_na") + "</td></tr>";
      }
      return "<tr><td>" + labelName(id) + '</td><td class="num">' + pos + '</td><td class="num">' +
        fmt(g.test_per_label_mean[id]) + " ± " + g.test_per_label_std[id].toFixed(3) +
        '</td><td class="num">' + fmt(lr.per_label[id].auroc) + "</td></tr>";
    });
    const three = ids.filter(id => id !== "umami");
    const mean = f => three.reduce((s, id) => s + f(id), 0) / three.length;
    rows.push('<tr class="highlight"><td>' + I18N.t("results.mean3") + '</td><td class="num"></td><td class="num">' +
      fmt(mean(id => g.test_per_label_mean[id])) + '</td><td class="num">' + fmt(mean(id => lr.per_label[id].auroc)) + "</td></tr>");
    $("results-body").innerHTML = rows.join("");
    $("results-note").textContent = I18N.t("results.note");

    const u = metrics.umami_valid_reference;
    $("results-umami").textContent = I18N.t("results.umami", {
      n: g.umami_nucleotides.nucleotides_vs_all_negatives.n_nucleotides, pos: g.per_label.umami.test_pos,
      vpos: u.pos, gnn: fmt(u.gnn), lr: fmt(u.morgan_logreg),
    });
    const bd = g.bitter_by_drug;
    $("results-drug").textContent = I18N.t("results.drug", {
      drug: fmt(bd.drug.auroc), nodrug: fmt(bd.non_drug.auroc),
      n: bd.drug.pos_neg[0] + bd.drug.pos_neg[1],
    });
  }

  function renderAll() {
    renderResults();
    document.title = I18N.t("about.page_title");
  }
  renderAll();
  I18N.onChange(renderAll);
})();
