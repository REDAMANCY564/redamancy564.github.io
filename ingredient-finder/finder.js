/*
 * ingredient-finder: data loading and search logic (no DOM), shared by the page and tests/unit.html.
 *
 * Data (training/ingredient/make_site_data.py):
 *   library.json  molecules [smiles, name, group, kb, foods], group 0 train / 1 valid / 2 test / 3 kb only
 *   probs.bin     uint8 [n, L]: predicted probability x 255 (odor-predictor model)
 *   fps.bin       uint32 offsets [n + 1], then uint16 on-bit indices (Morgan r = 2, 2048 bits)
 *
 * Mode A score = weighted geometric mean of the wanted descriptors' probabilities x weighted geometric
 * mean of (1 - probability) of the unwanted ones (1 when there are none), 0 to 1, weights high 1 /
 * mid 0.5 / low 0.25 (user decision 2026-10-20; until then an unnormalized weighted sum).
 * Mode B odor similarity = cosine of the predicted probability vectors (chosen on the validation
 * split, stage 3); structure similarity = Tanimoto of the Morgan fingerprints.
 */
(function () {
  const WEIGHTS = { high: 1, mid: 0.5, low: 0.25 };

  // The page loads the library first and the large arrays when they are first needed:
  // loadLibrary, then loadProbs (mode A and B) and loadFps (mode B). load() does all three (tests).
  async function get(base, p, version, kind, onBytes) {
    const res = await fetch(base + p + (version || ""));
    if (!res.ok) throw new Error("Failed to load " + p);
    if (kind === "json") return res.json();
    if (!onBytes || !res.body) return res.arrayBuffer();
    const reader = res.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length; onBytes(got);
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out.buffer;
  }

  async function loadLibrary(base, version) {
    const lib = await get(base, "library.json", version, "json");
    return { lib, n: lib.molecules.length, L: lib.labels.length, probs: null, offsets: null, bits: null,
             labelIndex: Object.fromEntries(lib.labels.map((l, i) => [l.id, i])) };
  }

  /** Adds d.probs; onBytes(received) reports progress against d.n * d.L bytes. */
  async function loadProbs(d, base, version, onBytes) {
    const probs = new Uint8Array(await get(base, "probs.bin", version, "bin", onBytes));
    if (probs.length !== d.n * d.L) throw new Error("probs.bin size does not match library.json");
    d.probs = probs;
    return d;
  }

  /** Adds d.offsets and d.bits (Morgan fingerprints). */
  async function loadFps(d, base, version) {
    const fpsBuf = await get(base, "fps.bin", version, "bin");
    const offsets = new Uint32Array(fpsBuf, 0, d.n + 1);
    d.bits = new Uint16Array(fpsBuf, (d.n + 1) * 4, offsets[d.n]);
    d.offsets = offsets;
    return d;
  }

  async function load(base, version) {
    const d = await loadLibrary(base, version);
    await Promise.all([loadProbs(d, base, version), loadFps(d, base, version)]);
    return d;
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
    const terms = list => (list || []).map(([id, w]) => [d.labelIndex[id], WEIGHTS[w]]).filter(([j]) => j != null);
    const tw = terms(want), ta = terms(avoid);
    const total = t => t.reduce((s, [, w]) => s + w, 0);
    const Ww = total(tw), Wa = total(ta);
    const out = [];
    for (let i = 0; i < d.n; i++) {
      if (!passes(d, i, filters)) continue;
      // sums of weight x log in the same order as training/ingredient/make_site_data.py (log 0 = -Infinity gives 0)
      let lw = 0, la = 0;
      for (const [j, w] of tw) lw += w * Math.log(prob(d, i, j));
      for (const [j, w] of ta) la += w * Math.log(1 - prob(d, i, j));
      out.push({ index: i, score: Math.exp((Ww ? lw / Ww : 0) + (Wa ? la / Wa : 0)) });
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

  window.FinderCore = { WEIGHTS, load, loadLibrary, loadProbs, loadFps, molecule, passes, scoreA, topLabels, topLabelsOf, vector, cosine, fpBits, tanimoto, prob, neighbours, bitsFromString };
})();
