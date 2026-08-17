# Storefront as an API (mobile apps): `invoke`, `?asJson`, `?renderJson`

A Deco storefront on TanStack Start can serve its data as JSON — so a native
mobile app (or any non-HTML client) consumes the same CMS-managed pages the web
uses. There are three ways in, from most granular to whole-page:

| Way | Returns | Weight | Use when |
|---|---|---|---|
| `/deco/invoke/<key>` (+`?select=`) | one loader/action result | lightest | you need one piece of data (a product, cart, search) |
| `?renderJson` | the resolved page, projected per-section | light (curated) | the app renders a whole CMS page and you control the payload |
| `?asJson` | the entire resolved page object, raw | heavy | admin preview / legacy compat only |

## 1. `/deco/invoke/<key>` — one loader, direct

Call a single loader or action by key and get its raw result. Add `?select=` to
trim fields server-side. This is the leanest path — no page resolution, no
section tree.

```http
POST /deco/invoke/site/loaders/product/productDetailsPage.ts?select=product.name,product.offers
Content-Type: application/json

{ "slug": "camisa-linho" }
```

Use it for pointed data (a PDP's product, the cart, a search). It does not give
you "the whole page's sections" — that's what `?renderJson` is for.

## 2. `?renderJson` — the page as curated JSON (the one for mobile)

Append `?renderJson` to any page URL. The framework resolves the CMS page and
returns a **lean, per-section-projected** document:

```http
GET /feminino/bolsas?renderJson
```

```jsonc
{
  "name": "Bolsas",
  "path": "/feminino/bolsas",
  "sections": [
    { "component": "site/sections/product-listing/listing-page.tsx",
      "props": { /* the section's projected props */ } },
    { "component": "site/sections/home/home-banner-collection.tsx",
      "props": { /* … */ } }
  ]
}
```

No admin `resolveChain`/metadata envelope (unlike `?asJson`). Each section
controls its own JSON through a recognized export — same convention family as
`loader`/`action`/`LoadingFallback`:

```tsx
// Web-only section (theme, analytics, SEO, scripts): drop it from the JSON.
// Also a perf short-circuit — a dropped section's loader is NOT run.
export const renderJson = false;

// Projection: trim the resolved props before serialization. Type it against the
// section's own props so a rename is compile-checked.
import { deepOmit } from "@decocms/blocks/sdk";
export const renderJson = (props: SectionProps<typeof loader>) =>
  deepOmit(props, "storeConfig", "page.seo", "page.productsMap.*.hasFetchedSimilars");

// No export at all → the section serializes with its full resolved props.
```

`deepOmit(obj, ...dottedPaths)` removes paths immutably; `*` fans over array
elements or record values (see `@decocms/blocks/sdk`).

### Dropping sections the site doesn't own

For app-owned sections (from `@decocms/apps-*`) that shouldn't reach the app,
set `renderJson.sectionsToIgnore` on the **Website** app (admin/decofile) —
matched by resolveType suffix:

```jsonc
// Site block
"renderJson": { "sectionsToIgnore": ["SeoV2.tsx", "DecoAnalytics.tsx"] }
```

Site-owned sections should prefer `export const renderJson = false` in their own
file over a store opinion in `sectionsToIgnore`.

### Response contract

- Envelope: `{ name, path, sections: [{ component, props }] }`.
- **CORS**: the response reflects the request `Origin` with
  `Access-Control-Allow-Credentials: true` (so credentialed fetches work).
- **Caching**: an `ETag` over the serialized body — the app sends
  `If-None-Match` and gets `304` when the page is unchanged. `Cache-Control:
  public, max-age=0, must-revalidate`.
- **Not found**: a stable `{ status: 404, notFound: true }` (HTTP 404), so the
  app has a predictable "page doesn't exist" shape.

### Lazy sections

Sections the CMS marks as deferred (⚡ / below-the-fold) are NOT resolved in the
page response. Instead they appear as a placeholder, interleaved in page order:

```jsonc
{ "component": "site/sections/home/shelf.tsx",
  "lazyUrl": "/feminino/bolsas?renderJson&__section=3" }
```

The app fetches `lazyUrl` (a plain GET, same origin) when it needs that section
— e.g. as it scrolls — and gets the resolved `{ component, props }`. This
mirrors the web's on-scroll deferral: above-the-fold sections arrive inline,
heavy ones (shelves, carousels) load on demand instead of bloating the first
response. Treat `lazyUrl` as opaque; only its shape (`{ component, lazyUrl }` vs
`{ component, props }`) is the contract. A deferred section that opts out
(`renderJson = false` / `sectionsToIgnore`) emits no placeholder at all.

### Mobile fetch example

```ts
async function fetchPage(path: string, etag?: string) {
  const res = await fetch(`https://loja.example.com${path}?renderJson`, {
    headers: etag ? { "If-None-Match": etag } : {},
  });
  if (res.status === 304) return null; // use cached
  const page = await res.json();
  return { page, etag: res.headers.get("ETag") };
}
```

### Contract stability (why this matters for mobile)

A `renderJson` export is invisible to the type system and the admin schema —
dropping or changing one during a refactor produces **no error anywhere**, the
app payload just silently changes. A mobile app is a released binary that can't
hot-fix, so guard the projections: keep a snapshot test of each key section's
projected shape, and bump a contract version before shipping a breaking change.

## 3. `?asJson` — legacy / preview only

`?asJson` dumps the **entire** resolved page object raw (full props of every
eager section, plus admin `resolveChain` metadata). It runs every eager
section's loader and serializes everything — multi-MB on a PLP/PDP. It exists
for the admin preview and legacy compatibility; prefer `?renderJson` for apps.
When both params are present, `?renderJson` wins.

## Choosing

- One datum → **invoke** (`?select=` to trim).
- A whole CMS page, payload under your control → **`?renderJson`**.
- Don't reach for **`?asJson`** in new app code.
