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
  const NOBR_TERMS = "GC×GC-(?:TOF)?MS|GC-O-MS|GC-IMS|GC-MS(?:\\/MS)?|GC-O|HS-SPME|LC-MS";
  // Words kept whole when they end a text (only there: followed by nothing but punctuation), so a
  // paragraph's last line never holds just one or two characters ("纹”。", "似。") or one English word.
  // Regular-expression sources, one per entry; the text itself is unchanged. tools/prerender.py reads
  // this list from here. Found with tools/check_orphans.py (text-wrap: pretty in assets/style.css does the rest).
  const NOBR_END = [
    "表中各行", "气味指纹", "页面加载", "方法与来源", "相互作用", "协同作用", "统计方法", "关联更强", "仅供参考",
    "整体信号", "接近母乳", "数据请求", "一种物质", "风味物质", "也不支持", "风味和成本", "替代物", "有意义的目标",
    "方向型目标", "文件为准", "复核为准", "提供换算", "分成三簇", "浏览器里", "问题写的", "几个特征", "才会高",
    "直接展示", "拟合曲线", "差距分析", "自动分析", "风味轮廓", "提供思路", "只是近似", "加权组合", "浏览器里运行",
    "分开标注", "归一化", "实验验证", "可能更大", "照常可用", "配方奶粉", "阈值的原因", "构效关系", "法规状态",
    "较好区分", "学术演示", "排在前面", "对比图谱", "替代物的筛选", "法规查询", "排序相同", "发布的数据",
    "训练 ?3 次", "气味来源", "黄油、烘烤", "的结果", "写明单位", "添加建议", "逻辑回归预测", "学习方法预测",
    "论文的结果", "计算一次", "粗略提示", "长得像", "决定了味觉", "同样很小", "之和为 1", "一个示例", "加进来",
    "指标测定", "不宜解读", "偏乐观", "越相似", "1\\.4\\) / 1\\.4\\)",
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
        btn.setAttribute("aria-label", "中/EN: " + (I18N.lang === "zh" ? "Switch to English" : "切换到中文"));
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
