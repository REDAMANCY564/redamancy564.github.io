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
    [D.n, D.L, D.probs.length === D.n * D.L, D.offsets.length === D.n + 1], [5119, 138, true, true]);
  check("data", "groups: 3910 train, 488 valid, 488 test, 233 knowledge base only",
    [0, 1, 2, 3].map(g => lib.molecules.filter(m => m[2] === g).length), [3910, 488, 488, 233]);

  for (const c of fx.mode_a) {
    const hits = F.scoreA(D, c.want, c.avoid, null).slice(0, 20);
    check("mode A", c.preset + ": top 20 molecules as in Python", hits.map(h => h.index), c.top);
    check("mode A", c.preset + ": scores as in Python (6 decimals)", hits.map(h => +h.score.toFixed(6)), c.scores);
  }
  const want = [["creamy", "high"]];
  const all = F.scoreA(D, want, [], null), nat = F.scoreA(D, want, [], { natural: true }), uns = F.scoreA(D, want, [], { unseen: true });
  check("filters", "natural: only molecules with food records", [nat.length, nat.every(h => lib.molecules[h.index][4].length > 0)],
    [lib.molecules.filter(m => m[4].length).length, true]);
  check("filters", "not used in training: valid + test + knowledge base only (1209)", [uns.length, uns.every(h => lib.molecules[h.index][2] !== 0)], [1209, true]);
  check("filters", "no filter: every molecule", all.length, 5119);
  check("weights", "high / mid / low = 1 / 0.5 / 0.25", F.WEIGHTS, { high: 1, mid: 0.5, low: 0.25 });
  const j = D.labelIndex.creamy, i0 = all[0].index;
  check("weights", "medium weight halves the score", +F.scoreA(D, [["creamy", "mid"]], [], null)[0].score.toFixed(9), +(0.5 * F.prob(D, i0, j)).toFixed(9));
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
  check("mode B", "threshold and rule from library.json", [lib.odor_threshold, lib.tanimoto_max_for_highlight, lib.highlight_top_n], [0.9458, 0.3, 20]);

  // ---------- parity: RDKit.js fingerprints and the browser model vs Python ----------
  const rdkit = await initRDKitModule({ locateFile: () => "https://cdn.jsdelivr.net/npm/@rdkit/rdkit@2026.3.6/dist/RDKit_minimal.wasm" });
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
