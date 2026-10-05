# The worker entry — `createDecoWorkerEntry` (`@decocms/tanstack`)

## Site Worker Entry (10 lines)

**CRITICAL**: `wrangler.jsonc` must point to this custom file, NOT to `@tanstack/react-start/server-entry`. TanStack Start's Cloudflare adapter completely ignores custom `export default` — it generates its own handler that calls `createStartHandler` directly. Without a separate worker-entry, none of the caching, admin routes, or purge logic will execute in production.

```jsonc
// wrangler.jsonc
{
  "main": "./src/worker-entry.ts"
  // NOT: "main": "@tanstack/react-start/server-entry"
}
```

```ts
// src/worker-entry.ts
import "./setup";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createDecoWorkerEntry } from "@decocms/tanstack";

const serverEntry = createServerEntry({
  async fetch(request) {
    return await handler.fetch(request);
  },
});

export default createDecoWorkerEntry(serverEntry);
```

### With Custom Overrides

```ts
export default createDecoWorkerEntry(serverEntry, {
  // Override profile for specific URLs
  detectProfile: (url) => {
    if (url.pathname.startsWith("/institucional")) return "static";
    return null; // fall through to built-in detection
  },
  // Disable mobile/desktop cache key splitting
  deviceSpecificKeys: false,
  // Custom purge token env var
  purgeTokenEnv: "MY_PURGE_TOKEN",
  // Add extra bypass paths
  extraBypassPaths: ["/preview/"],
});
```


## Factory Features

`createDecoWorkerEntry` provides:

1. **Cache API integration** — `caches.default.match()` / `.put()` for edge caching
2. **Device-specific keys** — mobile/desktop get separate cached HTML (`__cf_device` param)
3. **Per-URL profiles** — `detectCacheProfile(url)` selects the right Cache-Control
4. **Immutable static assets** — `/_build/assets/*-{hash}.*` get `immutable, max-age=31536000`
5. **Private path protection** — strips public Cache-Control from cart/checkout/account responses
6. **Cache API TTL fix** — stores with `max-age={sMaxAge}` since Cache API ignores `s-maxage`
7. **Purge API** — `POST /_cache/purge` with bearer token (`PURGE_TOKEN` env by default, `purgeTokenEnv` to rename, `false` to disable) to invalidate paths; `POST /_cache/purge-loaders` clears the in-memory loader cache of the serving isolate
8. **Diagnostic headers** — `X-Cache: HIT|STALE-HIT|STALE-ERROR|MISS|BYPASS`, `X-Cache-Profile: {profile}`, `X-Cache-Version`, and `X-Cache-Store: skipped-tracking` when a response was served but deliberately not stored


## Tracking Params, Geo and Cache Poisoning

- **Tracking params** (`utm_*`, `gclid`, `fbclid`, … plus anything registered via `registerTrackingParams`) are dropped from the key. A request that *carries* them is served from the clean entry but **never stored** (`X-Cache-Store: skipped-tracking`). The renderer saw the raw URL and embeds it, so storing it would serve one visitor's `gclid` to everyone.
- **POST server-fn bodies** are hashed with tracking params stripped, so deferred sections of ad visitors share the clean entry.
- **Geo:** don't put the Cloudflare region in `buildSegment`. `geoCacheKey: "auto"` adds it only when a `website/matchers/location.ts` block exists. The worker warns once if it sees a raw-geo `regionId` with no location matcher.

Probes, fixes and a PR checklist for these and the other egress regressions: `deco-storefront-egress-guardrails`.


## Cache Versioning with BUILD_HASH

Every cached entry's key is suffixed with `__v=<hash>` so a new deploy starts a fresh cache namespace and previously-cached HTML (which references now-deleted asset filenames like `/assets/main-XYZ.js`) stops being served the moment the new worker is live. Old entries become orphaned and expire naturally — no purge endpoint call required.

The hash is resolved automatically by `decoVitePlugin()` at build time and injected into the worker bundle as `__DECO_BUILD_HASH__`. Resolution order:

1. `WORKERS_CI_COMMIT_SHA` — Cloudflare Workers Builds default env var ([CF docs](https://developers.cloudflare.com/changelog/2025-06-10-default-env-vars/)). This is the production deploy path-of-record per `MIGRATION_TOOLING_PLAN.md` D6.3.
2. `git rev-parse --short=12 HEAD` — for someone running `wrangler deploy` from a developer laptop.
3. `Date.now().toString(36)` — last-resort fallback so the cache-bust invariant never silently regresses.

`createDecoWorkerEntry` reads `env.BUILD_HASH` first (explicit override path, e.g. `wrangler deploy --var BUILD_HASH:foo`) and falls back to the `__DECO_BUILD_HASH__` constant. Sites running `decoVitePlugin()` get the behaviour for free — **no per-site dashboard, `wrangler.jsonc`, or `--var` configuration required**.

Underneath the `__v` param, stored entries go through `createResponseCache` (`@decocms/blocks/sdk/responseCache`), whose key is scoped by `[origin, BUILD_HASH, decofile revision]` — so a CMS publish that reaches an isolate (new `getRevision()`) also starts a fresh namespace there, as does the request-scoped `cacheStorage` scope used by the layout and SWR caches (`swr-fetch-cache.md`). `createResponseCache.put` refuses anything without a `max-age`, anything `private`/`no-store`/`no-cache`, and any response carrying `Set-Cookie`. By default the backing store is `caches.default`; the `cacheStorage: (env, request) => CacheStorage` option replaces it (and also becomes the shared tier for the in-memory caches).

The active version is exposed on every cached response via the `X-Cache-Version` header for observability. Confirm a new deploy is shipping the right hash with:

```bash
curl -sI https://www.example.com/ | grep -i x-cache-version
```
