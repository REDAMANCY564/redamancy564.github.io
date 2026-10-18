/*
 * Minimal i18n for the site.
 * - Elements with data-i18n="key" get textContent = t(key)
 * - Elements with data-i18n-html="key" get innerHTML = t(key) (only for our own trusted strings)
 * - Elements with data-i18n-attr="attr:key;attr2:key2" get attributes set
 * - A button with id="lang-toggle" switches between zh and en
 * Dictionaries: shared  assets/i18n/<lang>.json  (path relative to this script)
 *               page    <data-page-dict>/<lang>.json  (attribute on this <script> tag, optional)
 * Usage in page code: await I18N.ready; I18N.t("key"); I18N.onChange(fn)
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
  function detectLang() {
    const saved = storedLang();
    if (LANGS.includes(saved)) return saved;
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
    return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  const dicts = {};
  const listeners = [];

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
      root.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = I18N.t(el.dataset.i18n); });
      root.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = I18N.t(el.dataset.i18nHtml); });
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
        btn.setAttribute("aria-label", I18N.lang === "zh" ? "Switch to English" : "切换到中文");
      }
    },
    async setLang(lang) {
      if (!LANGS.includes(lang)) return;
      await loadLang(lang);
      I18N.lang = lang;
      storeLang(lang);
      I18N.apply();
      listeners.forEach(fn => fn(lang));
    },
    onChange(fn) { listeners.push(fn); },
  };

  I18N.ready = loadLang(I18N.lang).then(() => {
    I18N.apply();
    const btn = document.getElementById("lang-toggle");
    if (btn) btn.addEventListener("click", () => I18N.setLang(I18N.lang === "zh" ? "en" : "zh"));
  });

  window.I18N = I18N;
})();
