"""Make the share-preview images and the home-screen icon with headless Chrome.

Outputs (committed to the repository):
  assets/og/site.png           1200x630, homepage / projects page / CV (template: tools/og-site.html)
  assets/og/<project>.jpg      1200x630, top of each tool page in Chinese, desktop width
  apple-touch-icon.png         180x180, favicon.svg on its own background colour

Run from anywhere:  python tools/make_og.py
Needs Google Chrome and the Python package websocket-client. The pages are served by a temporary
local web server; nothing is sent anywhere else.
"""
import base64, functools, json, subprocess, sys, tempfile, threading, time, urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import websocket

ROOT = Path(__file__).resolve().parent.parent
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PROJECTS = ["gcms-interpreter", "ingredient-finder", "odor-predictor", "flavor-improver",
            "odor-map", "taste-predictor", "perception-diversity", "flavor-kb"]


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    port = 9700 + int(time.time()) % 200
    proc = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={port}", "--remote-allow-origins=*",
                             "--no-first-run", f"--user-data-dir={tempfile.mkdtemp()}", "--hide-scrollbars", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=1))
                page = next(t for t in tabs if t["type"] == "page"); break
            except Exception:
                time.sleep(0.1)
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120, suppress_origin=True)
        mid = [0]

        def call(method, **params):
            mid[0] += 1
            ws.send(json.dumps({"id": mid[0], "method": method, "params": params}))
            while True:
                m = json.loads(ws.recv())
                if m.get("id") == mid[0]:
                    if "error" in m: raise RuntimeError(m["error"])
                    return m.get("result", {})

        def ev(expr):
            return call("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)["result"].get("value")

        def shot(url, w, h, out, fmt, wait_expr, settle=1.0, quality=None):
            call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=False)
            call("Page.navigate", url=url)
            for _ in range(150):
                time.sleep(0.2)
                try:
                    if ev(wait_expr): break
                except Exception:
                    pass
            time.sleep(settle)
            ev("window.scrollTo(0, 0)")
            params = {"format": fmt, "clip": {"x": 0, "y": 0, "width": w, "height": h, "scale": 1}}
            if quality: params["quality"] = quality
            data = base64.b64decode(call("Page.captureScreenshot", **params)["data"])
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
            print(f"{out.relative_to(ROOT)}  {len(data) // 1024} KB")

        call("Page.enable"); call("Runtime.enable")
        call("Emulation.setUserAgentOverride", userAgent="Mozilla/5.0 Chrome", acceptLanguage="zh-CN,zh;q=0.9")
        shot(base + "tools/og-site.html", 1200, 630, ROOT / "assets/og/site.png", "png",
             "document.body.dataset.ready === '1' && document.fonts.status === 'loaded'")
        for d in PROJECTS:
            shot(base + d + "/", 1200, 630, ROOT / f"assets/og/{d}.jpg", "jpeg",
                 "window.I18N && document.readyState === 'complete'", settle=3.0, quality=85)
        # home-screen icon: the favicon drawn edge to edge on its background colour (iOS rounds the corners)
        call("Page.navigate", url="about:blank"); time.sleep(0.3)
        svg = (ROOT / "favicon.svg").read_text(encoding="utf-8")
        ev("document.body.style.margin = '0'; document.body.style.background = '#e3f1ef';"
           "document.body.innerHTML = " + json.dumps('<img src="data:image/svg+xml;base64,' + base64.b64encode(svg.encode()).decode() +
                                                      '" width="180" height="180" style="display:block">'))
        call("Emulation.setDeviceMetricsOverride", width=180, height=180, deviceScaleFactor=1, mobile=False)
        time.sleep(0.5)
        data = base64.b64decode(call("Page.captureScreenshot", format="png", clip={"x": 0, "y": 0, "width": 180, "height": 180, "scale": 1})["data"])
        (ROOT / "apple-touch-icon.png").write_bytes(data)
        print(f"apple-touch-icon.png  {len(data) // 1024} KB")
        ws.close()
    finally:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
