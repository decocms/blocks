# `@decocms/apps-vtex`

A typed client for VTEX's Intelligent Search, legacy Catalog, Checkout, Session, Master
Data v1 and IO GraphQL APIs. It returns VTEX's own response types. Cookies and
`Set-Cookie` are covered in [`vtex-cookies-auth.md`](./vtex-cookies-auth.md).

## Configure

```ts
import { createVtexClient } from "@decocms/apps-vtex";

export const vtex = createVtexClient({
  account: "mystore",
  appKey: secrets.VTEX_APP_KEY, // from the deploy platform's secrets; optional,
  appToken: secrets.VTEX_APP_TOKEN, // sent only when both are set
  salesChannel: "1",            // default `sc`
  locale: "pt-BR",              // default Intelligent Search locale
  // environment: "vtexcommercestable", domain: "com.br" (defaults)
  // fetch, retry, circuitBreaker: see instrumented-fetch.md
});
```

- Requests go to `https://{account}.{environment}.{domain}`. `io.graphql` goes to
  `https://{account}.myvtex.com/_v/private/graphql/v1`.
- `appKey` and `appToken` are sent as `X-VTEX-API-AppKey` / `X-VTEX-API-AppToken`, but
  **only on calls without a `cookie`**. A call made for a shopper goes out as the
  shopper. With app credentials, VTEX would return the orderForm with profile data
  unmasked.
- Exported names: `createVtexClient`, `VtexClient`, `VtexClientConfig`, `VtexError`,
  `VtexRequestOptions`, `VtexCheckoutOptions`, `VtexResponse`, `VtexSearchArgs`,
  `VtexCatalogSearchArgs`. VTEX's response types (`ProductSearchResult`, `OrderForm`,
  `Session`…) are not exported by name. Get them from the client:
  `Awaited<ReturnType<VtexClient["search"]["products"]>>`.

Every operation accepts `cookie` and `signal` in its options.

## Operations

**Intelligent Search** (GET, retried)

| Call | Endpoint |
|---|---|
| `search.products(args)` | `product_search` |
| `search.facets(args)` | `facets` |
| `search.suggestions(args)` | `search_suggestions` |
| `search.autocomplete(args)` | `autocomplete_suggestions` |
| `search.topSearches(args)` | `top_searches` |

`args`: `query`, `facets` (`[{ key, value }]`, sent as the path
`category-1/shirts/brand/acme`), `page` (1-based), `count`, `sort` (`"price:asc"`,
`"orders:desc"`…), `fuzzy` (`"0" | "1" | "auto"`), `locale`, `hideUnavailableItems`,
`simulationBehavior` (`"default" | "skip" | "only1P"`), `regionId`, `salesChannel`.
Suggestions, autocomplete and top searches ignore `facets`.

**Legacy Catalog** (GET, retried)

| Call | Notes |
|---|---|
| `catalog.products({ term, ft, fq, from, to, sort, salesChannel })` | `from`/`to` are 0-based inclusive (`_from`, `_to`); `fq` is a list; `sort` is the `O` value (`"OrderByPriceASC"`…) |
| `catalog.pageType(path)` | Page type of a URL path (`Product`, `Category`, `Brand`, `NotFound`…) |
| `catalog.crossSelling(type, productId)` | VTEX's cross-selling lists by type |
| `catalog.categoryTree(levels = 3)` | |

`term` and `pageType`'s `path` usually come from the shopper's URL. The client encodes
them segment by segment and throws on `.` or `..` segments, so a path can't climb to
another endpoint or add a query while credentials are attached.

**Checkout** (POST, never retried; shopper-scoped)

| Call | Returns |
|---|---|
| `checkout.orderForm({ cookie, sections?, salesChannel? })` | `VtexResponse<OrderForm>` |
| `checkout.addItems(orderFormId, [{ id, quantity, seller }], options)` | `VtexResponse<OrderForm>` |
| `checkout.updateItems(orderFormId, [{ index, quantity }], options)` | `VtexResponse<OrderForm>` |
| `checkout.addCoupon(orderFormId, text, options)` | `VtexResponse<OrderForm>` |
| `checkout.attachment(orderFormId, name, body, options)` | `VtexResponse<OrderForm>` |
| `checkout.simulation({ items, postalCode?, country? }, options)` | `SimulationOrderForm` |
| `checkout.regions({ postalCode, country, salesChannel? })` (GET) | `[{ id, sellers }]` |

