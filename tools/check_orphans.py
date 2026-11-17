"""Find "orphans": paragraphs whose last line holds only one or two characters (Chinese) or one word (English).

Opens every page of the site (the list in tools/prerender.py) at 375, 768 and 1280 px wide, in Chinese and
in English, and measures every text block: p, li, figcaption, dd, dt, blockquote, h1-h4 (text inside a
nested block counts for that block). On the research page both animations are played through, step by
step, and each explanation line (.rs-say) is measured as it appears.

Rule for the last line (spaces and punctuation are not counted):
  - the block contains Chinese: an orphan when it has 1 or 2 characters (Chinese characters, Latin letters
    and digits count one each);
  - otherwise: an orphan when it has exactly one word.
Blocks of a single line are never orphans.

    python tools/check_orphans.py                 # list orphans, exit 1 if any
    python tools/check_orphans.py --out list.json # also save the list
    python tools/check_orphans.py --pages research/index.html --widths 375

Needs Google Chrome and the Python package playwright (pip install playwright; no browser download,
it drives the installed Chrome). Pages are served by a temporary local web server; nothing is sent anywhere else.
"""
import argparse, functools, json, sys, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prerender import ROOT, PAGES  # noqa: E402

WIDTHS = (375, 768, 1280)
HEIGHTS = {375: 812, 768: 1024, 1280: 800}
LANGS = ("zh", "en")

MEASURE_JS = r"""
(() => {
  const SEL = "p,li,figcaption,dd,dt,blockquote,h1,h2,h3,h4";
  const CJK = /[㐀-鿿豈-﫿]/g;
  const WORD = /[A-Za-z0-9Ͱ-ϿÀ-ɏ]+(?:[-'’.×\/][A-Za-z0-9Ͱ-ϿÀ-ɏ]+)*/g;
  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = [...el.classList].filter(c => c !== "nobr").slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    const k = el.closest("[data-i18n],[data-i18n-html]");
    if (k) s += " [" + (k.dataset.i18n || k.dataset.i18nHtml) + "]";
    else if (el.parentElement) {
      const p = el.parentElement.closest("[id]");
      if (p) s += " in #" + p.id;
    }
    return s;
  }
  function lines(el) {
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const out = []; let cur = null, n;
    while ((n = tw.nextNode())) {
      const p = n.parentElement;
      if (!p || p.closest("script,style,svg,button,select,textarea,[hidden]") || p.closest(SEL) !== el) continue;
      const s = n.nodeValue;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (/\s/.test(c)) { if (cur) cur.text += " "; continue; }
        const hi = c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) < 0xdc00 && i + 1 < s.length;
        range.setStart(n, i); range.setEnd(n, i + (hi ? 2 : 1));
        const rs = range.getClientRects();
        const ch = hi ? s.slice(i, i + 2) : c;
        if (hi) i++;
        if (!rs.length) continue;
        const r = rs[rs.length - 1];
        if (!r.width && !r.height) continue;
        if (!cur || r.top > cur.top + 0.5 * Math.max(cur.h, r.height)) { cur = { top: r.top, h: r.height, text: "" }; out.push(cur); }
        cur.text += ch;
      }
    }
    return out.map(l => l.text.trim()).filter(Boolean);
  }
  function units(t) {
    const cjk = (t.match(CJK) || []).length;
    const latin = t.replace(CJK, " ").match(WORD) || [];
    return { cjk, words: latin.length, chars: cjk + latin.join("").replace(/[^A-Za-z0-9Ͱ-ϿÀ-ɏ]/g, "").length };
  }
  function check(el) {
    if (!el.getClientRects().length) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "flex" || cs.display === "grid" || cs.display === "inline-flex") return null;
    const ls = lines(el);
    if (ls.length < 2) return null;
    const last = ls[ls.length - 1], u = units(last);
    // a Chinese paragraph is counted in characters even when its last line has none ("OAV）。")
    const zh = u.cjk || /[㐀-鿿]/.test(ls.join(""));
    const orphan = zh ? u.chars <= 2 : u.words === 1;
    if (!orphan) return null;
    const text = ls.reduce((a, l) => a + (/[㐀-鿿豈-﫿　-〿＀-￯]$/.test(a) || /^[㐀-鿿豈-﫿　-〿＀-￯]/.test(l) || /-$/.test(a) ? "" : " ") + l);
    return { element: describe(el), last, text, lines: ls.length };
  }
  window.__orphCheck = check;
  window.__orphAll = function () {
    const res = [];
    document.querySelectorAll(SEL).forEach(el => { const r = check(el); if (r) res.push(r); });
    return res;
  };
})();
"""

