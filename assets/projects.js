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
    if (document.body.hasAttribute("data-no-number")) return;   // 404.html, served at any address
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

  // Wide tables: a "swipe sideways" line above a table that is wider than its box, and a fade at the right
  // edge until the end is reached (shown on phones only, style.css). Tables drawn later are picked up too.
  function tableHints() {
    const done = new WeakSet();
    function setup(wrap) {
      if (done.has(wrap)) return;
      done.add(wrap);
      const hint = document.createElement("p");
      hint.className = "scroll-hint";
      hint.hidden = true;
      wrap.before(hint);
      let queued = false;
      const update = () => {
        queued = false;
        const over = wrap.scrollWidth > wrap.clientWidth + 2;
        hint.hidden = !over;
        hint.textContent = I18N.t("table.scroll_hint");
        wrap.classList.toggle("can-scroll", over);
        wrap.classList.toggle("at-end", wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 2);
      };
      const later = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
      wrap.addEventListener("scroll", later, { passive: true });
      const sizes = new ResizeObserver(later);
      sizes.observe(wrap);
      new MutationObserver(() => { const t = wrap.querySelector("table"); if (t) sizes.observe(t); later(); })
        .observe(wrap, { childList: true, subtree: true, characterData: true });
      const t = wrap.querySelector("table");
      if (t) sizes.observe(t);
      I18N.onChange(later);
      update();
    }
    let queued = false;
    const scan = () => { queued = false; document.querySelectorAll(".table-wrap").forEach(setup); };
    scan();
    new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(scan); } })
      .observe(document.body, { childList: true, subtree: true });
  }

  // Long method pages on phones: once the contents list at the top has scrolled away, a "Contents" button
  // (with the current section) opens the same list in a panel at the bottom; a section jumps there and
  // closes it. Esc, the back gesture or a tap outside closes it; focus returns to the button.
  function floatingToc() {
    const toc = document.querySelector(".about .toc");
    if (!toc) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toc-fab";
    btn.hidden = true;
    btn.setAttribute("aria-haspopup", "dialog");
    const dlg = document.createElement("dialog");
    dlg.className = "toc-sheet";
    dlg.setAttribute("aria-labelledby", "toc-sheet-title");
    dlg.innerHTML = '<div class="toc-sheet-head"><b id="toc-sheet-title"></b><button type="button" class="toc-close"></button></div>' +
      '<nav class="toc-sheet-list"></nav>';
    document.body.append(btn, dlg);
    const list = dlg.querySelector(".toc-sheet-list"), close = dlg.querySelector(".toc-close");
    const heads = [...document.querySelectorAll("main [data-sec]")];
    let current = null;

    function render() {
      const t = I18N.t;
      dlg.querySelector("#toc-sheet-title").textContent = t("toc.title");
      close.textContent = "×";
      close.setAttribute("aria-label", t("toc.close"));
      list.setAttribute("aria-label", t("toc.title"));
      list.replaceChildren(...[...toc.querySelectorAll("a")].map(a => a.cloneNode(true)));
      const cur = current ? current.dataset.no + " " + current.textContent.trim() : "";
      btn.innerHTML = "<span>" + esc(t("toc.button")) + "</span>" + (cur ? '<span class="cur">' + esc(cur) + "</span>" : "");
      btn.setAttribute("aria-label", t("toc.button") + (cur ? ": " + cur : ""));
    }
    // the button shows once the contents list is above the screen; near the end it moves up so it never
    // covers the footer links
    new IntersectionObserver(([e]) => { btn.hidden = e.isIntersecting || e.boundingClientRect.bottom >= 0; }).observe(toc);
    const footer = document.querySelector(".site-footer");
    // current section: the last heading whose top has passed the header
    let queued = false;
    function track() {
      queued = false;
      let h = null;
      for (const x of heads) { if (x.getBoundingClientRect().top < 90 && x.offsetParent) h = x; else if (h) break; }
      if (h !== current) { current = h; render(); }
      const under = footer ? Math.max(0, innerHeight - footer.getBoundingClientRect().top) : 0;
      btn.style.bottom = under ? under + 16 + "px" : "";
    }
    addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(track); } }, { passive: true });

    btn.addEventListener("click", () => {
      dlg.showModal();
      const here = current && [...list.querySelectorAll("a")].find(a => a.dataset.no && current.dataset.no.startsWith(a.dataset.no));
      (here || list.querySelector("a") || close).focus();
    });
    close.addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });   // tap on the dimmed area
    list.addEventListener("click", e => { if (e.target.closest("a")) dlg.close(); });
    dlg.addEventListener("close", () => btn.focus({ preventScroll: true }));
    I18N.ready.then(() => { track(); render(); });
    I18N.onChange(render);
  }

  window.SITE = { PROJECTS, esc, renderDirectory, renderProjects };
  numberPage();
  I18N.ready.then(() => { tableHints(); floatingToc(); });
})();
