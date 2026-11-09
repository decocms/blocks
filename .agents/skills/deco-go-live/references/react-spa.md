# React and SPA leftovers

A Fresh site rendered islands on full page loads and tolerated Preact habits.
A v8 TanStack site is React with client-side navigation: components are reused
across routes, inline scripts inserted on the client don't run, and React is
strict about controlled inputs and hydration. Most of these pass a reload test
and fail on a **SPA click**.

Always test by clicking links the app rendered. A `click()` on an `<a>` you
appended to `body` does a full reload. Confirm SPA navigation with
`performance.getEntriesByType("navigation").length === 1` after the click.

How to write sections and client components on v8 is in
**deco-site-authoring**; this file is only the go-live sweep.

## Preact and Fresh leftovers

Found by a Playwright sweep, production against local, on one store:

| Symptom | Root cause | Fix |
|---|---|---|
| Typing in an input erases every letter | `value={…}` without `onChange` (Preact tolerated it; React makes it read-only) | `defaultValue` |
| Modal or zoom never opens on mobile | a controlled checkbox (`open={false}`) without `onChange` | uncontrolled, `defaultChecked` |
| "Add to cart" from a secondary component does nothing | `window.STOREFRONT.CART.addToCart` or `window.addToCart`: the Fresh global SDK doesn't exist | call the site's cart server function |
| A form does nothing | `hx-post` replaced by `preventDefault` and a TODO | wire it to a server function |
| A popup library never loads | `<script src>` inside a client-rendered section never runs | load it on demand |
| A label doesn't open its modal | raw HTML strings with `htmlFor` or `className` | `for` and `class` inside strings |
| An error on every keystroke | `onInput={useScript(...)}` passes a string as the handler | a function handler |
| The second lookup never renders | code removed React-owned DOM children by hand | reset state |
| Search steals focus every 300 ms | `setInterval(focus)` never cleared | bounded attempts, cancel on close and navigation |
| A double click adds two items | no in-flight guard | pending guards |
| A click before hydration is lost | | read `el.checked` on mount |

```bash
grep -rnE "window\.STOREFRONT|window\.addToCart|hx-(post|get|on|trigger)" src
grep -rnE "on[A-Z][a-zA-Z]+=\{useScript" src
grep -rnE "open=\{false\}" src
grep -rnE "<script[^>]+src=" src
grep -rnE "\.removeChild\(|\.innerHTML\s*=|replaceChildren\(" src
```

For `value=` without `onChange`, run dev with the console open on every form.
React warns: "You provided a `value` prop without an `onChange` handler".

## Inline scripts do not run on SPA navigation

