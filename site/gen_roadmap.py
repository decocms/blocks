#!/usr/bin/env python3
"""Render the Roadmap page of the Deco Blocks docs site from data/roadmap.json.

The Roadmap is the to-do list for the next major. Everything it shows comes from
data/roadmap.json (see README.md for the format); this script holds the page's structure, its
framing sentences and its self-checks, and fails loudly when the data doesn't hold together
(unknown ids, broken links, counts that disagree with the copy).

Nothing on the roadmap is done yet, so every to-do renders unchecked. The boxes are drawn by CSS
and are not interactive: a checklist kept in one reader's browser would look shared and isn't.

Output: a run of top-level <section class="doc-section"> blocks plus one small inline <script>
(feature chips, back-links, and the status/site filter of the feature list). build.py imports
this module and calls render(); run alone, it checks the data and prints a summary:

    python3 site/gen_roadmap.py [--out FILE]
"""
import argparse
import html
import json
import pathlib
import re
import sys
import unicodedata
from collections import Counter

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / "data" / "roadmap.json"
SRC = HERE / "src"

# The page's sections, in order. app.js's sidebar groups list these ids.
SEC_IDS = ["roadmap", "roadmap-blockers", "roadmap-studio-new", "roadmap-studio-legacy", "roadmap-api", "roadmap-cli",
           "roadmap-platform", "roadmap-docs", "roadmap-storefront", "roadmap-blog", "roadmap-faststore", "roadmap-features"]
# Work-item groups -> their sections.
GROUP_SEC = {"api": "roadmap-api", "cli": "roadmap-cli", "studio": "roadmap-platform", "docs": "roadmap-docs"}
# Status id -> the one-letter hook the styles colour by (data-v="..." in roadmap.css).
VC = {"to-build": "g", "to-finish": "p", "site-code": "a", "done": "c", "goes-away": "n"}
# Statuses that count as open work (the "Open work" effort tally).
OPEN = {"to-build", "to-finish", "site-code"}
# Site-step kinds. The site-migration lede below names these labels.
KIND = {"now": "Fix now", "pre": "Before migrating", "blocker": "Blocker", "work": "Site work", "content": "Content", "fix": "Note"}
EFF_RANK = {"L": 0, "M": 1, "S": 2}
# The page says "the ten release blockers" in several places.
N_BLOCKERS = 10


class DataError(SystemExit):
    pass


def check(cond, msg):
    if not cond:
        raise DataError(f"gen_roadmap: {msg}")


def esc(s):
    return html.escape(str(s), quote=True)


def slug(text):
    """Same rule as app.js's slugify, applied to plain text."""
    t = unicodedata.normalize("NFKD", re.sub(r"<[^>]+>", "", html.unescape(text)).lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-") or "section"


def plain(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s))


