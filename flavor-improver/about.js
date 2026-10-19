/*
 * Flavor improver: about page (method, results, mixture experiment, limitations, data).
 * The results tables and the base-composition sources were moved here from app.js.
 */
(async function () {
  const $ = id => document.getElementById(id);
  const getJson = url => fetch(url).then(r => { if (!r.ok) throw new Error("Failed to load " + url); return r.json(); });
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const [palette, bases, presets, metrics, jsCheck] = await Promise.all([
    "data/palette.json", "data/bases.json", "data/presets.json", "data/bo_metrics.json", "data/bo_js_check.json"].map(getJson));
  await I18N.ready;
  const t = (k, v) => I18N.t(k, v);
  const comps = palette.compounds;
  const nameOf = n => (I18N.lang === "zh" ? comps[n].name_zh : comps[n].name_en);

  // ---- results ----
  const METHODS = ["bo_sparse_init", "bo", "random_sparse", "random_uniform"];
  function renderResults() {
    const ids = presets.map(p => p.id);
    $("res-head").innerHTML = `<tr><th>${esc(t("results.col.method"))}</th>${presets.map(p => `<th class="num">${esc(t("short." + p.id))}</th>`).join("")}</tr>`;
    const best = Object.fromEntries(ids.map(id => [id, METHODS.reduce((a, m) => (metrics.presets[id].methods[m].best_score.mean > metrics.presets[id].methods[a].best_score.mean ? m : a), METHODS[0])]));
    const rows = [`<tr><td>${esc(t("results.no_add"))}</td>${ids.map(id => `<td class="num">${metrics.presets[id].no_addition.score.toFixed(4)}</td>`).join("")}</tr>`];
    for (const m of METHODS) {
      rows.push(`<tr><td>${esc(t("results.m." + m))}</td>${ids.map(id => {
        const e = metrics.presets[id].methods[m];
        const cell = `${e.best_score.mean.toFixed(4)} ± ${e.best_score.std.toFixed(4)} (${e.n_added.mean.toFixed(1)})`;
        return `<td class="num">${best[id] === m ? `<b>${cell}</b>` : cell}</td>`;
      }).join("")}</tr>`);
    }
    $("res-body").innerHTML = rows.join("");

    const krows = [];
    for (const [baseId, ks] of Object.entries(metrics.known_answer)) {
      for (const [k, row] of Object.entries(ks)) {
        const e = row.bo;
        krows.push(`<tr><td>${esc(t("known.case", { base: t("short." + baseId), k }))}</td>
          <td>${e.true.map(n => esc(nameOf(n))).join(I18N.lang === "zh" ? "、" : ", ")}</td>
          <td class="num">${e.cos.mean.toFixed(4)}</td>
          <td class="num">${e.exact_recovery}/${e.of}</td>
          <td class="num">${e.jaccard.mean.toFixed(2)}</td></tr>`);
      }
    }
    $("known-body").innerHTML = krows.join("");
    const wins = Object.values(jsCheck.presets).reduce((a, p) => a + p.bo_wins, 0);
    $("jsbo-text").innerHTML = t("jsbo.text", { wins });

    const seen = new Set();
    $("footer-bases").innerHTML = bases.filter(b => { const k = b.source.doi; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(b => `<li>${esc(b.source.citation)} <a href="https://doi.org/${esc(b.source.doi)}" target="_blank" rel="noopener">doi:${esc(b.source.doi)}</a> (${esc(b.source.license)})</li>`).join("");
  }

  function renderAll() {
    renderResults();
  }
  renderAll();
  I18N.onChange(renderAll);
})();
