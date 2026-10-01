#!/usr/bin/env python3
"""Build the Deco Blocks docs site into one self-contained page: site/dist/index.html.

    python3 site/build.py && open site/dist/index.html

Inputs, all under site/:
  src/shell.html        the page frame (header, sidebar, rail, search dialog) with {{placeholders}}
  src/landing.html      the Home page
  src/content.html      the Docs and Under-the-hood pages, and the Prism bundle (copied verbatim)
  src/style.css, src/dark-tokens.css, src/roadmap.css, src/app.js, src/cobogo-defs.svg, src/brand/*.svg
  data/roadmap.json     the Roadmap page, rendered by gen_roadmap.py

Python 3 standard library only. The page's only external requests are the Fontshare and Google
Fonts stylesheets in shell.html.
"""
import json
import pathlib
import re
import sys
import urllib.parse

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "src"
DIST = HERE / "dist"
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True  # no __pycache__ next to the sources
import gen_roadmap  # noqa: E402

content = (SRC / "content.html").read_text(encoding="utf-8")


def balanced_sections(fragment):
    """Top-level <section ...id="..."> blocks in order, balanced on <section> tags."""
    out, pos = [], 0
    while True:
        m = re.compile(r'<section\b[^>]*\bid="([^"]+)"').search(fragment, pos)
        if not m:
            return out
        depth = 0
        for t in re.finditer(r"<(/?)section\b", fragment[m.start():]):
            depth += -1 if t.group(1) else 1
            if depth == 0:
                end = m.start() + t.end()
                end = fragment.index(">", end) + 1
                out.append((m.group(1), fragment[m.start():end]))
                pos = end
                break


def page_fragment(name):
    start = content.index(f'<div class="page" data-page="{name}">')
    nxt = content.find('<div class="page" data-page=', start + 10)
    end = nxt if nxt != -1 else content.index('<script id="syntax-highlighter">')
    return content[start:end]


docs = balanced_sections(page_fragment("docs"))
internals = balanced_sections(page_fragment("internals"))
assert [s for s, _ in docs][:2] == ["architecture", "quickstart"], docs[:2]
assert len(docs) == 19 and len(internals) == 6, (len(docs), len(internals))

prism = re.search(r'<script id="syntax-highlighter">.*?</script>', content, re.S).group(0)
assert "MIT LICENSE" in prism, "keep the Prism license notice in the bundle"

# ------------------------------------------------------------------ roadmap page
# The fourth page ("Roadmap", the next major's to-do list) is rendered by gen_roadmap.py from
# data/roadmap.json; its styles are src/roadmap.css. The sidebar groups in app.js list these ids,
# so all of them must be present.
ROADMAP_IDS = gen_roadmap.SEC_IDS
roadmap_html = gen_roadmap.render().strip()
roadmap_ids = [s for s, _ in balanced_sections(roadmap_html)]
assert roadmap_ids == ROADMAP_IDS, ("roadmap sections differ from the sidebar's", roadmap_ids)
clash = sorted(set(roadmap_ids) & {s for s, _ in docs + internals})
assert not clash, ("roadmap section ids collide with doc ids", clash)
roadmap_css = (SRC / "roadmap.css").read_text(encoding="utf-8")

# ------------------------------------------------------------------ icons
P = 'fill="none" stroke="currentColor" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"'
ICON_PATHS = {
    "search": '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    "sun": '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    "moon": '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    "menu": '<path d="M4 8h16M4 16h16"/>',
    "x": '<path d="M18 6 6 18M6 6l12 12"/>',
    "copy": '<rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    "check": '<path d="M20 6 9 17l-5-5"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
    "arrow-left": '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    "arrow-up": '<path d="M12 19V5M6 11l6-6 6 6"/>',
    "file": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
    "link": '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    "printer": '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
    "list": '<path d="M3 6h18M3 12h12M3 18h15"/>',
    "git-commit": '<circle cx="12" cy="12" r="3"/><path d="M3 12h6M15 12h6"/>',
    "git-branch": '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    "pencil": '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    "play": '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5 3.5-5 3.5Z"/>',
    "box": '<path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    "sliders": '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5"/>',
    "globe": '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 3.6 9A14 14 0 0 1 12 21a14 14 0 0 1-3.6-9A14 14 0 0 1 12 3Z"/>',
    "book": '<path d="M3 4.5h6a3 3 0 0 1 3 3V20a2.5 2.5 0 0 0-2.5-2.5H3ZM21 4.5h-6a3 3 0 0 0-3 3V20a2.5 2.5 0 0 1 2.5-2.5H21Z"/>',
    "layers": '<path d="m12 2.5 9.5 5-9.5 5-9.5-5Z"/><path d="m2.5 12 9.5 5 9.5-5M2.5 16.5l9.5 5 9.5-5"/>',
    "server": '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
    "cpu": '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9.5 9.5h5v5h-5zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    "hash": '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    "code": '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    "terminal": '<path d="m4 17 6-5-6-5M12 19h8"/>',
    "sparkle": '<path d="M12 3.5 13.9 10 20.5 12l-6.6 2L12 20.5 10.1 14 3.5 12l6.6-2Z"/>',
    "eye": '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    "lock": '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    "zap": '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
    "corner": '<path d="m9 10-5 5 5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
    "cloud": '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    "smartphone": '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
    "plus": '<path d="M12 5v14M5 12h14"/>',
}
GITHUB = ('<svg class="icon i-github" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>')


