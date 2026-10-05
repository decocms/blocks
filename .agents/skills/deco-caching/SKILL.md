---
name: deco-caching
description: "Every cache layer of a deco storefront (@decocms/blocks, @decocms/tanstack): worker-entry edge cache and profiles, route staleTime/gcTime, page in-flight dedup, layout caches, loader cache, SWR upstream cache. Use when touching createDecoWorkerEntry, cacheHeaders, detectCacheProfile, routeCacheDefaults, staleTime, gcTime, createCachedLoader, createFetchCache, registerLayoutSections, X-Cache, Cache-Control or /_cache/purge; or when a page is a cache MISS/never HITs, a TTL is wrong, private data is cached, the same upstream call (e.g. a Header/Footer shelf hitting VTEX intelligent search) fires on every navigation, staleTime/gcTime values are asked about, a layout shows another visitor's variant, you need to purge, or the loader cache eats memory."
---

# Deco caching — every layer

A deco storefront on Cloudflare Workers has six caches between the visitor and the commerce API (on SPA navigation the Route layer answers first, before any request reaches the edge). Each keys on something different, so a bug in one looks like a bug in another. Find the layer by symptom (table below), then load only its reference.

## The layer stack

| # | Layer | Keys on | Lives in | Reference |
|---|---|---|---|---|
| 1 | **Edge** — Cloudflare Cache API, full HTML + `/_serverFn` GETs | URL minus tracking params, `__cf_device`, segment hash, geo (opt-in), `__v=<BUILD_HASH>`, decofile revision | `createDecoWorkerEntry` (`@decocms/tanstack`); TTLs from `cacheHeaders`/`detectCacheProfile` (`@decocms/blocks/sdk/cacheHeaders`) | `edge-worker-entry.md`, `edge-cache-profiles.md` |
| 2 | **Route** — TanStack Router client memory | route + `loaderDeps` (`staleTime: Infinity` in prod, `gcTime` per profile) | `routeCacheDefaults`, `cmsRouteConfig` | `route-cache.md` |
| 3 | **Page in-flight dedup** — concurrent `loadCmsPage` | full path incl. query, `__nav:` / `\|noGlobals` | `pageInflight`, `packages/tanstack/src/routes/cmsRoute.ts` | `route-page-inflight-dedup.md` |
| 4 | **Layout caches** — Header/Footer/Theme, 5 min | block ref or component `::<device>` | `resolve.ts` + `sectionLoaders.ts` (`@decocms/blocks/cms`) | `layout-*.md` |
| 5 | **`cachedLoader`** — commerce loader results | loader name + args, byte-capped (32 MB) | `createCachedLoader` (`@decocms/blocks/sdk/cachedLoader`) | `loader-cached-loader.md` |
| 6 | **SWR fetch cache** — upstream GET bodies | provider + caller key (usually URL), request scope | `createFetchCache` (`@decocms/blocks/sdk/fetchCache`), bound per app | `swr-fetch-cache.md` |
| → | upstream (VTEX, Shopify, Magento, …) | | | |

The **worker-entry** is the authority for edge caching. Routes declare intent via `headers()` and `staleTime`, but the worker-entry overrides Cache-Control based on URL-detected profiles.

## The one thing that silently disables everything

`wrangler.jsonc` `main` must point at the site's own `src/worker-entry.ts` (which wraps the TanStack server entry in `createDecoWorkerEntry`), not at `@tanstack/react-start/server-entry`. TanStack Start's Cloudflare adapter ignores a custom `export default` in the server entry, so without the separate worker-entry none of the caching, admin routes or purge logic runs in production — and nothing errors. Snippet in `references/edge-worker-entry.md`.

## When to load what

