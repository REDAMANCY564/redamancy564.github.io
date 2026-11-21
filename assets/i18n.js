/*
 * Minimal i18n for the site.
 * - Elements with data-i18n="key" get textContent = t(key)
 * - Elements with data-i18n-html="key" get innerHTML = t(key) (only for our own trusted strings)
 * - Elements with data-i18n-attr="attr:key;attr2:key2" get attributes set
 * - A button with id="lang-toggle" switches between zh and en
 * Dictionaries: shared  assets/i18n/<lang>.json  (path relative to this script)
 *               page    <data-page-dict>/<lang>.json  (attribute on this <script> tag, optional)
 * Usage in page code: await I18N.ready; I18N.t("key"); I18N.onChange(fn)
 * Load this script in <head> (not deferred): the static HTML already holds the Chinese page
 * (tools/prerender.py), so the language is decided before the first paint. Visitors of the other
 * language get <html class="i18n-pending"> (body hidden by style.css) until their dictionary is
 * applied, so they never see the wrong language and the page does not jump.
 * Elements with data-snap="name" hold text that page scripts compute from data; the result is kept
 * in the page dictionary as "snap.name" (tools/snapshot.py) and filled in at startup, so it is in
 * place in either language before the page script has loaded its data.
 */
(function () {
  const script = document.currentScript;
  const sharedBase = new URL("i18n/", script.src);
  const pageBase = script.dataset.pageDict ? new URL(script.dataset.pageDict, document.baseURI) : null;
  const version = new URL(script.src).search;   // e.g. "?v=20261018": passed on to the dictionaries (cache busting)
  const LANGS = ["zh", "en"];
  const STORAGE_KEY = "site-lang";

  function storedLang() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function storeLang(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* storage unavailable: ignore */ }
  }
  // ?lang=en / ?lang=zh in the address wins and is remembered (links such as the one on the English CV)
  function urlLang() {
    try { const v = new URLSearchParams(location.search).get("lang"); return LANGS.includes(v) ? v : null; } catch (e) { return null; }
  }
  // keep ?lang= in the address in step with the language, without reloading or adding history entries
  function syncUrl(lang) {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("lang") === lang) return;
      u.searchParams.set("lang", lang);
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    } catch (e) { /* file:// or sandboxed: ignore */ }
  }
  function detectLang() {
    const fromUrl = urlLang();
    if (fromUrl) { storeLang(fromUrl); return fromUrl; }
    const saved = storedLang();
    if (LANGS.includes(saved)) return saved;
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
    return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  const dicts = {};
  const listeners = [];

  // Instrument names with hyphens (GC-MS, GC-O-MS, GC×GC-MS ...) must not break at the end of a line.
  // Matches are wrapped in <span class="nobr"> (white-space: nowrap); the characters stay ordinary hyphens,
  // so copying and searching are unaffected. tools/prerender.py applies the same rule (NOBR_RE) to the static HTML.
  // Also kept whole wherever they occur: "24 h" / "24-h" (a number and its unit) and the threshold formula on the
  // intensity curves page (gcms-interpreter/curves.html), so no line starts with its minus sign.
  const NOBR_TERMS = "GC×GC-(?:TOF)?MS|GC-O-MS|GC-IMS|GC-MS(?:\\/MS)?|GC-O|HS-SPME|LC-MS|24[ -]h\\b" +
                     "|X = C - D · ln\\(\\(Imax - 1\\.4\\) \\/ 1\\.4\\)";
  // Words kept whole when they end a text (only there: followed by nothing but punctuation), so a
  // paragraph's last line never holds just one or two characters ("纹”。", "似。") or one English word.
  // Regular-expression sources, one per entry; the text itself is unchanged. tools/prerender.py reads
  // this list from here. Found with tools/check_orphans.py (text-wrap: pretty in assets/style.css does the rest).
  const NOBR_END = [
    "表中各行", "个描述词", "气味指纹", "页面加载", "方法与来源", "相互作用", "协同作用", "统计方法", "关联更强", "仅供参考",
    "整体信号", "接近母乳", "数据请求", "一种物质", "风味物质", "也不支持", "风味和成本", "替代物", "有意义的目标",
    "方向型目标", "文件为准", "复核为准", "提供换算", "分成三簇", "浏览器里", "问题写的", "几个特征", "才会高",
    "直接展示", "拟合曲线", "差距分析", "自动分析", "风味轮廓", "提供思路", "只是近似", "加权组合", "浏览器里运行",
    "分开标注", "归一化", "实验验证", "可能更大", "照常可用", "配方奶粉", "阈值的原因", "构效关系", "法规状态",
    "较好区分", "学术演示", "排在前面", "对比图谱", "替代物的筛选", "法规查询", "排序相同", "发布的数据",
    "训练 ?3 次", "气味来源", "黄油、烘烤", "的结果", "写明单位", "添加建议", "逻辑回归预测", "学习方法预测",
    "论文的结果", "计算一次", "粗略提示", "长得像", "决定了味觉", "同样很小", "之和为 1", "一个示例", "加进来",
    "指标测定", "不宜解读", "偏乐观", "气味越相似", "越相似", "区分这三簇", "被记为甜", "附中文名", "清单名称", "对气味重要", "分子较多", "1\\.4\\) / 1\\.4\\)",
    "CC BY-NC", "method (?:&|&amp;) sources", "not cherry-picked", "Flavor Interpreter", "the header"];
  const NOBR_RE = new RegExp(NOBR_TERMS + "|(?:" + NOBR_END.join("|") +
    ")(?=[\\s。，、；：？！?!.,;:）)」』”’\"']*$)", "g");
  const NOBR_SKIP = "script,style,textarea,option,title,svg,.nobr";
  function nobr(el) {
    if (!el || el.closest && el.closest(NOBR_SKIP)) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n; (n = walker.nextNode());) {
      NOBR_RE.lastIndex = 0;
      if (NOBR_RE.test(n.nodeValue) && !n.parentElement.closest(NOBR_SKIP)) hits.push(n);
    }
    hits.forEach(n => {
      const s = n.nodeValue, frag = document.createDocumentFragment();
      let last = 0;
      s.replace(NOBR_RE, (m, at) => {
        if (at > last) frag.append(s.slice(last, at));
        const sp = document.createElement("span"); sp.className = "nobr"; sp.textContent = m; frag.append(sp);
        last = at + m.length;
        return m;
      });
      if (last < s.length) frag.append(s.slice(last));
      n.replaceWith(frag);
    });
  }

  async function loadJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load " + url);
    return res.json();
  }
  async function loadLang(lang) {
    if (dicts[lang]) return dicts[lang];
    const parts = [loadJson(new URL(lang + ".json" + version, sharedBase))];
    if (pageBase) parts.push(loadJson(new URL(lang + ".json" + version, pageBase)));
    const loaded = await Promise.all(parts);
    dicts[lang] = Object.assign({}, ...loaded);
    return dicts[lang];
  }

  const I18N = {
    lang: detectLang(),
    t(key, vars) {
      let s = (dicts[I18N.lang] || {})[key];
      if (s === undefined) return key;
      if (vars) for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
      return s;
    },
    // Pick the current language from a {zh, en} object
    pick(obj) {
      if (obj == null || typeof obj !== "object") return obj;
      return obj[I18N.lang] != null ? obj[I18N.lang] : obj.en;
    },
    apply(root) {
      root = root || document;
      root.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = I18N.t(el.dataset.i18n); nobr(el); });
      root.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = I18N.t(el.dataset.i18nHtml); nobr(el); });
      root.querySelectorAll("[data-i18n-attr]").forEach(el => {
        el.dataset.i18nAttr.split(";").forEach(pair => {
          const [attr, key] = pair.split(":").map(s => s.trim());
          if (attr && key) el.setAttribute(attr, I18N.t(key));
        });
      });
      document.documentElement.lang = I18N.lang === "zh" ? "zh-CN" : "en";
      const title = I18N.t("page.title");
      if (title !== "page.title") document.title = title;
      const btn = document.getElementById("lang-toggle");
      if (btn) {
        btn.querySelectorAll("[data-lang]").forEach(s => s.classList.toggle("active", s.dataset.lang === I18N.lang));
        // Full meaning in both languages: on English phone pages under 360 px the button shows only "中"
        btn.setAttribute("aria-label", "中/EN: " + (I18N.lang === "zh" ? "切换到英文 / Switch to English" : "Switch to Chinese / 切换到中文"));
      }
    },
    async setLang(lang) {
      if (!LANGS.includes(lang)) return;
      await loadLang(lang);
      I18N.lang = lang;
      storeLang(lang);
      syncUrl(lang);
      I18N.apply();
      listeners.forEach(fn => fn(lang));
    },
    onChange(fn) { listeners.push(fn); },
    nobr,   // for page scripts that write text containing instrument names
    // For page scripts that rewrite the address: "?<qs>" (or the bare path) with the current ?lang= kept
    keepLang(qs) {
      const usp = new URLSearchParams(qs || "");
      const lang = urlLang();
      if (lang && !usp.has("lang")) usp.set("lang", lang);
      const s = usp.toString();
      return s ? "?" + s : location.pathname;
    },
    // Recorded output of a data-snap element (undefined if none, or while tools/snapshot.py records afresh)
    snap(name) {
      return window.__noSnap ? undefined : (dicts[I18N.lang] || {})["snap." + name];
    },
  };

  // The static HTML is written in this language (tools/prerender.py)
  const root = document.documentElement;
  const staticLang = (root.getAttribute("lang") || "").toLowerCase().startsWith("zh") ? "zh" : "en";
  root.lang = I18N.lang === "zh" ? "zh-CN" : "en";
  if (I18N.lang !== staticLang) root.classList.add("i18n-pending");
  const domReady = new Promise(resolve => {
    if (document.readyState !== "loading") resolve();
    else document.addEventListener("DOMContentLoaded", resolve, { once: true });
  });

  function applySnaps() {
    document.querySelectorAll("[data-snap]").forEach(el => {
      const v = I18N.snap(el.dataset.snap);
      if (v !== undefined) el.innerHTML = v;
    });
  }
  function startup() {
    I18N.apply();
    applySnaps();
    root.classList.remove("i18n-pending");
  }

  const dictReady = loadLang(I18N.lang);
  // Other-language visitors: show the page as soon as the dictionary is here and the body has been
  // parsed up to the footer (the scripts come after it), without waiting for large scripts to load.
  dictReady.then(() => {
    const early = () => {
      if (!root.classList.contains("i18n-pending")) return true;
      if (!document.querySelector(".site-footer")) return false;
      startup();
      return true;
    };
    if (early()) return;
    const watch = new MutationObserver(() => { if (early()) watch.disconnect(); });
    watch.observe(root, { childList: true, subtree: true });
    domReady.then(() => watch.disconnect());
  }, () => {});

  I18N.ready = Promise.all([dictReady, domReady]).then(() => {
    startup();
    const btn = document.getElementById("lang-toggle");
    if (btn) btn.addEventListener("click", () => I18N.setLang(I18N.lang === "zh" ? "en" : "zh"));
  }, err => {
    root.classList.remove("i18n-pending");   // show the static page rather than nothing
    throw err;
  });

  window.I18N = I18N;
})();

