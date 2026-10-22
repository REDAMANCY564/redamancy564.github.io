/*
 * Flavouring regulatory status (EU Union list, China GB 2760-2024 tables B.2/B.3, US 21 CFR flavouring sections
 * with the FDA list "Substances Added to Food" for CAS numbers and FEMA notes), shared by the
 * ingredient finder, the odor predictor, the knowledge base card and the regulatory lookup page.
 * Data: flavor-kb/data/regulatory.json (one copy; built by training/regulatory/build_regulatory.py),
 * a static file on this site: no other request. Only library molecules matched by CAS are listed.
 * Display rules (REG-REVIEW.md): never "not permitted" for a missing match; no FEMA use levels;
 * every block names its source, version and date and ends with the disclaimer.
 * Strings: assets/i18n/<lang>.json, keys reg.*.
 */
(function () {
  const script = document.currentScript;
  const DATA_URL = new URL("../flavor-kb/data/regulatory.json" + new URL(script.src).search, script.src);
  // every list entry (not only library molecules): loaded by the regulatory lookup page only
  const LOOKUP_URL = new URL("../flavor-kb/data/regulatory-lookup.json" + new URL(script.src).search, script.src);
  const EU_URL = "https://eur-lex.europa.eu/eli/reg/2008/1334/2026-02-16";
  const CFR_URL = sec => "https://www.ecfr.gov/current/title-21/section-" + sec;
  // 21 CFR sections and their kind (i18n reg.us.k.<kind>); Part 184 sections are all "gras184"
  const US_KIND = { "172.510": "natural", "172.515": "synthetic", "182.10": "spices", "182.20": "oils", "182.40": "extractives",
                    "182.50": "other", "182.60": "synthetic_gras" };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const t = (k, v) => I18N.t(k, v);

  let loading = null;
  const R = { items: [], meta: null, notes: {}, uslim: [] };
  const byLib = new Map(), byKb = new Map(), byIk = new Map();
  let nocas = new Set();

  // list entries (see build_regulatory.py): eu "FL[;r][;f12][;s]", cn "B3;code;FEMA[;r][;s][;m][;c][;x]"
  function euEntry(e) {
    const p = e.split(";"), f = new Set(p.slice(1));
    const fn = p.slice(1).find(x => x[0] === "f");
    return { fl: p[0], r: f.has("r") ? "eu:" + p[0] : null, fn: fn ? fn.slice(1).split("") : [], s: f.has("s") };
  }
  function cnEntry(e) {
    const p = e.split(";"), f = new Set(p.slice(3));
    return { t: p[0], code: p[1], fema: p[2], r: f.has("r") ? "cn:" + p[1] : null, s: f.has("s"), m: f.has("m"),
             c: f.has("c") ? "cnc:" + p[1] : null, x: f.has("x") };
  }
  // us entries (build_regulatory.py): "<section>[;l<n>][;k<note>]" listed in a 21 CFR flavouring section (l: limitation
  // uslim[n] as written in the eCFR, k: reviewed note), "P<section>" prohibited by Part 189, "U<section>" cited by the
  // FDA list but not found in the current section, "F<FEMA>;<GRAS pubs>[;n<NLFG text>]" FEMA no. in the FDA list,
  // "D" removed from 172.515 in 2018; each may end with ;s (one stereoisomer)
  function usEntry(e) {
    const p = e.split(";"), h = p[0], s = p[p.length - 1] === "s";
    if (h[0] === "F") {
      const n = p.slice(2).find(x => x[0] === "n");
      return { kind: "f", fema: h.slice(1), gras: p[1], nlfg: n != null ? n.slice(1) : null, s };
    }
    if (h === "D") return { kind: "d", s };
    if (h[0] === "P") return { kind: "p", sec: h.slice(1), s };
    if (h[0] === "U") return { kind: "u", sec: h.slice(1), s };
    const l = p.slice(1).find(x => x[0] === "l"), k = p.slice(1).find(x => x[0] === "k");
    return { kind: "cfr", sec: h, lim: l ? +l.slice(1) : null, note: k ? k.slice(1) : null, s };
  }
  // item = [li, ik, name, smiles, "CAS CAS", kb, "中文名|…", eu[], cn[], annexIII, us[]]
  function decode(a) {
    return {
      li: a[0], ik: a[1], name: a[2], smiles: a[3], cas: a[4] ? a[4].split(" ") : [], kb: a[5] || null,
      zh: a[6] ? a[6].split("|") : [], eu: a[7].map(euEntry), cn: a[8].map(cnEntry), a3: a[9], us: (a[10] || []).map(usEntry),
    };
  }
  // lookup substance = [name, "中文名|…", "CAS CAS", eu[], cn[], annexIII, [[li, name, SMILES, KB id]…], "search|keys", us[]]
  function decodeSub(a) {
    return {
      name: a[0], zh: a[1] ? a[1].split("|") : [], cas: a[2] ? a[2].split(" ") : [], eu: a[3].map(euEntry), cn: a[4].map(cnEntry),
      a3: a[5], links: a[6].map(([li, name, smiles, kb]) => ({ li, name, smiles, kb: kb || null })), keys: a[7] ? a[7].split("|") : [],
      us: (a[8] || []).map(usEntry),
    };
  }

  function load() {
    if (!loading) {
      loading = fetch(DATA_URL).then(r => {
        if (!r.ok) throw new Error("Failed to load " + DATA_URL);
        return r.json();
      }).then(d => {
        R.meta = d.meta;
        R.notes = d.notes;
        R.uslim = d.uslim || [];
        R.items = d.items.map(decode);
        R.items.forEach(it => {
          byLib.set(it.li, it);
          if (it.kb) byKb.set(it.kb, it);
          byIk.set(it.ik, it);
        });
        nocas = new Set(d.meta.nocas);
        return R;
      }).catch(err => { loading = null; throw err; });
    }
    return loading;
  }

  let lookupLoading = null;
  /** All list entries as substances (regulatory lookup page). Uses the lookup file's notes and metadata. */
  function loadLookup() {
    if (!lookupLoading) {
      lookupLoading = fetch(LOOKUP_URL).then(r => {
        if (!r.ok) throw new Error("Failed to load " + LOOKUP_URL);
        return r.json();
      }).then(d => {
        R.meta = d.meta;
        R.notes = d.notes;
        R.uslim = d.uslim || [];
        R.lookup = d.s.map(decodeSub);
        return R;
      }).catch(err => { lookupLoading = null; throw err; });
    }
    return lookupLoading;
  }

  /**
   * US "permitted" (user decision D1, same rule as us_ok in build_regulatory.py): never with a Part 189 prohibition
   * or when removed from 172.515 in 2018; otherwise a 21 CFR flavouring section, or a FEMA no. without the NLFG note.
   */
  function usOk(it) {
    const us = it.us || [];
    if (us.some(e => e.kind === "p" || e.kind === "d")) return false;
    return us.some(e => e.kind === "cfr" || (e.kind === "f" && e.nlfg == null));
  }

  /** Listed in the region's list: "eu" (Union list), "cn" (GB 2760), "us", "both" (EU and China), "all3". */
  function permitted(it, region) {
    if (!it) return false;
    const eu = it.eu.length > 0, cn = it.cn.length > 0;
    return region === "eu" ? eu : region === "cn" ? cn : region === "us" ? usOk(it) : region === "both" ? eu && cn
      : region === "all3" ? eu && cn && usOk(it) : true;
  }

  const note = key => R.notes[key] ? I18N.pick(R.notes[key]) : "";
  const link = (href, text) => '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(text) + "</a>";
  const li = (html, cls) => "<li" + (cls ? ' class="' + cls + '"' : "") + ">" + html + "</li>";

  function euStatus(it) {
    if (it && it.eu.length) return it.eu.some(e => e.r) ? ["restr", t("reg.eu.restr")] : ["ok", t("reg.eu.ok")];
    if (it && it.a3) return ["a3", t("reg.a3.status")];
    return ["nf", t("reg.nf")];
  }
  function cnStatus(it) {
    if (it && it.cn.length) return it.cn.some(c => c.r) ? ["restr", t("reg.cn.restr")] : ["ok", t("reg.cn.ok")];
    return ["nf", t("reg.nf")];
  }

  // US status, in order of precedence: Part 189 > removed in 2018 > 21 CFR section > FEMA no. > NLFG only
  function usStatus(it) {
    const us = (it && it.us) || [];
    const p = us.find(e => e.kind === "p");
    if (p) return ["a3", t("reg.us.prohibited", { sec: p.sec })];
    if (us.some(e => e.kind === "d")) return ["a3", t("reg.us.deleted")];
    const cfr = us.filter(e => e.kind === "cfr");
    if (cfr.length) return cfr.some(e => e.lim != null) ? ["restr", t("reg.us.restr")] : ["ok", t("reg.us.ok")];
    const f = us.filter(e => e.kind === "f");
    if (f.some(e => e.nlfg == null)) return ["ok", t("reg.us.fema")];
    if (f.length) return ["a3", t("reg.us.nlfg")];
    return ["nf", t("reg.nf")];
  }

  // opts.li: library index of a molecule without a match (to say when it has no CAS);
  // opts.outside: the molecule may not be in the library (odor predictor input)
  function nfNote(region, opts) {
    if (opts.li != null && nocas.has(opts.li)) return t("reg.nocas");
    return (opts.outside ? t("reg.outside") + " " : "") + t(region === "cn" ? "reg.nf.cn_note" : region === "us" ? "reg.nf.us_note" : "reg.nf.eu_note");
  }

  function euRegion(it, opts) {
    const [cls, status] = euStatus(it);
    const lines = [];
    if (it && it.eu.length) {
      it.eu.forEach(e => {
        lines.push(li(esc(t("reg.eu.fl", { fl: e.fl }))));
        // restriction summary (reviewed text, notes.json); a restriction not yet summarised shows the link only
        if (e.r) lines.push(li((note(e.r) ? esc(note(e.r)) + " " : "") + link((R.notes[e.r] || {}).url || EU_URL, t("reg.official")), "reg-restr"));
        e.fn.forEach(n => lines.push(li(n === "1" ? esc(t("reg.fn1")) : n === "5" ? esc(t("reg.fn5"))
          : esc(t("reg.fn234", { n })) + " " + link(EU_URL, t("reg.official")), "muted")));
        if (e.s) lines.push(li(esc(t("reg.stereo")), "muted"));
      });
    } else if (it && it.a3) {
      lines.push(li(esc(t(it.a3 === 1 ? "reg.a3b" : "reg.a3")) + " " + link(EU_URL, t("reg.official"))));
    } else {
      lines.push(li(esc(nfNote("eu", opts)), "muted"));
    }
    return region("eu", cls, status, lines, opts.bare ? "" : t("reg.src_eu", { url: EU_URL }));
  }

  function cnRegion(it, opts) {
    const [cls, status] = cnStatus(it);
    const lines = [];
    if (it && it.cn.length) {
      if (it.zh.length) lines.push(li(esc(t("reg.cn.zh", { n: it.zh.join(I18N.lang === "zh" ? "、" : ", ") }))));
      it.cn.forEach(c => {
        lines.push(li(esc(t("reg.cn.line", { t: c.t.replace("B", "B."), kind: t(c.t === "B2" ? "reg.cn.natural" : "reg.cn.synthetic"), code: c.code }) +
          (c.fema ? " · FEMA " + c.fema.replace("+", ", ") : ""))));
        if (c.r) lines.push(li(esc(note(c.r)), "reg-restr"));
        if (!c.x) lines.push(li(esc(t(c.m ? "reg.cn.manual" : "reg.cn.via_fema")), "muted"));
        if (c.c) lines.push(li(esc(note(c.c)), "muted"));
        if (c.s) lines.push(li(esc(t("reg.stereo")), "muted"));
      });
      if (!opts.bare) lines.push(li(esc(t("reg.cn.infant")), "muted"));
    } else {
      lines.push(li(esc(nfNote("cn", opts)), "muted"));
    }
    return region("cn", cls, status, lines, opts.bare ? "" : t("reg.src_cn", { url: R.meta.cn.url }));
  }

  function usRegion(it, opts) {
    const [cls, status] = usStatus(it);
    const us = (it && it.us) || [], lines = [];
    const fema = us.filter(e => e.kind === "f"), cfr = us.filter(e => e.kind === "cfr");
    const prohibited = us.filter(e => e.kind === "p"), deleted = us.some(e => e.kind === "d");
    prohibited.forEach(e => lines.push(li(esc(t("reg.us.p_line", { sec: e.sec })) + " " + link(CFR_URL(e.sec), t("reg.official")))));
    cfr.forEach((e, k) => {
      const kind = t("reg.us.k." + (US_KIND[e.sec] || "gras184"));
      // FEMA no. after the first section line, without the words FEMA GRAS (plan)
      const fe = k === 0 && fema.length ? " · FEMA " + fema.map(f => f.fema).join(", ") : "";
      const official = e.lim != null || e.sec.startsWith("184.") || e.note;
      lines.push(li(esc(t("reg.us.cfr_line", { sec: e.sec, kind }) + fe) + (official ? " " + link(CFR_URL(e.sec), t("reg.official")) : "")));
      if (e.lim != null) lines.push(li(esc(t("reg.us.lim", { t: R.uslim[e.lim] || "" })), "reg-restr"));
      if (e.note) lines.push(li(esc(note(e.note)), "muted"));
    });
    if (!cfr.length) {
      fema.forEach(f => {
        // removed in 2018: the FEMA no. as listed, without the words FEMA GRAS (D2)
        lines.push(li(esc(t(deleted ? "reg.us.fema_listed" : "reg.us.fema_line", { fema: f.fema, gras: f.gras }))));
        if (f.nlfg != null) lines.push(li(esc(t("reg.us.nlfg_line", { pub: f.nlfg })), deleted ? "" : "muted"));
      });
      if (fema.some(f => f.nlfg == null) && !deleted && !prohibited.length) lines.push(li(esc(t("reg.us.fema_note")), "muted"));
    }
    us.filter(e => e.kind === "u").forEach(e => lines.push(li(esc(t("reg.us.not_found", { sec: e.sec })) + " " + link(CFR_URL(e.sec), t("reg.official")), "muted")));
    if (deleted) lines.push(li(esc(t("reg.us.deleted_note")) + " " + link(R.meta.us.deleted_url, "83 FR 50490"), "muted"));
    if (us.some(e => e.s)) lines.push(li(esc(t("reg.stereo")), "muted"));
    if (!us.length) lines.push(li(esc(nfNote("us", opts)), "muted"));
    return region("us", cls, status, lines, opts.bare ? "" : usSrc());
  }
  const usSrc = () => t("reg.src_us", { ecfr: R.meta.us.ecfr_url, fda: R.meta.us.fda_url });

  function region(key, cls, status, lines, src) {
    return '<div class="reg-region"><p class="reg-head"><span class="reg-name">' + esc(t("reg." + key)) + '</span> <span class="reg-status ' + cls + '">' +
      esc(status) + '</span></p><ul class="reg-lines">' + lines.join("") + "</ul>" + (src ? '<p class="reg-src">' + src + "</p>" : "") + "</div>";
  }

  /**
   * Status block for a matched item (or null). opts: {compact: collapsible one-line summary (result cards),
   * li: library index when null, outside: input may be outside the library, bare: status, entries and the
   * substance's own notes only; the page shows the sources, the GB 2760 Annex B sentence and the
   * disclaimer once (common()) - the regulatory lookup page}.
   */
  function html(it, opts) {
    opts = opts || {};
    if (!R.meta) return '<p class="small muted">' + esc(t("reg.loading")) + "</p>";
    const body = '<div class="reg-grid">' + euRegion(it, opts) + cnRegion(it, opts) + usRegion(it, opts) + "</div>" + (opts.bare ? "" : '<p class="reg-disc">' + esc(t("reg.disc")) + "</p>");
    if (!opts.compact) return '<div class="reg">' + body + "</div>";
    const short = (k, [cls, s]) => '<span class="reg-name">' + esc(t("reg." + k)) + '</span> <span class="reg-status ' + cls + '">' + esc(s) + "</span>";
    const cn = cnStatus(it), us = usStatus(it);
    if (cn[0] === "ok") cn[1] = t("reg.cn.ok_short");
    if (us[1] === t("reg.us.ok")) us[1] = t("reg.us.ok_short");
    else if (us[1] === t("reg.us.fema")) us[1] = t("reg.us.fema_short");
    const sep = '<span class="reg-sep"> · </span>';
    return '<details class="reg compact"><summary><span class="reg-sum">' + short("eu", euStatus(it)) + sep + short("cn", cn) + sep + short("us", us) +
      "</span></summary>" + body + "</details>";
  }

  /**
   * What bare blocks leave out, shown once on the page: the sources (EU, China, US) and, when any shown
   * substance is listed in China, the GB 2760 Annex B sentence.
   */
  function common(anyListedInChina) {
    return '<div class="reg"><p class="reg-src">' + t("reg.src_eu", { url: EU_URL }) + '</p><p class="reg-src">' + t("reg.src_cn", { url: R.meta.cn.url }) + "</p>" +
      '<p class="reg-src">' + usSrc() + "</p>" +
      (anyListedInChina ? '<p class="reg-src">' + esc(t("reg.cn.infant")) + "</p>" : "") + "</div>";
  }

  window.Reg = {
    load, loadLookup, permitted, html, decode, common,
    get lookup() { return R.lookup || []; },
    byLib: i => byLib.get(i) || null,
    byKb: id => byKb.get(id) || null,
    byIk: ik => byIk.get(String(ik || "").slice(0, 14)) || null,
    get items() { return R.items; },
    get meta() { return R.meta; },
    hasCas: i => !nocas.has(i),
  };
})();
