# SWR fetch cache — `createFetchCache` (`@decocms/blocks/sdk/fetchCache`)

The last cache before the commerce upstream. One shared implementation in `packages/blocks/src/sdk/fetchCache.ts` (tests: `fetchCache.test.ts`), bound once per commerce app. It caches **parsed JSON bodies of upstream GETs** (or anything the caller keys deterministically, e.g. a GraphQL POST keyed by a hash of query + variables), per isolate, with:

- in-flight dedup — concurrent callers for one key share one upstream call;
- stale-while-revalidate — a stale entry is served while a single background refresh runs;
- stale-if-error — the last-good entry keeps serving while the origin fails, up to a window;
- an inflight backstop — a hung `fetch()` cannot pin a dedup slot forever;
- fresh TTL by HTTP status, and a bounded LRU memory tier.

It replaced per-app copies (VTEX's was the original, itself ported from deco-cx/deco `runtime/fetch/fetchCache.ts`). Do not copy-paste it into a new app — call `createFetchCache` (see "Why the metric lives here").

## Binding it in an app

Each app owns one module-level instance with its own tuning knobs:

```ts
import { createFetchCache } from "@decocms/blocks/sdk/fetchCache";

const cache = createFetchCache({
  provider: "vtex",          // metric label + store namespace (`fetch:vtex`)
  maxEntries: 500,           // memory-tier entry cap
  freshTtlMs: { success: 180_000, notFound: 10_000, serverError: 0 },
  staleIfErrorMs: 86_400_000, // how long PAST freshness last-good may serve
  inflightBackstopMs: 15_000, // MUST exceed the underlying fetch's own timeout
});

const body = await cache.fetchWithCache<T>(url, () => instrumentedFetch(url), { ttl, sieMs });
```

Real bindings: `packages/apps-vtex/src/utils/fetchCache.ts` (`fetchWithCache`, `clearFetchCache`, `getFetchCacheStats`; knobs in `apps-vtex/src/utils/constants.ts`, the values above) and `packages/apps-magento/src/utils/fetchCache.ts` (`magentoCachedFetch`). For which VTEX calls go through it (`vtexCachedFetch`, intelligent search, cross-selling) and the VTEX knobs' rationale, load the **`apps-vtex`** skill.

Per-call options: `ttl` overrides the status-based fresh TTL for that call; `sieMs` overrides the instance's stale-if-error window (`0` disables stale serving).

## Decision flow (per `fetchWithCache` call)

Age = now − `createdAt`; fresh TTL = `opts.ttl ?? freshTtlMs[status class]`.

| State | What happens | Metric `status` |
|---|---|---|
| Entry, age ≤ fresh TTL | Return cached body | `HIT` |
| Entry stale, age ≤ fresh TTL + SIE | Return cached body now; start one background refresh if none is running (`entry.refreshing`) | `STALE-HIT` |
| Entry older than fresh TTL + SIE | Delete it, fall through to the cold path | (cold path) |
| No entry, same key in flight | Join the in-flight promise — no upstream call of our own | `HIT` |
| No entry, nothing in flight | Foreground fetch, wrapped in the backstop timeout; store if TTL > 0 | `MISS` |

Details that matter when debugging:

- **Response handling** (`executeFetch`): a single attempt — retries/backoff/breaker belong to the underlying (resilience) fetch, and retrying here would multiply upstream calls. **5xx throws** (`fetchWithCache: <status> ... — <url>`) and is never stored. 2xx returns parsed JSON. Any other non-2xx returns `null`; it is cached only if its status has a TTL > 0 — i.e. 404 (`notFound`). 400/401/403 etc. get TTL 0: returned as `null`, not stored, so they hit upstream every time.
- **Stored lifetime** = `createdAt + freshTTL + SIE` — that's the memory-tier `expiresAt`. A 404 entry therefore lives for its short fresh TTL *plus* the full SIE window and is stale-served (with background refresh) during it, same as a 2xx; the comment in `apps-vtex/src/utils/constants.ts` ("treated as expired (404/5xx)") does not match the code for 404.
- **Background refresh**: no retry; runs under `cacheBackground` (`ctx.waitUntil` on Workers). A fresh result replaces the entry — **unless it would downgrade a 2xx to a ≥400**, in which case the old 2xx stays and `refreshing` resets, so the next stale read tries again. A thrown refresh (5xx, network, backstop timeout) also just resets `refreshing`. On a healthy origin the refresh keeps resetting `createdAt`, so the "too stale" branch is only reached during an outage longer than SIE — then the cold fetch's 5xx propagates to the caller.
- **The backstop** (`withTimeout`, `inflightBackstopMs`) rejects the shared promise so `.finally()` always evicts the in-flight slot; without it a never-settling subrequest makes every later caller for that key join a zombie promise. It is a leak guard, not the request timeout — keep it above the per-call timeout the fetch owns.
- **The `refreshing` flag lives on the entry object.** With a shared storage tier, an entry read back from storage is a fresh decoded copy, so two isolates can each run one refresh.
- `clear()` drops entries + in-flight slots (memory only); `getStats()` returns `{ entries, inflight }`.

## Storage, keys, eviction

The entries live in `createCacheStore("fetch:<provider>", maxEntries)` (`packages/blocks/src/sdk/cacheStorage.ts`):

- **Memory tier is LRU by access** (a read moves the key to the back of the `Map`), bounded by `maxEntries` **and** a byte cap that `createFetchCache` leaves at the store default, **4 MB** (estimated as JSON length × 2, min 512 B per entry). A single body over 4 MB is never kept in memory. The `FetchCacheConfig.maxEntries` doc comment ("oldest `createdAt` evicted first") is out of date.
- **Keys are scoped.** `store.key(raw)` = `JSON.stringify([scope, "fetch:<provider>", raw])`. Under `createDecoWorkerEntry` the per-request scope is `[origin, BUILD_HASH, decofile revision, segment hash or mobile/desktop, geo param, …]`. Consequences: a deploy *or a CMS publish* (new revision) starts the fetch cache cold; mobile and desktop do not share entries; outside a worker request (Node, tests, Next) the scope is `"local"`.
- **Private requests bypass it.** The worker marks drafts, logged-in segments, `Authorization` headers, `__deco_preview`, matcher overrides, `/live/previews` and `/deco/render` as private, and dev mode likewise → `disabled: true`: no reads, no writes (in-flight dedup still applies). So "it never caches in dev" is expected.
- **Optional shared tier.** If the site passes `cacheStorage: (env, req) => CacheStorage` to `createDecoWorkerEntry`, completed entries are also written there (`createKVCacheStorage` / `createWebCacheStorage` adapters) and a memory miss reads through it. In-flight promises never leave the isolate.
- **No purge endpoint for it.** `POST /_cache/purge-loaders` clears `createCachedLoader` only. Levers: wait the TTL, publish/redeploy (new scope), or call the app's `clearFetchCache()` in-process.

## The metric, and why it is emitted inside the cache

Every decision calls `recordCacheMetric(decision !== "MISS", undefined, decision, "swr", provider)` → counter `deco.cache.requests{status, layer="swr", provider=<provider>}` plus span attributes `deco.cache.status/layer/provider`. `profile` is deliberately **unset**: it is the edge layer's page-type label (and `cachedLoader`'s loader name), so a `sum by (profile)` panel never mixes page types with backend names (asserted in `fetchCache.test.ts`). The SWR layer never emits `STALE-ERROR` — a stale serve during an outage is still `STALE-HIT`. No meter configured (dev, tests) = the counter is a no-op; the span attributes are still set on the active span.

