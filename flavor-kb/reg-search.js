/*
 * Regulatory lookup page (flavor knowledge base): find a substance by name (English or GB 2760 Chinese
 * name), CAS, FEMA, FL number or GB 2760 code, and show its EU / China status (assets/regulatory.js).
 * No search by food category or conditions of use (user decision). The query is kept in ?q=.
 */
(async function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MAX = 30;

  await I18N.ready;
  let query = "";

  function setStatus(key, vars, isError) {
    $("rq-status").textContent = key ? I18N.t(key, vars) : "";
    $("rq-status").classList.toggle("error", !!isError);
  }

  /** Items matching q, best first. The kind of query is recognised from its form. */
  function find(q) {
    const raw = q.trim(), s = raw.toLowerCase();
    const items = Reg.items;
    let m;
    if ((m = s.match(/^0*(\d{2,7}-\d{2}-\d)$/))) return items.filter(it => it.cas.includes(m[1]));
    if ((m = s.match(/^(?:fl\s*(?:no\.?)?\s*)?(\d{2})\.(\d{3})$/))) return items.filter(it => it.eu.some(e => e.fl === m[1] + "." + m[2]));
    if ((m = s.match(/^([ns])\s*0*(\d{1,4})$/))) {
      const code = m[1].toUpperCase() + m[2].padStart(m[1] === "n" ? 3 : 4, "0");
      return items.filter(it => it.cn.some(c => c.code === code));
    }
    if ((m = s.match(/^(?:fema\s*(?:no\.?)?\s*)?(\d{4})$/))) return items.filter(it => it.cn.some(c => c.fema.split("+").includes(m[1])));
    if (s.length < 2 && !/[㐀-鿿]/.test(s)) return [];
    const scored = [];
    for (const it of items) {
      const names = [it.name || ""].concat(it.zh).map(x => x.toLowerCase());
      let best = 99;
      for (const n of names) {
        if (n === s) best = Math.min(best, 0);
        else if (n.startsWith(s)) best = Math.min(best, 1);
        else if (n.includes(s)) best = Math.min(best, 2);
      }
      if (best < 99) scored.push([best, Math.min(...names.map(n => n.length)), it]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
  }

  function card(it) {
    const odorQ = it.smiles;
    const links = [
      '<a href="../ingredient-finder/?mode=b&amp;smiles=' + encodeURIComponent(it.smiles) + '">' + esc(I18N.t("rq.to_finder")) + "</a>",
      '<a href="../odor-predictor/?q=' + encodeURIComponent(odorQ) + '#demo">' + esc(I18N.t("rq.to_odor")) + "</a>",
      it.kb ? '<a href="./?compound=' + encodeURIComponent(it.kb) + '">' + esc(I18N.t("rq.to_kb")) + "</a>" : "",
    ].join("");
    return '<div class="card rq-item"><h3>' + esc(it.name || it.smiles) +
      (it.zh.length ? ' <span class="rq-zh">' + esc(it.zh.join("、")) + "</span>" : "") + "</h3>" +
      (it.cas.length ? '<p class="rq-cas">CAS ' + esc(it.cas.slice(0, 4).join(", ")) + "</p>" : "") +
      '<p class="rq-links">' + links + "</p>" + Reg.html(it, { bare: true }) + "</div>";
  }

  function render() {
    const box = $("rq-results");
    const common = $("rq-common");
    common.innerHTML = "";
    if (!query) { box.innerHTML = ""; setStatus(null); return; }
    const hits = find(query);
    if (!hits.length) { box.innerHTML = ""; setStatus("rq.none", { q: query }); return; }
    setStatus(hits.length > MAX ? "rq.count_more" : "rq.count", { n: hits.length, k: MAX });
    const shown = hits.slice(0, MAX);
    box.innerHTML = shown.map(card).join("");
    // sources and the GB 2760 Annex B sentence once, below the list (the disclaimer is in the note above)
    common.innerHTML = Reg.common(shown.some(it => it.cn.length));
  }

  async function run(q, push) {
    query = q.trim();
    $("rq-input").value = query;
    if (push) {
      try { history.pushState({ q: query }, "", query ? "?q=" + encodeURIComponent(query) : location.pathname); } catch (e) { /* ignore */ }
    }
    if (!query) { render(); return; }
    setStatus("reg.loading");
    try { await Reg.load(); } catch (e) { setStatus("reg.load_failed", null, true); return; }
    render();
  }

  $("rq-form").addEventListener("submit", e => { e.preventDefault(); run($("rq-input").value, true); });
  document.querySelectorAll("button[data-q]").forEach(b => b.addEventListener("click", () => run(b.dataset.q, true)));
  window.addEventListener("popstate", () => run(new URLSearchParams(location.search).get("q") || "", false));
  I18N.onChange(() => { if (Reg.meta) render(); });
  Reg.load().catch(() => {});   // start the download (static file, about 110 KB compressed) while the visitor types
  run(new URLSearchParams(location.search).get("q") || "", false);
})();
