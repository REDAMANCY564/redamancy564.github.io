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
 * Rules (user decision 2026-10-20, the user's own way of working; one setting, the retention time
 * range, replaces the former target window and adjacent-peak merge tolerance):
 *   rule 2  a peak that agrees with several targets goes only to the target whose reference RT is
 *           nearest (no competitor with a reference RT: the hit with the best match score)
 *   rule 1  for each target, the peaks identified as it within reference RT +- range that rule 2
 *           left to it are added up, as long as no peak of another compound lies between them;
 *           no chain merging. Peaks separated by another compound form groups: the group with the
 *           peak nearest the reference RT is used, the others are logged (possible misidentification).
 *           Without a reference RT the range is centred on the compound's largest peak (logged).
 * A target without an agreeing peak is "not found"; the user can look at the free peaks in its
 * range and assign one by hand (user decision 2026-10-18: no automatic "pending" any more).
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

  /** A field of several peaks added up (null when none of them has it). */
  const addUp = (ps, f) => (ps.some(p => p[f] != null) ? ps.reduce((s, p) => s + (p[f] || 0), 0) : null);
  /** Size of a peak for "largest peak": area, else relative content, else amount. */
  const size = p => (p.area != null ? p.area : p.rel != null ? p.rel : p.conc != null ? p.conc : 0);
  /**
   * Does peak p separate two peaks of target t? Any peak identified as another compound does
   * (user decision 2026-10-20), column bleed such as siloxanes included.
   */
  const separates = (p, t) => !agree(p.hits[0].keys, t.keys);

  /**
   * Rules 2 and 1 for one sample. targets: [{name, cas, rt, keys}]; range: +- min around the
   * reference RT. Returns {targets: [{status, peak, delta, hit, lostTo}], log, used (peak keys)}
   *   status "detected"     peaks identified as the target in the range (added up by rule 1)
   *          "not_detected" nothing found (or every fitting peak went to another target by rule 2)
   *          "no_rt"        no reference RT in the standard file: range centred on the largest peak
   *   peak: the largest peak of the group with area, relative content and amount added up and
   *   merged = the keys of all peaks added.
   */
  function sumInRange(peaks, targets, range) {
    const log = [];
    const timed = peaks.filter(p => p.rt != null);
    // peaks identified as each target within the range of its centre
    const cand = targets.map((t, ti) => {
      const agreeing = peaks.map(p => ({ p, hit: p.hits.find(h => agree(h.keys, t.keys)) })).filter(x => x.hit);
      let center = t.rt;
      if (center == null) {
        const withRt = agreeing.filter(x => x.p.rt != null);
        if (!withRt.length) return { center: null, list: agreeing.slice(0, 1), outside: [] };   // identity only
        center = withRt.reduce((a, b) => (size(b.p) > size(a.p) ? b : a)).p.rt;
        log.push({ rule: 1, kind: "no_rt_center", target: ti, rt: center });
      }
      const inRange = x => x.p.rt != null && Math.abs(x.p.rt - center) <= range + EPS;
      return { center, list: agreeing.filter(inRange), outside: agreeing.filter(x => x.p.rt != null && !inRange(x)) };
    });

    // rule 2: a peak wanted by several targets goes to the nearest reference RT
    // (no competitor with a reference RT: the hit with the best match score)
    const wanted = new Map();   // peak key -> [{ti, x}]
    cand.forEach((c, ti) => c.list.forEach(x => {
      if (!wanted.has(x.p.key)) wanted.set(x.p.key, []);
      wanted.get(x.p.key).push({ ti, x });
    }));
    const owner = new Map();    // peak key -> target index
    wanted.forEach((list, key) => {
      if (list.length === 1) { owner.set(key, list[0].ti); return; }
      const dist = o => Math.abs(o.x.p.rt - targets[o.ti].rt);
      const withRef = list.filter(o => targets[o.ti].rt != null && o.x.p.rt != null);
      const best = withRef.length
        ? withRef.reduce((a, b) => (dist(b) < dist(a) ? b : a))
        : list.reduce((a, b) => ((b.x.hit.match || 0) > (a.x.hit.match || 0) ? b : a));
      owner.set(key, best.ti);
      list.filter(o => o !== best).forEach(o => log.push({ rule: 2, kind: "peak_to_closer_target", target: o.ti, kept: best.ti, rt: o.x.p.rt }));
    });

    // rule 1: add up the target's peaks in the range that no other compound separates
    const used = new Set();
    const result = targets.map((t, ti) => {
      const c = cand[ti];
      const mine = c.list.filter(x => owner.get(x.p.key) === ti)
        .sort((a, b) => (a.p.rt == null) - (b.p.rt == null) || a.p.rt - b.p.rt);
      if (c.outside.length) log.push({ rule: 1, kind: "elsewhere", target: ti, rts: c.outside.map(x => x.p.rt) });
      if (!mine.length) {
        const lost = c.list.map(x => owner.get(x.p.key)).find(o => o != null && o !== ti);
        return lost != null ? { status: "not_detected", lostTo: lost } : { status: "not_detected" };
      }
      const groups = [[mine[0]]];
      for (let k = 1; k < mine.length; k++) {
        const a = mine[k - 1].p.rt, b = mine[k].p.rt;
        const apart = a == null || b == null || timed.some(p => p.rt > a && p.rt < b && separates(p, t));
        if (apart) groups.push([mine[k]]); else groups[groups.length - 1].push(mine[k]);
      }
      const dist = x => (c.center == null || x.p.rt == null ? 0 : Math.abs(x.p.rt - c.center));
      const nearest = mine.reduce((a, b) => (dist(b) < dist(a) ? b : a));
      const group = groups.find(g => g.includes(nearest));
      groups.filter(g => g !== group).forEach(g => log.push({ rule: 1, kind: "separated", target: ti, rts: g.map(x => x.p.rt) }));
      const ps = group.map(x => x.p);
      const big = ps.reduce((a, b) => (size(b) > size(a) ? b : a));
      const peak = Object.assign({}, big, { area: addUp(ps, "area"), rel: addUp(ps, "rel"), conc: addUp(ps, "conc"), merged: ps.map(p => p.key) });
      if (ps.length > 1) log.push({ rule: 1, kind: "summed", target: ti, rts: ps.map(p => p.rt), rt: big.rt });
      ps.forEach(p => {
        used.add(p.key);
        if (p.hits.length > 1) log.push({ rule: 2, kind: "hit_chosen", target: ti, rt: p.rt, hits: p.hits.map(h => h.name) });
      });
      return { status: t.rt == null ? "no_rt" : "detected", peak, hit: group.find(x => x.p === big).hit,
               delta: t.rt == null || peak.rt == null ? null : peak.rt - t.rt };
    });
    return { targets: result, log, used };
  }

  /** Peaks in the range of target t that no target uses (for assigning by hand), nearest first. */
  function windowPeaks(peaks, t, range, taken) {
    if (t.rt == null) return [];
    return peaks.filter(p => !taken.has(p.key) && p.rt != null && Math.abs(p.rt - t.rt) <= range + EPS)
      .sort((a, b) => Math.abs(a.rt - t.rt) - Math.abs(b.rt - t.rt));
  }

  /** Relative content (%) of a peak: the file's column if present, else area / total area x 100. */
  function relativeContent(peak, allPeaks) {
    if (peak.rel != null) return peak.rel;
    const total = allPeaks.reduce((s, p) => s + (p.area || 0), 0);
    return peak.area != null && total > 0 ? (100 * peak.area) / total : null;
  }

  /**
   * Whole pipeline for one sample. tol: {range} (+- min; {window} accepted for older callers).
   * manual: Map target index -> peak key, peaks the user assigned by hand to targets that were not
   * found. An assignment counts only if the target is still not found, the peak is in its range and
   * no other target has that peak.
   * Returns {rows, log, peaks, relSource, taken (peak keys in use)}.
   */
  function run(records, ident, targets, tol, manual) {
    const range = tol.range != null ? tol.range : tol.window;
    const peaks = groupPeaks(records, ident);
    const m = sumInRange(peaks, targets, range);
    const taken = new Set(m.used);
    const status = m.targets.slice();
    (manual || new Map()).forEach((key, ti) => {
      const t = targets[ti];
      if (!t || status[ti].status !== "not_detected" || taken.has(key)) return;
      const p = windowPeaks(peaks, t, range, taken).find(q => q.key === key);
      if (!p) return;
      taken.add(key);
      status[ti] = { status: "manual", peak: Object.assign({}, p, { merged: [p.key] }), delta: p.rt - t.rt, hit: p.hits[0] };
    });
    const hasRelColumn = records.some(r => r.rel != null);
    const rows = targets.map((t, i) => {
      const r = status[i];
      const found = ["detected", "no_rt", "manual"].includes(r.status);
      return Object.assign({}, r, {
        found, rel: found ? relativeContent(r.peak, peaks) : null,
        area: found ? r.peak.area : null, conc: found ? r.peak.conc : null,
      });
    });
    return { rows, log: m.log, peaks, relSource: hasRelColumn ? "column" : "area", taken };
  }

  window.GcmsRules = { idKeys, agree, groupPeaks, separates, sumInRange, windowPeaks, relativeContent, run };
})();
