# Case study: an egress audit on a VTEX storefront

A worked example. The site ran on the v1 Fresh/Deno stack, so the code it changed (loader
`cacheKey` exports, a Redis loader cache, site middleware) does not exist on v8. The lessons do;
each one ends with where it lives on v8.

## Starting point

- About 88 GB a week of CDN egress, about 52% cache hit rate.
- One listing page at 13 MB of HTML was 46% of a day's egress on its own.
- On a second VTEX storefront audited the same way, the origin was about 41% of a cluster's
  cost, almost all egress.

## What happened, in order

**1. The broad first cut.** Capped listing size at 48 products, set cache headers per path, took
tracking params out of the loader cache key, blocked aggressive crawlers (about 26% of bandwidth
was crawlers stacking filter combinations), redirected URLs with three or more stacked filters to
the clean path, and fixed layout shift (home desktop CLS from 0.42 to 0.0025).

**2. The hit rate dropped, from 52% to 38%.** CDN telemetry showed three causes curl had not:
top-level category links answered a 307 with no cache headers, so every main-menu click went to
origin; a static sprite answered `Vary: If-None-Match`, splitting its cache by ETag; listing TTLs
were too short. The device was also dropped from the listing key, since listings rendered the same
for every device.
*v8:* trap 5 (redirects), trap 4 (`Vary`), trap 3 (device split) in `egress-traps.md`.

**3. Every returning visitor was private.** The site's middleware bypassed the cache when the
*request* carried the checkout cookie, which VTEX sets for almost every returning visitor, even
with an empty cart. Checking the *response* for a new cookie instead fixed it.
*v8:* `loggedIn` in `buildSegment` must read the sign-in cookie only (`cache-keys.md`, rule 3).

**4. Payload trim.** Warm responses still averaged 180 KB compressed, because a HIT serves whatever
the miss produced. The product graph carried about 32 installment price entries per offer, and each
color swatch carried a full product.

| Page | Before | After |
|---|---|---|
| Best-sellers listing, raw HTML | 28.7 MB | 2.89 MB (−89.9%) |
| Same page, `UnitPriceSpecification` count | 63,744 | 585 (−99.1%) |
| Campaign listing, raw HTML | 5.84 MB | 1.77 MB (−69.7%) |

Cards were trimmed to the two price entries they read; the product detail page, the one consumer of
the full graph, was left alone. The same audit found the CDN's "cache by device type" rule was off,
so mobile HTML could be served to desktop.
*v8:* trap 8 and `deco-storefront-performance`.

**5. A consolidation, a revert, a re-land.** Three listing sections were merged into one with one
cached payload, plus a custom "last good copy" and failure backoff on top of the loader cache. The
upstream search returns `null` instead of throwing for some queries. The merged loader turned that
into a valid-looking empty result, the cache kept it for 30 minutes, and mobile users saw an empty
listing. Reverted four hours later. The re-land threw on `null` (errors were not cached), dropped
the custom layer, and kept the sections separate: an in-request dedupe still gave one upstream
call per render, and a failure now emptied one section instead of the whole page.
*v8:* rule 5 (store only clean 200s, `x-deco-degraded`) and single-flight in `cache-keys.md`.

**Last: the cache that held one key.** The loader cache had a single 8.4 MB entry. Every cached
loader gated its key on "anonymous visitor", and the platform's segment cookie marks a visitor as
not anonymous as soon as it carries any `utm_*` field, so about 99% of real traffic skipped the
cache. Gating on the fields that change the response (sales channel privacy, campaigns, price
tables, region) and keying on those fields only fixed it. Probes for 3 listings × 7 visitor
profiles then asserted that every profile hit the same entry.
*v8:* rules 1 to 3 in `cache-keys.md`, the fingerprint probe in `perf-guardrails-e2e.md`.

## Outcome

Projected 25 to 30 GB a week, from about 88: roughly a 65–70% drop, over 11 merged changes and two
reverts.

## Lessons

1. A HIT is not the goal. The key must exist for real traffic, the stored body must be small, and
   nothing may split the entry for no reason.
2. Test the failure path. Most of the regressions were "the upstream returned something odd and
   we cached it".
3. Do not build a cache on top of a cache. A per-process "last good" copy diverges between
   processes and hides failures.
4. Check what the CDN actually does. A header that looks right in curl is not proof that the CDN
   caches by it. A diagnostic response header that echoes what the CDN saw found the device rule
   in minutes.
5. One merged section is one failure domain. Keep sections that can fail separately apart.
6. Be exact about request cookies vs response cookies when a cookie decides cacheability.
