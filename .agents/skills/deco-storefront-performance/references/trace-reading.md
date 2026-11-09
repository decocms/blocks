# Reading a Chrome Performance trace, and measuring without fooling yourself

Load when: you need to know which element shifted, why the screen went blank for a moment,
or where a slow navigation spends its time; or your local numbers disagree with production.

A trace records which element moved, by how much, and what ran just before. It answers
questions the console and Lighthouse only hint at.

## Record one

1. DevTools, **Performance** panel.
2. Turn on **Screenshots** (to see flashes) and **Web Vitals** (to see layout shifts).
3. Set CPU and network throttling to match what you are debugging (mobile: 4x CPU, a
   slow 4G profile).
4. Record, then reproduce: a hard reload for load problems, a click for navigation
   problems. Wait until the page settles (3 to 5 s), then stop.

Save it (the export button, a `.json` file) so someone else can load it, or open it in
Perfetto. Record the same steps before and after a fix.

## Layout shifts (CLS)

1. In the **Layout shifts** (or Experience) track, each shift is a marker. Click one.
2. The summary shows its **score**, the **cumulative score**, and the **elements** that
   moved. Click an element to jump to it in the Elements panel.
3. Look just to the left of the shift on the **Network** and **Main** tracks: a script
   finished, a stylesheet arrived, a font swapped, an image decoded. That is the cause.

Fixes are in [`cls-third-party.md`](./cls-third-party.md).

## A flash or a blank frame

1. In the screenshot strip at the top, find the white or half-painted frame. Note its time.
2. On the **Main** track at that time, look for React work (`performConcurrentWorkOnRoot`,
   hydration) and for a Suspense fallback commit.
3. Check the console for a hydration error at the same moment.

A fallback during hydration usually means a component loaded with `React.lazy` was not
ready, or a block promise was still pending. See [`hydration.md`](./hydration.md#3-flashes-and-blank-frames).

## A slow navigation

1. Record while clicking a card or a menu link.
2. On the **Network** track, find the `/_serverFn/` request. Its duration is the server's
   share: routing, the page's blocks and the upstream.
3. After it ends, look on **Main** for long tasks: rendering the new page, effects, a large
   list. That is the browser's share.

If the server share dominates, go to [`render-location.md`](./render-location.md) and
count upstream calls ([`request-dedupe.md`](./request-dedupe.md#count-the-calls)). If two
`/_serverFn/` requests appear for one click, see [`navigation-ux.md`](./navigation-ux.md).

## Measurement traps

These produced false conclusions on real storefronts.

- **A local preview without compression is for deltas, not absolutes.** One local FCP of
  11.7 s was a dev server sending 573 KB of HTML instead of 62 KB, and 364 KB of CSS
  instead of 57 KB. Compare local against local.
- **A local build of `main` is not the deployed build.** A stale generated file made a
  local chunk 1,215 kB against the deployed 908 kB: 307 kB of difference that did not exist.
  Run the repo's codegen (`deco schema`, the content module) before the control build,
  and check that the local asset hashes match the deployed ones.
- **Warm the cache for the right segment.** When the page cache keys by device, the first
  hit with a mismatched User-Agent measures a cold render for the wrong segment. That
  produced two fake "TTFB regressions" on one site. Warm up with the same UA you measure with.
- **One run is noise.** Take the median of five runs per side. Lighthouse varies more than
  most fixes move it.
- **A hydration change needs a control.** Count the nodes that survive hydration and the
  console errors on representative pages, on the base branch and on yours. Without the
  control, 99.7% surviving tells you nothing.
- **Assert what must be there, not only what you removed.** After a change to the `<head>`
  or the client bundle, check that the served HTML still loads the client entry script.
  One change removed it with zero errors and zero warnings: the page rendered and never
  hydrated.
- **Escaping is not waste.** Removing `encodeURIComponent` from JSON in an HTML attribute
  to "save bytes" cost 8% more: React escapes `"` as `&quot;` (6 bytes) against `%22`
  (3 bytes), and JSON is mostly quotes.