`useScript` and `useScriptAsDataURI` still exist in `@decocms/compat-v7`
(v7's output, byte for byte), and `inlineScript(js)` is the string form they
point to. React inserts a `<script>` on the client without running it. Only
scripts parsed from the server HTML run. Seen: a countdown frozen at
00:00:00, a header under the timer, a sticky gallery that never shrinks. All
fine after F5.

Pattern: keep the inline script for the first paint, make it idempotent, and
also run it from `useLayoutEffect` with a cleanup.

```tsx
const init = (id: string) => {
  const el = document.getElementById(id) as (HTMLElement & { __started?: boolean; __stop?: () => void }) | null;
  if (!el || el.__started) return;             // idempotent
  el.__started = true;
  const stops: (() => void)[] = [];
  el.__stop = () => stops.forEach((s) => s()); // remove listeners and observers
  // ...
};
useLayoutEffect(() => { init(id); return () => document.getElementById(id)?.__stop?.(); }, []);
```

`useScript(fn)` serializes `fn.toString()`, which can differ between the
server and the client build and break hydration. Its own docs mark it
deprecated in favor of `inlineScript` with a plain string.

```bash
grep -rlnE "useScript\(|useScriptAsDataURI\(|inlineScript\(|<script" src
```

🧪 For each hit: reach the page by a SPA click and check it works. Go
listing → product → back three times; listener counts must stay flat.

## Same-route navigation reuses components

Product → product is the same route (the catch-all), so the page component is
reused.

1. `<img>` nodes reused with a new `src` show the previous product's photos for about 1.2 s. Fix: a `key` per product group on the gallery.
2. `if (!items.length) return null` **before** a hook: an instance moving from a product without that block to one with it calls more hooks → React error #310, and the page renders only header and footer. One store had 13 more components with the same pattern.

```tsx
<Gallery key={product.inProductGroupWithID ?? product.productID} … />
```

```bash
grep -rn "rules-of-hooks" eslint.config.* .eslintrc* biome.json 2>/dev/null || echo "rules-of-hooks not enabled"
```

Test any home-made scan against a known bug first. One awk scan "passed" with
zero hits because macOS awk did not support the regex.

🧪 SPA-click product → product between products **with and without**
optional blocks (video, size guide); the first gallery `<img>` must change.

## Hydration error #418

**What happened** (~2,750 users a day, 90% on mobile listings): tag-manager
scripts appended to `body` during parse landed between `</main>` and React's
own tail scripts. React claimed them during hydration → #418, and the whole
page re-rendered on the client.

- Keep every node after `<main>` one React rendered. `DecoDocument` renders its `children` after the page; put the site's own trailing UI there, not in raw HTML.
- CMS or platform HTML with unbalanced tags in `dangerouslySetInnerHTML` → balance it before rendering; truncate HTML at word boundaries, not as plain text.
- Block HTML inside `<p>` breaks the parse → use `<div>`.
- `location.origin` read during SSR → pass the origin in.

```bash
grep -rn "dangerouslySetInnerHTML" src
```

🧪 Mobile emulation, 6× CPU, tag manager on, scroll during load, about 20
listing loads: zero #418. After hydration, any third-party `<script>` in
`document.body.children` with a `__reactFiber$*` key is a bug.

## Server functions cancelled on navigation

**What happened:** a TanStack server function is cancelled when the user
navigates away mid-request. Cancelled at 50–250 ms, it never reached the
platform. "+" then "checkout" lost the item. Also, on Fresh the add-to-cart
call was not awaited, so the "added" sheet opened at once; awaited, it opened
0.7 s late.

- Open the UI optimistically before the `await`; close it on failure.
- Track pending cart writes; full-page links (especially checkout) wait for them.
- `fetch(..., { keepalive: true })` on `pagehide` for writes.

🧪 WebKit: change the quantity and click "checkout" within 300 ms. The
checkout shows the new quantity.

## Stale chunks after deploy

Every deploy removes old hashed chunks. Open tabs then get 404s on
`/assets/*.js` (103 to 254 per deploy on one store). The router reloads only
on route-chunk failures; a lazy section's chunk fails into the error boundary
(a product page without photos, price or buy button). The v8 packages add no
handler for this.

- Listen to Vite's `vite:preloadError` and reload once per chunk, guarded in `sessionStorage` with a cooldown of about 30 s.
- Add a small inline guard in `<head>` for when the main entry itself 404s.

🧪 Open a tab, deploy, then SPA-navigate in that tab to a page with lazy
sections.

## Preload on intent

`createDecoRouter` defaults to `defaultPreload: "intent"`: hovering a link
loads that page's data. On v7, intent preload cost one store 197 GB of egress
in 2.5 days (each hover fetched a 1.6 MB product payload). Measure the
payload of a page load before go-live. If it is large, trim it
(**deco-storefront-performance**) or pass `defaultPreload: false`.

## Browser memory leaks

**What happened (minicart):** 1–2 GB per open; the browser died at 3–4 GB.

- Signal shims (`useSignalEffect`, `useComputed` without deps) → render loops.
- A store hook expecting `{ unsubscribe }` while the source returns a function → subscriptions pile up. Use `useSyncExternalStore` with a stable `subscribe`.
- Every cart item re-rendered on open and close → make open/close CSS-only and memoize the list.
- `removeEventListener` with a new arrow function does nothing → keep the reference.

🧪 DevTools Memory: open and close the minicart 10 times with the tag manager
on; a heap snapshot before and after must be flat.

## Legacy service worker

An old site's service worker kept intercepting requests on one store.
Removing `register()` does not uninstall it for past visitors. Ship a `sw.js`
at the same path that unregisters itself.

```js
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", async () => {
  await self.registration.unregister();
  (await self.clients.matchAll()).forEach((c) => c.navigate(c.url));
});
```
