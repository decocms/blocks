# Loader cache (server-side SWR) — `createCachedLoader`

In `setup.ts`, wrap commerce loaders with `createCachedLoader`:

```ts
import { createCachedLoader } from "@decocms/blocks/sdk/cachedLoader";

const cachedPLP = createCachedLoader("vtex/plp", vtexPLP, {
  policy: "stale-while-revalidate",
  maxAge: 60_000,
});
```

This is a per-isolate in-memory cache (bounded memory tier via `createCacheStore`, optionally backed by the shared CacheStorage). Resets on cold start. Includes request deduplication (single-flight) and **byte-based** eviction, default cap 32 MB. The cap is an **estimate**, not a heap bound: entry size is `JSON.stringify(value).length` (min 512), and object-heavy payloads can occupy ~64–160 MB of real heap at the cap. Override with `DECO_LOADER_CACHE_MAX_BYTES` — but that is read from `process.env`, which Workers only populate with `nodejs_compat` on a recent `compatibility_date` (empty on `2024-09-23`, populated on `2025-06-01`); otherwise call `setLoaderCacheMaxBytes(bytes)` in `setup.ts` before wrapping any loader. It used to be an LRU capped at 500 entries; that was replaced because PLP payloads (~0.5–2 MB each) blew past the 128 MB isolate limit well under 500 entries. `loaderCacheOptions(profile)` from `@decocms/blocks/sdk/cacheHeaders` gives the profile's `{ policy, maxAge, staleIfError }` to pass instead of literals. `POST /_cache/purge-loaders` (same bearer token as `/_cache/purge`) clears the **memory tier** of the isolate that serves the request only; entries in a shared `cacheStorage` tier stay until their TTL and can repopulate memory. Redeploy (new scope) for a global flush.