It must be emitted here, not in `createInstrumentedFetch`: on a HIT the cache returns **before** `doFetch` runs, so the instrumented fetch (`http.client.request.duration`) never sees it. Hit ratio can only be measured in the cache. That is the whole reason for one shared implementation — a per-app copy goes dark. Note the stale comments: `FetchCacheConfig.provider` says it is emitted as `deco.cache.profile`, and the `apps-magento` binding and the `fetchCache.test.ts` header say `profile=<provider>`; the code and the test assertions use `provider`.

Missing in ClickHouse? Check, in order: the app calls `createFetchCache` (not a hand-rolled Map); the site configured a meter; the app's egress also goes through `createInstrumentedFetch` with `setXFetch(createXFetch())` wired at boot (see CLAUDE.md "Cache & upstream observability" — the `REQUIRED` list in `packages/apps-commerce/src/instrumentation-guardrail.test.ts` enforces the shipping half only). `apps-algolia` is intentionally uninstrumented.

## Cross-request promises on Workers

The in-flight `Map` hands one request's promise to another. That relies on the `no_handle_cross_request_promise_resolution` compatibility flag in the site's `wrangler.jsonc` (the migrate scaffold adds it; see `packages/blocks-cli/scripts/migrate/phase-scaffold.ts`); the same holds for `createCachedLoader` and the layout in-flight maps. If workers hang with cross-request promise warnings, check that flag before blaming the cache.
