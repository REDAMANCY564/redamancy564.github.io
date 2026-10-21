"""Write the default-language (Chinese) text into the static HTML of every page.

The pages are still translated in the browser by assets/i18n.js; this script only makes the HTML
that arrives first already contain the final Chinese page, so that visitors (and readers without
JavaScript) never see an empty or English page that then jumps into place.

What it fills in, from the same sources the browser uses:
  - <html lang="zh-CN"> and <title> (same title rules as the page scripts)
  - elements with data-i18n / data-i18n-html / data-i18n-attr (from assets/i18n/zh.json plus the
    page dictionary named by data-page-dict on the i18n.js script tag)
  - elements with data-snap: what the page script draws from data, recorded by tools/snapshot.py
  - section numbers (data-no) of project pages, as assets/projects.js numberPage() sets them
  - the lists drawn from assets/profile.json on the homepage, the projects page and the CV
  - the share-preview tags in <head> (Open Graph, Twitter card, canonical, theme-color,
    apple-touch-icon; title and description copied from <title> and the description meta)
    and sitemap.xml (every page except 404.html)

Run after changing any zh.json, profile.json, a page's data-i18n markup or projects.js:
    python tools/prerender.py           rewrite the pages
    python tools/prerender.py --check   exit 1 (and list the pages) if any page is out of date
Only the parts listed above are rewritten; everything else in the files stays byte for byte.
"""
import html, json, re, sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LANG = "zh"
# Same order as PROJECTS in assets/projects.js (the project number)
PROJECTS = [("gcms-interpreter", "gcms"), ("ingredient-finder", "finder"), ("odor-predictor", "odor"),
            ("flavor-improver", "fi"), ("odor-map", "map"), ("taste-predictor", "taste"),
            ("perception-diversity", "perc"), ("flavor-kb", "kb")]
PAGES = (["index.html", "projects/index.html", "cv/index.html", "404.html"] +
         [f"{d}/{f}" for d, _ in PROJECTS for f in ("index.html", "about.html")])
SITE = "https://redamancy564.github.io/"
THEME = "#fbfaf7"
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


