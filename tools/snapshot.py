"""Record what page scripts draw from data, so the first paint already shows it (no jump when it loads).

  <p id="x" data-snap="x">     text or a table filled by a page script: its final content in each
                               language is stored as "snap.x" in the page dictionary
                               (<project>/i18n/zh.json, en.json); assets/i18n.js fills it in at startup
                               and tools/prerender.py writes the Chinese version into the HTML.
  <svg data-snap-h>            a chart: its drawn height on a phone (390 px wide) and on a desktop
                               (1366 px) is stored as style="--snap-h: ...; --snap-h-wide: ...", which
                               assets/style.css applies only while the chart is still empty.

Run after changing the data, the page script or the text of such an element, then run
tools/prerender.py:
    python tools/snapshot.py && python tools/prerender.py
Needs Google Chrome and the Python package websocket-client; pages are served by a temporary local
web server and nothing is sent anywhere else. Keys "snap.*" are generated: do not edit them by hand.
"""
import functools, json, re, subprocess, sys, tempfile, threading, time, urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import websocket

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prerender import ROOT, PAGES, Tree, set_attr  # noqa: E402

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
COLLECT = r"""
(async () => {
  await I18N.ready;
  if (document.readyState !== "complete") await new Promise(r => addEventListener("load", r, { once: true }));
  // wait until the snapped elements stop changing (data loaded and drawn)
  const state = () => [...document.querySelectorAll("[data-snap],svg[data-snap-h]")].map(e => e.innerHTML.length).join(",");
  let last = "", stable = 0;
  for (let i = 0; i < 200 && stable < 8; i++) {
    await new Promise(r => setTimeout(r, 150));
    const s = state(); stable = s === last ? stable + 1 : 0; last = s;
  }
  const snaps = {}, heights = {};
  document.querySelectorAll("[data-snap]").forEach(e => { snaps[e.dataset.snap] = e.innerHTML; });
  document.querySelectorAll("svg[data-snap-h]").forEach(e => { heights[e.id] = Math.round(e.getBoundingClientRect().height); });
  return { snaps, heights };
})()
"""


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


class Chrome:
    def __init__(self):
        port = 9900 + int(time.time()) % 90
        self.proc = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={port}", "--remote-allow-origins=*",
                                      "--no-first-run", f"--user-data-dir={tempfile.mkdtemp()}", "about:blank"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                v = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1)); break
            except Exception:
                time.sleep(0.1)
        self.ws = websocket.create_connection(v["webSocketDebuggerUrl"], timeout=120, suppress_origin=True)
        self.mid = 0

    def call(self, method, sid=None, **params):
        self.mid += 1
        msg = {"id": self.mid, "method": method, "params": params}
        if sid: msg["sessionId"] = sid
        self.ws.send(json.dumps(msg))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.mid:
                if "error" in m: raise RuntimeError(method + ": " + str(m["error"]))
                return m.get("result", {})

    def collect(self, url, lang, width):
        ctx = self.call("Target.createBrowserContext")["browserContextId"]
        tid = self.call("Target.createTarget", url="about:blank", browserContextId=ctx)["targetId"]
        sid = self.call("Target.attachToTarget", targetId=tid, flatten=True)["sessionId"]
        self.call("Emulation.setDeviceMetricsOverride", sid, width=width, height=844, deviceScaleFactor=1, mobile=width < 900)
        self.call("Emulation.setUserAgentOverride", sid, userAgent="Mozilla/5.0 Chrome",
                  acceptLanguage="zh-CN,zh;q=0.9" if lang == "zh" else "en-US,en;q=0.9")
        self.call("Page.enable", sid)
        self.call("Page.navigate", sid, url=url)
        time.sleep(0.5)
        r = None
        for _ in range(20):
            try:
                r = self.call("Runtime.evaluate", sid, expression=COLLECT, awaitPromise=True, returnByValue=True)["result"].get("value")
                if r: break
            except RuntimeError:
                pass
            time.sleep(0.3)
        self.call("Target.closeTarget", targetId=tid)
        self.call("Target.disposeBrowserContext", browserContextId=ctx)
        return r

    def close(self):
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.proc.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def write_snaps(dict_path, snaps):
    s = open(dict_path, encoding="utf-8", newline="").read()
    nl = "\r\n" if "\r\n" in s else "\n"
    d = json.loads(s)
    keep = {k: v for k, v in d.items() if not k.startswith("snap.")}
    keep.update({"snap." + k: v for k, v in sorted(snaps.items())})
    out = "{" + nl + ("," + nl).join("  " + json.dumps(k, ensure_ascii=False) + ": " + json.dumps(v, ensure_ascii=False)
                                     for k, v in keep.items()) + nl + "}" + nl
    if out != s:
        open(dict_path, "w", encoding="utf-8", newline="").write(out)
        return True
    return False


def main():
    pages = [p for p in PAGES if (ROOT / p).exists() and re.search(r"data-snap", (ROOT / p).read_text(encoding="utf-8"))]
    srv = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    ch = Chrome()
    try:
        per_dict = {}   # (dict path, lang) -> {name: html}
        for rel in pages:
            path = ROOT / rel
            dict_dir = path.parent / "i18n"
            heights = {}
            for lang in ("zh", "en"):
                r = ch.collect(base + rel, lang, 390)
                if not r: raise SystemExit(f"{rel} ({lang}): page did not finish")
                bucket = per_dict.setdefault((dict_dir / f"{lang}.json", lang), {})
                for k, v in r["snaps"].items():
                    if k in bucket and bucket[k] != v:
                        raise SystemExit(f"{rel}: data-snap=\"{k}\" differs from another page using {dict_dir}; give it its own name")
                    bucket[k] = v
                if lang == "zh": heights = r["heights"]
            wide = ch.collect(base + rel, "zh", 1366)["heights"]
            # chart heights into the HTML
            with open(path, encoding="utf-8", newline="") as f: text = f.read()
            tree = Tree(text); edits = []
            for n in tree.all():
                if n.tag == "svg" and "data-snap-h" in n.attrs and n.attrs.get("id") in heights:
                    edits.append((n.start, n.start_end, set_attr(text[n.start:n.start_end], "style",
                                                                f"--snap-h: {heights[n.attrs['id']]}px; --snap-h-wide: {wide[n.attrs['id']]}px")))
            for a, b, s in sorted(edits, reverse=True):
                text = text[:a] + s + text[b:]
            with open(path, "w", encoding="utf-8", newline="") as f: f.write(text)
            print(f"{rel}: {len(r['snaps'])} text element(s), {len(heights)} chart(s)")
        for (p, lang), snaps in per_dict.items():
            changed = write_snaps(p, snaps)
            print(f"{p.relative_to(ROOT)}: {len(snaps)} snap key(s){' updated' if changed else ''}")
    finally:
        ch.close(); srv.shutdown()


if __name__ == "__main__":
    main()
