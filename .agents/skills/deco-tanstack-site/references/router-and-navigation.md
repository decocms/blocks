# Router and navigation

## `src/router.tsx`

```tsx
import { createDecoRouter } from "@decocms/tanstack/router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createDecoRouter({ routeTree });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
```

`createDecoRouter` is `createRouter` with Deco's defaults: scroll restoration on, `defaultPreload:
"intent"`, and the Deco search parser and serializer. Its options:

| Option | For |
|---|---|
| `routeTree` | Required. |
| `context` | Router context for every route (`{ queryClient }`). |
| `Wrap` | A provider around the whole app, non-DOM only (`QueryClientProvider`, `ImageUrlProvider`). |
| `nonce` | The CSP nonce TanStack stamps on its own scripts, when the site enforces one. |
| `defaultPreload` | `"intent"` (default), `"viewport"`, `"render"` or `false`. |
| `trailingSlash` | TanStack's trailing-slash option. |

It takes nothing else. A router that needs another TanStack option (`hydrate`, say) calls
`createRouter` itself with `parseSearch: decoParseSearch` and `stringifySearch:
decoStringifySearch` from the same module, plus the defaults above.

**One `QueryClient` per router.** `getRouter()` runs per request on the server. Create the client
inside it and pass it through `context` and `Wrap`. A client at module scope is shared by every
request in the isolate and leaks one shopper's cart to the next.

## `src/start.ts`

```ts
import { decoServerFnFetch } from "@decocms/tanstack/start";
import { createStart } from "@tanstack/react-start";

export const startInstance = createStart(() => ({ serverFns: { fetch: decoServerFnFetch } }));
```

`decoServerFnFetch` adds the page's CDN segment token (`__cseg`) to server-function calls, so a page
cache can let the CDN keep navigation data. With no token on the page it is a plain `fetch`. v7's
draft middleware in `start.ts` goes away: the worker decides drafts.

## Search params

The Deco parser reads the query with `URLSearchParams`, not TanStack's JSON format, so commerce URLs
round-trip unchanged:

- A repeated key is an array: `?filter.size=M&filter.size=L` → `{ "filter.size": ["M", "L"] }`.
  The serializer writes each value back.
- Every value is a string. `?page=2` is `"2"`, not `2`.
- An empty value is kept (`?q=`). `undefined` or `null` removes a param.

Pass search params as an object, not inside `to`:

```tsx
<Link to="/s" search={{ q: term }}>Search for {term}</Link>
<Link to="." search={(prev) => ({ ...prev, page: "2" })}>Next page</Link>
```

Keep the other params when you change one (`(prev) => ({ ...prev, sort })`). Don't rebuild the
object with `Object.fromEntries(new URLSearchParams(location.search))`: it keeps one value per key
and drops the other filters. How the loader turns these into the page's URL:
[`routes-and-pages.md`](./routes-and-pages.md).

A search form submits with `useNavigate`: `navigate({ to: "/s", search: { q } })`. Keep
`action="/s"` and `name="q"` on the `<form>` so it still works before hydration.

## Links and preload

With `defaultPreload: "intent"`, hovering or focusing a `<Link>` loads the target route: its code
and its loader, which is the page server function. A click soon after uses that result.

- Turn it off where hover is not intent: long footer lists, variant pickers, filter options
  (`<Link preload={false}>`). Each preload is a `/_serverFn/` call that resolves a whole page.
- `preload="render"` loads as soon as the link renders; keep it for the one next step most visitors
  take.
- `router.preloadRoute({ to })` preloads from code (an autocomplete result under the cursor).
- Commerce APIs return absolute URLs. Turn them into paths before linking: `relative(url)` from
  `@decocms/compat-v7/commerce/sdk/url` (its `stripSearchParams` option drops keys such as `skuId`).
- Keep a plain `<a href>` for other origins (a checkout on the platform's domain), downloads,
  `mailto:`, `tel:` and in-page anchors.

## A navigation that loads twice, or not at all

Count the `/_serverFn/` requests in the network panel (or a HAR) for one click. Each one resolves a
whole page.

| Symptom | Likely cause |
|---|---|
| Two calls per click, one on hover and one on click | Preload on intent, then a click whose search differs from the preloaded one. Turn preload off on that link, or make the link's target exactly the URL it navigates to. |
| Two calls for the same path, with and without a param | The param is in `loaderDeps` on one side and not the other. Keep client-only params out of `loaderDeps` and out of the href. |
| A filter or page change updates the URL but not the page | The param isn't in `loaderDeps`, so the href the loader builds from `deps` doesn't carry it. |
| Only one filter value reaches the server | A query built with `new URLSearchParams(search)`, or a search object rebuilt with `Object.fromEntries`. |

## Variant switching on a product page

There are two kinds of variant.

**Another product** (a different color that is its own product): navigate. Skip preload on these
links, and show progress on the clicked option until the new page arrives.

```tsx
const navigate = useNavigate();
const [loading, setLoading] = useState<number | null>(null);
// on click: e.preventDefault(); setLoading(index); navigate({ to: href });
```

Reset `loading` when the product prop changes: the component may stay mounted across the
navigation. Don't `await navigate()` to reset it.

**Another SKU of the same product** (a size): the page already has every SKU when the product loader
returns them all. Keep the selected SKU in component state and render from it. No server call is
needed.

If the URL must also change (so a shared link opens that SKU), measure before you rely on it. v7
storefronts called `window.history.replaceState` on the claim that the router didn't see it. That
is no longer true: `@tanstack/history` 1.162 (what `@tanstack/react-router` 1.170 depends on) wraps
`pushState` and `replaceState` and notifies the router, which then starts a load. Whether that load calls the page server function depends on
`loaderDeps` and `staleTime`. Keep the SKU param out of `loaderDeps` and out of the href, then
check the network panel: a SKU click should make zero `/_serverFn/` calls.

## Progress while a page loads

`DecoDocument` renders `NavigationProgress` (a bar at the top while `isLoading`) and
`StableOutlet` (keeps the content area's height so the footer doesn't jump). A site with its own
document can import both from `@decocms/tanstack/react`. `NavigationProgress` takes `color`
(default `--color-brand-primary-500`, else the text color).
