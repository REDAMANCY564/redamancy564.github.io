/*
 * ingredient-finder: data loading and search logic (no DOM), shared by the page and tests/unit.html.
 *
 * Data (training/ingredient/make_site_data.py):
 *   library.json  molecules [smiles, name, group, kb, foods], group 0 train / 1 valid / 2 test / 3 kb only
 *   probs.bin     uint8 [n, L]: predicted probability x 255 (odor-predictor model)
 *   fps.bin       uint32 offsets [n + 1], then uint16 on-bit indices (Morgan r = 2, 2048 bits)
 *
 * Mode A score = sum(weight x probability of a wanted descriptor) - sum(weight x probability of an
 * unwanted descriptor), weights high 1 / mid 0.5 / low 0.25 (user decision 2026-10-18).
 * Mode B odor similarity = cosine of the predicted probability vectors (chosen on the validation
 * split, stage 3); structure similarity = Tanimoto of the Morgan fingerprints.
 */
(function () {
  const WEIGHTS = { high: 1, mid: 0.5, low: 0.25 };

  async function load(base, version) {
    const v = version || "";
    const get = async (p, kind) => {
      const res = await fetch(base + p + v);
      if (!res.ok) throw new Error("Failed to load " + p);
      return kind === "json" ? res.json() : res.arrayBuffer();
    };
    const [lib, probsBuf, fpsBuf] = await Promise.all([get("library.json", "json"), get("probs.bin"), get("fps.bin")]);
    const n = lib.molecules.length, L = lib.labels.length;
    const probs = new Uint8Array(probsBuf);
    if (probs.length !== n * L) throw new Error("probs.bin size does not match library.json");
    const offsets = new Uint32Array(fpsBuf, 0, n + 1);
    const bits = new Uint16Array(fpsBuf, (n + 1) * 4, offsets[n]);
    return { lib, n, L, probs, offsets, bits, labelIndex: Object.fromEntries(lib.labels.map((l, i) => [l.id, i])) };
  }

  const prob = (d, i, j) => d.probs[i * d.L + j] / 255;

  /** Molecule i as an object. */
  function molecule(d, i) {
    const m = d.lib.molecules[i];
    return { index: i, smiles: m[0], name: m[1], group: m[2], kb: m[3], foods: m[4].map(k => d.lib.foods[k]) };
  }

  /** Molecules passing the filters: {natural: has a FlavorDB food record, unseen: not used in training}. */
  function passes(d, i, filters) {
    const m = d.lib.molecules[i];
    if (filters && filters.natural && !m[4].length) return false;
    if (filters && filters.unseen && m[2] === 0) return false;
    return true;
  }

  /**
   * Mode A. want / avoid: [[label id, "high" | "mid" | "low"], ...]. Returns [{index, score}] sorted by
   * score (ties keep library order), only molecules passing the filters.
   */
  function scoreA(d, want, avoid, filters) {
    const terms = want.map(([id, w]) => [d.labelIndex[id], WEIGHTS[w]])
      .concat((avoid || []).map(([id, w]) => [d.labelIndex[id], -WEIGHTS[w]]))
      .filter(([j]) => j != null);
    const out = [];
    for (let i = 0; i < d.n; i++) {
      if (!passes(d, i, filters)) continue;
      let s = 0;
      for (const [j, w] of terms) s += w * prob(d, i, j);
      out.push({ index: i, score: s });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** The k most probable descriptors of molecule i: [[label index, probability], ...]. */
  function topLabels(d, i, k) {
    const row = [];
    for (let j = 0; j < d.L; j++) row.push([j, prob(d, i, j)]);
    return row.sort((a, b) => b[1] - a[1]).slice(0, k);
  }

  /** The k largest entries of a probability vector: [[label index, probability], ...]. */
  function topLabelsOf(vec, k) {
    return Array.from(vec, (p, j) => [j, p]).sort((a, b) => b[1] - a[1]).slice(0, k);
  }

  /** Probability vector of molecule i (Float64Array). */
  function vector(d, i) {
    const v = new Float64Array(d.L);
    for (let j = 0; j < d.L; j++) v[j] = prob(d, i, j);
    return v;
  }

  function cosine(a, b) {
    let ab = 0, aa = 0, bb = 0;
    for (let j = 0; j < a.length; j++) { ab += a[j] * b[j]; aa += a[j] * a[j]; bb += b[j] * b[j]; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
  }

  /** On-bits of molecule i as a sorted Uint16Array. */
  const fpBits = (d, i) => d.bits.subarray(d.offsets[i], d.offsets[i + 1]);

  /** Tanimoto of two sorted on-bit lists. */
  function tanimoto(a, b) {
    let i = 0, j = 0, inter = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { inter++; i++; j++; } else if (a[i] < b[j]) i++; else j++;
    }
    const union = a.length + b.length - inter;
    return union ? inter / union : 0;
  }

  /**
   * Mode B for a query given as a probability vector and sorted on-bit list (from the library or
   * computed in the browser). exclude: library index of the query itself, or -1.
   * Returns {odor: Float64Array [n], struct: Float64Array [n], top: [{index, odor, tanimoto, highlight}]}
   * top = the topN most odor-similar molecules; highlight = odor similarity >= threshold and
   * Tanimoto < tanimotoMax (user decision 2026-10-18: top 20, 99.5th percentile, 0.3).
   */
  function neighbours(d, qVec, qBits, exclude, opts) {
    const o = Object.assign({ topN: d.lib.highlight_top_n, threshold: d.lib.odor_threshold, tanimotoMax: d.lib.tanimoto_max_for_highlight }, opts);
    const odor = new Float64Array(d.n), struct = new Float64Array(d.n);
    let qq = 0;
    for (let j = 0; j < d.L; j++) qq += qVec[j] * qVec[j];
    for (let i = 0; i < d.n; i++) {
      let ab = 0, bb = 0;
      const base = i * d.L;
      for (let j = 0; j < d.L; j++) { const b = d.probs[base + j] / 255; ab += qVec[j] * b; bb += b * b; }
      odor[i] = qq > 0 && bb > 0 ? ab / Math.sqrt(qq * bb) : 0;
      struct[i] = tanimoto(qBits, fpBits(d, i));
    }
    const order = [];
    for (let i = 0; i < d.n; i++) if (i !== exclude) order.push(i);
    order.sort((a, b) => odor[b] - odor[a]);
    const top = order.slice(0, o.topN).map(i => ({
      index: i, odor: odor[i], tanimoto: struct[i], highlight: odor[i] >= o.threshold && struct[i] < o.tanimotoMax,
    }));
    return { odor, struct, top };
  }

  /** Sorted on-bit list from an RDKit.js Morgan bit string ("0101..."). */
  function bitsFromString(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 49) out.push(i);
    return Uint16Array.from(out);
  }

  window.FinderCore = { WEIGHTS, load, molecule, passes, scoreA, topLabels, topLabelsOf, vector, cosine, fpBits, tanimoto, prob, neighbours, bitsFromString };
})();