def md(s):
    """Escape, then `code` and [label](#id) links (the feature summaries)."""
    s = esc(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    return re.sub(r"\[([^\]]+)\]\(#([a-z0-9-]+)\)", r'<a href="#\2">\1</a>', s)


def site_ids():
    """Ids and section labels of the rest of the site (Docs, Under the hood, landing, shell): the
    Roadmap links into the docs by these ids, and its own ids must not collide with them."""
    content = (SRC / "content.html").read_text(encoding="utf-8")
    labels = {m.group(1): html.unescape(m.group(2))
              for m in re.finditer(r'<section id="([^"]+)" data-nav="([^"]+)"', content)}
    # Both pages' first sections are "Overview" in the sidebar, so the Under-the-hood one gets its page name.
    labels["internals"] = "Under the hood"
    ids = set()
    for name in ("content.html", "landing.html", "shell.html", "cobogo-defs.svg"):
        ids |= set(re.findall(r'\bid="([^"]+)"', (SRC / name).read_text(encoding="utf-8")))
    return labels, ids


# The Feature readiness filter, chips and back-links. Kept inline so the fragment is self-contained.
SCRIPT = """<script>
(function () {
  var page = document.querySelector('.page[data-page="roadmap"]');
  if (!page) return;
  var byId = function (id) { return document.getElementById(id); };
  var sec = byId('roadmap-features');
  // Chips: each id becomes a link to its row, named from the row (with its status for screen
  // readers). Rows collect the reverse links: the release blockers and work items whose chips name them.
  var back = {};
  [].forEach.call(page.querySelectorAll('.gx-chips[data-f]'), function (box) {
    var h = box.previousElementSibling, s = box.closest('section');
    while (h && h.tagName !== 'H3') h = h.previousElementSibling;
    var src = h && s && /^roadmap-(blockers|api|cli|platform|docs)$/.test(s.id) ? h : null;
    box.getAttribute('data-f').split(' ').forEach(function (id) {
      var row = byId('roadmap-f-' + id), a = document.createElement('a'), sr = document.createElement('span');
      if (!row) return;
      a.href = '#roadmap-f-' + id; a.setAttribute('data-v', row.getAttribute('data-v'));
      sr.className = 'sr-only'; sr.textContent = row.querySelector('.gx-vp').textContent + ': ';
      a.append(sr, row.querySelector('h4').textContent);
      box.appendChild(a);
      if (src) (back[id] = back[id] || []).push(src);
    });
  });
  Object.keys(back).forEach(function (id) {
    var p = document.createElement('p');
    p.className = 'gx-fx-c';
    back[id].forEach(function (h) {
      var a = document.createElement('a'), n = h.querySelector('.gx-n'), t = h.querySelector('span:not(.gx-n)');
      a.href = '#' + h.id;
      if (n) { a.textContent = 'Blocker ' + n.textContent; a.title = t.textContent; } else a.innerHTML = t.innerHTML;
      p.append(a, ' ');
    });
    byId('roadmap-f-' + id).lastElementChild.appendChild(p);
  });
  var bar = sec && sec.querySelector('.gx-filter');
  if (!bar) return;
  var rows = [].slice.call(sec.querySelectorAll('.gx-fx > li'));
  var lists = [].slice.call(sec.querySelectorAll('.gx-fx'));
  var btns = [].slice.call(bar.querySelectorAll('button[data-fk]'));
  var count = bar.querySelector('.gx-fcount');
  var state = { v: '', s: '' };
  rows.forEach(function (li) { var st = li.querySelector('.gx-st'); li._s = ' ' + (st ? st.textContent.split(' \\u00b7 ').join(' ') : '') + ' '; });
  function hit(li, k, val) { return !val || (k === 'v' ? li.getAttribute('data-v') === val : li._s.indexOf(' ' + val + ' ') > -1); }
  function apply() {
    var shown = 0;
    rows.forEach(function (li) { var on = hit(li, 'v', state.v) && hit(li, 's', state.s); li.hidden = !on; if (on) shown++; });
    // A category with no matching rows hides whole: heading, description and list.
    lists.forEach(function (ul) {
      var off = !ul.querySelector('li:not([hidden])'), d = ul.previousElementSibling, h = d && d.previousElementSibling;
      ul.hidden = off; if (d) d.hidden = off; if (h && h.tagName === 'H3') h.hidden = off;
    });
    // Each button counts the rows it would show, given the other filter.
    btns.forEach(function (b) {
      var k = b.getAttribute('data-fk'), val = b.getAttribute('data-fv'), o = k === 'v' ? 's' : 'v', n = b.querySelector('span');
      b.setAttribute('aria-pressed', String(val === state[k]));
      if (n) n.textContent = rows.filter(function (li) { return hit(li, k, val) && hit(li, o, state[o]); }).length;
    });
    count.textContent = shown === rows.length ? 'Showing all ' + shown + ' features' : shown ? 'Showing ' + shown + ' of ' + rows.length + ' features' : 'No feature matches both filters';
    document.dispatchEvent(new CustomEvent('roadmap:filter'));
  }
  bar.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-fk]');
    if (!b) return;
    state[b.getAttribute('data-fk')] = b.getAttribute('data-fv'); apply();
  });
  // "See where the N features it uses stand": preset the site filter, then let the link navigate.
  page.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-gx-site]');
    if (a) { state.v = ''; state.s = a.getAttribute('data-gx-site'); apply(); }
  });
  // A link to something the filter hides clears the filter first, so the router scrolls to it.
  // Both listeners run before the router's: the click one (capture) also covers a link to the
  // current hash, which fires no hashchange; hashchange covers back and forward.
  function unhide(id) {
    try { id = decodeURIComponent(id); } catch (err) {}
    var el = id && byId(id);
    if (el && sec.contains(el) && el.closest('[hidden]')) { state.v = ''; state.s = ''; apply(); }
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#roadmap"]');
    if (a) unhide(a.getAttribute('href').slice(1));
  }, true);
  window.addEventListener('hashchange', function () { unhide(location.hash.slice(1)); });
  bar.hidden = false;
  apply();
})();
</script>"""


class Roadmap:
    def __init__(self, data):
        self.doc_label, self.site_ids = site_ids()
        self.load(data)

    # ------------------------------------------------------------------ data
    def load(self, d):
        # Statuses, in rank order (Feature readiness sorts by this order).
        self.VERDICTS = [s["id"] for s in d["statuses"]]
        check(self.VERDICTS == list(VC), f"statuses must be {list(VC)} in that order, got {self.VERDICTS}")
        st = {s["id"]: s for s in d["statuses"]}
        self.VLABEL = {v: st[v]["label"] for v in self.VERDICTS}
        self.VWORD = {v: st[v]["word"] for v in self.VERDICTS}
        self.VWORD1 = {v: st[v]["word_one"] for v in self.VERDICTS}
        self.TILE = {v: st[v]["tile"] for v in self.VERDICTS}
        self.LEGEND = {v: st[v]["legend"] for v in self.VERDICTS}

        self.SEC = {s["id"]: s for s in d["sections"]}
        check([s["id"] for s in d["sections"]] == SEC_IDS, "sections must list the page's section ids in order")
        for s in d["sections"]:
            check(s.get("nav") and s.get("eyebrow"), f"section {s['id']} needs nav and eyebrow")
            self.check_title(s["title"], f"section {s['id']}")

        self.CATS = d["categories"]
        cat_ids = [c["id"] for c in self.CATS]
        self.FEATS = d["features"]
        self.REPOS = [s["id"] for s in d["sites"]]
        for fid, f in self.FEATS.items():
            check(f["category"] in cat_ids, f"feature {fid}: unknown category {f['category']!r}")
            check(f["status"] in VC, f"feature {fid}: unknown status {f['status']!r}")
            check(f["effort"] in EFF_RANK, f"feature {fid}: effort must be L, M or S")
            check(f["sites"] and set(f["sites"]) <= set(self.REPOS), f"feature {fid}: unknown sites {f['sites']}")
            for k in ("first_rated", "rated_before_review"):
                check(f[k] is None or f[k] in VC, f"feature {fid}: {k} must be a status id or null")
            bad = [x for x in f["docs"] if x not in self.doc_label]
            check(not bad, f"feature {fid}: docs ids not found in src/content.html: {bad}")
            # Every feature names at least one part of these docs.
            check(f["docs"], f"feature {fid}: no docs ids")
        self.TOTALS = dict(self.counts(list(self.FEATS)))
        self.REPO_IDS = {r: [fid for fid in self.FEATS if r in self.FEATS[fid]["sites"]] for r in self.REPOS}

        self.SHORT = {s["id"]: s["short"] for s in d["sites"]}
        # The name the page shows for a site (bars, the intro's links, the site filter's tooltip).
        self.NAME = {s["id"]: s["name"] for s in d["sites"]}
        self.SITE_SEC = {s["id"]: s["section"] for s in d["sites"]}
        check(list(self.SITE_SEC.values()) == ["roadmap-storefront", "roadmap-blog", "roadmap-faststore"],
              "sites must map, in order, to the roadmap-storefront, roadmap-blog and roadmap-faststore sections")
        self.REPO_DESC = {s["id"]: s["description"] for s in d["sites"]}

        # Every to-do has an explicit id (its anchor); titles are looked up by id for links.
        self.TITLE = {}

        def reg(item, prefix, what):
            check(item["id"].startswith(prefix + "--"), f"{what} {item['id']!r} must start with {prefix}--")
            check(item["id"] not in self.TITLE, f"duplicate id {item['id']!r}")
            self.check_title(item["title"], f"{what} {item['id']}")
            self.check_features(item["features"], f"{what} {item['id']}")
            self.TITLE[item["id"]] = item["title"]

        self.TOP = d["blockers"]
        for b in self.TOP:
            reg(b, "roadmap-blockers", "blocker")
        check(len(self.TOP) == N_BLOCKERS, f"the page says 'ten release blockers'; the data has {len(self.TOP)}")
        self.STUDIO_NEW, self.STUDIO_LEGACY = d["studio_new"], d["studio_legacy"]
        for x in self.STUDIO_NEW:
            reg(x, "roadmap-studio-new", "Studio item")
        for x in self.STUDIO_LEGACY:
            reg(x, "roadmap-studio-legacy", "Studio item")
        self.CHANGES = d["work_items"]
        for c in self.CHANGES:
            check(c["group"] in GROUP_SEC, f"work item {c['id']}: unknown group {c['group']!r}")
            reg(c, GROUP_SEC[c["group"]], "work item")
            bad = [x for x in c["docs"] if x not in self.doc_label]
            check(not bad, f"work item {c['id']}: docs ids not found in src/content.html: {bad}")
        self.WORK = {c["id"]: c for c in self.CHANGES}
        self.PLAN, self.STEP = {}, {}  # step id -> (site, step number, step)
        for s in d["sites"]:
            self.PLAN[s["id"]] = s["steps"]
            for n, step in enumerate(s["steps"], 1):
                reg(step, s["section"], "site step")
                check(step["kind"] in KIND, f"site step {step['id']}: unknown kind {step['kind']!r}")
                # A Note with nothing to do (the migration removes it) is drawn without a box and isn't counted.
                check(not step["no_action"] or step["kind"] == "fix", f"site step {step['id']}: only a Note can carry no action")
                self.STEP[step["id"]] = (s["id"], n, step)

        # Work items delivering each blocker (each is one part of it, not all of it), and back.
        self.CLEARS = {}
        for i, b in enumerate(self.TOP, 1):
            for k in b["delivered_by"]:
                check(k in self.WORK, f"blocker {b['id']}: delivered_by {k!r} is not a work item")
                self.CLEARS.setdefault(k, []).append(i)
        # Studio items point to work items or site steps; a pointer must share at least one feature with the item.
        for x in self.STUDIO_NEW + self.STUDIO_LEGACY:
            for ref in x["delivered_by"]:
                check(ref in self.WORK or ref in self.STEP, f"Studio item {x['id']}: delivered_by {ref!r} is not a work item or site step")
                ids = self.WORK[ref]["features"] if ref in self.WORK else self.STEP[ref][2]["features"]
                check(set(ids) & set(x["features"]), f"Studio item {x['id']}: {ref!r} shares no feature with it")

        # {{item:ID}} in any HTML field becomes a link to that to-do, named by its current title.
        def expand(s):
            def one(m):
                check(m.group(1) in self.TITLE, f"{{{{item:{m.group(1)}}}}} names no to-do")
                return f'<a href="#{m.group(1)}">{self.TITLE[m.group(1)]}</a>'
            return re.sub(r"\{\{item:([a-z0-9-]+)\}\}", one, s)

        for b in self.TOP:
            b["today"], b["plan"] = expand(b["today"]), expand(b["plan"])
        for x in self.STUDIO_NEW + self.STUDIO_LEGACY:
            x["today"] = expand(x["today"])
        for c in self.CHANGES:
            c["plan"] = expand(c["plan"])
        for s in d["sites"]:
            for step in s["steps"]:
                step["text"] = expand(step["text"])
        self.HEADLINE = {s["id"]: expand(s["headline"]) for s in d["sites"]}
        self.OV = {k: expand(v) for k, v in d["overview"].items()}

    def check_title(self, t, where):
        # Titles are HTML: plain text, entities and <code> only.
        rest = re.sub(r"</?code>", "", t)
        check(t.strip() == t and t, f"{where}: empty title or stray whitespace")
        check(not re.search(r"[<>]|&(?!(?:amp|lt|gt|quot|#\d+);)", rest), f"{where}: title has markup other than <code>: {t!r}")

    def check_features(self, ids, where):
        bad = [i for i in ids if i not in self.FEATS]
        check(ids and not bad, f"{where}: unknown or missing feature ids {bad}")

    # ------------------------------------------------------------------ helpers
    def counts(self, ids):
        c = Counter(self.FEATS[i]["status"] for i in ids)
        return [(v, c.get(v, 0)) for v in self.VERDICTS]

    def vword(self, v, n):
        return self.VWORD1[v] if n == 1 else self.VWORD[v]

    def vq(self, v):
        return f"“{self.VWORD1[v]}”"

    def clink(self, k):
        return f'<a href="#{k}">{self.TITLE[k]}</a>'

    def section(self, sid, body, cls="", count=None):
        """A page section. Its eyebrow carries the section's honest count ("24 to do")."""
        s = self.SEC[sid]
        eb = esc(s["eyebrow"]) + (f'<span class="rm-count">{count}</span>' if count else "")
        return (f'<section id="{sid}" data-nav="{esc(s["nav"])}" class="doc-section gx-sec{(" " + cls) if cls else ""}" aria-labelledby="{sid}-title">\n'
                f'<p class="eyebrow">{eb}</p><h2 id="{sid}-title">{s["title"]}</h2>\n{body}\n</section>')

    def vpill(self, v, own=True):
        """Status pill. Inside an element that already carries data-v, own=False."""
        return f'<b class="gx-vp"{f" data-v={chr(34)}{VC[v]}{chr(34)}" if own else ""}>{self.VLABEL[v]}</b>'

    def chips(self, ids):
        """Feature chips. To keep the single-file page small, the ids are listed once and the
        inline script at the end expands each into <a href="#roadmap-f-ID" data-v=..>Name</a>, reading
        the name and status from that feature's row (static HTML). The "Features" label is CSS."""
        return f'<div class="gx-chips" data-f="{" ".join(ids)}"></div>'

    def site_tags(self, repos):
        return f'<span class="gx-st">{" · ".join(self.SHORT[r] for r in repos)}</span>' if repos else ""

    def sites_of(self, ids):
        return [r for r in self.REPOS if any(r in self.FEATS[x]["sites"] for x in ids)]

    # .rm-sr is visually hidden (roadmap.css) and left out of the search index (app.js).
    SR_TODO = '<span class="rm-sr">To do</span>'

    @staticmethod
    def todo_h3(hid, title_html, n=None):
        """A to-do's heading. The unchecked box is CSS (h3::before, decorative); the item's first
        child says "To do" to screen readers. A number and the title sit in two spans side by side,
        so a title that wraps hangs under its own first line."""
        num = f'<span class="gx-n">{n:02d}</span> ' if n else ""
        return f'<h3 id="{hid}">{num}<span>{title_html}</span></h3>'

    @staticmethod
    def detail(rows):
        """Today / Plan (and link rows) as a description list. rows: (label, html). The Today row carries
        a class: it sits on the plain surface, and the rows after it on a fill (roadmap.css). Link-run rows
        (any label but Today and Plan) mark their dd, so roadmap.css can space the links apart."""
        return '<dl class="gx-wf">' + "".join(
            f'<div{" class=" + chr(34) + "rm-t" + chr(34) if lab == "Today" else ""}><dt>{lab}</dt><dd{"" if lab in ("Today", "Plan") else " class=" + chr(34) + "rm-links" + chr(34)}>{body}</dd></div>'
            for lab, body in rows) + "</dl>"

    def todo_li(self, h3, *parts, note=False):
        """A to-do (box drawn by CSS), or with note=True a note with nothing to do (no box, "Note" to screen readers)."""
        head = '<li class="rm-note"><span class="rm-sr">Note</span>' if note else f"<li>{self.SR_TODO}"
        return head + h3 + "".join(p for p in parts if p) + "</li>"

    def legend(self, ids):
        return "".join(f'<span class="gx-lg" data-v="{VC[v]}"><b>{n}</b> {self.vword(v, n)}</span>' for v, n in self.counts(ids) if n)

    def key(self):
        # The colour key for chip dots (the to-build marker is a diamond, so the key doesn't rely on colour alone).
        return "".join(f'<span class="gx-lg" data-v="{VC[v]}">{self.vword(v, 1)}</span>' for v in self.VERDICTS if self.TOTALS[v])

    def open_work(self, ids):
        eff = Counter(self.FEATS[i]["effort"] for i in ids if self.FEATS[i]["status"] in OPEN)
        return f'Open work: <b>{eff.get("L", 0)}</b> L · <b>{eff.get("M", 0)}</b> M · <b>{eff.get("S", 0)}</b> S'

    def bar_row(self, label_html, ids, desc=""):
        cs = [(v, n) for v, n in self.counts(ids) if n]
        aria = ", ".join(f"{n} {self.vword(v, n)}" for v, n in cs)
        segs = "".join(f'<i data-v="{VC[v]}" style="--n:{n}"></i>' for v, n in cs)
        return (f'<div class="gx-barrow"><p class="gx-bar-h">{label_html}<span>{len(ids)} features</span></p>'
                f'<div class="gx-bar" role="img" aria-label="{esc(plain(label_html))}: {aria}">{segs}</div>'
                f'<p class="gx-bar-l">{self.legend(ids)}<span class="gx-ow" title="Effort of the features to build, to finish and left to site code">{self.open_work(ids)}</span></p>'
                + (f'<p class="gx-bar-d">{desc}</p>' if desc else "") + "</div>")

    def legend_p(self):
        # The status legend: a short definition list, one status per line, each label with its status marker (CSS).
        items = "".join(f'<div><dt><b class="gx-lg" data-v="{VC[v]}">{self.VLABEL[v]}</b></dt><dd>{self.LEGEND[v]}</dd></div>'
                        for v in self.VERDICTS)
        return f'<dl class="rm-legend" aria-label="Statuses">{items}</dl>'

    def ref_link(self, ref):
        """A link to a work item or, with the site and step number, to a site step."""
        if ref in self.STEP:
            r, n, st = self.STEP[ref]
            return f'<span class="rm-sref"><a href="#{st["id"]}">{st["title"]}</a> <span class="rm-ref">({self.SHORT[r]} step {n})</span></span>'
        return self.clink(ref)

    def blocker_lede(self):
        all_sites = all(self.sites_of(g["features"]) == self.REPOS for g in self.TOP)
        return ("Ranked by blast radius, the assessment's judgment of how much each one blocks, so the order doesn't follow the "
                "feature count shown beside each." + (" Every one hits all three sites." if all_sites else ""))

    # ------------------------------------------------------------------ 1 · overview
    def overview(self):
        n, T = len(self.FEATS), self.TOTALS
        intro, lead = self.OV["intro"].strip(), self.OV["readiness_lead"].strip()
        # The intro and the readiness line are copy; fail if the numbers or links move under them.
        R = self.REPOS
        for s in (*(f'<a href="#{self.SITE_SEC[r]}">{self.NAME[r]}</a>' for r in R),
                  'The <a href="#roadmap-blockers">ten release blockers</a> gate the release',
                  '<a href="#roadmap--release-readiness">Release readiness</a>'):
            check(s in intro, f"overview.intro must contain {s!r}")
        for s in (f"None of the {n} features", f"{T['to-build']} are still to build", f"{T['to-finish']} are to finish",
                  f"{T['site-code']} are left to site code", f"{T['goes-away']} go away"):
            check(s in lead, f"overview.readiness_lead must contain {s!r} (the counts come from the features)")
        tiles = "".join(f'<li data-v="{VC[v]}"><span class="gx-tile-n">{T[v]}</span>{self.vpill(v, False)}<span class="gx-tile-d">{esc(self.TILE[v])}</span></li>'
                        for v in self.VERDICTS)
        bars = self.bar_row("<b>All three sites</b>", list(self.FEATS)) + "".join(
            self.bar_row(f'<a href="#{self.SITE_SEC[r]}"><b>{self.NAME[r]}</b></a>', self.REPO_IDS[r], f"<span>{self.REPO_DESC[r]}</span> {self.HEADLINE[r]}")
            for r in self.REPOS)
        top = "".join(
            f'<li><span class="rm-sr">To do: </span><a href="#{g["id"]}">{g["title"]}</a><span class="gx-tl-s">{len(g["features"])} features</span></li>'
            for g in self.TOP)
        shorts = [f"<b>{self.SHORT[r]}</b>" for r in self.REPOS]
        short_names = ", ".join(shorts[:-1]) + " and " + shorts[-1]
        n_studio = len(self.STUDIO_NEW) + len(self.STUDIO_LEGACY)
        n_steps = sum(len(v) for v in self.PLAN.values())
        # The overview's to-do callouts share one shape: the box, an imperative title that links to the item, then the text.
        # fix_now (a live bug to fix whether or not a site migrates) is optional.
        fix_now = f'<div class="gx-now rm-do"><p><span class="rm-sr">To do: </span>{self.OV["fix_now"]}</p></div>\n' if self.OV.get("fix_now") else ""
        fix_docs = f'<div class="callout warning rm-do"><p><span class="rm-sr">To do: </span>{self.OV["fix_docs"]}</p></div>'
        F = self.FEATS.values()
        n_first = sum(1 for f in F if f["first_rated"])
        n_review = sum(1 for f in F if f["rated_before_review"])
        n_medium = sum(1 for f in F if f["confidence"] != "high")
        n_unv = sum(1 for f in F if f["unconfirmed_sub_claim"])
        body = f"""{intro}
{fix_now}<h3 id="roadmap--the-ten-release-blockers">The ten release blockers</h3>
<p>{self.blocker_lede()} Each links to where it stands today, the plan and the work items that deliver it.</p>
<ol class="gx-toplist">{top}</ol>
<h3 id="roadmap--release-readiness">Release readiness</h3>
<p>{lead}</p>
<ul class="gx-tiles" aria-label="Features by status">{tiles}</ul>
<div class="gx-bars">{bars}</div>
<p class="gx-note">Each bar counts the features in its scope: all three sites, then each site. Open work is the effort of the features to build, to finish and left to site code; effort is the assessor's relative size, S, M or L. Short names on this page: {short_names}.</p>
{fix_docs}
<h3 id="roadmap--using-this-page">Using this page</h3>
<ul class="gx-map">
<li><a href="#roadmap-blockers">Release blockers</a>: the ten items that gate the release, each with where it stands today, the plan and the work items that deliver it.</li>
<li><a href="#roadmap-studio-new">Studio support</a>: what has to work for editors, on a next-major site and with legacy content ({n_studio} items).</li>
<li><a href="#roadmap-api">Work items</a>: {len(self.CHANGES)} changes, deduplicated from the {n} per-feature proposals, in four groups: the API, the CLI, Studio and the Deco API, and these docs.</li>
<li><a href="#roadmap-storefront">Site migrations</a>: each site's plan as a checklist, in execution order ({n_steps} steps).</li>
<li><a href="#roadmap-features">Feature readiness</a>: every feature with its status, effort, sites and a short summary, the parts of these docs it concerns, and the roadmap items that address it. Feature chips anywhere on this page link there.</li>
</ul>
<p>The lists overlap, so their counts don't add up to one total: the release blockers and most Studio items are delivered by work items, and link to them, and several site steps depend on the same work. Nothing is checked off yet; the boxes mark open items and don't track progress.</p>
<p class="small muted">How this list was made: each site's features were catalogued from its code, with file and line evidence, and grouped into {len(self.CATS)} categories. Each feature was then assessed against these docs and verified against Studio's and the framework's code. The verifier changed {n_first} statuses, all toward “to finish”, and a later review changed {n_review} more. {n_medium} of the {n} assessments are medium confidence and the rest are high, and {n_unv} contain a sub-claim the verifier couldn't confirm. Feature readiness marks each of these on its row.</p>"""
        return self.section("roadmap", body)

    # ------------------------------------------------------------------ 2 · release blockers
    def blockers(self):
        lede = (f"<p>{self.blocker_lede()} Each says where things stand today, the plan, and the work items that deliver it; the chips link to "
                "the affected features.</p>")
        all_sites = all(self.sites_of(g["features"]) == self.REPOS for g in self.TOP)
        lis = []
        for i, g in enumerate(self.TOP, 1):
            by = " ".join(self.clink(k) for k in g["delivered_by"]) + (f' <span class="rm-dnote">{g["delivered_note"]}</span>' if g.get("delivered_note") else "")
            rows = [("Today", g["today"]), ("Plan", g["plan"]), ("Delivered by", by)]
            meta = "" if all_sites else f'<p class="gx-meta">{self.site_tags(self.sites_of(g["features"]))}</p>'
            lis.append(self.todo_li(self.todo_h3(g["id"], g["title"], i), meta, self.detail(rows), self.chips(g["features"])))
        return self.section("roadmap-blockers", f'{lede}\n<ol class="rm-list">{"".join(lis)}</ol>', "gx-items", f"{len(self.TOP)} to do")

    # ------------------------------------------------------------------ 3 · studio support
    def studio(self, sid, lede, items):
        # Unnumbered: unlike the blockers and the site plans, the order isn't a ranking.
        lis = [self.todo_li(self.todo_h3(x["id"], x["title"]),
                            self.detail([("Today", x["today"])] + ([("Delivered by", " ".join(self.ref_link(r) for r in x["delivered_by"]))] if x["delivered_by"] else [])),
                            self.chips(x["features"])) for x in items]
        return self.section(sid, f'<p>{lede}</p>\n<ul class="rm-list">{"".join(lis)}</ul>', "gx-items", f"{len(items)} to do")

    # ------------------------------------------------------------------ 4 · work items
    def changes(self, key):
        sid = GROUP_SEC[key]
        # Pinned items first, in data order (the docs items that correct statements that are wrong today);
        # then by how many features need them, ties in data order.
        items = sorted((c for c in self.CHANGES if c["group"] == key),
                       key=lambda c: (0, 0) if c.get("pinned") else (1, -len(c["features"])))
        n_pinned = sum(1 for c in items if c.get("pinned"))
        check(key == "docs" and n_pinned == 2 or key != "docs" and n_pinned == 0,
              "exactly two docs work items are pinned (the docs lede says so), and no other")
        sort = "They're sorted by how many features need them."
        lede = {
            "api": f"{len(items)} changes to the SDK, the bindings and the <code>@decocms/apps-*</code> packages. {sort}",
            "cli": f"{len(items)} changes to the <code>deco</code> CLI's output, codegen and migration tooling. {sort}",
            "studio": f"{len(items)} changes on the Studio side and in the Deco API's release service. {sort}",
            "docs": f"{len(items)} changes to the guides, recipes and reference. Two of them correct statements that are wrong today; they come first, "
                    "and the rest are sorted by how many features need them.",
        }[key]
        lis = []
        for c in items:
            ids = c["features"]
            # How many of the item's features have the status To build, said as part of the feature count,
            # so it doesn't read as the item's own status or as a count of sub-tasks.
            n_build = sum(1 for x in ids if self.FEATS[x]["status"] == "to-build")
            nf = f'{len(ids)} feature{"s" if len(ids) != 1 else ""}'
            if n_build:
                nf += ", to build" if n_build == len(ids) == 1 else f", {n_build} of them to build"
            meta = f'<span class="gx-meta-n">{nf}</span>' + self.site_tags(self.sites_of(ids))
            rows = [("Plan", c["plan"])]
            if c["docs"]:
                rows.append(("In these docs", " ".join(f'<a href="#{x}">{esc(self.doc_label[x])}</a>' for x in c["docs"])))
            if c["id"] in self.CLEARS:
                # One part of the blocker, not all of it: most blockers need two to four work items.
                cl = self.CLEARS[c["id"]]
                rows.append(("Part of blocker" + ("s" if len(cl) > 1 else ""),
                             " ".join(f'<a href="#{self.TOP[i - 1]["id"]}">{self.TOP[i - 1]["title"]}</a>' for i in cl)))
            lis.append(self.todo_li(self.todo_h3(c["id"], c["title"]), f'<p class="gx-meta">{meta}</p>', self.detail(rows), self.chips(ids)))
        body = (f'<p>{lede} A chip\'s dot shows that feature\'s status: <span class="gx-key">{self.key()}</span>.</p>\n'
                f'<ul class="rm-list">{"".join(lis)}</ul>')
        return self.section(sid, body, "gx-items", f"{len(items)} to do")

    # ------------------------------------------------------------------ 5 · site migrations
    def site_plan(self, r):
        sid = self.SITE_SEC[r]
        ids = self.REPO_IDS[r]
        steps = self.PLAN[r]
        n_note = sum(1 for s in steps if s["no_action"])
        parts = [f"<p>{self.HEADLINE[r]}</p>",
                 f'<p class="gx-sitedesc"><span class="gx-meta-k">The site</span>{self.REPO_DESC[r]}</p>',
                 f'<div class="gx-bars">{self.bar_row(f"<b>{self.NAME[r]}</b>", ids)}</div>',
                 "<p>The steps are in execution order, each tagged: <b>Fix now</b> (a live bug, migration or not), <b>Before migrating</b> "
                 "(an upgrade that comes first), <b>Blocker</b> (must be solved before this site can move; separate from the ten release "
                 "blockers), <b>Site work</b>, <b>Content</b> (stored content and data shapes), and <b>Note</b>."
                 + (" A note with nothing to do has no box." if n_note else "") + " "
                 f'<a href="#roadmap-features" data-gx-site="{self.SHORT[r]}">See where the {len(ids)} features it uses stand</a>.</p>']
        lis = [self.todo_li(self.todo_h3(s["id"], s["title"], i), f'<p class="gx-meta"><span class="gx-kind" data-k="{s["kind"]}">{KIND[s["kind"]]}</span></p>',
                            f'<p>{s["text"]}</p>', self.chips(s["features"]), note=s["no_action"])
               for i, s in enumerate(steps, 1)]
        parts.append(f'<ol class="rm-list">{"".join(lis)}</ol>')
        count = f"{len(steps) - n_note} to do" + (f" · {n_note} note" if n_note else "")
        return self.section(sid, "\n".join(parts), "gx-items gx-plan", count)

    # ------------------------------------------------------------------ 6 · feature readiness
    def row_tags(self, f):
        # The earlier statuses are ratings the assessment gave and later corrected, not progress that
        # was undone, so the tags name the rating ("First rated ...") rather than a past state ("Was ...").
        t = ""
        if f["confidence"] != "high":
            t += '<i class="gx-tg">Medium confidence</i>'
        if f["first_rated"]:
            t += f'<i class="gx-tg" title="The assessor\'s first rating; verification against the code changed it">First rated {self.vq(f["first_rated"])}</i>'
        if f["rated_before_review"]:
            t += f'<i class="gx-tg" title="The status a later review changed">Rated {self.vq(f["rated_before_review"])} before review</i>'
        if f["unconfirmed_sub_claim"]:
            t += '<i class="gx-tg" title="Contains a sub-claim the verifier couldn\'t confirm">Unconfirmed sub-claim</i>'
        return t

    def feature_index(self):
        V_RANK = {v: i for i, v in enumerate(self.VERDICTS)}
        T = self.TOTALS
        vbtn = '<span class="gx-fl">Status</span><button type="button" data-fk="v" data-fv="" aria-pressed="true">All statuses</button>' + "".join(
            f'<button type="button" data-fk="v" data-fv="{VC[v]}" aria-pressed="false"><i data-v="{VC[v]}"></i>{self.VLABEL[v]} <span>{T[v]}</span></button>'
            for v in self.VERDICTS if T[v])
        sbtn = '<span class="gx-fl">Site</span><button type="button" data-fk="s" data-fv="" aria-pressed="true">All sites</button>' + "".join(
            f'<button type="button" data-fk="s" data-fv="{self.SHORT[r]}" aria-pressed="false" title="{esc(self.NAME[r])}">{self.SHORT[r]} <span>{len(self.REPO_IDS[r])}</span></button>'
            for r in self.REPOS)
        parts = [
            f"<p>All {len(self.FEATS)} features the three sites use, grouped into {len(self.CATS)} categories, and where each one stands. Within a category, "
            "features to build come first, then those to finish, left to site code and going away, each ordered by effort (L, M, S). Each row "
            "names the parts of these docs the feature concerns and, below that, the release blockers and work items that address it. Feature "
            "chips elsewhere on this page link to these rows.</p>",
            self.legend_p(),
            f'<div class="gx-filter" hidden><div class="gx-fg" role="group" aria-label="Filter by status">{vbtn}</div>'
            f'<div class="gx-fg" role="group" aria-label="Filter by site">{sbtn}</div>'
            f'<p class="gx-fcount" aria-live="polite">Showing all {len(self.FEATS)} features</p></div>']
        for cat in self.CATS:
            ids = [fid for fid, f in self.FEATS.items() if f["category"] == cat["id"]]
            ids.sort(key=lambda x: (V_RANK[self.FEATS[x]["status"]], EFF_RANK[self.FEATS[x]["effort"]], self.FEATS[x]["name"]))
            title = cat["title"]
            rows = []
            for fid in ids:
                f = self.FEATS[fid]
                docs = " ".join(f'<a href="#{x}">{esc(self.doc_label[x])}</a>' for x in f["docs"])
                rows.append(
                    f'<li id="roadmap-f-{fid}" data-v="{VC[f["status"]]}">'
                    f'<h4>{esc(f["name"])}</h4><p class="gx-fx-m">{self.vpill(f["status"], False)}<span>Effort {f["effort"]}</span>{self.site_tags(f["sites"])}{self.row_tags(f)}</p>'
                    f'<div><p>{md(f["summary"])}</p>' + (f'<p class="gx-fx-d">{docs}</p>' if docs else "") + "</div></li>")
            parts.append(
                f'<h3 id="roadmap-features--{slug(title)}">{esc(title)}</h3>\n'
                f'<p class="gx-catd">{len(ids)} feature{"s" if len(ids) != 1 else ""} · {esc(cat["description"])}<span class="gx-catc">{self.legend(ids)}</span></p>\n'
                f'<ul class="gx-fx">{"".join(rows)}</ul>')
        # "Goes away" features can never be done, so the count leaves them out and names them.
        done, gone = T["done"], T["goes-away"]
        return self.section("roadmap-features", "\n".join(parts), "gx-index", f"{done} of {len(self.FEATS) - gone} done · {gone} go away")

    # ------------------------------------------------------------------ assemble
    def render(self):
        secs = [
            self.overview(),
            self.blockers(),
            self.studio("roadmap-studio-new", "What has to work when a migrated site runs against today's Studio. Each item says what happens today and, "
                        "where a work item's plan covers it, which work items deliver it. The chips link to the features it touches.", self.STUDIO_NEW),
            self.studio("roadmap-studio-legacy", "Content and assumptions Studio already has, which the next major has to handle. Each item says what "
                        "happens today and, where the plan covers it, which work items or site steps handle it.", self.STUDIO_LEGACY),
            self.changes("api"), self.changes("cli"), self.changes("studio"), self.changes("docs"),
            *(self.site_plan(r) for r in self.REPOS),
            self.feature_index(),
        ]
        out = "\n\n".join(secs) + "\n\n" + SCRIPT + "\n"
        out = re.sub(r"\n +<", "\n<", out)  # no source indentation: every byte counts in the single-file build
        out = re.sub(r"\n +", "\n", out)
        self.checks(out)
        self.out = out
        return out

    # ------------------------------------------------------------------ checks
    def checks(self, out):
        visible = re.sub(r"<script\b.*?</script>", "", out, flags=re.S)
        text = html.unescape(re.sub(r"<[^>]+>", " ", visible))

        def near(pat):
            return re.findall(r".{0,40}(?:" + pat + r").{0,40}", text, re.I)[:5]

        # Wording: these docs are the spec here, anchors are links not "#ids", and no undefined abbreviations.
        for pat, what in ((r"\bspec\b", "'spec'"), (r"(?<![\w&])#[a-z]", "a bare #anchor"), (r"\b(?:IS|hCMS|ALS)\b|N/A", "an undefined abbreviation")):
            check(not re.search(pat, text, re.I if what == "'spec'" else 0), f"{what} in the page text: {near(pat)}")
        check("{{" not in out and "}}" not in out, "an unexpanded {{placeholder}}")
        # No "gap" wording as a label: headings, eyebrows, nav names, detail labels, pills, buttons, tags.
        labels = re.findall(r'<(h[234])\b[^>]*>(.*?)</\1>', out)
        labels += re.findall(r'<(dt|button|b class="gx-vp"|span class="gx-kind"|i class="gx-tg"|p class="eyebrow")[^>]*>(.*?)</', out)
        labels += [(None, x) for x in re.findall(r'data-nav="([^"]*)"', out)]
        bad_lab = [x for _, x in labels if re.search(r"\bgaps?\b", plain(x), re.I)]
        check(not bad_lab, f"'gap' in a label: {bad_lab}")

        ids = re.findall(r'\bid="([^"]+)"', out)
        dupes = [i for i, n in Counter(ids).items() if n > 1]
        check(not dupes, f"duplicate ids: {dupes}")
        clash = sorted(set(ids) & self.site_ids)
        check(not clash, f"ids that collide with the rest of the site: {clash}")
        sec_ids = re.findall(r'<section id="([^"]+)"', out)
        check(sec_ids == SEC_IDS, f"sections: {sec_ids}")
        # Every to-do on the page. The page never shows this sum: the lists overlap (blockers and Studio
        # items are delivered by work items; site steps lean on the same work), so each section shows only its own count.
        n_notes = sum(1 for v in self.PLAN.values() for s in v if s["no_action"])
        n_todo = (len(self.TOP) + len(self.STUDIO_NEW) + len(self.STUDIO_LEGACY) + len(self.CHANGES)
                  + sum(len(v) for v in self.PLAN.values()) - n_notes)
        todos = re.findall(r'<li><span class="rm-sr">To do</span><h3 id="([^"]+)"', out)
        check(len(todos) == n_todo == out.count('<li><span class="rm-sr">To do</span>'), f"to-dos: {len(todos)} rendered, {n_todo} in the data")
        check(out.count('<li class="rm-note"><span class="rm-sr">Note</span><h3') == n_notes, "notes")
        # No row reads as work that was done and undone, and no grand total appears.
        check(str(n_todo) not in text and str(n_todo + n_notes) not in text, f"the page shows a to-do total ({n_todo})")
        check(not re.search(r"\bWas “", text), "a 'Was “...”' tag")
        check(out.count('<dl class="gx-wf">') == len(self.TOP) + len(self.STUDIO_NEW) + len(self.STUDIO_LEGACY) + len(self.CHANGES), "detail lists")
        rows = re.findall(r'<li id="roadmap-f-([^"]+)"', out)
        check(len(rows) == len(self.FEATS) and set(rows) == set(self.FEATS), "feature rows")
        row_v = Counter(re.findall(r'<li id="roadmap-f-[^"]+" data-v="([^"]+)"', out))
        check(dict(row_v) == {VC[k]: v for k, v in self.TOTALS.items() if v}, f"row statuses: {row_v}")
        # Every internal link resolves statically (h3 ids are all explicit here).
        hrefs = re.findall(r'href="#([^"]*)"', out)
        bad = sorted({h for h in hrefs if h not in set(ids) | self.site_ids})
        check(not bad, f"links to ids that don't exist: {bad}")
        chip_targets = [x for lst in re.findall(r'<div class="gx-chips" data-f="([^"]+)"></div>', out) for x in lst.split()]
        check(chip_targets and all(t in self.FEATS for t in chip_targets), "chip targets")
        check(out.count('class="gx-chips"') == len(re.findall(r'<div class="gx-chips" data-f="[^"]+"></div>', out)), "empty chip lists")
        n_tags = Counter(re.findall(r'<i class="gx-tg"[^>]*>([A-Z][a-z]+)', out))
        F = self.FEATS.values()
        check(n_tags["Medium"] == sum(1 for f in F if f["confidence"] != "high")
              and n_tags["Rated"] == sum(1 for f in F if f["rated_before_review"])
              and n_tags["Unconfirmed"] == sum(1 for f in F if f["unconfirmed_sub_claim"])
              and n_tags["First"] == sum(1 for f in F if f["first_rated"]), f"row tags: {n_tags}")
        counts_by_sec = {s: c for s, c in re.findall(r'<section id="([^"]+)"[^>]*>\n<p class="eyebrow">[^<]*<span class="rm-count">([^<]+)</span>', out)}
        check(list(counts_by_sec) == SEC_IDS[1:], "every section but the overview shows its own count")
        # Every "Part of blocker" link is a blocker whose "Delivered by" names that work item, and back.
        check(sum(len(v) for v in self.CLEARS.values()) == sum(len(b["delivered_by"]) for b in self.TOP), "blocker back-links")
        self.stats = dict(sec_ids=sec_ids, counts_by_sec=counts_by_sec, todos=len(todos), rows=len(rows), chips=len(chip_targets),
                          hrefs=hrefs, n_tags=n_tags, doc_links=sorted({h for h in hrefs if h in self.doc_label}))


def render(data=None):
    """The Roadmap fragment. data: the parsed roadmap.json (read from data/roadmap.json by default)."""
    if data is None:
        data = json.loads(DATA.read_text(encoding="utf-8"))
    return Roadmap(data).render()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", help="also write the rendered fragment to this file")
    args = ap.parse_args()
    # The summary has a few non-ASCII characters (·, ›); never fail on a terminal that can't show them.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    rm = Roadmap(json.loads(DATA.read_text(encoding="utf-8")))
    out = rm.render()
    if args.out:
        pathlib.Path(args.out).write_text(out, encoding="utf-8")
        print(f"wrote {args.out}  {len(out.encode()) / 1024:.1f} KB")
    s = rm.stats
    print("sections:", ", ".join(f"{x} [{s['counts_by_sec'].get(x, '-')}]" for x in s["sec_ids"]))
    print(f"to-dos: {s['todos']} (blockers {len(rm.TOP)}, studio {len(rm.STUDIO_NEW)}+{len(rm.STUDIO_LEGACY)}, work items {len(rm.CHANGES)}, "
          f"site steps {'+'.join(str(len(rm.PLAN[r])) for r in rm.REPOS)})  rows: {s['rows']}  chips: {s['chips']}  internal links: {len(s['hrefs'])}")
    print("statuses:", {rm.VLABEL[k]: v for k, v in rm.TOTALS.items()},
          "per site:", {rm.SHORT[r]: dict(rm.counts(rm.REPO_IDS[r])) for r in rm.REPOS})
    print("row tags:", dict(s["n_tags"]))
    print("links into Docs/Under the hood:", s["doc_links"])


if __name__ == "__main__":
    sys.exit(main())
