/* Tests for assets/intensity.js, run by tests/intensity.html (kept external because of the page's CSP). */
(async function () {
  const results = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function check(group, name, actual, expected) {
    const ok = eq(actual, expected);
    results.push({ group, name, ok, detail: ok ? "" : "got " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected) });
  }
  const r1 = x => Math.round(x * 10) / 10;
  const r2 = x => Math.round(x * 100) / 100;
  const I = Intensity;
  await I.load();
  const by = n => I.items.find(e => e.en === n);

  // ---------- data ----------
  check("data", "315 curves", I.items.length, 315);
  check("data", "CAS unique", new Set(I.items.map(e => e.cas)).size, 315);
  check("data", "5 step-like curves, exactly those with D < 0.1", [I.items.filter(e => e.step).length, I.items.every(e => e.step === (e.D < 0.1))], [5, true]);
  check("data", "source and DOI in meta", [I.meta.doi, /Wakayama/.test(I.meta.source)], ["10.1021/acs.iecr.9b01225", true]);
  check("data", "only the needed fields", I.meta.fields, ["cas", "name_en", "name_zh", "Imax", "C", "D", "step_like", "table", "kb", "lib", "ik", "alias"]);

  // ---------- the five self-tests of the task ----------
  check("self-test", "limonene at X = 1.67: Psi = 25.3", r1(I.psi(by("limonene"), 1.67)), 25.3);
  check("self-test", "linalool at X = -2.55: Psi = 0.87", r2(I.psi(by("linalool"), -2.55)), 0.87);
  // 10^X = 4.881e-4 from the published C, D, Imax (two decimals); within 1 % of the expected 4.89e-4
  const sk = 10 ** I.thresholdX(by("skatole"));
  check("self-test", "skatole threshold about 4.89e-4 ug/L (" + sk.toPrecision(4) + ")", Math.abs(sk / 4.89e-4 - 1) < 0.01, true);
  check("self-test", "isovaleric acid is found (main text Table 3)", [I.search("isovaleric acid")[0].cas, I.search("503-74-2")[0].table], ["503-74-2", "t3"]);
  check("self-test", "2,6-nonadienal has CAS 557-48-2", I.search("2,6-nonadienal")[0].cas, "557-48-2");

  // ---------- curve, threshold, levels ----------
  const lim = by("limonene");
  check("curve", "Psi at the threshold is 1.4", r2(I.psi(lim, I.thresholdX(lim))), 1.4);
  check("curve", "Psi at C is Imax / 2", r2(I.psi(lim, lim.C)), r2(lim.Imax / 2));
  check("level", "below 1.4", I.level(1), { below: "barely" });
  check("level", "on a mark", I.level(17.2), { at: "moderate" });
  check("level", "between marks", I.level(25.3), { from: "moderate", to: "strong" });
  check("level", "between barely and weak", I.level(3), { from: "barely", to: "weak" });
  check("level", "text between", I.levelText(I.level(25.3)), 'int.lv_between{"a":"int.lv.moderate","b":"int.lv.strong"}');

  // ---------- conversion ----------
  const c = I.convert(lim, 10 ** 1.67);
  check("convert", "limonene 46.8 ug/L -> Psi 25.3", [r2(c.x), r1(c.psi)], [1.67, 25.3]);
  check("convert", "X above 5 is out of range, no value", I.convert(lim, 2e5), { error: "range", x: Math.log10(2e5) });
  check("convert", "X below -5 is out of range, no value", I.convert(lim, 1e-6).error, "range");
  check("convert", "X = 5 and X = -5 are in range", [I.convert(lim, 1e5).error, I.convert(lim, 1e-5).error], [undefined, undefined]);
  check("convert", "zero, negative and text are invalid", [I.convert(lim, 0).error, I.convert(lim, -1).error, I.convert(lim, "abc").error], ["invalid", "invalid", "invalid"]);
  const van = by("vanillin");
  check("step-like", "vanillin (D = 0) is found but never converted", [I.search("vanillin")[0].cas, I.convert(van, 1).error, I.psi(van, 0), I.thresholdX(van)], ["121-33-5", "step", null, null]);

  // ---------- search ----------
  check("search", "CAS with leading zeros", I.search("0138-86-3")[0].en, "limonene");
  check("search", "English name, any case", I.search("LIMONENE")[0].en, "limonene");
  check("search", "unknown CAS gives nothing", I.search("50-00-0"), []);
  check("search", "alias finds the published spelling", I.search("dimethyl benzyl carbinyl acetate")[0].en, "dimethy benzyl carbinyl acetate");
  check("search", "pollenal II", I.search("pollenal")[0].en, "pollenal Ⅱ");
  check("search", "at most 8 suggestions", I.search("a").length, 8);

  // ---------- matching ----------
  check("match", "byCas", I.byCas("138-86-3").en, "limonene");
  check("match", "isoborneol library molecule links isoborneol only", [I.byLib(4205) && I.byLib(4205).en, by("borneol").lib], ["isoborneol", -1]);
  check("match", "byName: exact after trim, case-insensitive", [I.byName("  Linalool ").en, I.byName("linalool oxide").en], ["linalool", "linalool oxide"]);
  check("match", "byName: no partial or normalized match", [I.byName("linalol"), I.byName("linalool-"), I.byName("")], [null, null, null]);
  check("match", "forIdent: file CAS", I.forIdent({ casStatus: "ok", casNorm: "66-25-1" }, "whatever", "").en, "hexanal");
  check("match", "forIdent: file CAS not in the curves gives no name match", I.forIdent({ casStatus: "ok", casNorm: "431-03-8" }, "hexanal", ""), null);
  const hexKb = by("hexanal").kb;
  check("match", "forIdent: KB compound found by exact synonym", I.forIdent({ casStatus: "missing", kbId: hexKb, method: "name" }, "Hexanal", "").en, "hexanal");
  check("match", "forIdent: normalized-name KB match gives no link", I.forIdent({ casStatus: "missing", kbId: hexKb, method: "norm" }, "hexanal_x", ""), null);
  check("match", "forIdent: no CAS, no KB: exact name", I.forIdent({ casStatus: "missing", kbId: null, method: null }, "ISO E super", "").en, "ISO E super");
  check("match", "link points to the curve page with ?cas=", /curves\.html\?cas=138-86-3"/.test(I.link(lim)), true);
  check("match", "no curve, no link", I.link(null), "");

  // ---------- report ----------
  const passed = results.filter(r => r.ok).length;
  document.getElementById("rows").innerHTML = results.map((r, i) =>
    "<tr><td>" + (i + 1) + "</td><td>" + r.group + "</td><td>" + r.name.replace(/</g, "&lt;") + "</td><td class=\"" +
    (r.ok ? "pass\">PASS" : "fail\">FAIL " + r.detail.replace(/</g, "&lt;")) + "</td></tr>").join("");
  const s = document.getElementById("summary");
  s.textContent = (passed === results.length ? "PASS " : "FAIL ") + passed + "/" + results.length;
  s.className = passed === results.length ? "pass" : "fail";
  s.dataset.status = passed === results.length ? "pass" : "fail";
})().catch(e => {
  const s = document.getElementById("summary");
  s.textContent = "ERROR " + e;
  s.className = "fail";
  s.dataset.status = "error";
});
