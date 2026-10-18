/*
 * Processing rules for one sample (PLAN-gcms.md sections 9 to 11, as changed by the user on
 * 2026-10-18: only the compounds of the standard file matter; the result lists every target
 * with its relative content, or "-" when not found).
 *
 * A "hit" is one row of the peak table (one library candidate); a "peak" groups the hits that
 * share a peak number (or, without one, the same retention time). A row without peak number,
 * RT and area right after a peak (e.g. hits 2 to 5 in Agilent MassHunter library-search reports)
 * is another candidate of that peak. The first hit of a peak is its library identification.
 * Identity keys: knowledge-base compound, normalized CAS (check digit OK), normalized name.
 * Two identifications agree when they share any key, so targets outside the knowledge base
 * still match by CAS or name; cis/trans isomers (different CAS, compound and name) never agree.
 *
 * Order: group peaks -> rule 1 (merge adjacent peaks of one compound) -> rule 3 with rule 2
 * (targets, one peak with several candidates) -> targets the user assigned by hand -> relative content.
 * A target without an agreeing peak is "not found"; the user can look at the free peaks in its
 * window and assign one by hand (user decision 2026-10-18: no automatic "pending" any more).
 */
(function () {
  const RT_SAME = 0.0015;  // min: rows closer than this without a peak number = the same peak
  const EPS = 1e-9;

  function idKeys(kbId, casNorm, casStatus, name) {
    const k = [];
    if (kbId) k.push("kb:" + kbId);
    if (casNorm && casStatus === "ok") k.push("cas:" + casNorm);
    const n = name ? GcmsNames.normName(name) : "";
    if (n) k.push("name:" + n);
    return k;
  }
  const agree = (a, b) => a.some(k => b.includes(k));

  /**
   * records + identification -> peaks sorted by RT:
   * {key, no, rt, area, rel, conc, hits: [{rec, name, kbId, keys, match}], merged: [keys of merged peaks]}
   */
  function groupPeaks(records, ident) {
    const peaks = [];
    const byNo = new Map();
    records.forEach((r, i) => {
      const it = ident[i];
      const hit = {
        rec: i, name: r.name, kbId: it.kbId, match: r.match,
        keys: idKeys(it.kbId, it.auto.casNorm, it.auto.casStatus, r.name),
      };
      let p = null;
      const last = peaks[peaks.length - 1];
      if (!r.peak && r.rt == null && r.area == null && r.rel == null && r.conc == null && last) {
        last.hits.push(hit);   // continuation row: another library candidate of the previous peak
        return;
      }
      if (r.peak) p = byNo.get(r.peak);
      else p = peaks.find(q => !q.no && r.rt != null && q.rt != null && Math.abs(q.rt - r.rt) < RT_SAME);
      if (!p) {
        p = { key: r.peak ? "p" + r.peak : "r" + i, no: r.peak || null, rt: r.rt, area: r.area, rel: r.rel, conc: r.conc, hits: [], merged: [] };
        peaks.push(p);
        if (r.peak) byNo.set(r.peak, p);
      }
      p.hits.push(hit);
    });
    return peaks.sort((a, b) => (a.rt == null) - (b.rt == null) || a.rt - b.rt);
  }

  /**
   * Rule 1: in RT order, consecutive peaks whose library identifications agree and whose RT
   * difference is at most tol are merged: areas (relative contents, amounts) add up, the RT of the
   * largest peak is kept. The same compound at non-adjacent positions (another compound in
   * between) is not merged and is logged as a possible misidentification.
   * Returns {peaks, log}; the input is not modified. tol null = rule 1 not applied.
   */
  function mergeAdjacent(peaks, tol) {
    const log = [];
    if (tol == null) return { peaks: peaks.slice(), log };
    const out = [];
    for (const p of peaks) {
      const prev = out[out.length - 1];
      if (prev && p.rt != null && prev.lastRt != null && p.rt - prev.lastRt <= tol + EPS && agree(prev.hits[0].keys, p.hits[0].keys)) {
        const big = (p.area || 0) > (prev.bigArea || 0);
        log.push({ rule: 1, kind: "merged", name: prev.hits[0].name, rts: [prev.lastRt, p.rt], tol, keys: [prev.merged[0], p.key] });
        prev.merged.push(p.key);
        prev.area = prev.area != null || p.area != null ? (prev.area || 0) + (p.area || 0) : null;
        prev.rel = prev.rel != null || p.rel != null ? (prev.rel || 0) + (p.rel || 0) : null;
        prev.conc = prev.conc != null || p.conc != null ? (prev.conc || 0) + (p.conc || 0) : null;
        if (big) { prev.rt = p.rt; prev.bigArea = p.area; }
        prev.lastRt = p.rt;
        continue;
      }
      out.push(Object.assign({}, p, { merged: [p.key], lastRt: p.rt, bigArea: p.area }));
    }
    // same compound again, not adjacent: possible misidentification (kept, only logged)
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 2; j < out.length; j++) {
        if (agree(out[i].hits[0].keys, out[j].hits[0].keys)) {
          log.push({ rule: 1, kind: "not_adjacent", name: out[i].hits[0].name, rts: [out[i].rt, out[j].rt], keys: out[i].merged.concat(out[j].merged) });
        }
      }
    }
    out.forEach(p => { delete p.lastRt; delete p.bigArea; });
    return { peaks: out, log };
  }

  /**
   * Rule 3 with rule 2, for one sample. targets: [{name, cas, rt, keys}]; window: +- min.
   * Returns {targets: [{status, peak, delta, note...}], log}
   *   status "detected"     a peak with an agreeing identification in the window (if several
   *                          remain after rule 1, the one closest to the reference RT is taken)
   *          "not_detected" nothing found (or the only fitting peak went to another target)
   *          "no_rt"        no reference RT in the standard file: matched by identity only
   */
  function matchTargets(peaks, targets, window) {
    const log = [];
    const props = [];
    targets.forEach((t, ti) => {
      peaks.forEach(p => {
        const hit = p.hits.find(h => agree(h.keys, t.keys));
        if (!hit) return;
        if (t.rt == null) { props.push({ ti, p, hit, delta: null }); return; }
        if (p.rt == null) return;
        const delta = p.rt - t.rt;
        if (Math.abs(delta) <= window + EPS) props.push({ ti, p, hit, delta });
      });
    });

    // several peaks for one target (left after rule 1): keep the closest to the reference RT
    const byTarget = new Map();
    props.forEach(x => { if (!byTarget.has(x.ti)) byTarget.set(x.ti, []); byTarget.get(x.ti).push(x); });
    const firstPass = [];
    byTarget.forEach((list, ti) => {
      if (list.length === 1 || targets[ti].rt == null) { firstPass.push(list[0]); return; }
      const best = list.reduce((a, b) => (Math.abs(b.delta) < Math.abs(a.delta) ? b : a));
      log.push({ rule: 3, kind: "closest_of_several", target: ti, rts: list.map(x => x.p.rt), kept: best.p.rt });
      firstPass.push(best);
    });

    // rule 2: a peak wanted by several targets goes to the closest reference RT
    // (without reference RTs: the hit with the best match score)
    const byPeak = new Map();
    firstPass.forEach(x => { if (!byPeak.has(x.p.key)) byPeak.set(x.p.key, []); byPeak.get(x.p.key).push(x); });
    const chosen = new Map();   // target index -> proposal
    const lostTo = new Map();   // target index -> target index that got its peak
    byPeak.forEach(list => {
      if (list.length === 1) { chosen.set(list[0].ti, list[0]); return; }
      const withRt = list.filter(x => x.delta != null);
      const best = withRt.length
        ? withRt.reduce((a, b) => (Math.abs(b.delta) < Math.abs(a.delta) ? b : a))
        : list.reduce((a, b) => ((b.hit.match || 0) > (a.hit.match || 0) ? b : a));
      chosen.set(best.ti, best);
      list.filter(x => x !== best).forEach(x => {
        lostTo.set(x.ti, best.ti);
        log.push({ rule: 2, kind: "peak_to_closer_target", target: x.ti, kept: best.ti, rt: x.p.rt });
      });
    });
    chosen.forEach(x => {
      if (x.p.hits.length > 1) log.push({ rule: 2, kind: "hit_chosen", target: x.ti, rt: x.p.rt, hits: x.p.hits.map(h => h.name) });
    });

    const used = new Set([...chosen.values()].map(x => x.p.key));
    const result = targets.map((t, ti) => {
      const c = chosen.get(ti);
      if (c) return { status: t.rt == null ? "no_rt" : "detected", peak: c.p, delta: c.delta, hit: c.hit };
      if (lostTo.has(ti)) return { status: "not_detected", lostTo: lostTo.get(ti) };
      return { status: "not_detected" };
    });
    return { targets: result, log, used };
  }

  /** Peaks in the window of target t that no other target uses (for assigning by hand), closest first. */
  function windowPeaks(peaks, t, window, taken) {
    if (t.rt == null) return [];
    return peaks.filter(p => !taken.has(p.key) && p.rt != null && Math.abs(p.rt - t.rt) <= window + EPS)
      .sort((a, b) => Math.abs(a.rt - t.rt) - Math.abs(b.rt - t.rt));
  }

  /** Relative content (%) of a peak: the file's column if present, else area / total area x 100. */
  function relativeContent(peak, allPeaks) {
    if (peak.rel != null) return peak.rel;
    const total = allPeaks.reduce((s, p) => s + (p.area || 0), 0);
    return peak.area != null && total > 0 ? (100 * peak.area) / total : null;
  }

  /**
   * Whole pipeline for one sample. manual: Map target index -> peak key, peaks the user assigned
   * by hand to targets that were not found. An assignment counts only if the target is still not
   * found, the peak is in its window and no other target has that peak.
   * Returns {rows, log, peaks, relSource, taken (peak keys in use)}.
   */
  function run(records, ident, targets, tol, manual) {
    const grouped = groupPeaks(records, ident);
    const r1 = mergeAdjacent(grouped, tol.merge);
    const m = matchTargets(r1.peaks, targets, tol.window);
    const taken = new Set(m.used);
    const status = m.targets.slice();
    (manual || new Map()).forEach((key, ti) => {
      const t = targets[ti];
      if (!t || status[ti].status !== "not_detected" || taken.has(key)) return;
      const p = windowPeaks(r1.peaks, t, tol.window, taken).find(q => q.key === key);
      if (!p) return;
      taken.add(key);
      status[ti] = { status: "manual", peak: p, delta: p.rt - t.rt, hit: p.hits[0] };
    });
    const hasRelColumn = records.some(r => r.rel != null);
    const rows = targets.map((t, i) => {
      const r = status[i];
      const found = ["detected", "no_rt", "manual"].includes(r.status);
      return Object.assign({}, r, {
        found, rel: found ? relativeContent(r.peak, r1.peaks) : null,
        area: found ? r.peak.area : null, conc: found ? r.peak.conc : null,
      });
    });
    return { rows, log: r1.log.concat(m.log), peaks: r1.peaks, relSource: hasRelColumn ? "column" : "area", taken };
  }

  window.GcmsRules = { idKeys, agree, groupPeaks, mergeAdjacent, matchTargets, windowPeaks, relativeContent, run };
})();
