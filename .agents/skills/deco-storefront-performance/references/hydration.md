# Hydration: mismatches, sections that never wake up, and flashes

Load when: React logs a hydration mismatch; a section shows its server markup but clicks
and effects do nothing; part of the page goes blank or flashes a fallback on load.

Most of this is plain React 19 and TanStack Start. The v8-specific parts are the streamed
block promises (section 2) and the per-block `<Suspense>` (section 3).

## 1. Mismatches: find the element, then the cause

React's error names the element whose server HTML differs from the first client render.
Compare the server HTML (view-source, or `curl`) with the DOM in DevTools at that spot.
Test with a hard reload: a client-side navigation renders on the client only and hides
the problem.

| Cause | Example | Fix |
|---|---|---|
| A value only the server has | `process.env.STORE_NAME` in a component: set on the server, `undefined` in the browser bundle | Pass it from the server in loader data, or use a build-time value (`import.meta.env.VITE_*`) that both bundles get |
| Time, randomness, locale | `Date.now()`, `Math.random()`, `toLocaleString()` with the server's time zone | Compute on the server and pass the result, or render it in an effect |
| Browser-only state in render | `window`, `localStorage`, `matchMedia`, the cart count from a cookie | Render a stable placeholder, fill it in `useEffect` |
| Invalid nesting | `<a>` inside `<a>`, `<div>` inside `<p>`, a `<button>` inside a `<button>` | The browser repairs the HTML before React sees it. Fix the markup (below) |
| A browser extension | Injected attributes on `<html>` or `<body>` | Reproduce in a clean profile before you change code |

`DecoDocument` already sets `suppressHydrationWarning` on `<body>`. It covers that
element's own attributes only, not its children.

### `suppressHydrationWarning`, only where the content really differs

Some content is meant to differ: a cart badge, a greeting, a wishlist heart. Put the
attribute on the element whose text differs, not on a wrapper:

```tsx
// Wrong: hides every mismatch in the subtree, including real bugs
<div suppressHydrationWarning><Header /><CartBadge count={count} /></div>

// Right: one element, one known difference
<span suppressHydrationWarning>{count}</span>
```

It works one level deep and only for text and attributes. For anything bigger, render a
placeholder on the server and the real thing after mount.

### Nested links

A card that is a link, with a "see more" link inside it, is `<a>` inside `<a>`. React warns
(`validateDOMNesting`) and the browser splits the outer link. Give the inner component a
prop that renders a `<span>` when it is already inside a link:

```tsx
export function SeeMore({ href, insideLink }: { href: string; insideLink?: boolean }) {
  return insideLink ? <span className="see-more">See more</span> : <a href={href} className="see-more">See more</a>;
}
```

Find candidates with `rg -l '<a[^>]*>.*<a' src/ --glob '*.tsx'`, then read the components a
card renders.

## 2. A streamed section that never hydrates (TanStack Start)

Symptom: the section looks right, but no effect runs and no handler fires. It hides behind
plain links (navigation still works) and behind reduced motion (a scroll animation that
never starts looks like a static grid).

Seen on TanStack Start 1.166 with block promises returned through the page server function
and streamed: a block still pending when the document streamed arrived as a late
resolution script, and the browser's copy of its promise never settled.

Check, after any change to the page route or a TanStack upgrade:

1. Load a page whose blocks call the upstream. In the console, confirm that every block
   promise in the route's loader data is fulfilled.
2. Pick a section's DOM node and confirm it has a key starting with `__reactFiber`.

If either fails, await every block on the server before returning. TTFB then becomes the
slowest block (see [`render-location.md`](./render-location.md#3-streamed-blocks-vs-awaited-blocks)),
so say so in the route file and in the PR. The `deco-v7-to-v8-migration` skill has the same
note for migrated sites.

## 3. Flashes and blank frames

In the example page route, each section block renders inside its own `<Suspense>` with
a fallback. What the visitor
sees between the server HTML and the hydrated page depends on that fallback and on how
the section's component loads.

| Symptom | Cause | Fix |
|---|---|---|
| A section paints, goes blank or shows its fallback, then paints again | The component is loaded with `React.lazy`, and its module is not ready during hydration, so React drops the server HTML and shows the fallback | Import above-the-fold section components statically in the view map. Keep `React.lazy` for sections below the fold |
| The page jumps when a section resolves | The fallback is shorter than the section | Give the fallback the section's height (`min-height`, aspect ratio). See [`cls-third-party.md`](./cls-third-party.md) |
| A section shows the route's failure UI (the example app renders "This content is temporarily unavailable") | The block failed on the server | Read the server log for that block's error. It is a loader failure, not a render problem |

To see a flash frame by frame, record a trace with screenshots
([`trace-reading.md`](./trace-reading.md)).

## 4. Keys and DOM warnings

Fix these even when nothing looks broken: they hide real errors in the console, and a
wrong key reuses the wrong DOM node.

| Warning | Fix |
|---|---|
| `Each child in a list should have a unique "key" prop` | A stable id: `key={product.productID}`. An index only for static lists |
| `Encountered two children with the same key` | The id is not unique (two cards in the same product group). Combine: `` key={`${product.productID}-${index}`} `` |
| `Invalid DOM property 'fetchpriority'` | `fetchPriority`. Same for SVG: `strokeLinecap`, `fillRule`, `clipRule` |
| `Invalid DOM property 'class'` | `className` (a Preact leftover) |
| `value` without `onChange` | Add `onChange`, or use `defaultValue` |
| `selected` on `<option>` | `value` on the `<select>` |

## Checklist

- [ ] Hard reload, console open, zero hydration errors on home, listing, product page
- [ ] Every block promise fulfilled; a section node has `__reactFiber…`
- [ ] Above-the-fold sections imported statically
- [ ] Fallbacks the height of their section
- [ ] `suppressHydrationWarning` only on single elements with known differences
- [ ] No nested `<a>`, no key or DOM-property warnings
