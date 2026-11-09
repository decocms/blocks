---
name: deco-storefront-caching
description: "Edge caching and origin egress for storefronts on @decocms/blocks 8. Covers the site-owned pageCache on createDecoWorker from @decocms/tanstack/worker (isCacheable, cacheVersion keyed by build and content revision, assignmentsKey, segmentKey and the __cseg token, serverFnPagePath, DEGRADED_HEADER, markPrivate, drafts and old releases never cached, the purge route), cache-key rules (key only on what changes the payload, strip tracking params, segment without splitting for nothing, never store non-200, degraded or empty pages, one upstream call per request), the traps that kill hit rate or raise egress (Set-Cookie, tracking-param poisoning, region and device splits, Vary, redirects, hidden variants, payload bloat), the Next.js equivalents in @decocms/nextjs/proxy, and verification with curl, X-Cache headers, scripts/html-anatomy.mjs and Playwright guardrails. Load it when the hit rate drops, egress or upstream calls rise, a page is never cached, or a change touches the worker entry or the cache key."
---

# Storefront caching and egress (v8)

On v8 the framework caches no page. `createDecoWorker` from `@decocms/tanstack/worker` decides
drafts, the visitor and each test's assignment, then hands every cacheable request to the site's
own `pageCache`. The cache key, the TTLs and the purge route live in the site's
`src/worker-entry.ts`, usually a copy of the repo's example. So when the hit rate drops, the cause
is almost always in site code: the key, a cookie, a header, or a page that should not be stored.

Read this when you arrived with a number (egress up, hit rate down, upstream bill up) or with a
change to the worker entry, a loader on a cacheable page, or the segment.

## When to load what

| Reference | Load it when |
|---|---|
| [`references/worker-page-cache.md`](./references/worker-page-cache.md) | Wiring or changing `pageCache`: what the worker does for you, the helpers, profiles and TTLs, stale serving, server functions and `__cseg`, the purge route |
| [`references/cache-keys.md`](./references/cache-keys.md) | Writing or reviewing the key or `buildSegment`; a page cached empty or broken; deduping upstream calls; an upstream data cache |
| [`references/egress-traps.md`](./references/egress-traps.md) | Hit rate is low or egress is high and you need the list of causes, in the order to check them |
| [`references/verification.md`](./references/verification.md) | Proving a fix: curl probes, the headers to read, `scripts/html-anatomy.mjs`, telemetry |
| [`references/perf-guardrails-e2e.md`](./references/perf-guardrails-e2e.md) | Locking the gains in CI with a Playwright spec and probes |
| [`references/nextjs.md`](./references/nextjs.md) | The site runs on `@decocms/nextjs` instead of the TanStack worker |
| [`references/case-study.md`](./references/case-study.md) | You want a worked example of an egress audit, with measured numbers and two reverts |

`scripts/html-anatomy.mjs` (Node 18+, no dependencies) shows where the bytes of a page go:
`node .agents/skills/deco-storefront-caching/scripts/html-anatomy.mjs https://SITE/category`.

## The model in five lines

1. A request reaches `pageCache` only if `isCacheable` accepts it: a `GET` of the current release,
   no draft signal, no `Authorization`, not `/_build`, not `vite dev`. Everything else renders.
2. Every key carries `cacheVersion(cms, __BUILD_HASH__, url)`: `<build>.<content revision>`. A
   deploy or a publish moves every page to new entries. Nothing to purge after a publish.
3. Every key carries `assignmentsKey(page.assignments)`: the tests on and the campaigns running,
   never the visitor id. Visitors on the same side of every test share one entry.
4. The worker adds the visitor's first-visit cookie after `pageCache` answers, so a stored copy
   never carries it. Any other `Set-Cookie` outside the example's `SAFE_COOKIES` makes it treat
   the response as private and not store it.
5. A response that sets no `CDN-Cache-Control` leaves the worker with `CDN-Cache-Control: no-store`.
   The example lets the CDN keep only server-function data whose `__cseg` token matches.

## Order of work for "egress is high"

1. Get the numbers first: which paths, how many bytes, hit rate per path (`deco-performance-audit`
   in decocms/skills, or the `http.server.request.duration` metric by `cache` and `http.route`).
2. Pages that are never stored (`X-Cache: BYPASS`) cost on every visit. Fix those first.
3. Then keys that split for nothing (tracking params, region, device, assignments).
4. Then the size of what is stored (a fat HIT is still egress).
5. Lock it in with the Playwright guardrails, then watch telemetry for 24 hours.

## Related skills

- `deco-tanstack-site`: the worker entry, `createStart` with `decoServerFnFetch`, the router.
- `deco-nextjs-site`: Next.js setup; its caching reference covers ISR in depth.
- `deco-variants`: keeping variant pages cacheable, client-side personalization.
- `deco-storefront-performance`: payload trimming, duplicate upstream calls, Worker memory.
- `deco-apps`: which commerce responses are shopper-invariant and safe to cache.
- `deco-go-live`: the cache checks in the cutover list.
- `deco-v7-to-v8-migration`: moving v7's `createDecoWorkerEntry`, `buildSegment` and cache
  profiles into the worker entry (its caching-and-privacy reference).
- decocms/skills: `deco-performance-audit` (CDN numbers), `deco-bot-management` and
  `deco-cloudflare-waf` (crawler traffic), `deco-e2e-testing` (Playwright harness).
- Runbook: `docs/runbooks/cache-hit-drop.md` in this repo, for the cache-hit-drop alert.
