/*
 * Shared UI pieces for the flavor knowledge base (used by flavor-kb/ and odor-predictor/).
 * Depends on I18N (assets/i18n.js) and FlavorKB (kb.js). Builds DOM nodes; external text is
 * always set via textContent.
 */
(function () {
  const KB_PAGE = new URL(".", document.currentScript.src);  // .../flavor-kb/

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) if (c != null) n.append(c);
    return n;
  }

  function tag(kind) {
    const key = { t1k: "legend.t1k", t1d: "legend.t1d", t2: "legend.t2", t3: "legend.t3" }[kind];
    return el("span", { class: "tag " + kind, text: I18N.t(key) });
  }

  function link(kind, id) {
    return new URL("?" + kind + "=" + encodeURIComponent(id), KB_PAGE).href;
  }

  /** Chip list of foods or compounds with a "show all" toggle beyond `max` items. */
  function chips(items, max, onClick) {
    const box = el("div", { class: "kb-chips" });
    const render = (n) => {
      box.innerHTML = "";
      items.slice(0, n).forEach(it => box.append(el("a", {
        class: "kb-chip" + (it.strong ? " strong" : ""), href: it.href, title: it.title || null,
        onclick: onClick ? (e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onClick(it); } } : null,
      }, [it.label, it.mark ? el("sup", { class: "fsrc", text: it.mark }) : null])));
      if (items.length > n) {
        box.append(el("button", { type: "button", class: "kb-more", text: I18N.t("cmp.show_all", { n: items.length }),
          onclick: () => render(items.length) }));
      }
    };
    render(max);
    return box;
  }

  let litCounter = 0;

  /**
   * Tier 2 literature block. names: compound names (or a food name).
   * foods: [{name}] suggestions for a free-text food filter (null = no food filter).
   * Returns a DOM node that fills itself asynchronously; API failure only affects this block.
   */
  function literature(names, foods) {
    const wrap = el("div", { class: "kb-lit" });
    const head = el("div", { class: "kb-lit-head" }, [el("h4", { text: I18N.t("lit.title") }), tag("t2")]);
    wrap.append(head);
    let foodInput = null;
    if (foods) {
      // Free-text food filter with suggestions (key-odorant foods first, then every food in the KB)
      const listId = "kb-food-list-" + (++litCounter);
      foodInput = el("input", { type: "text", class: "kb-lit-input", list: listId, autocomplete: "off",
        autocapitalize: "off", spellcheck: "false", placeholder: I18N.t("lit.food_placeholder"),
        "aria-label": I18N.t("lit.food_label") });
      const datalist = el("datalist", { id: listId }, foods.map(f => el("option", { value: f.name })));
      const apply = el("button", { type: "button", class: "kb-lit-apply", text: I18N.t("lit.apply") });
      const form = el("form", { class: "kb-lit-form", novalidate: "" }, [
        el("label", { class: "small kb-row-title", for: null, text: I18N.t("lit.food_label") }),
        el("div", { class: "kb-lit-row" }, [foodInput, apply]), datalist]);
      form.addEventListener("submit", e => { e.preventDefault(); run(); });
      apply.addEventListener("click", run);
      foodInput.addEventListener("change", run);
      wrap.append(form);
    }
    const sortSel = el("select", { class: "kb-lit-food", "aria-label": I18N.t("lit.sort_label") }, [
      el("option", { value: "date", text: I18N.t("lit.sort_date") }),
      el("option", { value: "cited", text: I18N.t("lit.sort_cited") }),
    ]);
    wrap.append(el("label", { class: "small kb-lit-label" }, [I18N.t("lit.sort_label") + " ", sortSel]));
    const body = el("div", { class: "kb-lit-body small" });
    wrap.append(body, el("p", { class: "small muted kb-lit-note", text: I18N.t("lit.note") }));

    let seq = 0;
    let lastKey = null;
    let wait = null;   // progress display of the request in flight

    function render(r) {
      body.innerHTML = "";
      if (!r.results.length) { body.textContent = I18N.t("lit.none"); return; }
      body.append(el("p", { class: "muted", text: I18N.t("lit.count", { n: r.hitCount, k: r.results.length }) }));
      body.append(el("ol", { class: "kb-lit-list" }, r.results.map(p => el("li", {}, [
        el("a", { href: p.url, target: "_blank", rel: "noopener", text: p.title || p.url }),
        el("div", { class: "muted", text: [p.journal, p.year].filter(Boolean).join(", ") }),
      ]))));
      body.append(el("a", { href: r.searchUrl, target: "_blank", rel: "noopener", text: I18N.t("lit.more") }));
    }

    function renderError(e, searchUrl) {
      body.innerHTML = "";
      const msg = el("p", { class: "kb-error", text: I18N.t(e && e.code === "timeout" ? "lit.timeout" : "lit.failed",
        { s: FlavorKB.TIMEOUT_S }) });
      I18N.nobr(msg);
      body.append(msg, el("p", { class: "kb-lit-actions" }, [
        el("button", { type: "button", class: "kb-lit-apply kb-lit-retry", text: I18N.t("lit.retry"),
          onclick: () => run(true) }),
        el("a", { href: searchUrl, target: "_blank", rel: "noopener", text: I18N.t("lit.search_site") }),
      ]));
    }

    async function run(force) {
      const food = foodInput && foodInput.value.trim() ? foodInput.value.trim() : null;
      const key = (food || "") + "|" + sortSel.value;
      if (key === lastKey && force !== true) return;  // "change" and button can both fire for the same input
      lastKey = key;
      const my = ++seq;
      if (wait) { wait.stop(); wait = null; }
      const opts = { sort: sortSel.value };
      // answered before during this visit: show it at once, no request and no progress bar
      const cached = FlavorKB.literatureCached(names, food, opts);
      if (cached) { render(cached); return; }
      const req = FlavorKB.literatureRequest(names, food, opts);
      body.innerHTML = "";
      const w = wait = waitBar();
      body.append(w.node);
      try {
        const r = await FlavorKB.literature(names, food, opts);
        if (my !== seq) return;
        wait = null;
        await w.finish();
        if (my !== seq) return;
        render(r);
      } catch (e) {
        if (my !== seq) return;
        wait = null;
        w.stop();
        renderError(e, req.searchUrl);
      }
    }
    sortSel.addEventListener("change", run);
    run();
    return wrap;
  }

  /**
   * Timed progress for the Europe PMC request: the bar shows waited time / maximum wait (a real
   * clock, not an estimate of progress), with "waited n s (up to 60 s)" beside it and, after 8 s,
   * a line saying the network is slow. Only transform and opacity animate; with reduced motion
   * the bar is hidden and only the text is shown (CSS).
   */
  const SLOW_AFTER_MS = 8000;
  // textKey: i18n key with {n} (seconds waited) and {max}; restart(key) starts a new timed step
  // (DOI analysis: Europe PMC, then Crossref, each with its own 60 s).
  function waitBar(textKey) {
    textKey = textKey || "lit.waiting";
    const maxMs = FlavorKB.TIMEOUT_S * 1000;
    const fill = el("span", { class: "kb-wait-fill" });
    const bar = el("div", { class: "kb-wait-bar", "aria-hidden": "true" }, [fill]);
    const text = el("span", { class: "kb-wait-text" });
    const slow = el("span", { class: "kb-wait-slow", "aria-live": "polite" });
    const node = el("div", { class: "kb-wait", role: "status" }, [bar, el("p", { class: "muted" }, [text, slow])]);
    let t0 = performance.now();
    let shownS = -1;
    function tick() {
      const ms = performance.now() - t0;
      fill.style.transform = "scaleX(" + Math.min(ms / maxMs, 1).toFixed(4) + ")";
      const s = Math.min(Math.floor(ms / 1000), FlavorKB.TIMEOUT_S);
      if (s !== shownS) {
        shownS = s;
        text.textContent = I18N.t(textKey, { n: s, max: FlavorKB.TIMEOUT_S });
      }
      if (ms >= SLOW_AFTER_MS && !slow.textContent) slow.textContent = " " + I18N.t("lit.slow");
    }
    tick();
    const timer = setInterval(tick, 250);
    const stop = () => clearInterval(timer);
    const reduced = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    return {
      node, stop,
      restart(key) {
        textKey = key; t0 = performance.now(); shownS = -1; slow.textContent = "";
        tick();
      },
      // result arrived: fill the bar, fade it out, then the caller shows the result
      finish() {
        stop();
        if (reduced()) return Promise.resolve();
        node.classList.add("done");
        fill.style.transform = "scaleX(1)";
        return new Promise(res => setTimeout(res, 400));
      },
    };
  }

  /** Food name in the page language (only a few foods have a Chinese name, e.g. human milk). */
  const foodName = f => (I18N.lang === "zh" && f.zh ? f.zh : f.name);

  /**
   * Sources of one compound-food link (compounds.json "ds"; absent = FlavorDB2 only):
   * {mark: "F·Fo·A", lines: ["FlavorDB2", "FooDB: USDA ...", "author's published data: ..."]}.
   */
  function linkSources(kb, cid, fid) {
    const c = kb.compounds[cid];
    const codes = (c && c.ds && c.ds[fid]) || ["F"];
    const marks = [], lines = [];
    if (codes.includes("F")) { marks.push("F"); lines.push(I18N.t("src.flavordb")); }
    const refs = codes.filter(x => typeof x === "number");
    if (refs.length) {
      marks.push("Fo");
      refs.forEach(i => lines.push(I18N.t("src.foodb_ref", { r: (kb.refs[i] || {}).text || "" })));
    }
    const tabs = codes.filter(x => x === "S1" || x === "S2");
    if (tabs.length) { marks.push("A"); lines.push(I18N.t("src.author_ref", { t: tabs.join(", ") })); }
    return { mark: marks.join("·"), lines };
  }

  /** Chip items for the foods of a compound, with source marks and the sources as title. */
  function foodChips(kb, cid, fids, strong) {
    return fids.map(f => {
      const s = linkSources(kb, cid, f);
      return { label: foodName(kb.foods[f]), href: link("food", f), id: f, strong: !!strong, mark: s.mark, title: I18N.t("src.title") + "\n" + s.lines.join("\n") };
    });
  }

  /** "Typical flavor sources" summary for one compound (used on the odor predictor page). */
  function sourcesSummary(kb, id) {
    const c = kb.compounds[id];
    const wrap = el("div", { class: "kb-sources" });
    if (c.dunkel) wrap.append(el("p", { class: "small" }, [tag("t1k"), " ", I18N.t("cmp.generalist", { odor: c.dunkel.odor })]));
    const kfo = (c.kfo || []).map(f => ({ label: foodName(kb.foods[f]), href: link("food", f), strong: true }));
    if (kfo.length) wrap.append(el("div", { class: "kb-row" }, [
      el("p", { class: "small kb-tag-line" }, [tag("t1k"), " ", I18N.t("cmp.kfo_foods_desc")]), chips(kfo, 12)]));
    const det = foodChips(kb, id, c.det || [], false);
    if (det.length) wrap.append(el("div", { class: "kb-row" }, [
      el("div", { class: "small kb-row-title" }, [tag("t1d"), " ", I18N.t("cmp.det_foods", { n: det.length })]), chips(det, 12)]));
    if (!kfo.length && !det.length && !c.dunkel) wrap.append(el("p", { class: "small muted", text: I18N.t("kb.not_in_kb") }));
    wrap.append(el("a", { class: "small", href: link("compound", id), text: I18N.t("kb.open") }));
    return wrap;
  }

  /**
   * Food suggestions for the literature filter: foods where the compound is a key odorant, then
   * foods where it was detected, then every other food in the knowledge base (names de-duplicated).
   * c may be null (molecule not in the knowledge base).
   */
  function litFoods(kb, c) {
    const ids = c ? (c.kfo || []).concat(c.det || []) : [];
    const ordered = ids.concat(Object.keys(kb.foods).sort((a, b) => kb.foods[a].name.localeCompare(kb.foods[b].name)));
    const seen = new Set();
    const out = [];
    for (const id of ordered) {
      const name = kb.foods[id].name;
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ name });
    }
    return out;
  }

  window.FlavorKBUI = { el, tag, link, chips, literature, waitBar, sourcesSummary, litFoods, foodName, linkSources, foodChips };
})();
