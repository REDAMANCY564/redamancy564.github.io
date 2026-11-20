/* Flavor knowledge base page: search foods/compounds, detail views, DOI abstract analysis. */
(async function () {
  const MAX_CHIPS = 40;
  const $ = id => document.getElementById(id);
  const { el, tag, link, chips, literature, litFoods, foodName, linkSources, foodChips } = FlavorKBUI;

  /** Sources of a food record (src + srcs) as a sentence. */
  const SRC_KEY = { flavordb: "src.flavordb", foodb: "src.foodb", author: "src.author" };
  const foodSourceLine = f => (f.srcs || [f.src]).filter(s => SRC_KEY[s]).map(s => I18N.t(SRC_KEY[s])).join("; ");

  await I18N.ready;

  // RDKit is only needed to draw structures: start it lazily.
  let rdkitPromise = null;
  function getRdkit() {
    if (!rdkitPromise) {
      rdkitPromise = Libs.rdkit();   // self-hosted, loaded the first time a structure is drawn
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
    try { history.pushState(params, "", I18N.keepLang(qs)); } catch (e) { /* ignore */ }
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
    $("search-input").value = q;
    $("detail").innerHTML = "";
    const kbd = await ensureKb();
    const r = await FlavorKB.search(q, 30);
    // exactly one match (one food or one compound): open its card straight away
    if (r.foods.length + r.compounds.length === 1) {
      if (r.foods.length) await showFood(r.foods[0], push);
      else await showCompound(r.compounds[0], push);
      return;
    }
    if (push) pushUrl({ q });
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
        el("a", { href: "?food=" + id, text: foodName(f) + (I18N.lang === "zh" && f.zh ? " (" + f.name + ")" : ""), onclick: e => { e.preventDefault(); showFood(id, true); } }), " ",
        f.src === "dunkel" || f.kfo_src ? tag("t1k") : tag("t1d"),
        el("div", { class: "meta", text: f.src === "dunkel"
          ? I18N.t("search.meta_kfo", { n: (f.kfo || []).length })
          : I18N.t("search.meta_det", { c: f.cat || "", n: (f.det || []).length }) +
            (f.kfo_src === "author" ? I18N.t("search.meta_kfo_author", { n: f.kfo.length }) : "") }),
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
    // The tier tag is shown once, at the section that lists the compounds; the heading carries it only
    // when the food has neither section.
    const hasKfo = !!(f.kfo && f.kfo.length), hasDet = !!(f.det && f.det.length);
    card.append(el("h3", {}, [foodName(f), I18N.lang === "zh" && f.zh ? " (" + f.name + ")" : null, hasKfo || hasDet ? null : f.src === "dunkel" ? tag("t1k") : tag("t1d")]));
    if (f.src !== "dunkel" && f.cat) card.append(el("p", { class: "small muted", text: I18N.t("food.category", { c: f.cat }) }));
    if (f.src !== "dunkel") card.append(el("p", { class: "small muted", text: I18N.t("food.sources", { s: foodSourceLine(f) }) }));

    if (hasKfo) {
      // key flavor compounds: Dunkel 2014 statements, or the author's published data (human milk, Table 1)
      const author = f.kfo_src === "author";
      card.append(el("p", { class: "small kb-tag-line" }, [tag("t1k"), " ", I18N.t(author ? "food.kfo_desc_author" : "food.kfo_desc")]));
      if (author) {
        card.append(el("p", { class: "stmt muted" }, [I18N.t("food.kfo_author_src") + " ",
          el("a", { href: "https://doi.org/10.1016/j.fbio.2026.110162", target: "_blank", rel: "noopener", text: "doi:10.1016/j.fbio.2026.110162" })]));
      }
      for (const n of f.notes || []) {
        card.append(el("p", { class: "stmt muted" }, [
          n.text + " (Dunkel et al. 2014, " + I18N.t("food.page", { p: n.page }) + ")",
          n.complete ? el("strong", { text: " " + I18N.t("food.kfo_complete") }) : null,
        ]));
      }
      card.append(chips(f.kfo.map(c => ({ label: kbd.compounds[c].name, href: "?compound=" + c, id: c, strong: true })),
        MAX_CHIPS, it => showCompound(it.id, true)));
    }
    if (hasDet) {
      card.append(el("div", { class: "kb-row-title small" }, [tag("t1d"), " ", I18N.t("food.detected", { n: f.det.length })]));
      card.append(el("p", { class: "small muted", text: I18N.t("food.detected_note") }));
      const sorted = FlavorKBUI.sortDetected(kbd, id, f.det);
      card.append(chips(sorted.map(c => {
        const s = linkSources(kbd, c, id);
        return { label: kbd.compounds[c].name, href: "?compound=" + c, id: c, strong: !!kbd.compounds[c].kfo, mark: s.mark,
                 title: I18N.t("src.title") + "\n" + s.lines.join("\n") };
      }), MAX_CHIPS, it => showCompound(it.id, true)));
      card.append(el("p", { class: "small muted", text: I18N.t("src.legend") }));
    }
    card.append(literature([f.name], null));   // the bracketed note ("wine (red and white)") is dropped in FlavorKB
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
    // "intensity curve" link beside the name when this compound has an odor intensity curve (matched by CAS, assets/intensity.js)
    const curve = el("span", {});
    card.append(el("h3", {}, [c.name, curve]));   // the key flavor compound tag is shown once, in the section below
    Intensity.load().then(() => { curve.innerHTML = Intensity.link(Intensity.byKb(id)); }, () => { /* no link without the data */ });
    if (c.alt || c.syn) {
      card.append(el("p", { class: "small muted", text: I18N.t("cmp.synonyms") + ": " + (c.alt || []).concat(c.syn || []).slice(0, 10).join("; ") }));
    }

    const svgBox = el("div", { class: "mol-svg", text: I18N.t("cmp.loading_struct") });
    // SMILES with a copy button (assets/i18n.js); the knowledge base has no CAS numbers to show
    const smilesText = document.createTextNode(c.smiles);
    const left = el("div", {}, [
      el("p", { class: "mono small muted", style: "word-break:break-all;margin:0" },
        [smilesText, " ", UI.copyButton({ text: c.smiles, label: "copy.smiles", select: smilesText })]), svgBox,
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
    if (c.kfo && c.kfo.length) {
      FlavorKBUI.kfoGroups(kbd, c).forEach(g => {
        right.append(el("p", { class: "small kb-tag-line" }, [tag("t1k"), " ", I18N.t(g.desc)]));
        right.append(chips(g.foods.map(f => ({ label: foodName(kbd.foods[f]), href: "?food=" + f, id: f, strong: true })), MAX_CHIPS, it => showFood(it.id, true)));
      });
    } else {
      right.append(el("p", { class: "small muted", text: I18N.t("cmp.no_kfo") }));
    }
    if (c.det && c.det.length) {
      right.append(el("div", { class: "kb-row-title small" }, [tag("t1d"), " ", I18N.t("cmp.det_foods", { n: c.det.length })]));
      right.append(chips(foodChips(kbd, id, c.det, false).map(it => Object.assign(it, { href: "?food=" + it.id })), MAX_CHIPS, it => showFood(it.id, true)));
      right.append(el("p", { class: "small muted", text: I18N.t("src.legend") }));
      if (c.fdbm) right.append(el("p", { class: "small muted", text: I18N.t(c.fdbm === "sk14" ? "cmp.fdbm_sk14" : "cmp.fdbm_cas") }));
      if (c.isomer_note) right.append(el("p", { class: "small muted", text: I18N.t("cmp.isomer_note") }));
      // every food with its sources (FooDB references in full), for touch screens without hover
      const det = el("details", { class: "small" }, [el("summary", { text: I18N.t("cmp.src_details", { n: c.det.length }) })]);
      const ul = el("ul", { class: "kb-src-list" });
      c.det.forEach(f => ul.append(el("li", {}, [el("b", { text: foodName(kbd.foods[f]) }), ": " + linkSources(kbd, id, f).lines.join("; ")])));
      det.append(ul);
      right.append(det);
    }
    if (c.flavor && c.flavor.length) {
      right.append(el("div", { class: "kb-row-title small", text: I18N.t("cmp.flavor") }));
      right.append(el("p", { class: "small", text: c.flavor.join(", ") }));
    }
    if (c.fema) right.append(el("p", { class: "small" }, [el("b", { text: I18N.t("cmp.fema") + ": " }), c.fema]));

    card.append(el("div", { class: "grid cmp" }, [left, right]));
    // regulatory status (EU, China): matched by CAS to the ingredient-finder library (assets/regulatory.js)
    const regBox = el("div", { class: "small", text: I18N.t("reg.loading") });
    card.append(el("div", { class: "kb-row-title small", text: I18N.t("reg.title") }), regBox);
    Reg.load().then(() => { regBox.innerHTML = Reg.html(Reg.byKb(id)); }, () => { regBox.textContent = I18N.t("reg.load_failed"); });
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
    setStatus("doi-status", null);
    // timed progress per source: Europe PMC first, then Crossref if needed, each up to 60 s
    const wait = FlavorKBUI.waitBar("doi.wait_epmc");
    $("doi-result").append(wait.node);
    try {
      const paper = await FlavorKB.paper(doi, (src, why) => {
        if (src === "crossref") wait.restart(why === "failed" ? "doi.wait_crossref_failed" : "doi.wait_crossref");
      });
      await wait.finish();
      wait.node.remove();
      let segs = null;
      if (paper.abstract) {
        await ensureKb();
        segs = await FlavorKB.matchText(paper.abstract);
      }
      doiState = { paper, segs };
      setStatus("doi-status", null);
      renderDoi();
    } catch (e) {
      wait.stop();
      wait.node.remove();
      doiState = null;
      const key = e.code === "bad_doi" ? "doi.bad" : e.code === "not_found" ? "doi.not_found" : e.code === "timeout" ? "doi.timeout" : "doi.failed";
      setStatus("doi-status", key, { s: FlavorKB.TIMEOUT_S }, true);
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
