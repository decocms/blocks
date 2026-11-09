# Traffic ramp: splitting the host with the old site

During the ramp the new worker takes every request on the production host and
sends a share of visitors to the old origin. On a TanStack site this is
`abTestingRoutes` from `@decocms/compat-v7/tanstack/worker`, v7's
`withABTesting` as a `routes` handler for `createDecoWorker`.

```ts
// src/worker-entry.ts
import { abTestingRoutes } from "@decocms/compat-v7/tanstack/worker";

const abTesting = abTestingRoutes({
  worker: () => worker,
  kvBinding: "SITES_KV",                                      // the default
  shouldBypassAB: (_request, url) => isNewSiteOnly(url.pathname),
});

const worker = createDecoWorker({
  // …
  routes: async (request, env, ctx) => (await abTesting(request, env, ctx)) ?? siteRoutes(request),
});
export default worker;
```

## How a visitor gets a bucket

- The config is a KV entry under the request's **hostname**: `{ workerName, fallbackOrigin, abTest: { ratio } }`, with `ratio` from 0 to 1. Without the binding, without an entry for the host, or without `fallbackOrigin`, the handler returns `null` and the worker serves everyone.
- The bucket comes from, in order: the `?_deco_bucket=worker|fallback` override; the `_deco_bucket=<bucket>:<ratio %>` cookie, if it was set under the current ratio; the FNV-1a hash of `cf-connecting-ip` against the ratio (a random draw without that header).
- Every answer that goes through the split carries `x-deco-bucket` (a bypassed request does not). The cookie is set again when the bucket or the ratio changed, so changing the ratio re-draws everyone.
- The "worker" bucket is the worker called back, so it goes on to the site's other routes, its page cache and the page. If that call throws and `circuitBreaker` is on (the default), the visitor gets the old origin, tagged `fallback`.
- The "fallback" bucket gets `proxyToFallback`: the request goes to `fallbackOrigin` with `x-forwarded-host` set to the public host, redirects are not followed, and the old hostname is rewritten back to the public one in `Set-Cookie` domains, `Location`, and the text of 2xx bodies (streamed).

## Traps

**The worker answers some paths before the split.** `createDecoWorker` runs,
in this order: `/deco/_liveness`; a 404 for v7's admin paths (`/deco/*`,
`/live/*`, `/.decofile`); the CMS redirects; then `routes`. So:

- An old page served from the fallback bucket that calls `/live/invoke/...`, `/deco/render` or any other `/live/*` or `/deco/*` path on the same host gets a 404 from the worker. Those calls never reach the old origin. Test the fallback bucket's interactions (add to cart, partial loads, forms) at 0%, before any visitor is on it.
- The new site's redirects apply to both buckets. A rule meant for the new URL scheme also redirects visitors on the old site.

**`shouldBypassAB` reads backwards.** `true` means "serve from this worker,
skip the draw". Return `true` for routes that exist only on the new site
(headless login and account routes, the sitemap, the platform proxies the new
site owns). Leave shared proxies (checkout, `/api`) in the draw unless both
buckets can use the new site's proxy.

**Old-site responses leave like any route response.** The worker adds
`CDN-Cache-Control: no-store` when the old origin sets none. On an HTML
response it also adds each of its security headers the old origin did not
set, including `Cross-Origin-Opener-Policy: same-origin-allow-popups` and a
`Content-Security-Policy` with a `frame-ancestors` list. Diff the old site's headers through the worker
against the old site direct ([proxy-headers-checkout.md](./proxy-headers-checkout.md#header-diff-against-the-old-site)).

**Indexing at 0%.** The old site may decide `noindex` from its own hostname.
It receives `x-forwarded-host` with the public host; confirm it honors it.
Check `robots.txt` and the robots meta on the public host before you create the
route ([seo-analytics.md](./seo-analytics.md#indexability-and-status-codes)).

**Existing proxies.** Checkout, `/api`, media: test each in both buckets. On
one store the split broke proxies the site already had.

## Forcing a bucket

```bash
for b in worker fallback; do
  for p in / /checkout/ /robots.txt /sitemap.xml; do
    curl -s -o /dev/null -D - "https://$HOST$p?_deco_bucket=$b" \
      | tr -d '\r' | awk -v b="$b" -v p="$p" '/^HTTP/{s=$2} tolower($1)=="x-deco-bucket:"{x=$2} END{print b, p, s, x}'
  done
done
```

The override also sets the cookie, so a browser stays in the forced bucket
for the next pages. Clear `_deco_bucket` to get a fresh draw.

## Rollback

Set `abTest.ratio` to `0` in the host's KV entry: every visitor without a
current cookie draws `fallback`, and old cookies were set under another ratio,
so they draw again. If the split handler was removed from the code, rollback is
a code rollback instead; know which one you have.

## After 100%

Keep the handler at ratio 1 for a few days (a rollback is then one KV write),
then remove it and the KV entry in a normal deploy.
