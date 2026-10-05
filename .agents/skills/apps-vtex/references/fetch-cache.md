# VTEX fetch cache — `fetchWithCache` / `vtexCachedFetch`

Server-side SWR cache for VTEX GET responses. The engine (in-flight dedup,
stale-while-revalidate, stale-if-error, inflight backstop, storage tier,
`deco.cache.requests{layer="swr"}` metric) is **not** VTEX code — it is
`createFetchCache` in `@decocms/blocks/sdk/fetchCache`, shared by every commerce
app. For those mechanics see the `deco-caching` skill. This file covers only
the VTEX binding.

> Older docs described a standalone `@decocms/apps/vtex/utils/fetchCache` with its
> own LRU Map, `TTL_BY_STATUS` and "non-ok throws". That copy is gone; if a site
> still carries it, it is an uninstrumented fork — delete it and use the package.

## The pieces (`packages/apps-vtex/src/`)

| File | What it is |
|---|---|
| `utils/fetchCache.ts` | One module-level `createFetchCache({ provider: "vtex", ... })` instance. Exports `fetchWithCache`, `clearFetchCache`, `getFetchCacheStats`, `FetchCacheOptions` (re-export of the shared type: `{ ttl?, sieMs? }`). |
| `utils/constants.ts` | The tuning knobs, with the reasoning next to each number. Also holds `DEFAULT_RESILIENCE_CONFIG` for `utils/resilience.ts`. |
| `client.ts` `vtexCachedFetch` | The function loaders should call. GET → cache; anything else → plain `vtexFetch`. |
| `client.ts` `intelligentSearch` | Calls `fetchWithCache` directly for every IS request. |

### Tuning constants (`utils/constants.ts`)

| Constant | Value | Why |
|---|---|---|
| `FETCH_CACHE_MAX_ENTRIES` | 500 | Bounded memory; least-recently-used entry evicted first (a hit moves the key to the tail) |
| `FETCH_CACHE_FRESH_TTL_MS.success` | 180_000 (3 min) | Catalog/price data needn't be second-fresh |
| `FETCH_CACHE_FRESH_TTL_MS.notFound` | 10_000 (10 s) | A just-published SKU shouldn't 404 for long |
| `FETCH_CACHE_FRESH_TTL_MS.serverError` | 0 | 5xx is never a good hit |
| `FETCH_CACHE_STALE_IF_ERROR_MS` | 86_400_000 (24 h) | A warm key survives a full VTEX outage; mirrors the edge `sie` window |
| `FETCH_CACHE_INFLIGHT_BACKSTOP_MS` | 15_000 | Frees a dedup slot held by a hung fetch. **Must stay above** `DEFAULT_RESILIENCE_CONFIG.totalTimeoutMs` (12 s) — if it fired first it would throw away a slow-but-good response and let a concurrent request launch a duplicate upstream call |

Change a knob here, not at the call site — the point of the file is that the
whole resilience posture is auditable in one place.

## `vtexCachedFetch` (`client.ts`)

```ts
import { vtexCachedFetch } from "@decocms/apps-vtex/client";

vtexCachedFetch<T>(path, init?, { cacheTTL?: number }?): Promise<T | null>
```

- Cache key = the full sanitized URL (`baseUrl()` + path, or the path itself if it starts with `http`).
- Sends `authHeaders()` and, unless `init.headers` already has a `cookie`, the request's `vtex_segment` cookie — Legacy Catalog gates regional seller availability on it, so cached PDP/shelf lookups see the same regionalization as the rest of the stack. Note the segment cookie is **not** part of the cache key; regionalization that must split the cache has to show up in the URL (e.g. `sc`, `regionId`).
- `cacheTTL` maps to the shared `ttl` option (overrides the status-based fresh TTL). `cacheTTL: 0` is falsy and is ignored — it does not disable caching.
- Returns `null` for every non-2xx below 500; only 404 is cached by default (10 s), other 4xx get a 0 TTL and refetch next time (unless `cacheTTL` is set, which caches them too). 5xx throws. Callers handle both.
- Non-GET falls through to `vtexFetch` (returns `T`, no cache).