/*
 * Small interface helpers shared by every page (this is the one script all pages load, so they add no request).
 * Styles in assets/style.css; animations only with transform and opacity, and none when the system asks for
 * reduced motion (the CSS keeps them inside prefers-reduced-motion: no-preference).
 * 1. Tooltips: UI.tip(trigger, text), and every a.help or [data-tip] element that has a title: the title text
 *    moves into the tooltip (when I18N.apply puts a translated title back, it is moved again). Mouse: shown on
 *    hover. Keyboard: shown on focus. Touch: a tap shows it, a second tap or a tap outside hides it; on an
 *    a.help the tooltip then holds the link to the method page. Esc closes. It opens on the side with room
 *    and stays inside the screen.
 * 2. Term notes: the first visible OAV, ROAV (相对气味活性值) and LMS in the text of each page get a dotted
 *    underline and a tooltip (term.* in assets/i18n). Not inside links, buttons, labels, headings,
 *    navigation, the tool directory lists, charts or data-snap blocks (tools/snapshot.py records those).
 * 3. Copy buttons: UI.copyButton({text, label, select}) gives a small icon button; a clipboard copy shows a
 *    tick for 1.5 s and says "Copied" through an aria-live region; when copying fails the text is selected
 *    (opts.select, or the text shown in a bubble) with "Please copy it by hand".
 */