# Filled monochrome marks for the stack strip, drawn like the site's (fill: currentColor, 18px).
# Next.js and the git diamond are the site's own paths; the others are simple filled glyphs.
MARKS = {
    "nextjs": '<path d="M18.665 21.978C16.758 23.255 14.465 24 12 24 5.377 24 0 18.623 0 12S5.377 0 12 0s12 5.377 12 12c0 3.583-1.574 6.801-4.067 9.001L9.219 7.2H7.2v9.596h1.615V9.251l9.85 12.727Zm-3.332-8.533 1.6 2.061V7.2h-1.6v6.245Z"/>',
    "git": '<path d="M23.546 10.93L13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187"/>',
    "cloudflare": '<circle cx="6.6" cy="15" r="5"/><circle cx="13.2" cy="10.6" r="7"/><circle cx="19" cy="15.5" r="4.5"/><rect x="6.6" y="14" width="12.4" height="6"/>',
    "tanstack": '<path d="M12 1.8 22.2 7 12 12.2 1.8 7Z"/><path d="M1.8 11.1 12 16.3l10.2-5.2v2.6L12 18.9 1.8 13.7Z"/><path d="M1.8 16.2 12 21.4l10.2-5.2v2.6L12 24 1.8 18.8Z"/>',
    "react": '<circle cx="12" cy="12" r="2.2"/><g fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="12" rx="10.5" ry="4.1"/><ellipse cx="12" cy="12" rx="10.5" ry="4.1" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10.5" ry="4.1" transform="rotate(120 12 12)"/></g>',
    "node": '<path d="M12 .8 21.7 6.4v11.2L12 23.2 2.3 17.6V6.4Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
}


def svg_mark(name):
    return (f'<svg class="mark m-{name}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">'
            f'{MARKS[name]}</svg>')


def svg_icon(name, width="1.75"):
    if name == "github":
        return GITHUB
    return (f'<svg class="icon i-{name}" viewBox="0 0 24 24" {P.format(w=width)} aria-hidden="true" focusable="false">'
            f'{ICON_PATHS[name]}</svg>')


# ------------------------------------------------------------------ brand
def brand(name, cls):
    s = (SRC / "brand" / name).read_text(encoding="utf-8")
    s = re.sub(r"\s+", " ", s).strip()
    s = s.replace("> <", "><")
    s = re.sub(r'<svg[^>]*?viewBox="([^"]+)"[^>]*>',
               lambda m: f'<svg class="{cls}" viewBox="{m.group(1)}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">', s, count=1)
    s = s.replace(" />", "/>")
    return s


wordmark = brand("wordmark-on-light.svg", "wm wm-light") + brand("wordmark-on-dark.svg", "wm wm-dark")
# Both variants of the "d" symbol; CSS shows the one that matches the theme (like the wordmark).
symbol = brand("symbol-on-light.svg", "sym sym-light") + brand("symbol-on-dark.svg", "sym sym-dark")
fav = re.sub(r"\s+", " ", (SRC / "brand" / "favicon.svg").read_text(encoding="utf-8")).strip()
# Single quotes inside the SVG and everything else percent-encoded, so the data URI
# can sit inside a double-quoted href without ending the attribute early.
favicon = "data:image/svg+xml," + urllib.parse.quote(fav.replace('"', "'"), safe="=:/'")
assert '"' not in favicon


def fill_icons(text):
    text = re.sub(r"\{\{mark:([\w-]+)\}\}", lambda m: svg_mark(m.group(1)), text)
    return re.sub(r"\{\{icon:([\w-]+)\}\}", lambda m: svg_icon(m.group(1)), text)


css = (SRC / "style.css").read_text(encoding="utf-8")
dark = (SRC / "dark-tokens.css").read_text(encoding="utf-8").strip()
dark = "\n".join("    " + line for line in dark.splitlines())
css = css.replace("{{dark_tokens}}", dark)
# Print always uses the light palette, so the light :root token list is repeated
# inside @media print (where it also beats the automatic dark block).
light = re.search(r"^:root \{\n(.*?)^\}", css, re.S | re.M).group(1)
light = re.sub(r"/\*.*?\*/", "", light)
light = "\n".join("  " + l for l in light.splitlines() if l.strip())
css = css.replace("{{light_tokens}}", light)