`intelligentSearch()` adds `sc`, `locale`, `regionId` to the URL before keying,
forwards the explicit `cookieHeader` (IS session cookies) or the segment cookie,
and its `doFetch` throws on any non-ok, so IS 404s are not cached as `null`.

## Who uses it today

| Call site | Endpoint | Via |
|---|---|---|
| `utils/slugCache.ts` | `catalog_system/pub/products/search/{slug}/p` | `vtexCachedFetch` |
| `loaders/legacy/relatedProductsLoader.ts` | `products/crossselling/{type}/{id}` | `vtexCachedFetch` |
| `loaders/intelligentSearch/productDetailsPage.ts` | kit-items legacy search | `vtexCachedFetch` |
| `client.ts` `cachedPageType` | `portal/pagetype/{term}` | `vtexCachedFetch` |
| `client.ts` `intelligentSearch` | IS `product_search`, `facets`, … | `fetchWithCache` |

Not cached by this layer: `loaders/catalog.ts` `getCrossSelling` (plain
`vtexFetch` — the loader in `legacy/` is the cached one), every checkout /
session / auth call (they go through `vtexFetchWithCookies`, which must never
be cached — it rotates cookies).

Shipping simulation is a POST, so it has its own body-only cache instead:
`utils/simulationCache.ts` + `loaders/cart/shipping.ts` `getShippingSimulation`
(5 min, keyed on `{account, salesChannel, items, postalCode, country}`; inject a
shared store with `setSimulationCache`). See [`cart-loaders.md`](./cart-loaders.md).

## Adding cache to a new VTEX endpoint

```ts
// Before — no cache
const data = await vtexFetch<MyType>(`/api/my-endpoint/${id}`);

// After — SWR, 3 min fresh on 2xx
const data = await vtexCachedFetch<MyType>(`/api/my-endpoint/${id}`);
if (!data) return null; // 404

// Custom fresh TTL
const data = await vtexCachedFetch<MyType>(`/api/my-endpoint/${id}`, undefined, {
  cacheTTL: 60_000,
});
```

Only for responses that are the same for every shopper given the URL. Anything
that depends on the auth cookie, orderForm or session must stay on
`vtexFetch` / `vtexFetchWithCookies`. Do not create a second
`createFetchCache({ provider: "vtex" })` or a per-loader Map — one instance
keeps dedup and the `provider="vtex"` hit ratio meaningful.

## Diagnostics

```ts
import { getFetchCacheStats, clearFetchCache } from "@decocms/apps-vtex/utils/fetchCache";
getFetchCacheStats(); // { entries, inflight } — local tier only
clearFetchCache();    // drop entries + inflight slots (mainly tests)
```

- **Hit ratio**: `deco.cache.requests{deco.cache.layer="swr", deco.cache.provider="vtex"}` in ClickHouse. A HIT never reaches `doFetch`, so it never shows in `http.client.request.duration` — don't infer hit ratio from upstream call counts alone. Upstream calls only carry provider/operation labels if the site wired `setVtexFetch(createVtexFetch())` at boot.
- **Stale data after a catalog change**: up to 3 min fresh, then one more request served stale while it refreshes. During a VTEX outage a 2xx entry can be served for up to 24 h past fresh — that's intended.
- **`inflight` stays > 0**: a hung upstream; the 15 s backstop clears it. If it doesn't, check the resilience layer's timeouts weren't raised above the backstop.
- **Dev**: the cache is active in dev too (unlike `createCachedLoader`'s dev mode); restart to clear.

## Related

| Skill | Purpose |
|---|---|
| `deco-caching` | `createFetchCache` internals, storage tiers, `createCachedLoader`, edge cache |
