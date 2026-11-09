# Proving nothing changed

Every conversion PR is checked three ways before merge: the HTML, the pixels,
and a live edit. A PR built from a Figma file is compared with the design
instead of with `main`.

## Two servers side by side

Run `main` and the branch at once. A separate worktree keeps `main` untouched:

```sh
git worktree add ../site-main origin/main
(cd ../site-main && bun install --frozen-lockfile && npx vite dev --port 5192) &
npx vite dev --port 5191 &
```

On a hosted site the branch reads its new blocks from a draft (see
[seeding-content.md](./seeding-content.md#a-hosted-site-site-set)). Add the
`__draft` value from `deco drafts url <name>` to every branch URL
(`?__draft=…`). Two things to know about draft pages:

- Once hydrated, they show a draft badge, fixed at the bottom left
  (`[data-deco-preview-badge]`). Hide it before taking screenshots.
- If the draft cannot be read on that host, the page renders the release and
  shows a notice (`[data-deco-preview-unavailable]`). A screenshot with that
  notice compared the wrong content: stop and fix the host first.

## HTML parity

Strip what is expected to differ (scripts and comments) and diff the rest.
The draft badge mounts in the browser after hydration, so it is not in the
server HTML:

```python
# body.py: normalize a page for diffing. Usage: curl -s URL | python3 body.py
import re, sys
s = sys.stdin.read()
t = re.search(r"<title>(.*?)</title>", s, flags=re.S)
print("TITLE", t.group(1) if t else None)
b = s[s.find("<body"):]
b = re.sub(r"<script.*?</script>", "", b, flags=re.S)
b = re.sub(r"<!--.*?-->", "", b, flags=re.S)          # also React's streaming markers
print(b.replace("><", ">\n<"))
```

```sh
for p in / /pt /pricing /pt/pricing /docs/some-article; do
  f=$(echo "$p" | tr / _)
  curl -s "localhost:5192$p" | python3 body.py > "/tmp/main$f"
  curl -s "localhost:5191$p?__draft=$DRAFT" | python3 body.py > "/tmp/new$f"
  echo "$p: $(diff "/tmp/main$f" "/tmp/new$f" | grep -c '^[<>]') changed lines"
done
```

Zero changed lines is the goal. The site writes the loop that renders
sections, so it controls the markup: if a wrapper element appears, remove it
rather than accept it.

Include a few pages you did **not** convert but whose components you moved or
touched. They must be identical too.

## Pixel parity

Full-page screenshots of each page, in each language, at desktop and mobile
widths, on both servers, then a per-pixel diff.

Headless Chrome's `--screenshot` flag can hang on a Vite dev server (the HMR
socket never goes idle). `playwright-core` with a local Chromium works:

```js
// shot.mjs: npm i playwright-core in a scratch folder; CHROMIUM=path to a Chromium binary
import { chromium } from "playwright-core";
const DRAFT = process.env.DRAFT ? `?__draft=${process.env.DRAFT}` : "";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
for (const [w, h] of [[1440, 900], [390, 844]])
  for (const [name, port, query] of [["main", 5192, ""], ["new", 5191, DRAFT]])
    for (const path of ["/", "/pt", "/pricing"]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      page.on("pageerror", (e) => console.error(name, path, String(e)));
      await page.goto(`http://localhost:${port}${path}${query}`, { waitUntil: "load" });
      await page.addStyleTag({ content: "[data-deco-preview-badge]{display:none!important}" });
      if (await page.locator("[data-deco-preview-unavailable]").count()) throw new Error(`${path}: draft not read`);
      // Scroll once so reveal-on-scroll animations and lazy images run.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 400) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 50)); }
        scrollTo(0, 0);
      });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(700);
      await page.screenshot({ path: `shots/${name}${path.replaceAll("/", "_")}-${w}.png`, fullPage: true });
      await page.close();
    }
await browser.close();
```

```python
# diff.py: pip install pillow
from PIL import Image, ImageChops
import glob
for m in sorted(glob.glob("shots/main*.png")):
    n = m.replace("main", "new", 1)
    a, b = Image.open(m).convert("L"), Image.open(n).convert("L")
    if a.size != b.size: print(m, "SIZE", a.size, b.size); continue
    d = ImageChops.difference(a, b); px = [p for p in d.getdata() if p]
    print(m, "identical" if not px else f"{len(px)} px, max {max(px)}/255 in {d.getbbox()}")
```

Reading the result:

- A different page height, or any visible difference, is a regression.
- In a real conversion, a few dozen pixels at an intensity of 7/255 or less,
  around a transition (a select chevron, an animated demo), were rendering
  noise. Crop that box from both images and look before dismissing it.
- Sections that stream in (a `Suspense` boundary per section) can be caught
  half-rendered. If one run shows a fallback, wait for it to go away
  (`page.waitForSelector`) instead of raising the timeout everywhere.

## Against a Figma design

With no `main` to compare with, the baseline is the design:

1. Call `get_screenshot` on each section frame (desktop and mobile). Save as
   `tests/visual-qa/baselines/<device>/<order>-<Section>.png`.
2. Screenshot each section of the page at the frame's width (1440 and 375 are
   common). If the site renders an attribute per section, use it as a
   locator; otherwise screenshot by section element order.
3. Compare by eye and list each mismatch. A pixel diff against a Figma render
   is noisy (font rendering, antialiasing); it finds regions, it does not
   judge them.

What to compare, per section:

- **Layout:** direction, alignment, grid columns, max width and centering,
  order of elements.
- **Spacing:** padding, gaps, vertical rhythm between sections.
- **Type:** family, size, weight, line height, letter spacing, case, color.
- **Color:** backgrounds, borders, buttons, links, hover states.
- **Images:** the right asset, aspect ratio, crop (`object-fit`), radius.
- **Responsive:** both widths, and no jump at the breakpoints in between
  (768px, 1024px).

Write the mismatches as a table and fix them one by one:

| # | Device | Section | Issue | Expected | Actual | Fix |
|---|---|---|---|---|---|---|
| 1 | desktop | Hero | title size | 48px | 36px | use the `display` text token |
| 2 | mobile | Header | menu icon missing | present | missing | render the menu button below `md` |

Re-screenshot after each fix and mark the row fixed. Done means every row is
fixed at both widths.

## Live edit

With the branch running, change the content and watch it land:

- change a text in each language and confirm it changes on that language's
  pages only;
- empty a `fooPt` and confirm the secondary language falls back to `foo`;
- remove and reorder sections of a page and confirm the rendered order follows;
- break a required field and confirm `deco check` names it.

With content in git, edit the block files (`deco content --watch` reloads the
page). On a hosted site, make the same edits in the draft, from Studio or with
`deco push --draft=<name>`. Restore the content afterwards.

Then the real path, end to end: open the page in Studio, edit, preview, and
publish (with the owner's OK) or discard the draft. Confirm the change on the
site. This is the half of the goal that the pixel checks do not prove.