# ------------------------------------------------------------------ size
# The page is one file with a size budget, so our own CSS, JS and HTML are compacted here.
# Only whitespace and comments go: quoted strings and url() are set aside first, and nothing
# frozen (doc sections, Prism) passes through these functions.
def min_css(text):
    kept = []

    def keep(m):
        kept.append(m.group(0))
        return f"\x00{len(kept) - 1}\x00"

    text = re.sub(r'"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|url\([^)]*\)', keep, text)
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s*([{};,>])\s*", r"\1", text)  # never around + ~ - (calc, combinators)
    text = re.sub(r":\s+", ":", text)  # "prop: value" and "(min-width: 640px)"; selectors never have a space after ':'
    text = text.replace(";}", "}").strip()
    assert "\x00" not in "".join(kept)
    return re.sub(r"\x00(\d+)\x00", lambda m: kept[int(m.group(1))], text)


def min_js(text):
    """Drop whole-line comments and indentation. app.js has no multi-line strings or
    template literals (asserted), so no line break or indent inside a string is touched."""
    assert text.count("`") == len(re.findall(r"^\s*//.*`.*`", text, re.M)) * 2, "template literal in app.js"
    text = re.sub(r"^[ \t]*/\*(?:(?!\*/)[\s\S])*\*/[ \t]*\n", "", text, flags=re.M)
    text = re.sub(r"^[ \t]*//.*\n", "", text, flags=re.M)
    return re.sub(r"^[ \t]+", "", text, flags=re.M)


def min_html(text):
    """Indentation outside <pre> only (a newline still separates inline elements)."""
    parts = re.split(r"(<pre\b[\s\S]*?</pre>)", text)
    return "".join(p if p.startswith("<pre") else re.sub(r"\n[ \t]+", "\n", p) for p in parts)


css = min_css(css)
roadmap_css = min_css(roadmap_css)

js = min_js((SRC / "app.js").read_text(encoding="utf-8"))
icons_for_js = {n: svg_icon(n) for n in ["link", "copy", "check", "file", "arrow-left", "arrow-right", "play", "box", "sliders", "globe", "book", "layers", "server", "cpu", "hash", "code", "terminal", "printer", "search", "corner", "list", "zap", "pencil", "git-branch", "eye"]}
js = js.replace("{{icons_json}}", json.dumps(icons_for_js, separators=(",", ":")))

wordmark_lime = brand("wordmark-on-dark.svg", "wm wm-lime")
landing = (fill_icons((SRC / "landing.html").read_text(encoding="utf-8"))
           .replace("{{wordmark_dark}}", wordmark_lime).replace("{{wordmark}}", wordmark).replace("{{symbol}}", symbol))

fm = re.search(r"\n\s*<footer class=\"site-footer\">.*?</footer>\n", landing, re.S)
assert fm, "site footer not found in landing"
site_footer = min_html(fm.group(0).strip())
landing = min_html(landing[: fm.start()] + "\n" + landing[fm.end():])

shell = min_html((SRC / "shell.html").read_text(encoding="utf-8"))
out = (shell
       .replace("{{favicon}}", favicon)
       .replace("{{cobogo}}", (SRC / "cobogo-defs.svg").read_text(encoding="utf-8").strip())
       .replace("{{wordmark}}", wordmark)
       .replace("{{landing}}", landing.strip())
       .replace("{{site_footer}}", site_footer)
       .replace("{{docs}}", "\n\n".join(frag for _, frag in docs))
       .replace("{{internals}}", "\n\n".join(frag for _, frag in internals))
       .replace("{{roadmap}}", roadmap_html))
out = fill_icons(out)
# Frozen pieces and code go in last, so no placeholder expansion can touch them.
out = out.replace("{{css}}", css).replace("{{roadmap_css}}", roadmap_css).replace("{{prism}}", prism).replace("{{js}}", js)

assert "<main" not in out[: out.index('<main id="main"')], "stray <main before main"
assert "</main>" not in out[out.index("</main>") + 7:], "stray </main> after main"
left = re.findall(r"\{\{(?:css|js|prism|landing|site_footer|docs|internals|roadmap|roadmap_css|favicon|wordmark|cobogo|dark_tokens|light_tokens|icons_json|icon:[\w-]+|mark:[\w-]+)\}\}", out)
assert not left, left[:5]

DIST.mkdir(exist_ok=True)
(DIST / "index.html").write_text(out, encoding="utf-8")
print(f"wrote {DIST / 'index.html'}  {len(out.encode()) / 1024:.1f} KB  docs={len(docs)} internals={len(internals)} roadmap={len(roadmap_ids)}")
