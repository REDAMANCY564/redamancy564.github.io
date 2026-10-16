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
        class: "kb-chip" + (it.strong ? " strong" : ""), href: it.href, text: it.label,
        onclick: onClick ? (e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onClick(it); } } : null,
      })));
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
    async function run() {
      const food = foodInput && foodInput.value.trim() ? foodInput.value.trim() : null;
      const key = (food || "") + "|" + sortSel.value;
      if (key === lastKey) return;  // "change" and button can both fire for the same input
      lastKey = key;
      const my = ++seq;
      body.textContent = I18N.t("lit.loading");
      try {
        const r = await FlavorKB.literature(names, food, { sort: sortSel.value });
        if (my !== seq) return;
        body.innerHTML = "";
        if (!r.results.length) { body.textContent = I18N.t("lit.none"); return; }
        body.append(el("p", { class: "muted", text: I18N.t("lit.count", { n: r.hitCount, k: r.results.length }) }));
        body.append(el("ol", { class: "kb-lit-list" }, r.results.map(p => el("li", {}, [
          el("a", { href: p.url, target: "_blank", rel: "noopener", text: p.title || p.url }),
          el("div", { class: "muted", text: [p.journal, p.year].filter(Boolean).join(", ") }),
        ]))));
        body.append(el("a", { href: r.searchUrl, target: "_blank", rel: "noopener", text: I18N.t("lit.more") }));
      } catch (e) {
        if (my !== seq) return;
        body.innerHTML = "";
        body.append(el("p", { class: "kb-error", text: I18N.t("lit.failed") }));
      }
    }
    sortSel.addEventListener("change", run);
    run();
    return wrap;
  }

  /** "Typical flavor sources" summary for one compound (used on the odor predictor page). */
  function sourcesSummary(kb, id) {
    const c = kb.compounds[id];
    const wrap = el("div", { class: "kb-sources" });
    if (c.dunkel) wrap.append(el("p", { class: "small" }, [tag("t1k"), " ", I18N.t("cmp.generalist", { odor: c.dunkel.odor })]));
    const kfo = (c.kfo || []).map(f => ({ label: kb.foods[f].name, href: link("food", f), strong: true }));
    if (kfo.length) wrap.append(el("div", { class: "kb-row" }, [
      el("div", { class: "small kb-row-title" }, [tag("t1k"), " ", I18N.t("cmp.kfo_foods")]), chips(kfo, 12)]));
    const det = (c.det || []).map(f => ({ label: kb.foods[f].name, href: link("food", f) }));
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

  window.FlavorKBUI = { el, tag, link, chips, literature, sourcesSummary, litFoods };
})();
