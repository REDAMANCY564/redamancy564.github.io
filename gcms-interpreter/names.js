/*
 * Compound identification against the flavor knowledge base (PLAN-gcms.md section 6).
 *
 * Priority: CAS with a valid check digit > exact synonym > normalized name > fuzzy.
 * Fuzzy matches are only offered as candidates with a similarity; the user must pick one.
 * Data: data/names.json (built offline from PubChem by training/gcms/build_names.py).
 */
(function () {
  const GREEK = { "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "ω": "omega", "ɑ": "alpha" };
  const FUZZY_MIN = 0.7, FUZZY_TOP = 3;

  /**
   * Normalized key of a compound name:
   *  - NFKC, lower case, Greek letters spelled out (δ-decalactone = delta-decalactone)
   *  - a trailing stereo descriptor of a CAS index name moved to the front ("2-Octenal, (E)-")
   *  - cis / trans written as z / e; a leading "n-" (normal chain) dropped before a chain stem
   *  - then everything except letters and digits removed (spaces, hyphens, commas, brackets)
   */
  function normName(name) {
    let s = String(name || "").normalize("NFKC").toLowerCase().trim();
    s = s.replace(/[αβγδεωɑ]/g, c => GREEK[c]);
    const tail = /^(.*?),\s*(\((?:[ezrs]|[rs]\*?|[\d,]*[ezrs][\d,ezrs]*|cis|trans|\+|-|±)\)-?|cis-|trans-)$/.exec(s);
    if (tail) s = tail[2].replace(/-?$/, "-") + tail[1];
    s = s.replace(/(^|[\s,(-])cis-/g, "$1(z)-").replace(/(^|[\s,(-])trans-/g, "$1(e)-");
    // "n-" = normal chain only before a chain stem (n-decanoic acid); "N-methylpyrrole" keeps its N
    s = s.replace(/^n-(?=(prop|but|pent|hex|hept|oct|non|dec|undec|dodec|tridec|tetradec|pentadec|hexadec|heptadec|octadec|eicos|valer|capr|lauric|myrist|palmit|stear))/, "");
    return s.replace(/[^\p{L}\p{N}]/gu, "");
  }

  /** Dice coefficient on character trigrams of normalized names (0..1). */
  function trigrams(s) {
    const t = "  " + s + " ";
    const out = new Map();
    for (let i = 0; i < t.length - 2; i++) {
      const g = t.slice(i, i + 3);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  }
  function similarity(a, b) {
    const A = trigrams(a), B = trigrams(b);
    let inter = 0, na = 0, nb = 0;
    A.forEach((v, k) => { na += v; inter += Math.min(v, B.get(k) || 0); });
    B.forEach(v => { nb += v; });
    return na + nb ? (2 * inter) / (na + nb) : 0;
  }

  /** Build lookup tables from names.json. */
  function buildIndex(namesJson) {
    const byCas = new Map(), exact = new Map(), norm = new Map(), info = new Map();
    const add = (map, key, id) => {
      if (!key) return;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(id);
    };
    for (const [id, display, cas, syns] of namesJson.compounds) {
      info.set(id, { id, name: display, cas });
      cas.forEach(c => add(byCas, c, id));
      [display].concat(syns).forEach(s => {
        add(exact, s.trim().toLowerCase(), id);
        add(norm, normName(s), id);
      });
    }
    // fuzzy search runs over distinct normalized keys
    const normKeys = [...norm.keys()];
    return { byCas, exact, norm, info, normKeys };
  }

  /**
   * Identify one peak. Returns {casNorm, casStatus, kbId, method, candidates, note}
   *   method: "cas" | "name" | "norm" | null (unmatched; candidates may hold fuzzy suggestions)
   *   note:   "cas_name_conflict" when the name points to another compound than the CAS
   *           "cas_not_in_kb" when a valid CAS is not in the knowledge base
   *           "ambiguous" when a name fits several compounds (shown as candidates)
   * withFuzzy false skips the fuzzy suggestions (slow: every unmatched name is compared with all
   * synonyms); the page does not show them, so it passes false.
   */
  function identify(index, name, casRaw, casIsDate, withFuzzy = true) {
    const c = GcmsCas.normalizeCas(casRaw, casIsDate);
    const out = { casNorm: c.cas, casStatus: c.status, kbId: null, method: null, candidates: [], note: null };
    const one = set => (set && set.size === 1 ? [...set][0] : null);

    const byName = () => {
      const e = index.exact.get(String(name || "").trim().toLowerCase());
      if (e) return { set: e, method: "name" };
      const n = index.norm.get(normName(name));
      if (n) return { set: n, method: "norm" };
      return null;
    };

    if (c.status === "ok") {
      const id = one(index.byCas.get(c.cas));
      if (id) {
        Object.assign(out, { kbId: id, method: "cas" });
        const nm = name ? byName() : null;
        if (nm && !nm.set.has(id)) out.note = "cas_name_conflict";
        return out;
      }
      out.note = "cas_not_in_kb";
    }
    if (!name) return out;
    const nm = byName();
    if (nm) {
      const id = one(nm.set);
      if (id) return Object.assign(out, { kbId: id, method: nm.method, note: out.note });
      out.candidates = [...nm.set].map(k => ({ id: k, score: 1 }));
      out.note = "ambiguous";
      return out;
    }
    if (withFuzzy) out.candidates = fuzzy(index, name);
    return out;
  }

  /** Best FUZZY_TOP compounds by name similarity (at least FUZZY_MIN). */
  function fuzzy(index, name) {
    const q = normName(name);
    if (q.length < 3) return [];
    const best = new Map();
    for (const key of index.normKeys) {
      if (Math.abs(key.length - q.length) > Math.max(6, q.length)) continue;
      const s = similarity(q, key);
      if (s < FUZZY_MIN) continue;
      for (const id of index.norm.get(key)) if (!best.has(id) || best.get(id) < s) best.set(id, s);
    }
    return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, FUZZY_TOP)
      .map(([id, score]) => ({ id, score: Math.round(score * 100) / 100 }));
  }

  /**
   * User search box: compounds whose normalized names contain the query (shorter names first),
   * then fuzzy matches. Returns up to 6 candidates {id, score}.
   */
  function search(index, query) {
    const q = normName(query);
    if (q.length < 2) return [];
    const hits = new Map();
    index.normKeys.filter(k => k.includes(q)).sort((a, b) => a.length - b.length).forEach(k => {
      for (const id of index.norm.get(k)) if (!hits.has(id)) hits.set(id, Math.round((q.length / k.length) * 100) / 100);
    });
    fuzzy(index, query).forEach(c => { if (!hits.has(c.id)) hits.set(c.id, c.score); });
    return [...hits.entries()].slice(0, 6).map(([id, score]) => ({ id, score }));
  }

  window.GcmsNames = { normName, similarity, buildIndex, identify, fuzzy, search };
})();