| Symptom / task | Load |
|---|---|
| Page is a MISS / never HITs; wiring `worker-entry.ts` + `wrangler.jsonc`, factory options, `BUILD_HASH` | [`edge-worker-entry.md`](./references/edge-worker-entry.md), then [`verifying-cache.md`](./references/verifying-cache.md) |
| Wrong TTL / `Cache-Control`; which URL gets which profile; adding site patterns | [`edge-cache-profiles.md`](./references/edge-cache-profiles.md) |
| Private page cached / user sees another's data (cart, account, CEP, `gclid` in HTML) | [`edge-cache-profiles.md`](./references/edge-cache-profiles.md) (`registerPrivatePaths`), [`edge-worker-entry.md`](./references/edge-worker-entry.md) (tracking params, geo); probes in `deco-storefront-egress-guardrails` |
| SPA navigation refetches, `loadCmsPage` right after hydration, route `headers()` | [`route-cache.md`](./references/route-cache.md); route files themselves: `deco-cms-route-config` |
| Prefetch + click double-fetch; two searches returning each other's results | [`route-page-inflight-dedup.md`](./references/route-page-inflight-dedup.md) |
| Same VTEX / intelligent-search call on every navigation (Header shelves) | [`layout-registering-sections.md`](./references/layout-registering-sections.md), [`layout-cache-stack-and-impact.md`](./references/layout-cache-stack-and-impact.md) |
| Same upstream GET repeated across requests or within one | [`swr-fetch-cache.md`](./references/swr-fetch-cache.md) |
| Header/Footer shows another visitor's variant (device, cookie, geo, sales channel) | [`layout-registering-sections.md`](./references/layout-registering-sections.md), [`layout-loader-cache.md`](./references/layout-loader-cache.md) |
| `layoutCacheRace.test.ts` fails; how `resolveDecoPage` short-circuits layout blocks | [`layout-resolution-cache.md`](./references/layout-resolution-cache.md) — never relax that test |
| Stale data after CMS publish | Edge/layout/SWR keys include the decofile revision ([`edge-worker-entry.md`](./references/edge-worker-entry.md)); else browser `max-age` ([`edge-cache-profiles.md`](./references/edge-cache-profiles.md)), layout 5 min TTL ([`layout-registering-sections.md`](./references/layout-registering-sections.md)) |
| Need to purge (paths, loaders, upstream) | [`verifying-cache.md`](./references/verifying-cache.md), [`loader-cached-loader.md`](./references/loader-cached-loader.md); the SWR cache has no endpoint ([`swr-fetch-cache.md`](./references/swr-fetch-cache.md)) |
| Memory pressure from the loader cache | [`loader-cached-loader.md`](./references/loader-cached-loader.md) (`DECO_LOADER_CACHE_MAX_BYTES`); bigger picture: `deco-cf-worker-memory` |
| Cache metrics missing in ClickHouse (`deco.cache.requests`) | [`swr-fetch-cache.md`](./references/swr-fetch-cache.md) (`layer="swr"`); edge/`cachedLoader` layers emit from the worker and `cachedLoader` |
| Reading Stats Lake "unknown" cache status, curl checks | [`verifying-cache.md`](./references/verifying-cache.md) |

Origin cost / egress audit (HTML size, tracking params, region splits, PR checklist): `deco-storefront-egress-guardrails`.

## Key constraints

- **Cache API ignores `s-maxage`** — the factory stores entries with `max-age = edge.fresh + max(edge.swr, edge.sie)` (the full retention window, not the fresh TTL); the worker enforces fresh vs. stale windows itself from `X-Deco-Stored-At`
- **In-memory loader cache is ephemeral** — resets when Workers isolates recycle (~30s idle)
- **Device keys add a query param** — `__cf_device=mobile|desktop` is appended to cache keys, so purging must clear both
- **Non-200 responses are never cached** — only 200 OK goes into Cache API
- **Server-fn GETs are cached with the page's profile** — `/_serverFn/...` GET requests (SPA-navigation data such as `loadCmsPage`) resolve the page path embedded in their payload (`serverFnPagePath`) and cache under that page's profile, so PDP navigation data caches like the PDP HTML. Earlier docs said `/_server` always bypassed the cache; that is no longer true. POST server-fn bodies are hashed (tracking params stripped) for deferred sections. Always bypassed: `/_build`, `/deco/`, `/live/`, `/.decofile` plus `extraBypassPaths`.
- **UTM parameters are stripped** — `utm_*`, `gclid`, `fbclid` are removed from cache keys to improve hit rates (and a request carrying them is never stored — see `references/edge-worker-entry.md`)
- **Segment hashing** — user segments (from matchers/flags) are hashed into the cache key so different audiences get different cached responses

## Package exports

```ts
import { cacheHeaders, routeCacheDefaults, detectCacheProfile } from "@decocms/blocks/sdk/cacheHeaders";
import { getCacheProfile, registerCachePattern } from "@decocms/blocks/sdk/cacheHeaders";
import { setCacheProfile, registerPrivatePaths, loaderCacheOptions } from "@decocms/blocks/sdk/cacheHeaders";
// Root-only. (@decocms/tanstack has a few ./sdk/* subpaths, e.g. ./sdk/cdnSegment.)
import { createDecoWorkerEntry } from "@decocms/tanstack";
import { createCachedLoader, clearLoaderCache } from "@decocms/blocks/sdk/cachedLoader";
import { createFetchCache } from "@decocms/blocks/sdk/fetchCache";
import { registerLayoutSections, unregisterLayoutSections } from "@decocms/blocks/cms";
```

## Related skills

| Skill | Purpose |
|---|---|
| `deco-cms-route-config` | CMS route files (`$.tsx`, `index.tsx`), `cmsRouteConfig`, `ignoreSearchParams` |
| `deco-storefront-egress-guardrails` | Egress/cost audit, cache-poisoning probes, PR checklist |
| `apps-vtex` | VTEX binding of the SWR cache (`fetchWithCache`, `vtexCachedFetch`) |
| `deco-variant-selection-perf` | Eliminate server calls for same-product variant selection |
| `deco-api-call-dedup` | In-flight deduplication + batching for VTEX API calls |
| `deco-to-tanstack-migration` (decocms/migrations) | Migration playbook whose `references/async-rendering.md` documents this same layout-cache/`cmsRoute.ts` machinery in depth (deferred sections, hydration payload size) |
