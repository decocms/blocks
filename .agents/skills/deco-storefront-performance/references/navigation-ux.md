# Navigation: variant switches, prefetch, scroll and feedback

Load when: clicking a size or colour on the product page takes >500 ms; one variant click
makes two `/_serverFn/` requests; forward navigation keeps the old scroll position; a
click gives no feedback for seconds; hovering a grid of cards loads the upstream.

TanStack Start only. A client-side navigation in v8 calls the page server function (one
`/_serverFn/` request), which routes, resolves the page's blocks and calls the upstream,
the same work as a full page render.

## What you already have

- `createDecoRouter` turns on `scrollRestoration` and sets `defaultPreload: "intent"`
  (prefetch on hover or focus). You can pass `defaultPreload` to change it.
- `DecoDocument` renders `NavigationProgress` (a bar at the top while the router loads)
  and `StableOutlet` (keeps the content's height during a navigation, so the footer does
  not jump). A site with its own document can import both from `@decocms/tanstack/react`.

## 1. Variant switches

Two kinds of "variant", two mechanics:

| Case | Data needed | Do |
|---|---|---|
| Same product, other SKU (size, voltage) | Already loaded: `product.isVariantOf.hasVariant` | Change the URL with `history.replaceState`: **zero requests** |
| Other product (a colour that is its own product) | A new product | Navigate: exactly one request, with a loading state |

A product page usually loads every SKU in the first render. A `?skuId=` in the URL is for
sharing and bookmarks. If the page route passes the search string to the page server
function, any change to it reloads the whole page. Do not route a same-product SKU change
through the router:

```tsx
const [current, setCurrent] = useState(() => relativeUrl(product.url));

const onVariant = useCallback((event: React.MouseEvent, href: string) => {
  event.preventDefault();
  setCurrent(href);
  window.history.replaceState(null, "", href);
}, []);

<a href={href} onClick={(e) => onVariant(e, href)} aria-current={href === current}>
  {label}
</a>
```

Use a plain `<a>` with `preventDefault`, not `<Link>`: a `<Link>` asks the router, and the
router fetches. The router does not see this URL change; that is the point. A reload or a
shared link opens the right SKU as long as the page reads `skuId` on the server.

### The double fetch

A `<Link to="…?skuId=160">` with prefetch on intent fires twice: hover prefetches one URL,
the click loads another (with a different search string), and the prefetched result is
not reused. On variant links, turn prefetch off: `<Link preload={false}>`. Prefetch is for
pages you do not have yet; a variant of the page you are on is not one.

## 2. Prefetch on dense grids

With `defaultPreload: "intent"`, moving the mouse across a listing page prefetches each
card's product page. Each one is a server function call that resolves a full page against
the upstream. On a grid of 48 cards that can be dozens of upstream page loads per visitor
who never clicks.

Measure it: record a HAR while you move the mouse over a grid, then count `/_serverFn/`
entries. Options, in order of preference:

1. Let the site's `pageCache` answer them. The worker calls it for server-function
   requests too, so a cached product page costs no upstream. See `deco-storefront-caching`.
2. Turn prefetch off on card links only (`preload={false}`), and keep it on menus and
   other links people hover with intent.
3. `createDecoRouter({ defaultPreload: false })`, and opt in per link.

## 3. Scroll to top on forward navigation

`scrollRestoration` restores the position on back and forward. If forward navigation (a
card click to a product page) sometimes leaves the new page scrolled down, scroll on
resolved navigations that are not history traversal:

```ts
// src/router.tsx, after createDecoRouter
if (typeof window !== "undefined") {
  let lastAction: string | undefined;
  router.history.subscribe(({ action }) => {
    lastAction = action.type;
  });
  router.subscribe("onResolved", (event) => {
    // PUSH and REPLACE are forward navigations; BACK, FORWARD and GO are restored by the router
    if (event.pathChanged && (lastAction === "PUSH" || lastAction === "REPLACE")) {
      window.scrollTo({ top: 0 });
    }
  });
}
```

Check that back still restores the old position after adding it.

## 4. Feedback on the clicked element

`NavigationProgress` is a thin bar. On product cards, a spinner over the clicked card is
clearer. `useRouterState` tells you a navigation to that card's path is pending:

```tsx
import { Link, useRouterState } from "@tanstack/react-router";

export function CardLink({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) {
  const pending = useRouterState({
    select: (s) => s.isLoading && s.location.pathname === to && s.resolvedLocation?.pathname !== to,
  });
  return (
    <Link to={to} className={`relative ${className ?? ""}${pending ? " pointer-events-none" : ""}`}>
      {children}
      {pending && <span className="absolute inset-0 grid place-items-center bg-white/60" aria-hidden>…</span>}
    </Link>
  );
}
```

Use it on the card image. On text links the overlay looks odd; the top bar is enough.

## Verify

Record a HAR (a script, so both runs click the same things) and count `/_serverFn/`
requests:

- Same-product variant click: **0**.
- Other-product variant click: **1**.
- Card click after hovering it: **1** in total, not 2.

Then time the click to the next paint in a Performance trace ([`trace-reading.md`](./trace-reading.md)).