# research page: play every step of both stages; measure the step text when the step has finished and
# every explanation line as it is written
RESEARCH_JS = r"""
async (stageId) => {
  const root = document.getElementById(stageId);
  const found = [];
  const take = el => { const r = window.__orphCheck(el); if (r) found.push(r); };
  const say = root.querySelector(".rs-say");
  const mo = new MutationObserver(() => { if (say.textContent.trim() && !say.hidden) take(say); });
  mo.observe(say, { childList: true, subtree: true, characterData: true });
  const canvas = root.querySelector(".rs-canvas");
  const next = root.querySelector(".rs-next"), pause = root.querySelector(".rs-pause");
  const n = root.querySelectorAll(".rs-step").length;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const done = k => {
    const a = root.querySelectorAll(".rs-step")[k - 1];
    return !a.hidden && pause.disabled && getComputedStyle(a.querySelector(".rs-cap")).opacity === "1";
  };
  canvas.scrollIntoView({ block: "center" });
  for (let k = 1; k <= n; k++) {
    if (k > 1) { canvas.scrollIntoView({ block: "center" }); next.click(); }
    await sleep(300);
    for (let t = 0; t < 600 && !done(k); t++) { canvas.scrollIntoView({ block: "center" }); await sleep(200); }
    const a = root.querySelectorAll(".rs-step")[k - 1];
    a.querySelectorAll("p,li,h3").forEach(take);
  }
  mo.disconnect();
  return found;
}
"""


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


def serve():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def check_page(page, base, rel, lang):
    url = base + rel.replace("index.html", "") + "?lang=" + lang
    page.goto(url, wait_until="load")
    page.wait_for_function("window.I18N && I18N.ready", timeout=20000)
    page.evaluate("I18N.ready")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)
    page.evaluate(MEASURE_JS)
    found = page.evaluate("__orphAll()")
    if rel == "research/index.html":
        for sid in ("rs-stage", "rs-stage-m"):
            found += page.evaluate(RESEARCH_JS, sid)
    seen, out = set(), []
    for f in found:
        key = (f["element"], f["text"])
        if key not in seen:
            seen.add(key); out.append(f)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", nargs="*", default=None)
    ap.add_argument("--widths", nargs="*", type=int, default=list(WIDTHS))
    ap.add_argument("--langs", nargs="*", default=list(LANGS))
    ap.add_argument("--out")
    a = ap.parse_args()
    pages = a.pages or [p for p in PAGES if (ROOT / p).exists()]
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    results = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        for w in a.widths:
            ctx = browser.new_context(viewport={"width": w, "height": HEIGHTS.get(w, 900)}, device_scale_factor=1,
                                      is_mobile=w < 500, has_touch=w < 500)
            page = ctx.new_page()
            for rel in pages:
                for lang in a.langs:
                    for f in check_page(page, base, rel, lang):
                        results.append({"page": rel, "width": w, "lang": lang, **f})
                        print(f"{rel}\t{w}\t{lang}\t{f['element']}\t…{f['last']}\t{f['text']}", flush=True)
            ctx.close()
        browser.close()
    srv.shutdown()
    if a.out:
        Path(a.out).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{len(results)} orphan(s)")
    return 1 if results else 0


if __name__ == "__main__":
    sys.exit(main())
