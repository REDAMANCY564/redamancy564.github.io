/*
 * Odor space map: about page (method, parameters, results, limitations, data).
 * The text sections were moved here from app.js; they read the same library and map metadata.
 */
(async function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const VERSION = new URL(document.currentScript.src).search;

  const get = url => fetch(url + VERSION).then(r => {
    if (!r.ok) throw new Error("Failed to load " + url);
    return r.json();
  });
  const [lib, meta] = await Promise.all([get("../ingredient-finder/data/library.json"), get("data/map.json"), I18N.ready]);
  const n = lib.molecules.length;
  const labelIndex = Object.fromEntries(lib.labels.map((l, j) => [l.id, j]));
  const labelName = j => I18N.pick(lib.labels[j]);
  const nCat = meta.colours.length;

  const f3 = x => Number(x).toFixed(3);
  const pct = x => Math.round(100 * x) + "%";

  function renderText() {
    $("hero-intro").textContent = I18N.t("hero.intro", { n: n.toLocaleString(I18N.lang === "zh" ? "zh-CN" : "en") }); I18N.nobr($("hero-intro"));
    $("desc-odor").textContent = I18N.t("map.desc.odor", { n: meta.k });
    $("desc-structure").textContent = I18N.t("map.desc.structure", { n: meta.k });
    const fr = meta.top1_counts.fruity || 0;
    $("colour-note").textContent = I18N.t("colour.note", { k: nCat, fruity: labelName(labelIndex.fruity), p: pct(fr / n) });
    $("region-note").textContent = I18N.t("region.note", { o: meta.regions.odor.length, s: meta.regions.structure.length, k: meta.region_rule.k_clusters });

    const P = meta.params, V = meta.eval.valid;
    $("params-table").innerHTML = "<thead><tr><th></th><th>" + esc(I18N.t("ctl.odor")) + "</th><th>" + esc(I18N.t("ctl.structure")) + "</th></tr></thead><tbody>" +
      [["params.input", I18N.t("params.input.odor"), I18N.t("params.input.structure")],
       ["params.metric", I18N.t("params.metric.cosine"), I18N.t("params.metric.jaccard")],
       ["params.nn", P.odor.n_neighbors, P.structure.n_neighbors],
       ["params.md", P.odor.min_dist, P.structure.min_dist],
       ["params.seed", meta.seed, meta.seed],
       ["params.valid", f3(V.odor_map.share_common_label) + " / " + f3(V.odor_map.mean_jaccard),
        f3(V.structure_map.share_common_label) + " / " + f3(V.structure_map.mean_jaccard)]]
        .map(([k, a, b]) => "<tr><th>" + esc(I18N.t(k)) + "</th><td>" + esc(a) + "</td><td>" + esc(b) + "</td></tr>").join("") + "</tbody>";

    const T = meta.eval.test;
    $("res-intro").textContent = I18N.t("results.intro", { n: T.n, k: meta.k }); I18N.nobr($("res-intro"));
    const row = (key, r, cls) => '<tr class="' + (cls || "") + '"><td>' + esc(I18N.t(key)) + '</td><td class="num">' + f3(r.share_common_label) +
      '</td><td class="num">' + f3(r.mean_jaccard) + "</td></tr>";
    const ci = T.map_diff_ci95;
    $("res-table").innerHTML = "<thead><tr><th></th><th class=\"num\">" + esc(I18N.t("res.share")) + "</th><th class=\"num\">" + esc(I18N.t("res.jaccard")) + "</th></tr></thead><tbody>" +
      row("res.odor_map", T.odor_map, "highlight") + row("res.structure_map", T.structure_map) +
      '<tr><td>' + esc(I18N.t("res.diff")) + '</td><td class="num">' + f3(T.odor_map.share_common_label - T.structure_map.share_common_label) +
      " [" + f3(ci.share_common_label[0]) + ", " + f3(ci.share_common_label[1]) + ']</td><td class="num">' +
      f3(T.odor_map.mean_jaccard - T.structure_map.mean_jaccard) + " [" + f3(ci.mean_jaccard[0]) + ", " + f3(ci.mean_jaccard[1]) + "]</td></tr>" +
      row("res.random", T.random) + row("res.odor_hd", T.odor_highdim) + row("res.structure_hd", T.structure_highdim) + "</tbody>";
    $("res-take").textContent = I18N.t("results.take", {
      oh: f3(T.odor_highdim.share_common_label), om: f3(T.odor_map.share_common_label),
      sh: f3(T.structure_highdim.share_common_label), sm: f3(T.structure_map.share_common_label),
      rnd: f3(T.random.share_common_label) });
    const sup = meta.eval.supplementary_top1_agreement;
    $("supp-text").textContent = I18N.t("supp.text", { n, k: meta.k, o: f3(sup.odor), s: f3(sup.structure) });

    const ex = lib.excluded || [], by = {};
    ex.forEach(e => { (by[e.category] = by[e.category] || []).push(e); });
    $("excluded-note").textContent = I18N.t("excluded.note", { n: ex.length, total: n });
    I18N.nobr($("excluded-note"));
    $("excluded-list").innerHTML = Object.keys(by).map(c => "<li><b>" + esc(I18N.t("excluded.cat." + c)) + "</b> (" + by[c].length + "): " +
      esc(by[c].map(e => e.name || e.smiles).join(", ")) + "</li>").join("");
  }

  // ---------- 5.2.2 training animation (odor-map/media, training/odormap/make_training_video.py) ----------
  // The video loads only when played (preload="none"). It plays once by itself when it first scrolls
  // into view, unless the system asks for reduced motion (then the poster stays until the visitor plays it).
  // The epoch is page text (not burnt into the video), so it follows the language.
  const video = $("train-video"), epochEl = $("train-epoch");
  const frames = await get("data/training_frames.json");
  const epochAt = t => {
    let e = frames.keyframes[0].epoch;
    for (const k of frames.keyframes) if (t >= k.t) e = k.epoch;
    return e;
  };
  let shown = null;
  function showEpoch() {
    // before playing, the poster is the last frame (the model used on the site)
    const e = video.currentTime > 0 || !video.paused ? epochAt(video.currentTime) : frames.best_epoch;
    const key = e === frames.best_epoch ? "train.epoch_final" : "train.epoch";
    const text = I18N.t(key, { n: e });
    if (text !== shown) { epochEl.textContent = text; shown = text; }
  }
  let ticking = false;
  function tick() {
    showEpoch();
    if (!video.paused && !video.ended) requestAnimationFrame(tick); else ticking = false;
  }
  video.addEventListener("play", () => { if (!ticking) { ticking = true; requestAnimationFrame(tick); } });
  ["seeked", "pause", "ended", "loadedmetadata"].forEach(ev => video.addEventListener(ev, showEpoch));
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(entries => {
      if (entries.some(en => en.isIntersecting)) {
        io.disconnect();
        video.play().catch(() => {});   // muted, so autoplay is allowed; if refused, the controls remain
      }
    }, { threshold: 0.6 });
    io.observe(video);
  }

  function renderAll() {
    renderText();
    shown = null;
    showEpoch();
  }
  renderAll();
  I18N.onChange(renderAll);
})();
