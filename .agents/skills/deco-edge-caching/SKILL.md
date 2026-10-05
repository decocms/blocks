---
name: deco-edge-caching
description: Edge and layered caching for TanStack Start storefronts on Cloudflare Workers — createDecoWorkerEntry from @decocms/tanstack (Cache API, device/segment/geo keys, tracking-param handling, BUILD_HASH versioning, purge endpoints, X-Cache diagnostics) and the cache-profile system in @decocms/blocks/sdk/cacheHeaders (cacheHeaders, detectCacheProfile, registerCachePattern, registerPrivatePaths, setCacheProfile, routeCacheDefaults) plus createCachedLoader from @decocms/blocks/sdk/cachedLoader. Load when setting up or debugging worker-entry caching, tuning Cache-Control or per-page-type TTLs (PDP, PLP, search, home), a private page might be cached, cache HIT/MISS rates look wrong, or you need to purge.
---

# Deco Edge Caching

Complete caching infrastructure for Deco storefronts on Cloudflare Workers, provided by `@decocms/tanstack` (worker-entry) and `@decocms/blocks/sdk` (cache headers, profiles, loader cache).

## Architecture Overview

Three caching layers work together:

| Layer | What | Where | TTL Control |
|-------|------|-------|-------------|
| **Edge cache** | Full HTML responses | Cloudflare Cache API + CDN | `cacheHeaders(profile)` via worker-entry |
| **Loader cache** | VTEX/Shopify API data | In-memory per-isolate (V8) | `createCachedLoader()` in setup.ts |
| **Client cache** | Route data after navigation | TanStack Router memory | `routeCacheDefaults(profile)` on routes |

The **worker-entry** is the authority for edge caching. Routes declare intent via `headers()` and `staleTime`, but the worker-entry overrides Cache-Control based on URL-detected profiles.


## The one thing that silently disables everything

`wrangler.jsonc` `main` must point at the site's own `src/worker-entry.ts` (which wraps the TanStack server entry in `createDecoWorkerEntry`), not at `@tanstack/react-start/server-entry`. TanStack Start's Cloudflare adapter ignores a custom `export default` in the server entry, so without the separate worker-entry none of the caching, admin routes or purge logic runs in production — and nothing errors. Snippet in `references/worker-entry.md`.

## When to load what

| Reference | Load it when |
|---|---|
| [`references/worker-entry.md`](./references/worker-entry.md) | Wiring `src/worker-entry.ts` + `wrangler.jsonc`, `createDecoWorkerEntry` options, what the factory does, tracking params / geo keys, `BUILD_HASH` cache versioning |
| [`references/cache-profiles.md`](./references/cache-profiles.md) | The real per-profile TTLs, which URL gets which profile, adding site patterns or private paths |
| [`references/route-cache.md`](./references/route-cache.md) | Route `headers()` + `routeCacheDefaults` on TanStack routes, and why production `staleTime` is `Infinity` |
| [`references/loader-cache.md`](./references/loader-cache.md) | Wrapping commerce loaders in `createCachedLoader`, its memory cap, purging it |
| [`references/verifying-cache.md`](./references/verifying-cache.md) | Checking HIT/MISS with curl, purging paths, reading Stats Lake cache numbers ("unknown" status) |

## Key Constraints

- **Cache API ignores `s-maxage`** — the factory uses `max-age` equal to `sMaxAge` when storing in Cache API
- **In-memory loader cache is ephemeral** — resets when Workers isolates recycle (~30s idle)
- **Device keys add a query param** — `__cf_device=mobile|desktop` is appended to cache keys, so purging must clear both
- **Non-200 responses are never cached** — only 200 OK goes into Cache API
- **Server-fn GETs are cached with the page's profile** — `/_serverFn/...` GET requests (SPA-navigation data such as `loadCmsPage`) resolve the page path embedded in their payload (`serverFnPagePath`) and cache under that page's profile, so PDP navigation data caches like the PDP HTML. Earlier docs said `/_server` always bypassed the cache; that is no longer true. POST server-fn bodies are hashed (tracking params stripped) for deferred sections. Always bypassed: `/_build`, `/deco/`, `/live/`, `/.decofile` plus `extraBypassPaths`.
- **UTM parameters are stripped** — `utm_*`, `gclid`, `fbclid` are removed from cache keys to improve hit rates (and a request carrying them is never stored — see `references/worker-entry.md`)
- **Segment hashing** — user segments (from matchers/flags) are hashed into the cache key so different audiences get different cached responses


## Package Exports

```ts
// Headers and profiles
import { cacheHeaders, routeCacheDefaults, detectCacheProfile } from "@decocms/blocks/sdk/cacheHeaders";
import { getCacheProfile, registerCachePattern } from "@decocms/blocks/sdk/cacheHeaders";

import { setCacheProfile, registerPrivatePaths, loaderCacheOptions } from "@decocms/blocks/sdk/cacheHeaders";

// Worker entry factory — from the root. (@decocms/tanstack does have a few
// ./sdk/* subpaths, e.g. ./sdk/cdnSegment, but createDecoWorkerEntry is root-only.)
import { createDecoWorkerEntry } from "@decocms/tanstack";

// Loader cache
import { createCachedLoader, clearLoaderCache } from "@decocms/blocks/sdk/cachedLoader";
```
