# Client route cache — `staleTime` / `gcTime`

`cmsRouteConfig` spreads `routeCacheDefaults("product")` and `cmsHomeRouteConfig`
spreads `routeCacheDefaults("static")`. Source of truth:
`packages/blocks/src/sdk/cacheHeaders.ts` (`routeCacheDefaults`, importable from
`@decocms/blocks/sdk/cacheHeaders`).

### Production

`staleTime` is **always `Infinity`** in production, for every profile. Only
`gcTime` varies, and it comes from the profile's `client.gcTime`:

| Profile | staleTime | gcTime |
|---------|-----------|--------|
| static | `Infinity` | 30 min |
| product | `Infinity` | 5 min |
| listing | `Infinity` | 5 min |
| search | `Infinity` | 2 min |
| cart | `Infinity` | 0 |
| private | `Infinity` | 0 |
| none | `Infinity` | 0 |

Why `Infinity`, not a per-profile window: TanStack Router v1 dehydrates SSR route
data with `updatedAt: 0`, so any finite `staleTime` makes the SSR data look
stale the moment the client hydrates. That fires a second
`/_serverFn/loadCmsPage` request — a separate Worker isolate that re-runs every
loader — doubling origin load on every first navigation (decocms/blocks#355).
With `Infinity` the router never time-refetches in-memory data. `gcTime` only
starts counting once the route match becomes **inactive** (navigated away from);
data for the route currently on screen is not bounded or refreshed by it. The
edge cache (see `deco-caching`) only governs freshness when a new loader request
actually happens — a navigation after the match was GC'd, a fresh page load, or
an explicit `router.invalidate()`.

The profile objects still carry a `client.staleTime` (5 min / 1 min / 1 min /
30 s for static / product / listing / search). `routeCacheDefaults` ignores it
in production — an earlier version of this doc listed those numbers as the
effective `staleTime`, which they are not. Overriding
`setCacheProfile(name, { client: { staleTime } })` has no effect on routes
built with `routeCacheDefaults`.

### Development

`staleTime: 5_000` (5 seconds) — not zero! — and `gcTime: 30_000`, for every
profile. Dev mode is `NODE_ENV === "development"` **or**
`DECO_CACHE_DISABLE === "true"`.

With `staleTime: 0`, TanStack Router re-fetches on every navigation even if `loaderDeps` returns identical deps. This causes:
- Double-fetch on variant changes (despite `ignoreSearchParams`)
- Prefetch + click = 2 server calls

Setting 5s staleTime allows rapid interactions (variant clicks, back/forward) to use cached data while still reflecting changes within a few seconds.