def esc(s):
    """Same escaping as SITE.esc in assets/projects.js."""
    return re.sub(r"[&<>\"']", lambda m: {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[m.group()], str(s))


class Node:
    def __init__(self, tag, attrs, start, start_end, parent):
        self.tag, self.attrs, self.start, self.start_end, self.parent = tag, attrs, start, start_end, parent
        self.end = None        # offset of the end tag (end of content)
        self.children = []

    def closest(self, pred):
        n = self
        while n is not None:
            if pred(n): return n
            n = n.parent
        return None

    def descendants(self):
        for c in self.children:
            yield c
            yield from c.descendants()


class Tree(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.text = text
        self.line_start = [0] + [m.end() for m in re.finditer("\n", text)]
        self.root = Node("#root", {}, 0, 0, None)
        self.stack = [self.root]
        self.feed(text); self.close()

    def _abs(self):
        line, col = self.getpos()
        return self.line_start[line - 1] + col

    def handle_starttag(self, tag, attrs):
        start = self._abs()
        raw = self.get_starttag_text()
        node = Node(tag, {k: (v or "") for k, v in attrs}, start, start + len(raw), self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in VOID and not raw.endswith("/>"):
            self.stack.append(node)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                self.stack[i].end = self._abs()
                del self.stack[i:]
                return

    def all(self):
        return list(self.root.descendants())


def set_attr(tag_text, name, value):
    v = value.replace("&", "&amp;").replace('"', "&quot;")
    pat = re.compile(r"(\s" + re.escape(name) + r')="[^"]*"')
    if pat.search(tag_text):
        return pat.sub(lambda m: m.group(1) + '="' + v + '"', tag_text, count=1)
    close = 2 if tag_text.endswith("/>") else 1
    return tag_text[:-close].rstrip() + f' {name}="{v}"' + tag_text[-close:]


def load_json(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


SHARED = load_json(ROOT / "assets/i18n" / f"{LANG}.json")
PROFILE = load_json(ROOT / "assets/profile.json")


def pick(o):
    if not isinstance(o, dict): return o
    return o[LANG] if o.get(LANG) is not None else o.get("en")


# ---- profile-driven lists (same markup as the page scripts) ----
def home_lists(t, root):
    p = PROFILE
    links = []
    if p.get("email"): links.append('<a href="mailto:' + esc(p["email"]) + '">' + esc(t("home.email")) + "</a>")
    if p.get("cv_pdf"): links.append('<a href="' + esc(p["cv_pdf"]) + '" target="_blank" rel="noopener">' + esc(t("home.cv_pdf")) + "</a>")
    if p.get("github"): links.append('<a href="' + esc(p["github"]) + '" target="_blank" rel="noopener">GitHub</a>')
    if p.get("linkedin"): links.append('<a href="' + esc(p["linkedin"]) + '" target="_blank" rel="noopener">LinkedIn</a>')
    directory = "".join(
        "<li>" + '<span class="no">' + str(i + 1) + "</span>" +
        '<div><a class="toc-title" href="' + root + d + '/">' + esc(t("home." + k + ".title")) + "</a>" +
        "<p>" + esc(t("home." + k + ".one")) + "</p></div>" + "</li>" for i, (d, k) in enumerate(PROJECTS))
    papers = "".join("<li>" + esc(x["title"]) + '<br><span class="venue"><i>' + esc(x["venue"]) + "</i> · " +
                     esc(t("home.first_author")) + "</span></li>" for x in p.get("papers") or [])
    patents = "".join("<li>" + esc(pick(x["title"])) + '<br><span class="venue">' + esc(pick(x["note"])) + "</span></li>"
                      for x in (p.get("patents") or []) + (p.get("talks") or []))
    return {"role": esc(pick(p.get("role")) or ""), "bio": esc(pick(p.get("bio")) or ""), "contact": "".join(links),
            "dir-list": directory, "paper-list": papers, "patent-list": patents}


def projects_list(t, root):
    out = []
    for i, (d, k) in enumerate(PROJECTS):
        title = esc(t("home." + k + ".title")); href = root + d + "/"
        out.append('<div class="pub-item">' +
                   '<a class="thumb" href="' + href + '" tabindex="-1">' +
                   '<img src="' + root + "assets/thumbs/" + d + '.webp" width="200" height="150" loading="lazy" alt="' +
                   esc(t("home.thumb_alt", {"name": t("home." + k + ".title")})) + '">' + "</a>" +
                   "<div>" + '<a class="pub-title" href="' + href + '" data-no="' + str(i + 1) + '">' + title + "</a>" +
                   "<p>" + esc(t("home." + k + ".one")) + "</p>" +
                   '<p class="links"><a href="' + href + '">' + esc(t("nav.tool")) + "</a>" +
                   '<a href="' + href + 'about.html">' + esc(t("nav.about")) + "</a></p>" + "</div></div>")
    return {"pub-list": "".join(out)}


def cv_lists(t, root):
    p = PROFILE
    pk = lambda o: esc(pick(o))
    noted = lambda lst: "".join("<li>" + pk(x["title"]) + '<br><span class="venue">' + pk(x["note"]) + "</span></li>" for x in lst or [])
    return {
        "pub-published": "".join("<li>" + esc(x["title"]) + '<br><span class="venue"><i>' + esc(x["venue"]) + "</i> · " + pk(x["rank"]) + "</span></li>"
                                 for x in p.get("papers") or []),
        "pub-submitted": "".join("<li>" + esc(s) + "</li>" for s in p.get("submitted") or []),
        "pub-cn": "".join("<li>" + pk(x["title"]) + '<br><span class="venue"><i>' + pk(x["venue"]) + "</i>" + ("，" if LANG == "zh" else ", ") + pk(x["note"]) + "</span></li>"
                          for x in p.get("cn_papers") or []),
        "pub-patents": noted(p.get("patents")), "pub-apps": noted(p.get("patent_apps")), "pub-talks": noted(p.get("talks")),
    }


def gcms_scope(t, root):
    # same markup as gcms-interpreter/app.js and about.js (renderScope)
    p = PROFILE
    mail = (' <a class="mail-link" href="mailto:' + esc(p["email"]) + '">' + esc(p["email"]) + "</a>" + esc(t("scope.end"))
            if p.get("email") else "")
    return {"scope-note": esc(t("scope.text")) + mail}


def page_url(rel):
    if rel.endswith("index.html"): rel = rel[: -len("index.html")]
    return SITE + rel


def share_block(rel, text, title, nl):
    """Remove the tags this script owns from <head> and insert them again after the description."""
    text = re.sub(r'[ \t]*<(?:meta (?:property="og:|name="twitter:|name="theme-color"|name="robots")'
                  r'|link rel="(?:canonical|apple-touch-icon)")[^>]*>\r?\n', "", text)
    m = re.search(r'([ \t]*)<meta name="description" content="([^"]*)">\r?\n', text)
    desc = html.unescape(m.group(2)) if m else ""
    if m is None: m = re.search(r"([ \t]*)<title>.*?</title>\r?\n", text)
    ind = m.group(1)
    a = lambda v: v.replace("&", "&amp;").replace('"', "&quot;")
    tags = [f'<meta name="theme-color" content="{THEME}">', '<link rel="apple-touch-icon" href="/apple-touch-icon.png">']
    if rel != "404.html":   # served with HTTP status 404, so it is not indexed anyway
        parts = rel.split("/")
        image = SITE + "assets/og/" + (parts[0] + ".jpg" if len(parts) > 1 and parts[0] in dict(PROJECTS) else "site.png")
        url = page_url(rel)
        tags = [f'<link rel="canonical" href="{url}">'] + tags + [
            '<meta property="og:type" content="website">',
            f'<meta property="og:site_name" content="{a(SHARED["home.page_title"])}">',
            f'<meta property="og:title" content="{a(title)}">',
            f'<meta property="og:description" content="{a(desc)}">',
            f'<meta property="og:url" content="{url}">',
            f'<meta property="og:image" content="{image}">',
            '<meta property="og:image:width" content="1200">',
            '<meta property="og:image:height" content="630">',
            '<meta property="og:locale" content="zh_CN">',
            '<meta property="og:locale:alternate" content="en_US">',
            '<meta name="twitter:card" content="summary_large_image">',
            f'<meta name="twitter:title" content="{a(title)}">',
            f'<meta name="twitter:description" content="{a(desc)}">',
            f'<meta name="twitter:image" content="{image}">']
    return text[:m.end()] + "".join(ind + t + nl for t in tags) + text[m.end():]


def render(rel):
    path = ROOT / rel
    with open(path, encoding="utf-8", newline="") as f: text = f.read()
    tree = Tree(text)
    nodes = tree.all()

    # dictionaries: shared + the page dictionary named on the i18n.js script tag
    d = dict(SHARED)
    i18n_tag = next((n for n in nodes if n.tag == "script" and re.search(r"assets/i18n\.js", n.attrs.get("src", ""))), None)
    if i18n_tag is not None and i18n_tag.attrs.get("data-page-dict"):
        d.update(load_json((path.parent / i18n_tag.attrs["data-page-dict"] / f"{LANG}.json").resolve()))
    missing = set()

    def t(key, vars=None):
        if key not in d:
            missing.add(key); return key
        s = d[key]
        for k, v in (vars or {}).items(): s = s.replace("{" + k + "}", str(v))
        return s

    tag_edits = {}      # node -> new start tag text
    content = {}        # node -> new inner HTML

    def tag_of(n):
        return tag_edits.get(n, text[n.start:n.start_end])

    for n in nodes:
        a = n.attrs
        if "data-i18n" in a: content[n] = html.escape(t(a["data-i18n"]), quote=False)
        if "data-i18n-html" in a: content[n] = t(a["data-i18n-html"])
        if "data-snap" in a: content[n] = t("snap." + a["data-snap"])   # generated by tools/snapshot.py
        if "data-i18n-attr" in a:
            s = tag_of(n)
            for pair in a["data-i18n-attr"].split(";"):
                if ":" not in pair: continue
                attr, key = [x.strip() for x in pair.split(":", 1)]
                if attr and key: s = set_attr(s, attr, t(key))
            tag_edits[n] = s
        if n.tag == "html": tag_edits[n] = set_attr(tag_of(n), "lang", "zh-CN" if LANG == "zh" else "en")

    # profile-driven lists
    lists = {"index.html": home_lists, "projects/index.html": projects_list, "cv/index.html": cv_lists,
             "404.html": lambda t, root: {"dir-list": home_lists(t, root)["dir-list"]},
             "gcms-interpreter/index.html": gcms_scope, "gcms-interpreter/about.html": gcms_scope}.get(rel)
    if lists:
        root = {"index.html": "", "404.html": "/"}.get(rel, "../")
        for id_, inner in lists(t, root).items():
            n = next((x for x in nodes if x.attrs.get("id") == id_), None)
            if n is None: raise SystemExit(f"{rel}: no element #{id_}")
            content[n] = inner

    # section numbers and tab title of project pages (assets/projects.js numberPage)
    parts = rel.split("/")
    proj = next((i for i, (dname, _) in enumerate(PROJECTS) if dname in parts), None)
    title = None
    if proj is not None:
        no = proj + 1
        main = next((x for x in nodes if x.tag == "main"), None)
        h1 = next((x for x in main.descendants() if x.tag == "h1"), None) if main else None
        if h1 is not None: tag_edits[h1] = set_attr(tag_of(h1), "data-no", str(no))
        counters = {}; sec_no = {}
        for n in nodes:
            if "data-sec" not in n.attrs: continue
            scope = n.closest(lambda x: "data-sec-scope" in x.attrs) or tree.root
            c = counters.setdefault(id(scope), [0, 0])
            if n.attrs["data-sec"] == "1": c[0] += 1; c[1] = 0; v = f"{no}.{c[0]}"
            else: c[1] += 1; v = f"{no}.{c[0]}.{c[1]}"
            sec_no[n] = v; tag_edits[n] = set_attr(tag_of(n), "data-no", v)
        by_id = {x.attrs["id"]: x for x in nodes if "id" in x.attrs}
        for a in nodes:
            if a.tag != "a" or not a.attrs.get("href", "").startswith("#"): continue
            if a.closest(lambda x: "toc" in x.attrs.get("class", "").split()) is None: continue
            target = by_id.get(a.attrs["href"][1:])
            if target is None: continue
            h = target if "data-sec" in target.attrs else next((x for x in target.descendants() if "data-sec" in x.attrs), None)
            if h is not None: tag_edits[a] = set_attr(tag_of(a), "data-no", sec_no[h])
        title = (t("nav.about") + " | " if rel.endswith("about.html") else "") + f"{no} " + t("hero.short") + " | " + t("site.name")
    else:
        key = {"index.html": "home.page_title", "projects/index.html": "projects.page_title",
               "404.html": "nf.page_title"}.get(rel, "page.title")
        if key in d: title = d[key]
    if title is not None:
        tn = next((x for x in nodes if x.tag == "title"), None)
        content[tn] = html.escape(title, quote=False)

    # nodes inside a replaced content are rewritten by that replacement
    def inside_replaced(n):
        p = n.parent
        while p is not None:
            if p in content: return True
            p = p.parent
        return False

    edits = []
    for n, s in tag_edits.items():
        if not inside_replaced(n): edits.append((n.start, n.start_end, s))
    for n, s in content.items():
        if n.end is None: raise SystemExit(f"{rel}: <{n.tag}> without end tag")
        if not inside_replaced(n): edits.append((n.start_end, n.end, s))
    edits.sort()
    out, pos = [], 0
    for a, b, s in edits:
        if a < pos: raise SystemExit(f"{rel}: overlapping edits at {a}")
        out.append(text[pos:a]); out.append(s); pos = b
    out.append(text[pos:])
    if missing: raise SystemExit(f"{rel}: keys missing from the {LANG} dictionaries: {sorted(missing)}")
    result = share_block(rel, "".join(out), title or "", "\r\n" if "\r\n" in text else "\n")
    return text, result


def main():
    check = "--check" in sys.argv
    stale = []
    for rel in PAGES:
        if not (ROOT / rel).exists(): continue
        old, new = render(rel)
        if old != new:
            stale.append(rel)
            if not check:
                with open(ROOT / rel, "w", encoding="utf-8", newline="") as f: f.write(new)
    sitemap = ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
               "".join(f"  <url><loc>{page_url(r)}</loc></url>\n" for r in PAGES if r != "404.html" and (ROOT / r).exists()) +
               "</urlset>\n")
    sm = ROOT / "sitemap.xml"
    if not sm.exists() or sm.read_text(encoding="utf-8") != sitemap:
        stale.append("sitemap.xml")
        if not check: sm.write_text(sitemap, encoding="utf-8", newline="\n")
    if check:
        print("out of date: " + ", ".join(stale) if stale else "all pages up to date")
        sys.exit(1 if stale else 0)
    print(f"rewrote {len(stale)} page(s): " + ", ".join(stale) if stale else "no changes")


if __name__ == "__main__":
    main()
