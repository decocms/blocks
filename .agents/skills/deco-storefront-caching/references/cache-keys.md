# Cache keys and what may be stored

One rule decides most hit-rate bugs: **the key holds exactly what changes the response, and
nothing else.** Too little in the key serves the wrong page to someone. Too much splits one page
into many entries that each miss.

## The example's key

`cacheKey(url, parts)` in the example worker entry builds a `Request` from:

| Part | Where it comes from | Why |
|---|---|---|
| Path and query | `page.url`, minus the hash, `TRACKING_PARAMS` and `__cseg` | The page itself |
| `payload` | Server functions only, canonicalized (`skuId`, `idsku` dropped from page paths) | The page data the call loads |
| `__v` | `cacheVersion(cms, __BUILD_HASH__, url)` | A deploy or publish moves every entry |
| `__seg` | `segmentKey(segmentOf(request))` | Device and the site's own parts |
| `__a` | `assignmentsKey(page.assignments)` | Which side of each test, which campaigns |
| `__fetch` | `Sec-Fetch-Dest: empty` on a page URL | A programmatic fetch gets its own entry, as in v7 |

Use the same function for lookup, store and purge. Two functions drift, and then a purge
silently deletes nothing.

## Rules

### 1. Strip tracking parameters, and add yours

The example drops `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`,
`utmi_campaign`, `utmi_page`, `utmi_part`, `fbclid`, `gclid`, `gclsrc`, `dclid`, `msclkid`,
`twclid`, `li_fat_id`, `mc_cid`, `mc_eid`, `ttclid`, `srsltid` (case-insensitive name match).

Check your real traffic for others and add them to `TRACKING_PARAMS`. Common ones not in the list:
`gad_source` and other `gad_*`, `gbraid`, `wbraid`, `_gl`. A param that is not in the list makes
every ad click a new entry.

Stripping a param from the key is only half the job. The page was rendered with the raw URL. See
"tracking-param poisoning" in `egress-traps.md` before you trust it.

### 2. Never the visitor, always the assignments

`page.visitor` must never be in the key: every visitor would miss. `assignmentsKey` is what the
page renders by. Two visitors on the same side of every test share an entry. More running tests
mean more entries per URL (up to 2^tests); retire finished tests. `deco-variants` covers the rest.

### 3. Segment only by what the content varies by

`buildSegment(request)` in the worker entry returns the device plus the site's own parts (a
region, a sales channel). Each part multiplies the entries per URL.

- Add a part only if the HTML differs by it. Ask: would two requests that differ only in this
  part get byte-identical pages? If yes, it does not belong in the key.
- Region is the usual offender. A part filled from the CDN's geo header on every request splits
  each URL by every region, even when one region sees different content. On VTEX, use the
  regionalization `regionId` the shopper actually has, or move the regional choice to the
  browser and a separate cacheable URL.
- Device: the example keys every page by device. If a page renders the same HTML for all devices,
  the device split only lowers the hit rate for it.
- `loggedIn: true` makes the request private: never read from or written to the cache. Detect it
  from the cookie your sign-in flow actually sets. A cookie that every returning visitor carries
  (a checkout or cart cookie) turns most traffic private.

### 4. Keep the key stable

Order changes must not change the key. `segmentKey` and `assignmentsKey` sort their parts, and the
example canonicalizes server-function payloads with `JSON.stringify` after a walk. If you add a
part built from an object, sort its keys first.

### 5. Store only clean 200s

The example stores a render only if it is a 200, not degraded, not private. Keep all three.

- A non-200 (a CMS 404 page through `x-page-status`, a 5xx) is never stored.
- An empty or partial page that answers 200 is the dangerous one. In v8 a block read returns a
  `[value, error]` result instead of throwing. If a section's loader failed or the upstream returned
  `null`, the page can still render a 200 with an empty grid. Stored, every visitor gets it for the
  whole fresh and stale window.
- Fix: when a loader the page needs fails or returns nothing, set `x-deco-degraded: true`
  (`DEGRADED_HEADER`). The example then serves a stale copy if it has one, and never stores the
  degraded render. Treat "no products where products are required" as a failure, not as data.
- Do not add a process-wide "last good" copy on top of the page cache. The stale windows already
  do that, and an extra copy per isolate diverges between isolates and hides real failures.

### 6. Private data never shares a URL's entry

- Cart, user, wishlist, addresses: server functions that call `markPrivate()`, or answer with
  `Cache-Control: private, no-store`. The example never stores them.
- Do not write a cookie while rendering a cacheable page. Move the write to a POST handler or a
  private server function. A cookie on the response makes the example bypass, which is safe but
  costs a render every time.
- Do not strip `Set-Cookie` or override `private` to "fix" the hit rate. The private header is
  usually there because the response depends on the shopper (price table, campaign).

## One upstream call per request

Several sections often need the same upstream data.

- Inside one request, `@decocms/blocks` already runs each block function once per canonical input:
  the resolver keeps one promise per function and inputs, for that request only. Two sections
  that resolve the same loader block with the same props share one call.
- Block bodies (the content) are fetched once per hash per isolate and shared by concurrent
  requests.
- Across requests, the example does not coalesce concurrent misses. Two requests that miss the
  same key at once both render. Stale-while-revalidate keeps this rare on hot pages. If a viral
  page's misses hurt the upstream, add a lock in your own `pageCache`; nothing in the framework
  provides one.
- If you write a helper that calls the upstream directly, dedupe it per request (a `Map` of key to
  promise that drops a rejected promise), never per process.

`deco-storefront-performance` covers finding the duplicate calls.

## Upstream data cache

v8 has no framework loader cache (v7's `createCachedLoader` is gone). An upstream cache is a
`fetch` you write and pass to the client:

- `createVtexClient({ ..., fetch })` from `@decocms/apps-vtex`; the other `@decocms/apps-*` clients
  take a `fetch` option too. They all go through `createInstrumentedFetch` from
  `@decocms/blocks/fetch`.
- A response your fetch serves from its cache should carry `x-cache: HIT`: the
  `http.client.request.duration` metric then labels it `cached=true`.
- Key it on everything the response depends on (the VTEX client's docs name `regionId`; also the
  sales channel, locale, price table). Cache only shopper-invariant responses (`deco-apps`).
- An in-memory cache is per isolate and TTL-only. A long TTL delays every upstream change, deploy
  or not. Keep it to seconds or minutes.

## Test the key

The example's `worker-entry.test.ts` shows the shape: tracking params share one entry, devices get
their own, the purge's keys equal the stored keys. Add a case for every part you add to
`buildSegment`, and one that asserts two visitors in the same test bucket share a key.