(function () {
  const I18N = window.I18N;
  const MARGIN = 8, GAP = 8;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- aria-live region for short notices ("Copied") ----
  let live = null;
  function liveRegion() {
    if (!live) {
      live = document.createElement("div");
      live.className = "sr-only";
      live.setAttribute("aria-live", "polite");
      document.body.append(live);
    }
    return live;
  }
  function announce(msg) {
    const r = liveRegion();
    r.textContent = "";
    setTimeout(() => { r.textContent = msg; }, 60);   // a fresh change, so the same notice is read again
  }

  // ---- tooltips ----
  let uid = 0, open = null, lastPointer = "", hideTimer = 0;
  const tips = new Map();   // trigger -> {trigger, box, text(), link}

  function fill(st) {
    const box = st.box;
    box.textContent = st.text();
    if (st.link) {
      const a = document.createElement("a");
      a.href = st.link;
      a.className = "ui-tip-link";
      a.textContent = I18N.t("nav.about") + " →";
      box.append(" ", a);
    }
  }
  // fixed position next to the trigger: above when there is room, else below; always inside the screen
  function place(trigger, box) {
    const r = trigger.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    box.style.maxWidth = Math.min(320, vw - 2 * MARGIN) + "px";
    box.style.left = "0px"; box.style.top = "0px";
    const w = box.offsetWidth, h = box.offsetHeight;
    const roomAbove = r.top - GAP - MARGIN, roomBelow = vh - r.bottom - GAP - MARGIN;
    const below = roomAbove < h && roomBelow > roomAbove;
    let top = below ? r.bottom + GAP : r.top - GAP - h;
    top = Math.max(MARGIN, Math.min(vh - MARGIN - h, top));
    const cx = r.left + r.width / 2;
    const left = Math.max(MARGIN, Math.min(vw - MARGIN - w, cx - w / 2));
    box.style.left = Math.round(left) + "px";
    box.style.top = Math.round(top) + "px";
    // grows out of the trigger
    box.style.transformOrigin = Math.round(Math.max(0, Math.min(w, cx - left))) + "px " + (below ? "0" : h + "px");
    box.dataset.side = below ? "below" : "above";
  }
  function show(trigger, pinned) {
    const st = tips.get(trigger);
    if (!st) return;
    clearTimeout(hideTimer);
    if (open && open.trigger === trigger) { open.pinned = open.pinned || !!pinned; return; }
    hide(true);
    fill(st);
    const box = st.box;
    clearTimeout(st.timer);
    box.classList.remove("open");
    box.hidden = false;
    place(trigger, box);
    void box.offsetWidth;   // start the transition from the closed state
    box.classList.add("open");
    open = { trigger, st, pinned: !!pinned };
  }
  function hide(now) {
    clearTimeout(hideTimer);
    if (!open) return;
    const st = open.st;
    open = null;
    st.box.classList.remove("open");
    if (st.temp) { tips.delete(st.trigger); st.box.remove(); return; }
    if (now || reduced()) st.box.hidden = true;
    else st.timer = setTimeout(() => { if (!st.box.classList.contains("open")) st.box.hidden = true; }, 200);
  }
  function hideSoon(trigger) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (open && open.trigger === trigger && !open.pinned) hide(); }, 150);
  }
  function makeBox() {
    const box = document.createElement("div");
    box.className = "ui-tip";
    box.id = "ui-tip-" + (++uid);
    box.setAttribute("role", "tooltip");
    box.hidden = true;
    // the pointer may move from the trigger onto the tooltip (to reach its link)
    box.addEventListener("pointerenter", e => { if (e.pointerType === "mouse") clearTimeout(hideTimer); });
    box.addEventListener("pointerleave", e => { if (e.pointerType === "mouse" && open && open.st.box === box) hideSoon(open.trigger); });
    document.body.append(box);
    return box;
  }

  /** Tooltip on trigger; text is a string or a function (read each time it opens, so it follows the language).
   *  opts.link: a link shown in the tooltip; opts.noDescribe: the trigger's name already is the text. */
  function tip(trigger, text, opts) {
    opts = opts || {};
    const getText = typeof text === "function" ? text : () => text;
    let st = tips.get(trigger);
    if (st) { st.text = getText; if (open && open.st === st) fill(st); return st.box; }
    st = { trigger, box: makeBox(), text: getText, link: opts.link || null };
    tips.set(trigger, st);
    if (!opts.noDescribe) trigger.setAttribute("aria-describedby", st.box.id);
    const isField = trigger.matches("input, select, textarea, label");
    trigger.addEventListener("pointerdown", e => { lastPointer = e.pointerType; });
    trigger.addEventListener("pointerenter", e => { if (e.pointerType === "mouse") show(trigger); });
    trigger.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") hideSoon(trigger); });
    trigger.addEventListener("focus", () => {
      // keyboard focus, and any focus of a field; a tap on a link or a term is handled by click
      if (isField || trigger.matches(":focus-visible")) show(trigger);
    });
    trigger.addEventListener("blur", () => { if (open && open.trigger === trigger && !open.pinned) hideSoon(trigger); });
    trigger.addEventListener("click", e => {
      const touch = e.detail > 0 && lastPointer !== "" && lastPointer !== "mouse";
      lastPointer = "";
      if (!touch) return;   // mouse and keyboard: links and buttons work as before
      if (isField) { show(trigger, true); return; }   // a tap on a label still ticks its box
      e.preventDefault();   // on a.help the method-page link is in the tooltip
      if (open && open.trigger === trigger && open.pinned) hide(); else show(trigger, true);
    });
    return st.box;
  }

  // a one-off note next to an element; closed by Esc, a tap outside or the next tooltip
  function note(anchor, build) {
    hide(true);
    const box = makeBox();
    box.classList.add("ui-tip-note");
    build(box);
    const st = { trigger: anchor, box, text: () => "", temp: true };
    tips.set(anchor, st);
    box.hidden = false;
    place(anchor, box);
    void box.offsetWidth;
    box.classList.add("open");
    open = { trigger: anchor, st, pinned: true };
    return box;
  }

  document.addEventListener("pointerdown", e => {
    if (open && !open.trigger.contains(e.target) && !open.st.box.contains(e.target)) hide();
  }, true);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && open) hide(); });
  let queuedPlace = false;
  const replace = () => {
    if (!open || queuedPlace) return;
    queuedPlace = true;
    requestAnimationFrame(() => {
      queuedPlace = false;
      if (!open) return;
      if (!open.trigger.isConnected) { hide(true); return; }
      place(open.trigger, open.st.box);
    });
  };
  addEventListener("scroll", replace, { passive: true, capture: true });
  addEventListener("resize", replace);

  // existing help: a.help and [data-tip] elements with a title (the title text is the tooltip)
  const TIP_SEL = "a.help[title], [data-tip][title]";
  function upgrade(el) {
    const text = el.getAttribute("title");
    if (!text) return;
    el.removeAttribute("title");   // no second, native tooltip
    const st = tips.get(el);
    if (st) { st.text = () => text; if (open && open.st === st) fill(st); return; }
    const href = el.matches("a.help[href]") ? el.getAttribute("href") : null;
    tip(el, () => text, { link: href, noDescribe: el.getAttribute("aria-label") === text });
  }
  function upgradeAll(root) {
    if (root.matches && root.matches(TIP_SEL)) upgrade(root);
    if (root.querySelectorAll) root.querySelectorAll(TIP_SEL).forEach(upgrade);
  }

  // ---- term notes ----
  const TERMS = [
    { key: "term.oav", re: /(?<![A-Za-z])OAVs?(?![A-Za-z])/ },
    { key: "term.roav", re: /相对气味活性值|[Rr]elative odou?r activity values?|(?<![A-Za-z])ROAVs?(?![A-Za-z])/ },
    { key: "term.lms", re: /(?<![A-Za-z])LMS(?![A-Za-z])/ },
  ];
  const TERM_SKIP = "a,button,label,select,option,textarea,input,script,style,svg,code,h1,h2,h3,h4,nav,header,footer,dialog," +
    ".term,.ui-tip,[aria-hidden='true'],[data-snap],[hidden],.dir-list,.pub-list,.toc,.chart-box,.mono";
  const marks = new Map();   // term key -> its span
  const visible = el => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);
  function scanTerms() {
    const root = document.querySelector("main");
    if (!root) return;
    const need = TERMS.filter(T => !(marks.get(T.key) || {}).isConnected);
    if (!need.length) return;
    const hits = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let g = 0;
    for (let n; need.length && (n = walker.nextNode()); g++) {
      const s = n.nodeValue;
      if (!/[A-Za-z相]/.test(s)) continue;
      let ok = null;   // whether this text may get a note (checked once, on the first match)
      for (let i = need.length - 1; i >= 0; i--) {
        const m = need[i].re.exec(s);
        if (!m) continue;
        if (ok === null) { const p = n.parentElement; ok = !!p && !p.closest(TERM_SKIP) && visible(p); }
        if (!ok) break;
        hits.push({ T: need[i], n, g, at: m.index, len: m[0].length });
        need.splice(i, 1);
      }
    }
    // several hits in one text node: split from the end, so the earlier offsets stay valid
    hits.sort((a, b) => a.g - b.g || b.at - a.at);
    hits.forEach(({ T, n, at, len }) => {
      const mid = n.splitText(at);
      mid.splitText(len);
      const sp = document.createElement("span");
      sp.className = "term";
      sp.tabIndex = 0;
      mid.replaceWith(sp);
      sp.append(mid);
      marks.set(T.key, sp);
      tip(sp, () => I18N.t(T.key));
    });
  }
  // rescan when page scripts write new text (a hidden step appears, a result is drawn), at most every 400 ms
  let scanTimer = 0, lastScan = 0;
  function scanSoon() {
    if (scanTimer) return;
    const wait = Math.max(0, 400 - (Date.now() - lastScan));
    scanTimer = setTimeout(() => { scanTimer = 0; lastScan = Date.now(); scanTerms(); }, wait);
  }

  // ---- copy buttons ----
  const ICONS = '<svg class="i-copy" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<rect x="5.5" y="5.5" width="8" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<path d="M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5.5A1.5 1.5 0 0 0 4 10h1.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>' +
    '<svg class="i-ok" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<path d="M3 8.5l3.2 3.1L13 4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function selectNode(node) {
    const sel = window.getSelection(), range = document.createRange();
    if (node.nodeType === 3) range.selectNode(node); else range.selectNodeContents(node);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  /** opts.text: string or function; opts.label: i18n key of the button name; opts.select: node (or function
   *  giving one) to select when the clipboard cannot be used; without it the text is shown in a bubble. */
  function copyButton(opts) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "copy-btn";
    b.innerHTML = ICONS;
    b.dataset.i18nAttr = "aria-label:" + opts.label;   // translated again by I18N.apply
    b.setAttribute("aria-label", I18N.t(opts.label));
    let timer = 0;
    b.addEventListener("click", async () => {
      const text = String(typeof opts.text === "function" ? opts.text() : opts.text);
      clearTimeout(timer);
      try {
        if (!navigator.clipboard || !window.isSecureContext) throw new Error("no clipboard");
        await navigator.clipboard.writeText(text);
        b.classList.add("done");
        announce(I18N.t("copy.done"));
        timer = setTimeout(() => b.classList.remove("done"), 1500);
      } catch (e) {
        b.classList.remove("done");
        const target = typeof opts.select === "function" ? opts.select() : opts.select;
        let span = null;
        note(b, box => {
          if (target && target.isConnected) { box.textContent = I18N.t("copy.manual"); return; }
          span = document.createElement("span");
          span.className = "ui-tip-copy";
          span.textContent = text;
          box.append(I18N.t("copy.manual") + " ", span);
        });
        selectNode(span || target);
        announce(I18N.t("copy.manual"));
      }
    });
    return b;
  }

  window.UI = { tip, copyButton, announce, scanTerms };

  I18N.ready.then(() => {
    liveRegion();
    upgradeAll(document);
    scanTerms();
    I18N.onChange(() => { upgradeAll(document); scanTerms(); });
    new MutationObserver(records => {
      let text = false;
      for (const r of records) {
        if (r.type === "attributes") { if (r.target.matches(TIP_SEL)) upgrade(r.target); continue; }
        const t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        if (!t || t.closest("svg, .ui-tip, .sr-only")) continue;
        r.addedNodes.forEach(n => { if (n.nodeType === 1) upgradeAll(n); });
        text = true;
      }
      if (text) scanSoon();
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["title"] });
  }, () => {});
})();
