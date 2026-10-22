/* Unit tests for ingredient-finder (finder.js), run by tests/unit.html. */
(async function () {
  const results = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function check(group, name, actual, expected) {
    const ok = eq(actual, expected);
    results.push({ group, name, ok, detail: ok ? "" : "got " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected) });
  }
  const F = window.FinderCore;
  const D = await F.load("../data/");
  const fx = await (await fetch("fixtures.json")).json();
  const lib = D.lib;

  check("data", "library, probabilities and fingerprints have matching sizes",
    [D.n, D.L, D.probs.length === D.n * D.L, D.offsets.length === D.n + 1], [5072, 138, true, true]);
  check("data", "47 excluded molecules listed with a reason", [lib.excluded.length, lib.excluded.every(e => e.reason && e.category)], [47, true]);
  check("data", "no excluded molecule left in the library", lib.excluded.filter(e => lib.molecules.some(m => m[0] === e.smiles)).length, 0);
  check("data", "groups: 3881 train, 479 valid, 486 test, 226 knowledge base only (47 non-flavor molecules excluded)",
    [0, 1, 2, 3].map(g => lib.molecules.filter(m => m[2] === g).length), [3881, 479, 486, 226]);

  for (const c of fx.mode_a) {
    const hits = F.scoreA(D, c.want, c.avoid, null).slice(0, 20);
    check("mode A", c.preset + ": top 20 molecules as in Python", hits.map(h => h.index), c.top);
    check("mode A", c.preset + ": scores as in Python (6 decimals)", hits.map(h => +h.score.toFixed(6)), c.scores);
  }
  const want = [["creamy", "high"]];
  const all = F.scoreA(D, want, [], null), nat = F.scoreA(D, want, [], { natural: true }), uns = F.scoreA(D, want, [], { unseen: true });
  check("filters", "natural: only molecules with food records", [nat.length, nat.every(h => lib.molecules[h.index][4].length > 0)],
    [lib.molecules.filter(m => m[4].length).length, true]);
  check("filters", "not used in training: valid + test + knowledge base only (1191)", [uns.length, uns.every(h => lib.molecules[h.index][2] !== 0)], [1191, true]);
  check("filters", "no filter: every molecule", all.length, 5072);
  check("weights", "high / mid / low = 1 / 0.5 / 0.25", F.WEIGHTS, { high: 1, mid: 0.5, low: 0.25 });
  const j = D.labelIndex.creamy, i0 = all[0].index;
  const scoreOf = (want, avoid, i) => F.scoreA(D, want, avoid, null).find(h => h.index === i).score;

  // ---------- mode A score: weighted geometric means (0 to 1) ----------
  check("score", "one wanted descriptor: score = its probability, whatever the weight",
    [+scoreOf([["creamy", "high"]], [], i0).toFixed(9), +scoreOf([["creamy", "low"]], [], i0).toFixed(9)], [+F.prob(D, i0, j).toFixed(9), +F.prob(D, i0, j).toFixed(9)]);
  const byProb = [...Array(D.n).keys()].sort((a, b) => F.prob(D, b, j) - F.prob(D, a, j));
  check("score", "one wanted descriptor: ranking = ranking by predicted probability (top 100)", all.slice(0, 100).map(h => h.index), byProb.slice(0, 100));
  const big = F.scoreA(D, [["creamy", "high"], ["fruity", "mid"], ["green", "low"]], [["musty", "high"], ["sweet", "mid"]], null);
  check("score", "scores lie between 0 and 1", big.every(h => h.score >= 0 && h.score <= 1), true);
  const jb = D.labelIndex.buttery;
  check("score", "two wanted (high, high), no unwanted: geometric mean, unwanted factor 1",
    [+scoreOf([["creamy", "high"], ["buttery", "high"]], [], i0).toFixed(9), +scoreOf([["creamy", "high"], ["buttery", "high"]], undefined, i0).toFixed(9)],
    Array(2).fill(+Math.sqrt(F.prob(D, i0, j) * F.prob(D, i0, jb)).toFixed(9)));
  check("score", "unwanted descriptor: factor (1 - probability)",
    +scoreOf([["creamy", "high"]], [["buttery", "high"]], i0).toFixed(9), +(F.prob(D, i0, j) * (1 - F.prob(D, i0, jb))).toFixed(9));
  // the descriptor this molecule is least likely to have
  const unrelated = lib.labels.map((l, k) => [l.id, F.prob(D, i0, k)]).filter(([id]) => id !== "creamy").sort((a, b) => a[1] - b[1])[0][0];
  check("score", "adding a descriptor unrelated to the molecule (" + unrelated + ") lowers its score",
    scoreOf([["creamy", "high"], [unrelated, "high"]], [], i0) < scoreOf([["creamy", "high"]], [], i0), true);
  check("similarity", "Tanimoto of identical / disjoint bit lists", [F.tanimoto(new Uint16Array([1, 5, 9]), new Uint16Array([1, 5, 9])), F.tanimoto(new Uint16Array([1]), new Uint16Array([2]))], [1, 0]);
  check("similarity", "Tanimoto 2 shared of 4 bits", F.tanimoto(new Uint16Array([1, 2, 3]), new Uint16Array([2, 3, 4])), 0.5);
  check("similarity", "cosine of a vector with itself", +F.cosine(F.vector(D, 0), F.vector(D, 0)).toFixed(12), 1);

  // ---------- mode B: neighbours of the presets (library vectors and fingerprints) ----------
  for (const c of fx.mode_b) {
    const r = F.neighbours(D, F.vector(D, c.query), F.fpBits(D, c.query), c.query);
    check("mode B", c.preset + ": top 20 by odor similarity as in Python", r.top.map(h => h.index), c.top);
    check("mode B", c.preset + ": odor similarity (6 decimals)", r.top.map(h => +h.odor.toFixed(6)), c.odor);
    check("mode B", c.preset + ": Tanimoto (6 decimals)", r.top.map(h => +h.tanimoto.toFixed(6)), c.tanimoto);
    check("mode B", c.preset + ": highlighted (odor >= threshold, Tanimoto < 0.3)", r.top.map(h => h.highlight), c.highlight);
  }
  check("mode B", "threshold and rule from library.json", [lib.odor_threshold, lib.tanimoto_max_for_highlight, lib.highlight_top_n], [0.9464, 0.3, 20]);

  // ---------- regulatory status (assets/regulatory.js, flavor-kb/data/regulatory.json) ----------
  await Reg.load();
  const regOf = i => Reg.byLib(i);
  const inLib = Reg.items.every(it => lib.molecules[it.li] && lib.molecules[it.li][0] === it.smiles);
  check("regulatory", "every item is a library molecule (same index and SMILES)", inLib, true);
  check("regulatory", "molecules listed: EU 2014, China 1283, both 1184",
    ["eu", "cn", "both"].map(r => Reg.items.filter(it => Reg.permitted(it, r)).length), [2014, 1283, 1184]);
  const dia = regOf(396), van = regOf(3302), cou = regOf(5023);
  check("regulatory", "diacetyl: FL 07.052, GB S0207 / FEMA 2370", [dia.eu.map(e => e.fl), dia.cn.map(c => c.code + "/" + c.fema)], [["07.052"], ["S0207/2370"]]);
  check("regulatory", "vanillin: FL 05.018 without restriction, GB S0172", [van.eu.map(e => [e.fl, e.r]), van.cn.map(c => [c.code, c.r])], [[["05.018", null]], [["S0172", null]]]);
  check("regulatory", "coumarin: not in either list, Annex III Part A with Part B levels", [cou.eu.length, cou.cn.length, cou.a3], [0, 0, 1]);
  check("regulatory", "d-camphor: FL 07.215 restricted, stereo note", Reg.items.filter(it => it.eu.some(e => e.fl === "07.215")).map(it => it.eu[0].r + "|" + it.eu[0].s), ["eu:07.215|true"]);
  const gly = regOf(1072);
  check("regulatory", "glycyrrhizic acid (library 1072): FL 16.012 restricted with its summary, GB S0881 (supplemented CAS)",
    [gly.eu.map(e => e.fl + "|" + e.r), gly.cn.map(c => c.code + "|" + c.m),
     /20–5000 mg\/kg/.test(((await (await fetch("../../flavor-kb/data/regulatory.json")).json()).notes["eu:16.012"] || {}).zh)],
    [["16.012|eu:16.012"], ["S0881|true"], true]);
  // US: 21 CFR flavouring sections and the FDA list (user decisions D1-D6, E1-E6)
  await I18N.ready;   // the status blocks are checked in the page language
  const usK = it => it.us.map(e => e.kind + ":" + (e.sec || e.fema || "") + (e.lim != null ? ";l" : "") + (e.nlfg != null ? ";n" : "") + (e.note ? ";k" : ""));
  check("regulatory US", "molecules: US permitted 1852, all three 1164",
    ["us", "all3"].map(r => Reg.items.filter(it => Reg.permitted(it, r)).length), [1852, 1164]);
  check("regulatory US", "coumarin 189.130 and safrole 189.180 prohibited, not permitted", [usK(cou), usK(regOf(4016)), Reg.permitted(cou, "us")],
    [["p:189.130"], ["p:189.180"], false]);
  check("regulatory US", "diacetyl 184.1278 + FEMA 2370; vanillin 182.60; acetal 172.515", [usK(dia), usK(van), usK(regOf(2995))],
    [["cfr:184.1278", "f:2370"], ["cfr:182.60", "f:3107"], ["cfr:172.515", "f:2002"]]);
  check("regulatory US", "pulegone and styrene removed in 2018 (styrene also NLFG), not permitted",
    [usK(regOf(4102)), usK(regOf(366)), Reg.permitted(regOf(4102), "us"), Reg.permitted(regOf(366), "us")],
    [["d:", "f:2963"], ["d:", "f:3233;n"], false, false]);
  check("regulatory US", "quinoline NLFG only: not permitted; 2-acetylpyridine FEMA only: permitted",
    [usK(regOf(3864)), Reg.permitted(regOf(3864), "us"), usK(regOf(626)), Reg.permitted(regOf(626), "us")], [["f:3470;n"], false, ["f:3251"], true]);
  check("regulatory US", "undecanal: 172.515 not found in the current text (FEMA only); 3-(hydroxymethyl)-2-heptanone: 172.515 with the reviewed note",
    [usK(regOf(2474)), usK(regOf(2045))], [["u:172.515", "f:3092"], ["cfr:172.515;k", "f:2804"]]);
  check("regulatory US", "delta-decalactone: 172.515(c) limitation as written", [usK(regOf(4573)), /oleomargarine/.test(Reg.html(regOf(4573)))], [["cfr:172.515;l", "f:2361"], true]);
  check("regulatory US", "block wording: prohibited, removed in 2018, FEMA note, not found",
    [/21 CFR 189\.130/.test(Reg.html(cou)), /83 FR 50490/.test(Reg.html(regOf(4102))), Reg.html(regOf(626)).includes(I18N.t("reg.us.fema_note")),
     Reg.html(null).includes(I18N.t("reg.nf.us_note"))], [true, true, true, true]);

  // lookup page data: every list entry, grouped by CAS (flavor-kb/data/regulatory-lookup.json)
  const smallItems = Reg.items.slice();
  await Reg.loadLookup();
  const L = Reg.lookup;
  const fls = L.flatMap(s => s.eu.map(e => e.fl)), codes = L.flatMap(s => s.cn.map(c => c.code));
  check("lookup", "every Union list entry once (2475) and every GB 2760 B.2/B.3 code once (1892)",
    [fls.length, new Set(fls).size, codes.length, new Set(codes).size], [2475, 2475, 1892, 1892]);
  check("lookup", "all 15 Annex III Part A substances (coumarin alone, not in either list)",
    [L.filter(s => s.a3).length >= 15 - 1, L.some(s => s.cas.includes("91-64-5") && s.a3 === 1 && !s.eu.length && !s.cn.length)], [true, true]);
  const byFl = fl => L.find(s => s.eu.some(e => e.fl === fl)), byCode = c => L.find(s => s.cn.some(x => x.code === c));
  check("lookup", "quinine hydrochloride (FL 14.011): outside the library, no links, restricted, also GB 2760",
    [byFl("14.011").links.length, byFl("14.011").eu[0].r, byFl("14.011").cn.length > 0], [0, "eu:14.011", true]);
  check("lookup", "entries without CAS: N024 (no FEMA no.) and FL 16.137 stand alone, flagged",
    [byCode("N024").cas.length, byCode("N024").cn[0].x, byFl("16.137").cas.length], [0, true, 0]);
  check("lookup", "diacetyl: one substance with FL 07.052 and S0207, linked to library molecule 396",
    [byFl("07.052") === byCode("S0207"), byFl("07.052").links.map(l => l.li)], [true, [396]]);
  check("lookup", "hidden search keys: GB 2760 English name (isopropylalcohol) and FDA name (eugenylmethylether)",
    [byCode("S0003").keys.some(k => k.includes("isopropylalcohol")), byCode("S0093").keys.some(k => k.includes("eugenylmethylether"))], [true, true]);
  check("lookup", "library links: the same 2386 molecules as the tool-page file",
    new Set(L.flatMap(s => s.links.map(l => l.li))).size, smallItems.length);
  // tool pages and lookup page agree for every library molecule (training/regulatory/check_consistency.py)
  const lkOf = new Map();
  L.forEach(s => s.links.forEach(l => {
    const o = lkOf.get(l.li) || { eu: new Set(), cn: new Set(), a3: false, us: new Set() };
    s.eu.forEach(e => o.eu.add(e.fl)); s.cn.forEach(c => o.cn.add(c.code)); o.a3 = o.a3 || !!s.a3; usK(s).forEach(k => o.us.add(k));
    lkOf.set(l.li, o);
  }));
  const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
  const mismatch = smallItems.filter(it => {
    const o = lkOf.get(it.li);
    return !o || !sameSet(new Set(it.eu.map(e => e.fl)), o.eu) || !sameSet(new Set(it.cn.map(c => c.code)), o.cn) || o.a3 !== !!it.a3 ||
      !sameSet(new Set(usK(it)), o.us);
  }).map(it => it.li);
  check("lookup", "every library molecule: same EU entries, GB codes, Annex III flag and US entries on the tool pages and the lookup page", mismatch, []);
  const byUs = (kind, v) => L.find(s => s.us.some(e => e.kind === kind && (e.sec === v || e.fema === v)));
  check("lookup US", "every FEMA no. of the FDA list once at most per substance; 189.110 calamus and tonka cards; 172.510 limitation as written",
    [L.every(s => new Set(s.us.filter(e => e.kind === "f").map(e => e.fema)).size === s.us.filter(e => e.kind === "f").length),
     L.filter(s => s.us.some(e => e.kind === "p" && e.sec === "189.110")).length >= 3,
     L.some(s => /tonka/i.test(s.name) && s.us.some(e => e.kind === "p")),
     L.some(s => s.us.some(e => e.kind === "cfr" && e.sec === "172.510" && e.lim != null))], [true, true, true, true]);
  check("lookup US", "US-only substances are named from the FDA list in ordinary case (no capitals-only names)",
    L.filter(s => s.us.length && !s.eu.length && !s.cn.length && !s.links.length && !s.a3).some(s => s.name === s.name.toUpperCase() && /[A-Z]{4}/.test(s.name)), false);
  check("lookup US", "FEMA 2475 (methyleugenol) is found through the US entries", !!byUs("f", "2475"), true);
  check("lookup", "thujone stands alone (Annex III); bornyl acetate (FL 09.017, S0385) is its own substance",
    [L.filter(s => s.a3 && s.links.some(l => /thujone/i.test(l.name))).map(s => [s.eu.length, s.cn.length]), byFl("09.017") === byCode("S0385"), !!byFl("09.017").a3],
    [[[0, 0]], true, false]);
  check("lookup", "stereo notes only on substances linked to the library",
    L.filter(s => !s.links.length).some(s => s.eu.some(e => e.s) || s.cn.some(c => c.s)), false);

  const euSet = new Set(smallItems.filter(it => Reg.permitted(it, "eu")).map(it => it.li));
  const onlyEu = F.scoreA(D, want, [], { only: euSet });
  check("filters", "region filter: only molecules permitted in the EU (2014)", [onlyEu.length, onlyEu.every(h => euSet.has(h.index))], [2014, true]);
  const usSet = new Set(smallItems.filter(it => Reg.permitted(it, "us")).map(it => it.li));
  const onlyUs = F.scoreA(D, want, [], { only: usSet });
  check("filters", "region filter: only molecules permitted in the US (1852), coumarin and pulegone left out",
    [onlyUs.length, onlyUs.every(h => usSet.has(h.index)), usSet.has(5023), usSet.has(4102)], [1852, true, false, false]);
  const cnSet = new Set(smallItems.filter(it => Reg.permitted(it, "cn")).map(it => it.li));
  const nb = F.neighbours(D, F.vector(D, 396), F.fpBits(D, 396), 396, { keep: i => cnSet.has(i) });
  check("mode B", "region filter: the 20 neighbours are all listed in China, best odor similarity first",
    [nb.top.length, nb.top.every(h => cnSet.has(h.index)), nb.top.every((h, k) => !k || nb.top[k - 1].odor >= h.odor)], [20, true, true]);

  // ---------- parity: RDKit.js fingerprints and the browser model vs Python ----------
  const rdkit = await initRDKitModule({ locateFile: () => new URL("../../assets/vendor/rdkit/RDKit_minimal.wasm", location.href).href });
  const spec = await (await fetch("../../odor-predictor/model/feature_spec.json")).json();
  const session = await OdorEngine.loadModel("../../odor-predictor/model/" + spec.model_file);
  let fpBad = [], maxDiff = 0;
  for (const m of fx.parity) {
    const { mol } = OdorEngine.parseLargestFragment(rdkit, m.smiles);
    try {
      const bits = Array.from(F.bitsFromString(mol.get_morgan_fp(JSON.stringify({ radius: 2, nBits: 2048 }))));
      if (JSON.stringify(bits) !== JSON.stringify(m.on_bits)) fpBad.push(m.smiles);
      const probs = await OdorEngine.predict(session, OdorEngine.featurizeMol(mol, spec), spec);
      m.probs.forEach((p, j) => { maxDiff = Math.max(maxDiff, Math.abs(p - probs[j])); });
    } finally { mol.delete(); }
  }
  check("parity", "RDKit.js Morgan fingerprints = Python (100 molecules), mismatches", fpBad, []);
  check("parity", "browser model probabilities = Python (max abs diff < 1e-5)", maxDiff < 1e-5, true);
  console.log("parity max diff", maxDiff);

  const passed = results.filter(r => r.ok).length;
  document.getElementById("rows").innerHTML = results.map((r, i) => "<tr><td>" + (i + 1) + "</td><td>" + r.group + "</td><td>" + r.name +
    '</td><td class="' + (r.ok ? 'pass">PASS' : 'fail">FAIL ' + r.detail) + "</td></tr>").join("");
  const s = document.getElementById("summary");
  s.textContent = (passed === results.length ? "PASS " : "FAIL ") + passed + "/" + results.length;
  s.className = passed === results.length ? "pass" : "fail";
  s.dataset.status = passed === results.length ? "pass" : "fail";
})().catch(e => { const s = document.getElementById("summary"); s.textContent = "ERROR " + e; s.className = "fail"; s.dataset.status = "error"; });
