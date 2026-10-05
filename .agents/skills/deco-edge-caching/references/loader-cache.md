# Loader cache (server-side SWR) — `createCachedLoader`

In `setup.ts`, wrap commerce loaders with `createCachedLoader`:

```ts
import { createCachedLoader } from "@decocms/blocks/sdk/cachedLoader";

const cachedPLP = createCachedLoader("vtex/plp", vtexPLP, {
  policy: "stale-while-revalidate",
  maxAge: 60_000,
});
```

This is a per-isolate in-memory cache (bounded memory tier via `createCacheStore`, optionally backed by the shared CacheStorage). Resets on cold start. Includes request deduplication (single-flight) and **byte-based** eviction, default cap 32 MB (`DECO_LOADER_CACHE_MAX_BYTES` overrides). It used to be an LRU capped at 500 entries; that was replaced because PLP payloads (~0.5–2 MB each) blew past the 128 MB isolate limit well under 500 entries. `loaderCacheOptions(profile)` from `@decocms/blocks/sdk/cacheHeaders` gives the profile's `{ policy, maxAge, staleIfError }` to pass instead of literals. `POST /_cache/purge-loaders` (same bearer token as `/_cache/purge`) clears it for the isolate that serves the request; redeploy for a global flush.
