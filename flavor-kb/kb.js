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
    constructor(code) { super(code); this.code = code; }  // network | timeout | not_found | bad_response
  }

  // Europe PMC can take more than 15 s on slow networks (measured 16 s), so wait up to 60 s.
  const TIMEOUT_MS = 60000;

  // Successful responses are cached per request URL for this visit (memory + sessionStorage),
  // so switching the sort order back or repeating a query does not send the request again.
  const memCache = new Map();
  const CACHE_PREFIX = "kb-api:";
  function cacheGet(url) {
    if (memCache.has(url)) return memCache.get(url);
    try {
      const s = sessionStorage.getItem(CACHE_PREFIX + url);
      if (s) { const v = JSON.parse(s); memCache.set(url, v); return v; }
    } catch (e) { /* storage blocked or bad entry: ignore */ }
    return undefined;
  }
  function cachePut(url, v) {
    memCache.set(url, v);
    try { sessionStorage.setItem(CACHE_PREFIX + url, JSON.stringify(v)); } catch (e) { /* quota or blocked */ }
  }

  async function fetchJson(url, timeoutMs) {
    const hit = cacheGet(url);
    if (hit !== undefined) return hit;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs || TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } catch (e) {
        throw new ApiError(timedOut ? "timeout" : "network");
      }
      if (res.status === 404) throw new ApiError("not_found");
      if (!res.ok) throw new ApiError("network");
      let d;
      try { d = await res.json(); } catch (e) { throw new ApiError(timedOut ? "timeout" : "bad_response"); }
      cachePut(url, d);
      return d;
    } finally {
      clearTimeout(timer);   // the timeout also covers reading the body
    }
  }

  // ---------- Tier 1 data ----------
  let dataPromise = null;
  function load() {
    if (!dataPromise) {
      dataPromise = Promise.all(["compounds", "foods", "meta", "refs"].map(n =>
        fetch(new URL("data/" + n + ".json", BASE)).then(r => {
          if (!r.ok) throw new Error("Failed to load " + n);
          return r.json();
        }))).then(([compounds, foods, meta, refs]) => {
          const byInchi = new Map();
          for (const [id, c] of Object.entries(compounds)) byInchi.set(c.inchi, id);
          return { compounds, foods, meta, refs, byInchi };
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
  /**
   * Name for a literature query: removes only notes written after a space in brackets, as in
   * "Diacetyl (2,3-butanedione)" or "wine (red and white)"; brackets that are part of a chemical name,
   * as in "3-(methylthio)propionaldehyde", stay. Returns null when what is left is not a complete name
   * (empty, unbalanced brackets, or a separator left dangling by the removal).
   */
  function searchName(term) {
    const src = String(term || "").replace(/"/g, "").trim();
    let out = "", i = 0;
    while (i < src.length) {
      const sp = src.slice(i).match(/^\s+\(/);
      if (sp) {
        // find the matching closing bracket of this note (notes may contain brackets themselves)
        let j = i + sp[0].length, depth = 1;
        for (; j < src.length && depth; j++) depth += src[j] === "(" ? 1 : src[j] === ")" ? -1 : 0;
        // a note ends the name or is followed by a space or ,; ; "methyl (9E,12Z)-octadeca…" and
        // "ethyl (Z)hex-3-enoate" are names, not notes
        if (depth === 0 && (j === src.length || /[\s,;]/.test(src[j]))) { i = j; continue; }   // drop " (…)"
      }
      out += src[i++];
    }
    out = out.replace(/\s+/g, " ").trim();
    if (!out) return null;
    let depth = 0;
    for (const ch of out) {
      depth += "([{".includes(ch) ? 1 : ")]}".includes(ch) ? -1 : 0;
      if (depth < 0) return null;
    }
    if (depth !== 0) return null;
    if (out !== src && /[,;:/]$/.test(out)) return null;   // "Foo, (note)" leaves "Foo,"
    return out;
  }

  function quote(name) { return '"' + name + '"'; }

  /** Up to `max` distinct complete names (case-insensitive) for the query. */
  function searchNames(names, max) {
    const seen = new Set(), out = [];
    for (const n of names) {
      const s = searchName(n);
      if (!s || seen.has(s.toLowerCase())) continue;
      seen.add(s.toLowerCase());
      out.push(s);
      if (out.length >= max) break;
    }
    return out;
  }

  /** API and website URLs for one literature query (the website link is shown when the API fails). */
  function literatureRequest(names, food, opts) {
    opts = opts || {};
    // All terms are restricted to title + abstract: full-text matching returns many off-topic papers.
    // Names left incomplete by removing a bracketed note are not used; if none is complete, the first
    // name is used as written.
    let terms = searchNames(names.filter(Boolean), 3);
    if (!terms.length) terms = names.filter(Boolean).slice(0, 1).map(n => String(n).replace(/"/g, "").trim());
    const nameQ = "TITLE_ABS:(" + terms.map(quote).join(" OR ") + ")";
    const parts = [nameQ];
    if (food) parts.push("TITLE_ABS:" + quote(searchName(food) || String(food).replace(/"/g, "").trim()));
    parts.push("TITLE_ABS:(aroma OR odor OR odour OR odorant OR odorants OR flavor OR flavour)");
    const query = parts.join(" AND ");
    const sort = opts.sort === "cited" ? "&sort=" + encodeURIComponent("CITED desc") : "";
    return {
      url: EPMC + "?format=json&resultType=lite&pageSize=" + (opts.pageSize || 8) + sort + "&query=" + encodeURIComponent(query),
      searchUrl: "https://europepmc.org/search?query=" + encodeURIComponent(query),
    };
  }

  function literatureResult(d, searchUrl) {
    if (!d.resultList) throw new ApiError("bad_response");
    return {
      hitCount: d.hitCount || 0,
      searchUrl,
      results: d.resultList.result.map(r => ({
        title: stripTags(r.title || ""),
        journal: r.journalTitle || r.bookOrReportDetails && r.bookOrReportDetails.publisher || "",
        year: r.pubYear || "",
        url: r.doi ? "https://doi.org/" + r.doi : "https://europepmc.org/article/" + r.source + "/" + r.id,
      })),
    };
  }

  /**
   * names: compound names (OR-ed), food: optional food name.
   * Returns {hitCount, results: [{title, journal, year, url}], searchUrl}.
   */
  async function literature(names, food, opts) {
    const req = literatureRequest(names, food, opts);
    return literatureResult(await fetchJson(req.url), req.searchUrl);
  }

  /** The same result if this query was already answered during this visit, otherwise null (no request). */
  function literatureCached(names, food, opts) {
    const req = literatureRequest(names, food, opts);
    const d = cacheGet(req.url);
    if (d === undefined) return null;
    try { return literatureResult(d, req.searchUrl); } catch (e) { return null; }
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

  /**
   * onStep(source, why): called before each lookup — ("epmc"), then ("crossref", "not_found" | "failed")
   * when Europe PMC has no record of the DOI or could not be reached. Each lookup has its own timeout.
   */
  async function paper(doiInput, onStep) {
    const doi = cleanDoi(doiInput);
    if (!doi) throw new ApiError("bad_doi");
    const step = onStep || (() => {});
    let epmcErr = null;
    step("epmc");
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
    step("crossref", epmcErr ? "failed" : "not_found");
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

  window.FlavorKB = { TIMEOUT_S: TIMEOUT_MS / 1000, load, search, findByMol, stripStereo, literature, literatureCached, literatureRequest, searchName, searchNames, paper, matchText, cleanDoi, ApiError, compoundNames };
})();