`VtexResponse<T>` is `{ data, setCookies }`. Forward `setCookies` to the browser.

**Session**: `sessions.get({ cookie, items? })` and `sessions.update(publicProps, { cookie })`,
both `VtexResponse`. `items` is a list such as `["profile.email", "profile.isAuthenticated"]`.

**Master Data v1**

- `masterdata.search(entity, { where, fields, sort, from = 0, to = 10, cookie })`:
  `from`/`to` go in the `REST-Range` header.
- `masterdata.create(entity, document, { cookie })`: when the client has app
  credentials, it sends them and leaves the shopper's cookie out (Master Data refuses
  anonymous writes). It returns `{ Id, Href, DocumentId }`.

**IO GraphQL**: `io.graphql<T>({ query, variables?, operationName? }, { cookie })`
returns `data`. GraphQL `errors` (sent with HTTP 200) throw `VtexError("io.graphql", 200)`
without the messages, since they can echo inputs.

## Sales channel (`sc`)

A wrong or missing sales channel gives wrong prices, missing products or checkout
errors. VTEX answers 200 with a well-formed body either way, so nothing fails loudly.

- The client sends `sc` on Intelligent Search, `catalog.products`, every orderForm and
  simulation call, and `regions`. The per-call `salesChannel` wins over the config's.
- With no channel configured or passed, no `sc` is sent (never an empty `sc=`). VTEX
  then uses the account default.
- `pageType`, `crossSelling` and `categoryTree` send no `sc`.
- A store with several channels reads the shopper's channel per request (v7 read the
  `VTEXSC` cookie) and passes it on cart calls, the same one the search used.

## Region (`regionId`)

Regionalized stores price and stock by region. Get the region for a postal code with
`checkout.regions({ postalCode, country })`; its `id` is the `regionId`. VTEX also keeps
it in the shopper's `vtex_segment` cookie.

- Pass `regionId` to `search.*`. It goes on the query string, so it is part of the URL
  and of any cache key built from it.
- A block function has no request, so it can't read `vtex_segment` itself. Fetch
  regionalized results where you have the request, or pass the region in as an input.
  Pages split by region are a cache decision: see `deco-storefront-caching`.
- Delivery promise badges, PLP delivery filters and postal-code capture are in the
  `vtex-delivery-promise` skill (decocms/skills).

## orderForm sections

`checkout.orderForm` sends `{ expectedOrderFormSections: sections }` when you pass
`sections`, and `{}` otherwise, which per the client asks for every section. Ask for
what the view needs: `SECTIONS_MINIMAL`, `SECTIONS_DRAWER` or `SECTIONS_FULL` from
`@decocms/compat-v7/commerce/types/cart` ([`commerce-types.md`](./commerce-types.md)).

`addItems`, `updateItems` and `addCoupon` send only their payload. `attachment` sends
the `body` you give it, so include `expectedOrderFormSections` there if you need it.

## Images

`@decocms/apps-vtex/image` exports `ImageProvider`s for `createImageUrl` from
`@decocms/blocks/image`: `vtexCatalog()`, `vtexCatalogFrame({ frame? })`,
`vtexCatalogWebp({ quality? })` and `vtexFileManager({ via: "query" | "thumbor" })`.
List them before `decoCdn`. Which one matches a site, and the binding wiring, is in
`deco-images-media`.

## Failure modes

| Symptom | Likely cause |
|---|---|
| Prices differ from the VTEX storefront | No `sc`, or a different `sc` than the shopper's; `regionId` missing on a regionalized store |
| Cart empties after each action | `setCookies` not forwarded, or joined into one header ([`vtex-cookies-auth.md`](./vtex-cookies-auth.md)) |
| A new, empty cart on every call | The cart call got no `cookie`: with no `checkout.vtex.com` cookie VTEX starts a new cart, and the call goes out with the app's credentials instead of as the shopper |
| Every call fails at once for a few seconds | The circuit breaker opened after 5 failures in a row on any operation |
| `vtex: invalid path segment` | A `.` or `..` segment in `term` or `pageType`'s path |
