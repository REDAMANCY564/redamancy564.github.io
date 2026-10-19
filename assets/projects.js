/*
 * Project list shared by the homepage (featured ones only) and the projects page (all).
 * Needs assets/i18n.js loaded first. Screenshots live in assets/thumbs/<directory>.webp.
 */
(function () {
  // [directory, i18n key prefix, featured, has an about page]
  const PROJECTS = [
    ["gcms-interpreter", "gcms", true, true],
    ["ingredient-finder", "finder", true, true],
    ["odor-predictor", "odor", true, true],
    ["flavor-improver", "fi", false, false],
    ["odor-map", "map", false, false],
    ["taste-predictor", "taste", false, false],
    ["perception-diversity", "perc", false, false],
    ["flavor-kb", "kb", false, false],
  ];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // root: path from the current page to the site root ("" on the homepage, "../" one level down)
  function renderProjects(el, root, featuredOnly) {
    const t = I18N.t;
    el.innerHTML = PROJECTS.filter(p => !featuredOnly || p[2]).map(([dir, key, , hasAbout]) => {
      const title = esc(t("home." + key + ".title"));
      const href = root + dir + "/";
      return '<div class="pub-item">' +
        '<a class="thumb" href="' + href + '" tabindex="-1">' +
          '<img src="' + root + "assets/thumbs/" + dir + '.webp" width="200" height="150" loading="lazy" alt="' +
            esc(t("home.thumb_alt", { name: t("home." + key + ".title") })) + '">' +
        "</a>" +
        "<div>" +
          '<a class="pub-title" href="' + href + '">' + title + "</a>" +
          "<p>" + esc(t("home." + key + ".one")) + "</p>" +
          '<p class="links"><a href="' + href + '">' + esc(t("nav.tool")) + "</a>" +
            (hasAbout ? '<a href="' + href + 'about.html">' + esc(t("nav.about")) + "</a>" : "") + "</p>" +
        "</div></div>";
    }).join("");
  }

  window.SITE = { PROJECTS, esc, renderProjects };
})();
