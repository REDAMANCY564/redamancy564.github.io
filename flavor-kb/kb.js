/*
 * Flavor knowledge base: shared data access + external literature APIs.
 * Used by flavor-kb/ and odor-predictor/. No API keys: Europe PMC and Crossref are
 * free, keyless and allow browser (CORS) requests.
 *
 * Tier 1: data/compounds.json, data/foods.json (Dunkel 2014 main text; FlavorDB2)
 * Tier 2: Europe PMC search (live)
 * Tier 3: DOI -> abstract (Europe PMC, Crossref fallback) + text matching
 *
 * All external text is inserted as text nodes, never as HTML.
 */
(function () {
  const BASE = new URL(".", document.currentScript.src);
  const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
  const CROSSREF = "https://api.crossref.org/works/";
  const STEREO_LAYERS = ["b", "t", "m", "s"];

  class ApiError extends Error {
    constructor(code) { super(code); this.code = code; }  // network | not_found | bad_response
  }

  async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } catch (e) {
      throw new ApiError("network");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) throw new ApiError("not_found");
    if (!res.ok) throw new ApiError("network");
    try { return await res.json(); } catch (e) { throw new ApiError("bad_response"); }
  }

  // ---------- Tier 1 data ----------
  let dataPromise = null;
  function load() {
    if (!dataPromise) {
      dataPromise = Promise.all(["compounds", "foods", "meta"].map(n =>
        fetch(new URL("data/" + n + ".json", BASE)).then(r => {
          if (!r.ok) throw new Error("Failed to load " + n);
          return r.json();
        }))).then(([compounds, foods, meta]) => {
          const byInchi = new Map();
          for (const [id, c] of Object.entries(compounds)) byInchi.set(c.inchi, id);
          return { compounds, foods, meta, byInchi };
        });
      dataPromise.catch(() => { dataPromise = null; });
    }
    return dataPromise;
  }

  /** Standard InChI with stereo layers removed (same rule as training/knowledge/build_kb.py). */
  function stripStereo(inchi) {
    if (!inchi) return null;
    const parts = inchi.split("/");
    return [parts[0]].concat(parts.slice(1).filter(p => !STEREO_LAYERS.includes(p[0]))).join("/");
  }

  /** Look up a molecule (RDKit.js mol) in the knowledge base. Returns compound id or null. */
  async function findByMol(mol) {
    const kb = await load();
    return kb.byInchi.get(stripStereo(mol.get_inchi())) || null;
  }

  function norm(s) { return (s || "").toLowerCase().trim(); }

  function compoundNames(c) {
    return [c.name].concat(c.alt || [], c.syn || []);
  }

  /** Simple ranked search: exact > prefix > word-prefix > substring. */
  function rank(names, q, wordRe) {
    let best = 0;
    for (const n of names) {
      const s = norm(n);
      if (!s) continue;
      let score = 0;
      if (s === q) score = 4;
      else if (s.startsWith(q)) score = 3;
      else if (wordRe.test(s)) score = 2;
      else if (s.includes(q)) score = 1;
      if (score > best) best = score;
    }
    return best;
  }

  async function search(query, limit) {
    const kb = await load();
    const q = norm(query);
    if (!q) return { foods: [], compounds: [] };
    const foods = [], compounds = [];
    const wordRe = new RegExp("(^|[^a-z0-9])" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    for (const [id, f] of Object.entries(kb.foods)) {
      const s = rank([f.name].concat(f.syn || []), q, wordRe);
      if (s) foods.push({ id, s, n: (f.kfo || []).length * 1000 + (f.det || []).length });
    }
    for (const [id, c] of Object.entries(kb.compounds)) {
      const s = rank(compoundNames(c), q, wordRe);
      if (s) compounds.push({ id, s, n: (c.kfo || []).length * 1000 + (c.det || []).length });
    }
    const cmp = (a, b) => b.s - a.s || b.n - a.n;
    return {
      foods: foods.sort(cmp).slice(0, limit || 30).map(x => x.id),
      compounds: compounds.sort(cmp).slice(0, limit || 30).map(x => x.id),
    };
  }

  // ---------- Tier 2: Europe PMC literature search ----------
  function quote(term) {
    return '"' + String(term).replace(/"/g, "").replace(/\s*\(.*?\)\s*/g, " ").trim() + '"';
  }

  /**
   * names: compound names (OR-ed), food: optional food name.
   * Returns {hitCount, results: [{title, journal, year, url}], searchUrl}.
   */
  async function literature(names, food, opts) {
    opts = opts || {};
    // All terms are restricted to title + abstract: full-text matching returns many off-topic papers.
    const nameQ = "TITLE_ABS:(" + names.filter(Boolean).slice(0, 3).map(quote).join(" OR ") + ")";
    const parts = [nameQ];
    if (food) parts.push("TITLE_ABS:" + quote(food));
    parts.push("TITLE_ABS:(aroma OR odor OR odour OR odorant OR odorants OR flavor OR flavour)");
    const query = parts.join(" AND ");
    const sort = opts.sort === "cited" ? "&sort=" + encodeURIComponent("CITED desc") : "";
    const url = EPMC + "?format=json&resultType=lite&pageSize=" + (opts.pageSize || 8) + sort + "&query=" + encodeURIComponent(query);
    const d = await fetchJson(url);
    if (!d.resultList) throw new ApiError("bad_response");
    return {
      hitCount: d.hitCount || 0,
      searchUrl: "https://europepmc.org/search?query=" + encodeURIComponent(query),
      results: d.resultList.result.map(r => ({
        title: stripTags(r.title || ""),
        journal: r.journalTitle || r.bookOrReportDetails && r.bookOrReportDetails.publisher || "",
        year: r.pubYear || "",
        url: r.doi ? "https://doi.org/" + r.doi : "https://europepmc.org/article/" + r.source + "/" + r.id,
      })),
    };
  }

  // ---------- Tier 3: DOI -> title, journal, abstract ----------
  function cleanDoi(input) {
    const m = String(input || "").trim().match(/10\.\d{4,9}\/\S+/);
    return m ? m[0].replace(/[.,;)\]]+$/, "") : null;
  }

  function stripTags(s) {
    // Parse as an inert document (no scripts run, nothing attached to the page) and keep text only.
    // Some sources escape their markup (&lt;i&gt;), so decode a second time when tags remain.
    const once = str => {
      const doc = new DOMParser().parseFromString("<body>" + str + "</body>", "text/html");
      doc.querySelectorAll("jats\\:title, title").forEach(t => { if (/^abstract$/i.test(t.textContent.trim())) t.remove(); });
      return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
    };
    let t = once(s);
    if (/<\/?[a-z][^>]*>/i.test(t)) t = once(t);
    return t;
  }

  async function paper(doiInput) {
    const doi = cleanDoi(doiInput);
    if (!doi) throw new ApiError("bad_doi");
    let epmcErr = null;
    try {
      const d = await fetchJson(EPMC + "?format=json&resultType=core&pageSize=1&query=" + encodeURIComponent("DOI:" + doi));
      const r = d.resultList && d.resultList.result[0];
      if (r && (r.doi || "").toLowerCase() === doi.toLowerCase()) {
        return {
          doi, source: "Europe PMC",
          title: stripTags(r.title || ""),
          journal: (r.journalInfo && r.journalInfo.journal && r.journalInfo.journal.title) || "",
          year: r.pubYear || "",
          abstract: r.abstractText ? stripTags(r.abstractText) : "",
        };
      }
    } catch (e) {
      epmcErr = e;
    }
    // Fallback: Crossref (abstract only if the publisher deposited one)
    try {
      const m = (await fetchJson(CROSSREF + encodeURIComponent(doi))).message;
      const issued = m.issued && m.issued["date-parts"] && m.issued["date-parts"][0];
      return {
        doi, source: "Crossref",
        title: stripTags((m.title || [""])[0]),
        journal: (m["container-title"] || [""])[0],
        year: issued ? String(issued[0]) : "",
        abstract: m.abstract ? stripTags(m.abstract) : "",
      };
    } catch (e) {
      throw (e.code === "not_found" && epmcErr && epmcErr.code === "network") ? epmcErr : e;
    }
  }

  // ---------- Tier 3: dictionary matching ----------
  const GREEK = [["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["delta", "δ"], ["epsilon", "ε"]];
  const STOP = new Set(["water", "acid", "ester", "alcohol", "aldehyde", "ketone", "lactone", "oil", "sugar",
    "starch", "protein", "carbon", "oxygen", "nitrogen", "sulfur", "flavor", "aroma", "odor", "acetate"]);

  let matcherPromise = null;
  function matcher() {
    if (!matcherPromise) {
      matcherPromise = load().then(kb => {
        const terms = new Map();  // lower-case term -> compound id (first wins: core compounds sort first)
        const entries = Object.entries(kb.compounds).sort((a, b) =>
          ((b[1].kfo || b[1].dunkel || b[1].preset) ? 1 : 0) - ((a[1].kfo || a[1].dunkel || a[1].preset) ? 1 : 0));
        for (const [id, c] of entries) {
          for (const n of compoundNames(c)) {
            const t = norm(n);
            if (t.length < 5 || STOP.has(t) || /^[0-9\W]+$/.test(t)) continue;
            const variants = [t];
            for (const [word, sym] of GREEK) {
              if (t.includes(word + "-")) variants.push(t.split(word + "-").join(sym + "-"));
              if (t.includes(sym + "-")) variants.push(t.split(sym + "-").join(word + "-"));
            }
            for (const v of variants) if (!terms.has(v)) terms.set(v, id);
          }
        }
        const sorted = [...terms.keys()].sort((a, b) => b.length - a.length);
        const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp("(?<![A-Za-z0-9α-ω])(" + sorted.map(esc).join("|") + ")(?![A-Za-z0-9α-ω])", "gi");
        return { re, terms };
      });
      matcherPromise.catch(() => { matcherPromise = null; });
    }
    return matcherPromise;
  }

  /** Split text into [{text}, {text, id}] segments for highlighting. */
  async function matchText(text) {
    const { re, terms } = await matcher();
    const segs = [];
    let last = 0;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) segs.push({ text: text.slice(last, m.index) });
      segs.push({ text: m[0], id: terms.get(m[0].toLowerCase()) });
      last = m.index + m[0].length;
    }
    if (last < text.length) segs.push({ text: text.slice(last) });
    return segs;
  }

  window.FlavorKB = { load, search, findByMol, stripStereo, literature, paper, matchText, cleanDoi, ApiError, compoundNames };
})();
