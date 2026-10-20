/*
 * Project list and numbering, shared by every page. The order of PROJECTS is the project number
 * (1 to 8) used on the homepage, the projects page, project titles, section headings and tab titles.
 * Needs assets/i18n.js loaded first. Screenshots live in assets/thumbs/<directory>.webp.
 */
(function () {
  // [directory, i18n key prefix]; the first three are the main projects
  const PROJECTS = [
    ["gcms-interpreter", "gcms"],
    ["ingredient-finder", "finder"],
    ["odor-predictor", "odor"],
    ["flavor-improver", "fi"],
    ["odor-map", "map"],
    ["taste-predictor", "taste"],
    ["perception-diversity", "perc"],
    ["flavor-kb", "kb"],
  ];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Homepage: a plain table of contents (number, name linking to the tool, one sentence)
  function renderDirectory(el, root) {
    const t = I18N.t;
    el.innerHTML = PROJECTS.map(([dir, key], i) =>
      "<li>" +
        '<span class="no">' + (i + 1) + "</span>" +
        '<div><a class="toc-title" href="' + root + dir + '/">' + esc(t("home." + key + ".title")) + "</a>" +
        "<p>" + esc(t("home." + key + ".one")) + "</p></div>" +
      "</li>"
    ).join("");
  }

  // Projects page: the same list with screenshots and links to both project pages
  // root: path from the current page to the site root ("" on the homepage, "../" one level down)
  function renderProjects(el, root) {
    const t = I18N.t;
    el.innerHTML = PROJECTS.map(([dir, key], i) => {
      const title = esc(t("home." + key + ".title"));
      const href = root + dir + "/";
      return '<div class="pub-item">' +
        '<a class="thumb" href="' + href + '" tabindex="-1">' +
          '<img src="' + root + "assets/thumbs/" + dir + '.webp" width="200" height="150" loading="lazy" alt="' +
            esc(t("home.thumb_alt", { name: t("home." + key + ".title") })) + '">' +
        "</a>" +
        "<div>" +
          '<a class="pub-title" href="' + href + '" data-no="' + (i + 1) + '">' + title + "</a>" +
          "<p>" + esc(t("home." + key + ".one")) + "</p>" +
          '<p class="links"><a href="' + href + '">' + esc(t("nav.tool")) + "</a>" +
            '<a href="' + href + 'about.html">' + esc(t("nav.about")) + "</a></p>" +
        "</div></div>";
    }).join("");
  }

  // Project pages: number the title, the headings marked data-sec="1" / "2" and the method-page
  // contents. Numbers go into data-no (shown by CSS), so the i18n text of a heading can change
  // freely. Hidden sections count too, so numbers do not change as steps appear. A container
  // with data-sec-scope (a mode of the flavor improver) restarts the numbering.
  function numberPage() {
    const parts = location.pathname.split("/");
    const idx = PROJECTS.findIndex(p => parts.includes(p[0]));
    if (idx < 0) return;
    const n = idx + 1;
    const h1 = document.querySelector("main h1");
    if (h1) h1.dataset.no = n;

    const counters = new Map();
    document.querySelectorAll("[data-sec]").forEach(h => {
      const scope = h.closest("[data-sec-scope]") || document;
      const c = counters.get(scope) || [0, 0];
      if (h.dataset.sec === "1") { c[0]++; c[1] = 0; h.dataset.no = n + "." + c[0]; }
      else { c[1]++; h.dataset.no = n + "." + c[0] + "." + c[1]; }
      counters.set(scope, c);
    });

    document.querySelectorAll(".toc a[href^='#']").forEach(a => {
      const target = document.getElementById(a.getAttribute("href").slice(1));
      const h = target && (target.matches("[data-sec]") ? target : target.querySelector("[data-sec]"));
      if (h) a.dataset.no = h.dataset.no;
    });

    // The full project names are long, so the tab shows the number and the short name (hero.short)
    const about = /about\.html$/.test(location.pathname);
    function setTitle() {
      const t = I18N.t;
      document.title = (about ? t("nav.about") + " | " : "") + n + " " + t("hero.short") + " | " + t("site.name");
    }
    I18N.ready.then(setTitle);
    I18N.onChange(setTitle);
  }

  window.SITE = { PROJECTS, esc, renderDirectory, renderProjects };
  numberPage();
})();
