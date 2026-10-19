/*
 * GC-MS flavor interpreter: about page (method, limitations, data).
 * Renders the limitation list and the batch-processing note (moved here from app.js).
 * Same Content-Security-Policy as the tool: only this site is contacted.
 */
(async function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const [profile] = await Promise.all([
    fetch("../assets/profile.json").then(r => (r.ok ? r.json() : {})).catch(() => ({})),
    I18N.ready,
  ]);

  function renderLimits() {
    const items = [];
    for (let k = 1; I18N.t("lim." + k) !== "lim." + k; k++) items.push("<li>" + esc(I18N.t("lim." + k)) + "</li>");
    $("lim-list").innerHTML = items.join("");
  }

  // One sample at a time; batch processing by email
  function renderScope() {
    const email = profile.email || "";
    $("scope-note").innerHTML = esc(I18N.t("scope.text")) + (email
      ? ' <a href="mailto:' + esc(email) + '">' + esc(email) + "</a>" + esc(I18N.t("scope.end")) : "");
  }

  function renderAll() {
    renderLimits();
    renderScope();
  }
  renderAll();
  I18N.onChange(renderAll);
})();
