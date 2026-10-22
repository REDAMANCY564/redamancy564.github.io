/*
 * Regulatory lookup page (flavor knowledge base): every entry of the EU Union list (with Annex III Part A),
 * of GB 2760 tables B.2 / B.3 and of the US 21 CFR flavouring sections and FDA list, grouped by CAS into
 * substances (flavor-kb/data/regulatory-lookup.json, loaded by this page only). Find a substance by name
 * (English, GB 2760 Chinese name, hidden GB 2760 English and FDA names), CAS, FEMA, FL number or GB 2760
 * code, and show its EU / China / US status (assets/regulatory.js).
 * Substances in the site's molecule library link to the ingredient finder, odor predictor and knowledge base.
 * No search by food category or conditions of use (user decision). The query is kept in ?q=.
 */
(async function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MAX = 30;
  // same normalization as the hidden search keys (build_regulatory.py skey): spaces and punctuation ignored
  const skey = s => String(s || "").toLowerCase().replace(/α/g, "alpha").replace(/β/g, "beta").replace(/γ/g, "gamma")
    .replace(/δ/g, "delta").replace(/[^0-9a-z㐀-鿿]/g, "");

  await I18N.ready;
  let query = "";

  function setStatus(key, vars, isError) {
    $("rq-status").textContent = key ? I18N.t(key, vars) : "";
    $("rq-status").classList.toggle("error", !!isError);
  }

  /** Substances matching q, best first. The kind of query is recognised from its form. */
  function find(q) {
    const s = q.trim().toLowerCase();
    const subs = Reg.lookup;
    let m;
    if ((m = s.match(/^0*(\d{2,7}-\d{2}-\d)$/))) return subs.filter(it => it.cas.includes(m[1]));
    if ((m = s.match(/^(?:fl\s*(?:no\.?)?\s*)?(\d{2})\.(\d{3})$/))) return subs.filter(it => it.eu.some(e => e.fl === m[1] + "." + m[2]));
    if ((m = s.match(/^([ns])\s*0*(\d{1,4})$/))) {
      const code = m[1].toUpperCase() + m[2].padStart(m[1] === "n" ? 3 : 4, "0");
      return subs.filter(it => it.cn.some(c => c.code === code));
    }
    if ((m = s.match(/^(?:fema\s*(?:no\.?)?\s*)?(\d{4})$/)))
      return subs.filter(it => it.cn.some(c => c.fema.split("+").includes(m[1])) || it.us.some(e => e.kind === "f" && e.fema === m[1]));
    const k = skey(s);
    if (k.length < 2 && !/[㐀-鿿]/.test(k)) return [];
    const scored = [];
    for (const it of subs) {
      // shown names rank before hidden search keys (GB 2760 English names, FDA names)
      const shown = [it.name].concat(it.zh, it.links.map(l => l.name)).map(skey);
      let best = 99;
      shown.forEach(n => { if (n === k) best = Math.min(best, 0); else if (n.startsWith(k)) best = Math.min(best, 1); else if (n.includes(k)) best = Math.min(best, 2); });
      if (best === 99) it.keys.forEach(n => { if (n === k) best = Math.min(best, 3); else if (n.includes(k)) best = Math.min(best, 4); });
      if (best < 99) scored.push([best, Math.min(...shown.filter(Boolean).map(n => n.length)), it]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
  }

  // Substance in the China and US lists only (no library molecule, no EU entry): the name comes from the FDA list;
  // the Chinese page shows the GB 2760 Chinese name, as for China-only substances (user E6).
  // English page, China-only substance: 「中文名（编码）」, no translation of the name (user decision)
  function title(it) {
    if (it.name && it.zh.length && I18N.lang === "zh" && !it.eu.length && !it.a3 && !it.links.length) return esc(it.zh.join("、"));
    if (it.name) return esc(it.name) + (it.zh.length ? ' <span class="rq-zh">' + esc(it.zh.join("、")) + "</span>" : "");
    const zh = it.zh.join("、");
    return esc(I18N.lang === "zh" ? zh : zh + "（" + it.cn.map(c => c.code).join("、") + "）");
  }

  const linkRow = l => [
    '<a href="../ingredient-finder/?mode=b&amp;smiles=' + encodeURIComponent(l.smiles) + '">' + esc(I18N.t("rq.to_finder")) + "</a>",
    '<a href="../odor-predictor/?q=' + encodeURIComponent(l.smiles) + '#demo">' + esc(I18N.t("rq.to_odor")) + "</a>",
    l.kb ? '<a href="./?compound=' + encodeURIComponent(l.kb) + '">' + esc(I18N.t("rq.to_kb")) + "</a>" : "",
  ].join("");

  function card(it) {
    // links only for substances in the site's molecule library; one row per molecule when several match
    const links = it.links.length === 1 ? '<p class="rq-links">' + linkRow(it.links[0]) + "</p>"
      : it.links.map(l => '<p class="rq-links"><span class="muted">' + esc(l.name) + "</span>" + linkRow(l) + "</p>").join("");
    return '<div class="card rq-item"><h3>' + title(it) + "</h3>" +
      '<p class="rq-cas">' + (it.cas.length ? "CAS " + esc(it.cas.slice(0, 4).join(", ")) : esc(I18N.t("rq.nocas"))) + "</p>" +
      links + Reg.html(it, { bare: true }) + "</div>";
  }

  function render() {
    const box = $("rq-results");
    const common = $("rq-common");
    common.innerHTML = "";
    if (!query) { box.innerHTML = ""; setStatus(null); return; }
    const hits = find(query);
    if (!hits.length) { box.innerHTML = ""; setStatus("rq.none", { q: query }); return; }
    setStatus(hits.length > MAX ? "rq.count_more" : hits.length === 1 ? "rq.count_one" : "rq.count", { n: hits.length, k: MAX });
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
    try { await Reg.loadLookup(); } catch (e) { setStatus("reg.load_failed", null, true); return; }
    render();
  }

  $("rq-form").addEventListener("submit", e => { e.preventDefault(); run($("rq-input").value, true); });
  document.querySelectorAll("button[data-q]").forEach(b => b.addEventListener("click", () => run(b.dataset.q, true)));
  window.addEventListener("popstate", () => run(new URLSearchParams(location.search).get("q") || "", false));
  I18N.onChange(() => { if (Reg.meta) render(); });
  Reg.loadLookup().catch(() => {});   // start the download (static file, about 125 KB compressed) while the visitor types
  run(new URLSearchParams(location.search).get("q") || "", false);
})();
