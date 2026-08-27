# CDN caching (Cloudflare) — `@decocms/tanstack`

## The short version

Every deco storefront serves HTML with `CDN-Cache-Control: no-store`, so
`Cf-Cache-Status` is always `BYPASS`. **That is correct, not a bug**, and the
`X-Cache: HIT` next to it means the response *was* served from cache — the
Worker's own Cache API. What `no-store` costs is the Worker invocation, not the
cache.

This document explains why, and what you can turn on.

## Why `no-store` is the default

The Worker keys its edge cache on a **synthetic Request**, not the URL the
visitor typed (`buildCacheKey` in `sdk/workerEntry.ts`):

| Param | Meaning | When it applies |
|---|---|---|
| `__cf_device` | mobile / desktop / tablet | always — `deviceSpecificKeys` defaults to `true` |
| `__seg` | the site's `buildSegment` (device, logged-in, sales channel, region) | when the site supplies one |
| `__cf_geo` | country / region / city | `geoCacheKey: "auto"` turns this on for sites with a location matcher |
| `__bot` | crawler vs human — bots render every section eagerly, ~10x the payload | per request |
| `__fetch` | programmatic fetch (`Sec-Fetch-Dest: empty`), also eager | per request |
| `__abf` | sticky A/B cohort cookie | visitors in a test |
| `__v` | build hash | per deploy |

Cloudflare's CDN keys on the raw URL, and ignores `Vary` beyond
`Accept-Encoding`. So if the CDN were allowed to cache by URL alone, it would
serve desktop HTML to mobile, one region's page to another, or a crawler's eager
render to a human. `no-store` is what prevents that.

This is also why `cdnCacheControl: "match-profile"` is **ignored** unless the
cache key really is the raw URL (no `buildSegment`, `deviceSpecificKeys: false`,
`geoCacheKey: "off"`). It warns once and keeps `no-store` rather than silently
cross-serving segments.

## What you can turn on today: `/_serverFn` (no infra work)

SPA navigation and prefetch data requests **can** be CDN-cached, because the
client can put the segment in the URL itself. With the segment in the URL, the
CDN's key becomes equivalent to the Worker's.

Two steps:

```ts
// src/worker-entry.ts
createDecoWorkerEntry(serverEntry, {
  cdnCacheControl: "serverfn-segment",
  buildSegment: (request) => ({ /* ... */ }),  // required
});
```

```ts
// src/start.ts
import { createStart } from "@tanstack/react-start";
import { decoServerFnFetch } from "@decocms/tanstack/sdk/serverFnFetch";

export const startInstance = createStart(() => ({
  serverFns: { fetch: decoServerFnFetch },
}));
```

The client appends `?__cseg=<device>.<buildHash>`; the Worker recomputes the
segment from the request and only relaxes `no-store` when the two match.

**The marker is a hint, never a source of truth.** Missing, diverging, forged,
or stale-build markers, plus logged-in / region / sales-channel / custom-segment
requests, bot user agents and A/B cohort cookies, all keep today's `no-store`.
The worst case is not caching — never a wrong response.

The build hash is in the token because **deploying does not purge the CDN**: the
framework's purge clears `caches.default`. The URL has to change on its own when
the bundle does.

HTML documents are not covered: the initial navigation is a browser request,
with no JS hook to attach a marker.

## Caching HTML at the CDN (needs zone configuration)

Not a header change. The zone has to reproduce the parts of the cache key that
the URL doesn't carry.

### Division of labour

| Who | Decides |
|---|---|
| Worker (headers) | **whether** a response may be cached — private routes, logged-in, drafts, set-cookie |
| Cache Rules (zone) | **how to key** it — the dimensions that would hand one visitor another's entry |

The rules deliberately do **not** list private paths. The Worker already emits
`no-store` for them and Cloudflare honours it, so a site calling
`registerPrivatePaths([...])` propagates to the CDN with no rule change.

### The rules

Generated from the same constants the Worker uses, so the two cannot drift:

```bash
tsx node_modules/@decocms/blocks-cli/scripts/cdn-rules.ts
```

Two rules: bypass anything segment-sensitive (auth cookie, A/B cookie, bot UA,
`Sec-Fetch-Dest: empty`, draft/preview/matcher-override), then cache the rest
with **Cache by device type** on and edge TTL `respect_origin` — so the TTL
keeps coming from the cache profile the Worker resolves.

### Enabling per site

Sites are custom hostnames under one deco zone, so a rule applies to all of them
at once. Enablement rides on per-hostname custom metadata:

```bash
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/custom_hostnames/$ID" \
  --request PATCH --header "Authorization: Bearer $TOKEN" \
  --json '{"custom_metadata": {"deco_cdn_html": "on"}}'
```

Rollout and rollback are that PATCH (propagates in ~30s). Requires the
`SSL and Certificates Write` permission.

### Invalidation

Set both env vars and `POST /_cache/purge` also purges the CDN for the
request's hostname:

```
DECO_CF_ZONE_ID=...
DECO_CF_PURGE_TOKEN=...     # API token with cache-purge on the zone
```

Purge **by hostname**, not by URL: it is correctly scoped in a shared zone, and
immune to cache-key customization (a URL purge would have to replay the headers
that make up the key). Without both vars it is a no-op — `caches.default` is
then the only copy anyway.

Keep the CDN TTL short at first, so a failed purge expires on its own instead of
serving stale content indefinitely.

### Before enabling, check

- `buildSegment` is wired. Without it, `segment.loggedIn` is never set and the
  logged-in bypass is inert — authenticated and anonymous visitors share one
  entry. The Worker warns about this at boot.
- The site has a build hash (not `"dev"`).
- `geoCacheKey` is `"off"`. While only device is in the CDN cache key, a site
  with a location matcher must stay bypassed or regions leak.

Then walk a real site — home, PLP, PDP, search, checkout, account, wishlist —
logged in and anonymous, mobile and desktop, with and without a bot user agent,
checking `Cf-Cache-Status`, `X-Cache`, `X-Cache-Segment` and
`CDN-Cache-Control`. In particular: log in, open the wishlist, and confirm the
response never comes from the CDN.

## Configuring what is never cached

Cache configuration from a site can **tighten** freely; loosening is what leaks
user data, so it is deliberately awkward.

```ts
// The safe tool. Can only restrict. Propagates to the CDN on its own.
registerPrivatePaths(["/listadedesejos", "/trocas"]);
```

Built-in private prefixes cover cart/checkout/account/login/orders/wishlist/
profile/signup/returns, case-insensitively and behind a locale prefix
(`/pt/checkout`). See `PRIVATE_SEGMENTS` in `@decocms/blocks/sdk/cacheHeaders`.

Guardrails you may run into:

- `registerCachePattern` still wins over built-ins — **except** it cannot turn a
  private path public.
- `setCacheProfile("private", { isPublic: true })` is refused with a warning.
  `allowPublicPrivateProfile()` opts out, and there is no good reason to.
- `bypassPaths` no longer replaces the framework defaults, it adds to them.
