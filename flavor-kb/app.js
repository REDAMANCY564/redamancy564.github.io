/* Flavor knowledge base page: search foods/compounds, detail views, DOI abstract analysis. */
(async function () {
  const RDKIT_WASM = "https://cdn.jsdelivr.net/npm/@rdkit/rdkit@2026.3.6/dist/RDKit_minimal.wasm";
  const MAX_CHIPS = 40;
  const $ = id => document.getElementById(id);
  const { el, tag, link, chips, literature, litFoods } = FlavorKBUI;

  await I18N.ready;

  // RDKit is only needed to draw structures: start it lazily.
  let rdkitPromise = null;
  function getRdkit() {
    if (!rdkitPromise) {
      rdkitPromise = typeof initRDKitModule === "function"
        ? initRDKitModule({ locateFile: () => RDKIT_WASM })
        : Promise.reject(new Error("RDKit not loaded"));
    }
    return rdkitPromise;
  }

  // View state, mirrored in the URL (?q= / ?food= / ?compound= / ?doi=)
  let view = { type: "none" };
  let kb = null;

  function setStatus(id, key, vars, isError) {
    const s = $(id);
    s.textContent = key ? I18N.t(key, vars) : "";
    s.classList.toggle("error", !!isError);
  }

  function pushUrl(params) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) usp.set(k, v);
    const qs = usp.toString();
    try { history.pushState(params, "", qs ? "?" + qs : location.pathname); } catch (e) { /* ignore */ }
  }

  async function ensureKb() {
    if (kb) return kb;
    setStatus("search-status", "search.loading");
    try {
      kb = await FlavorKB.load();
      setStatus("search-status", null);
      return kb;
    } catch (e) {
      setStatus("search-status", "search.load_failed", null, true);
      throw e;
    }
  }

  // ---------- Search ----------
  async function doSearch(q, push) {
    view = { type: "search", q };
    if (push) pushUrl({ q });
    $("search-input").value = q;
    $("detail").innerHTML = "";
    const kbd = await ensureKb();
    const r = await FlavorKB.search(q, 30);
    const res = $("results");
    res.innerHTML = "";
    if (!r.foods.length && !r.compounds.length) {
      setStatus("search-status", "search.none", { q });
      return;
    }
    setStatus("search-status", null);
    const foodList = el("ul", {}, r.foods.map(id => {
      const f = kbd.foods[id];
      return el("li", {}, [
        el("a", { href: "?food=" + id, text: f.name, onclick: e => { e.preventDefault(); showFood(id, true); } }), " ",
        f.src === "dunkel" ? tag("t1k") : tag("t1d"),
        el("div", { class: "meta", text: f.src === "dunkel"
          ? I18N.t("search.meta_kfo", { n: (f.kfo || []).length })
          : I18N.t("search.meta_det", { c: f.cat || "", n: (f.det || []).length }) }),
      ]);
    }));
    const cmpList = el("ul", {}, r.compounds.map(id => {
      const c = kbd.compounds[id];
      return el("li", {}, [
        el("a", { href: "?compound=" + id, text: c.name, onclick: e => { e.preventDefault(); showCompound(id, true); } }), " ",
        (c.kfo || c.dunkel) ? tag("t1k") : null,
        el("div", { class: "meta", text: (c.flavor || []).slice(0, 5).join(", ") }),
      ]);
    }));
    res.append(el("div", { class: "results" }, [
      el("div", {}, [el("h3", { text: I18N.t("search.foods", { n: r.foods.length }) }), foodList]),
      el("div", {}, [el("h3", { text: I18N.t("search.compounds", { n: r.compounds.length }) }), cmpList]),
    ]));
  }

  // ---------- Food detail ----------
  async function showFood(id, push) {
    const kbd = await ensureKb();
    const f = kbd.foods[id];
    if (!f) { setStatus("search-status", "search.none", { q: id }); return; }
    view = { type: "food", id };
    if (push) pushUrl({ food: id });
    $("results").innerHTML = "";
    const d = $("detail");
    d.innerHTML = "";
    const card = el("div", { class: "card" });
    card.append(el("h3", {}, [f.name, f.src === "dunkel" ? tag("t1k") : tag("t1d")]));
    if (f.src === "flavordb" && f.cat) card.append(el("p", { class: "small muted", text: I18N.t("food.category", { c: f.cat }) }));

    if (f.kfo && f.kfo.length) {
      card.append(el("div", { class: "kb-row-title small" }, [tag("t1k"), " ", I18N.t("food.kfo")]));
      for (const n of f.notes || []) {
        card.append(el("p", { class: "stmt muted" }, [
          n.text + " (Dunkel et al. 2014, " + I18N.t("food.page", { p: n.page }) + ")",
          n.complete ? el("strong", { text: " " + I18N.t("food.kfo_complete") }) : null,
        ]));
      }
      card.append(chips(f.kfo.map(c => ({ label: kbd.compounds[c].name, href: "?compound=" + c, id: c, strong: true })),
        MAX_CHIPS, it => showCompound(it.id, true)));
    }
    if (f.det && f.det.length) {
      card.append(el("div", { class: "kb-row-title small" }, [tag("t1d"), " ", I18N.t("food.detected", { n: f.det.length })]));
      card.append(el("p", { class: "small muted", text: I18N.t("food.detected_note") }));
      const sorted = f.det.slice().sort((a, b) => (kbd.compounds[b].kfo ? 1 : 0) - (kbd.compounds[a].kfo ? 1 : 0));
      card.append(chips(sorted.map(c => ({ label: kbd.compounds[c].name, href: "?compound=" + c, id: c, strong: !!kbd.compounds[c].kfo })),
        MAX_CHIPS, it => showCompound(it.id, true)));
    }
    card.append(literature([f.name.replace(/\s*\(.*?\)\s*/g, " ").trim()], null));
    d.append(card);
    d.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- Compound detail ----------
  async function showCompound(id, push) {
    const kbd = await ensureKb();
    const c = kbd.compounds[id];
    if (!c) { setStatus("search-status", "search.none", { q: id }); return; }
    view = { type: "compound", id };
    if (push) pushUrl({ compound: id });
    $("results").innerHTML = "";
    const d = $("detail");
    d.innerHTML = "";
    const card = el("div", { class: "card" });
    card.append(el("h3", {}, [c.name, (c.kfo || c.dunkel) ? tag("t1k") : null]));
    if (c.alt || c.syn) {
      card.append(el("p", { class: "small muted", text: I18N.t("cmp.synonyms") + ": " + (c.alt || []).concat(c.syn || []).slice(0, 10).join("; ") }));
    }

    const svgBox = el("div", { class: "mol-svg", text: I18N.t("cmp.loading_struct") });
    const left = el("div", {}, [
      el("p", { class: "mono small muted", style: "word-break:break-all;margin:0", text: c.smiles }), svgBox,
      c.cid ? el("a", { class: "small", href: "https://pubchem.ncbi.nlm.nih.gov/compound/" + c.cid, target: "_blank", rel: "noopener", text: I18N.t("cmp.pubchem") }) : null,
      el("p", { class: "small" }, [el("a", { href: "../odor-predictor/?q=" + encodeURIComponent(c.smiles) + "#demo", text: I18N.t("cmp.predict") })]),
      el("p", { class: "small" }, [el("a", { href: "../ingredient-finder/?mode=b&smiles=" + encodeURIComponent(c.smiles), text: I18N.t("cmp.finder") })]),
    ]);
    getRdkit().then(R => {
      const mol = R.get_mol(c.smiles);
      if (!mol) return;
      try { svgBox.innerHTML = mol.get_svg_with_highlights(JSON.stringify({ width: 360, height: 270, clearBackground: false })); }
      finally { mol.delete(); }
    }).catch(() => { svgBox.textContent = ""; });

    const right = el("div", {});
    if (c.dunkel) right.append(el("p", { class: "small" }, [tag("t1k"), " ", I18N.t("cmp.generalist", { odor: c.dunkel.odor }) + " (" + I18N.t("food.page", { p: c.dunkel.page }) + ")"]));
    right.append(el("div", { class: "kb-row-title small" }, [tag("t1k"), " ", I18N.t("cmp.kfo_foods")]));
    if (c.kfo && c.kfo.length) {
      right.append(chips(c.kfo.map(f => ({ label: kbd.foods[f].name, href: "?food=" + f, id: f, strong: true })), MAX_CHIPS, it => showFood(it.id, true)));
    } else {
      right.append(el("p", { class: "small muted", text: I18N.t("cmp.no_kfo") }));
    }
    if (c.det && c.det.length) {
      right.append(el("div", { class: "kb-row-title small" }, [tag("t1d"), " ", I18N.t("cmp.det_foods", { n: c.det.length })]));
      right.append(chips(c.det.map(f => ({ label: kbd.foods[f].name, href: "?food=" + f, id: f })), MAX_CHIPS, it => showFood(it.id, true)));
    }
    if (c.flavor && c.flavor.length) {
      right.append(el("div", { class: "kb-row-title small", text: I18N.t("cmp.flavor") }));
      right.append(el("p", { class: "small", text: c.flavor.join(", ") }));
    }
    if (c.fema) right.append(el("p", { class: "small" }, [el("b", { text: I18N.t("cmp.fema") + ": " }), c.fema]));

    card.append(el("div", { class: "grid cmp" }, [left, right]));
    card.append(literature(FlavorKB.compoundNames(c), litFoods(kbd, c)));
    d.append(card);
    d.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- DOI analysis (tier 3) ----------
  let doiState = null;   // {paper, segs} or {error}
  async function analyzeDoi(input, push) {
    const doi = FlavorKB.cleanDoi(input);
    $("doi-input").value = input;
    $("doi-result").innerHTML = "";
    if (!doi) { doiState = null; setStatus("doi-status", "doi.bad", null, true); return; }
    if (push) pushUrl({ doi });
    $("doi-btn").disabled = true;
    setStatus("doi-status", "doi.loading");
    try {
      const paper = await FlavorKB.paper(doi);
      let segs = null;
      if (paper.abstract) {
        await ensureKb();
        segs = await FlavorKB.matchText(paper.abstract);
      }
      doiState = { paper, segs };
      setStatus("doi-status", null);
      renderDoi();
    } catch (e) {
      doiState = null;
      const key = e.code === "bad_doi" ? "doi.bad" : e.code === "not_found" ? "doi.not_found" : "doi.failed";
      setStatus("doi-status", key, null, true);
    } finally {
      $("doi-btn").disabled = false;
    }
  }

  function renderDoi() {
    const box = $("doi-result");
    box.innerHTML = "";
    if (!doiState) return;
    const { paper, segs } = doiState;
    const card = el("div", { class: "card" });
    card.append(el("h3", {}, [el("a", { href: "https://doi.org/" + paper.doi, target: "_blank", rel: "noopener", text: paper.title || paper.doi })]));
    card.append(el("p", { class: "small muted", text: [paper.journal, paper.year, "doi:" + paper.doi].filter(Boolean).join(" · ") }));
    if (!paper.abstract) {
      card.append(el("p", { class: "kb-error", text: I18N.t("doi.no_abstract") }));
      box.append(card);
      return;
    }
    const abs = el("p", { class: "abstract" });
    const found = new Map();
    for (const s of segs) {
      if (!s.id) { abs.append(document.createTextNode(s.text)); continue; }
      found.set(s.id, (found.get(s.id) || 0) + 1);
      abs.append(el("mark", { class: "kb-hit" }, [el("a", { href: "?compound=" + s.id, text: s.text,
        onclick: e => { e.preventDefault(); showCompound(s.id, true); } })]));
    }
    card.append(el("div", { class: "kb-lit-head" }, [tag("t3"), el("span", { class: "small muted", text: I18N.t("doi.source", { s: paper.source }) })]));
    card.append(abs);
    if (found.size) {
      card.append(el("div", { class: "kb-row-title small", text: I18N.t("doi.matches", { n: found.size }) }));
      card.append(chips([...found.keys()].map(id => ({ label: kb.compounds[id].name, href: "?compound=" + id, id, strong: !!kb.compounds[id].kfo })),
        MAX_CHIPS, it => showCompound(it.id, true)));
    } else {
      card.append(el("p", { class: "small muted", text: I18N.t("doi.no_matches") }));
    }
    card.append(el("p", { class: "small muted", text: I18N.t("doi.disclaimer") }));
    box.append(card);
  }

  // ---------- Wiring ----------
  $("search-form").addEventListener("submit", e => {
    e.preventDefault();
    const q = $("search-input").value.trim();
    if (q) doSearch(q, true).catch(() => {});
  });
  document.querySelectorAll("button[data-q]").forEach(b => b.addEventListener("click", () => doSearch(b.dataset.q, true).catch(() => {})));
  $("doi-form").addEventListener("submit", e => { e.preventDefault(); analyzeDoi($("doi-input").value, true); });

  function route() {
    const p = new URLSearchParams(location.search);
    const run = p.get("food") ? showFood(p.get("food"), false)
      : p.get("compound") ? showCompound(p.get("compound"), false)
      : p.get("q") ? doSearch(p.get("q"), false) : null;
    if (run) run.catch(() => {});
    if (p.get("doi")) analyzeDoi(p.get("doi"), false);
  }
  window.addEventListener("popstate", route);
  I18N.onChange(() => {
    if (view.type === "search") doSearch(view.q, false).catch(() => {});
    else if (view.type === "food") showFood(view.id, false).catch(() => {});
    else if (view.type === "compound") showCompound(view.id, false).catch(() => {});
    renderDoi();
  });
  route();
})();
