# Verifying cache and egress changes

Run these after every change, in order. A page that is never stored (trap 1) makes the later
checks look better than they are.

The headers below are the ones the example worker entry sets. If your `pageCache` names them
differently, adapt the greps.

## 0. Where to run

- Production or a preview deployment: the real thing. The Cache API is per data center, so a
  second request from the same place is what tells you whether the first one stored.
- Locally: `pageCache` never runs in `vite dev`. Build and use `vite preview` (Miniflare runs the
  Worker), as the example's `bun run build && bun run smoke` does.
- Always `GET`. `curl -I` sends `HEAD`, which never reaches `pageCache`. Use
  `curl -s -o /dev/null -D -`.

## 1. Is it stored?

```bash
UA='Mozilla/5.0 (Macintosh) Chrome/140'
H='^(cache-control|cdn-cache-control|vary|x-cache|x-cache-reason|x-cache-profile|x-cache-segment|x-cache-version|x-cache-age|set-cookie)'
for p in / /some-category /some-product/p '/s?q=shirt'; do
  echo "== $p"
  for i in 1 2; do curl -s -o /dev/null -D - -A "$UA" "https://SITE$p" | grep -iE "$H"; echo; done
done
```

Expect on the second request: `x-cache: HIT`, the profile you meant, `x-cache-version:
<build>.<revision>`, `vary: Accept-Encoding`, no `set-cookie` other than `deco_segment` on a first
visit. A `BYPASS` comes with `x-cache-reason`; `egress-traps.md` maps each reason to a cause.

After a deploy or a publish, `x-cache-version` changes and the first request is a `MISS` again.
That is expected.

## 2. What must never be stored

```bash
# A preview: no x-cache, revalidate header, noindex
curl -s -o /dev/null -D - "https://SITE/?__draft=off" | grep -iE '^(cache-control|vary|x-robots-tag|x-cache)'
# expect: cache-control: max-age=0, no-cache, must-revalidate ; vary: Cookie ; no x-cache

# A signed request
curl -s -o /dev/null -D - -H 'Authorization: Bearer x' "https://SITE/" | grep -i '^cache-control'
# expect: private, no-cache, no-store, must-revalidate

# A signed-in shopper (use the cookie your buildSegment reads)
curl -s -o /dev/null -D - -H 'Cookie: <sign-in-cookie>=1' "https://SITE/" | grep -iE '^x-cache'
# expect: x-cache: BYPASS, x-cache-reason: private

# Private paths
curl -s -o /dev/null -D - "https://SITE/cart" | grep -iE '^(cache-control|x-cache)'
# expect: private, no-cache, no-store, must-revalidate ; x-cache-reason: profile:private

# A missing page
curl -s -o /dev/null -D - "https://SITE/this-does-not-exist" | grep -iE '^(x-cache)'
# expect: x-cache-reason: status:404
```

## 3. Tracking params: shared entry, no poisoning

```bash
curl -s -o /dev/null -D - -A "$UA" 'https://SITE/some-category?gclid=POISON42' | grep -iE '^x-cache'
curl -s -o /dev/null -D - -A "$UA" 'https://SITE/some-category?gclid=POISON42' | grep -iE '^x-cache'
curl -s -A "$UA" 'https://SITE/some-category' | grep -c POISON42      # must print 0
curl -s -o /dev/null -D - -A "$UA" 'https://SITE/some-category?utm_source=a&fbclid=b' | grep -iE '^x-cache:'
# expect HIT once the clean URL is warm, no redirect, same x-cache-segment
```

A non-zero count means the stored HTML carries the raw URL. Fix it as trap 2 says.

## 4. Same content, same entry

Different visitor profiles that should see the same page must land on the same entry. Compare a
fingerprint of the content (the ordered product ids on a listing) and the `x-cache-segment`:

```bash
fp() { curl -s -A "$2" -H "Cookie: $3" "$1" | grep -oE 'data-product-id="[^"]*"' | md5sum; }
URL='https://SITE/some-category'
fp "$URL" "$UA" ""
fp "$URL?utm_source=test&gclid=abc" "$UA" ""
fp "$URL" "$UA" "<a marketing cookie your site sets>=x"
# all hashes equal; replace the grep with whatever marks a product card in your HTML
```

Then change only what should split: a phone user agent must change `x-cache-segment`; a geo header
or region cookie must change it only if the content really differs by region.

## 5. How big is what you store?

```bash
curl -s --compressed -o /tmp/body -w '%{size_download} bytes compressed\n' 'https://SITE/some-category'
curl -s -o /tmp/body -w '%{size_download} bytes raw\n' -H 'Accept-Encoding: identity' 'https://SITE/some-category'
node .agents/skills/deco-storefront-caching/scripts/html-anatomy.mjs https://SITE/some-category
```

`html-anatomy.mjs` prints the cache headers, the raw and gzip size, bytes per attribute, analytics
events in the markup, and every large blob repeated more than once. Repeated blobs are the usual
fix: emit once, reference by id. Set budgets from what you measure (see `perf-guardrails-e2e.md`).

## 6. Failure mode: an empty page must not stick

Make the upstream fail on purpose (an env switch in your loader that returns `null`, or point the
client at a dead host on a preview deployment) and request a cacheable page twice.

- Expect `x-cache: BYPASS` with `x-cache-reason: degraded` (or `STALE-ERROR` if a good copy
  existed), never `MISS` followed by `HIT`.
- Turn the switch off. The next request must render the full page at once, not after the fresh
  window expires.

If the empty page was stored, the page does not set `x-deco-degraded` for that failure.

## 7. Purge

```bash
curl -s -X POST "https://SITE/_cache/purge" \
  -H "Authorization: Bearer $PURGE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"paths":["/some-category"]}'
# expect {"purged":[...],"total":n}; the next GET of that path from the same data center is a MISS
```

`total: 0` right after a HIT means the purge's key differs from the stored key.

## 8. Telemetry, for 24 hours after the deploy

- `http.server.request.duration`, counted by `cache` and `http.route`: hit share per page template.
  `BYPASS` growing on one route points at a new cookie or private header there.
- `http.client.request.duration` by `provider` and `operation`: upstream calls per page view should
  drop. `cached=true` counts hits of your upstream `fetch` cache.
- 5xx share must not rise. A rise after "degraded" changes means a failure path now throws.
- CDN bandwidth per path (`deco-performance-audit` in decocms/skills).

The alert runbook is `docs/runbooks/cache-hit-drop.md`. Its diagnostic queries and its section on
loader caches name metrics and routes from the v7 line (`cache_hit_total`, `createCachedLoader`,
`/_cache/purge-loaders`); on v8 use the metrics above and the example's purge route.
