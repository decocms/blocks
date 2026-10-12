---
name: deco-storefront-egress-guardrails
description: "Audit for storefront patterns that burn origin egress and edge cache hit rate on deco sites (@decocms/tanstack; legacy Fresh/Deno too), with a zero-dependency HTML anatomy script. Use when origin egress or bandwidth cost spikes, HTML of a PLP/PDP/home is megabytes (oversized SSR payload), a PLP/PDP never gets a cache HIT, gclid/utm tracking params leak into cached pages, the cache is split per region, or when reviewing a PR or migration for these regressions."
---

# Storefront egress guardrails

Every item below was measured on a production VTEX storefront whose origin was
~41% of a cluster's cost, almost all egress. Each has a **probe** (how to find
it in minutes), a **fix**, and the **guard** that now prevents it in the
framework, or the review rule that has to catch it when no guard exists.

Order matters: check the ones that make pages *uncacheable* first. A 6 MB page
served from the edge costs nothing at the origin; a 150 KB page that is never
cached costs on every visit.

Related skills: `deco-caching` (every cache layer: profiles, TTLs, purge), `apps-vtex`
(loader-level VTEX caching), `deco-performance-audit` (CDN numbers first). The
Fresh-specific counterpart lives in decocms/skills as `deco-storefront-egress-audit`.

## 0. Measure first (5 minutes)

```bash
UA='Mozilla/5.0 (Macintosh) Chrome/140'
# a) cacheability of the top pages — run twice, the 2nd should be HIT
for p in / /category /category?filter.x=y /some-product/p; do
  curl -s -o /dev/null -D - -A "$UA" "https://SITE$p" \
    | grep -iE '^(cache-control|cf-cache-status|x-cache|x-cache-segment|x-cache-store|age|set-cookie)'
done
# b) where the bytes go
node .cursor/skills/deco-storefront-egress-guardrails/scripts/html-anatomy.mjs https://SITE/category
```

`x-cache-segment` is a hash of the segment: if it changes when you only change
`cf-region-code`, the cache is split by region (see §3).

## 1. A loader with no cache vetoes the whole page

**Symptom.** A page is `no-store` / `BYPASS` on every visit and no cookie is set.

**Cause.**
- **Fresh:** a loader without `export const cache` defaults to `no-store` and sets `ctx.vary.shouldCache = false`, which vetoes the page.
- **TanStack:** the same happens when a `cacheKey` returns `null`.
- Two common triggers:
  - a loader reading a **request header** (e.g. `cf-region-code` to pick a regional collection). Its output varies by something the cache key can't see, so it can't be cached.
  - VTEX `advancedConfigs.cacheFilteredPLP` missing, which makes every `filter.*` listing return a `null` key.

**Fix.**
- Make the loader depend only on props + URL, and give it `cache = "stale-while-revalidate"` plus a `cacheKey` that ignores tracking params.
- Anything genuinely per-visitor (region, customer group) moves to the browser: it asks once, remembers the answer, and swaps in a *different, also cacheable* URL (e.g. `?regiao=sul`).
- Set `cacheFilteredPLP: true` and `removeUTMFromCacheKey: true` on the VTEX app block.

**Review rule.** A loader that reads `req.headers` (other than cookies for private data) is a red flag on any cacheable page.

## 2. Tracking params poison the cache (and fragment partials)

**Symptom.**
- One visitor's `gclid`/`utm_*` shows up in the HTML everyone gets.
- Attribution goes wrong.
- The infinite-scroll/deferred-section partials of ad visitors are always MISS.

**Probe.**

```bash
curl -s -A "$UA" 'https://SITE/category?gclid=POISON42' >/dev/null     # MISS
curl -s -A "$UA" 'https://SITE/category' | grep -c POISON42             # must be 0
```

**Cause.** The edge key drops tracking params, but the renderer saw the raw URL
and embeds it: page URL, router match id, analytics payloads, pagination base
URL. Storing that response under the clean key serves it to everyone. Partials
build their inner `href`/`pageUrl` from `location.search`, so the params travel
*inside* a param value, where CDN query stripping never looks.

**Guard (framework, `createDecoWorkerEntry`).**
- **Requests carrying tracking params READ the clean entry but never WRITE it.** This covers HTML, GET server functions (tracking inside `payload`) and POST server functions (tracking inside the body). A skipped write is labelled `X-Cache-Store: skipped-tracking`.
- **POST server-fn bodies are hashed with tracking params stripped** (`canonicalizeServerFnPayloadForCacheKey(body, [])`), so ad visitors share the clean entry.
- **Register site-specific params** with `registerTrackingParams([...])` from `@decocms/blocks/sdk/urlUtils`. Guard and key both use that list.

**Fresh fix.** Strip the site's blocked query params from `location.search` before setting the `href` of any `useSection` partial.

## 3. The cache split by region for no reason

**Symptom.** ~27 copies of every URL in Brazil, one per state, while only one
region actually sees different content.

**Cause.**
- **A `buildSegment` that returns the Cloudflare region as `regionId` on every request.** Older migration templates generated exactly this.
- **A single `website/matchers/location.ts` block anywhere in the decofile.** It turns `geoCacheKey: "auto"` to `"region"` site-wide.

**Guard.**
- **Templates:** they no longer put geo in `buildSegment`. The worker's own backfill adds the region only when a location matcher exists.
- **Runtime warning, once per isolate:** `[deco] buildSegment sets regionId to the Cloudflare region … but no website/matchers/location.ts block exists`.

**Fix.**
1. Return only the VTEX regionalization `regionId` from `buildSegment`.
2. If only a few pages vary by location, prefer a client-side decision (§1) over a site-wide geo key. Or remove the one stray location matcher.

## 4. Hidden variants rendered in full

**Symptom.** The HTML contains N copies of a grid/menu, and CSS or an A/B tool shows one.

**Probe.** `html-anatomy.mjs` shows the same blobs ×N; `grep -o 'id="gallery-container[^"]*"'` counts grids.

**Fix.**
- Render the default variant only.
- Each other variant is an empty wrapper (same id/class the A/B tool toggles) whose placeholder fetches its content on `intersect`. A `display:none` element never intersects, so only the revealed variant loads, through a cacheable GET.
- Paginate inside a lazily loaded variant with the variant id in the partial props.

**Review rule.** "Render all variants, hide with CSS" is never acceptable for anything heavier than a label. The same goes for A/B menus: render the active one on the server.

## 5. Per-pageview calls that are uncacheable, or that create state

**Symptom.** Every page view fires a POST or no-store GET, or creates a VTEX orderForm for visitors without a cart cookie (`Set-Cookie: checkout.vtex.com=__ofid=…` on a cookieless request).

**Fix.**
- **No cart cookie means no cart:** return 0 without calling VTEX.
- **Keep the response uncacheable anyway.** The URL is shared, and the edge doesn't key on cookies. Forcing `vary.shouldCache = false` on Fresh is what stops a cached "0" being served to shoppers who do have a cart.
- **Anonymous session hydration:** don't fire a POST at all when there is no auth cookie and nothing to patch.
- **Third-party scripts (cart capture, recommendations):** check them in the browser's network panel. They can create orderForms too.

## 6. Payload bloat that brotli hides

**Symptom.** Multiple MB raw per page. Compressed looks OK, but every miss and every scroll page pays for it, and parse/hydration time grows.

**Usual suspects, in the order `html-anatomy.mjs` ranks them:**
- **The same product serialized once per size button.** Cart/analytics handlers inline the full product per size. Emit one payload per card and reference it by id.
- **Analytics payloads per card:** `select_item` + `add_to_wishlist` per card, plus `view_item_list` embedding whole product lists. Send the constant part once.
- **One script inlined per component instance** (e.g. `scriptAsDataURI(setup, props)` per slider). Emit the code once per render and have each instance push its props onto a queue.
- **TanStack hydration of full `Product` objects** (offers, installments, all variants) when the card needs ten fields. Map to a slim card model in the loader, which also shrinks the infinite-scroll JSON.

## 7. Traffic you asked the browser to make

- **Mount-time fetches for closed UI** (help/store-locator drawers). Fetch when the drawer opens.
- **Speculation rules** (`speculationRules` in `createDecoWorkerEntry`) default to `prerender` + `moderate`. A 200 ms hover then downloads a whole page plus its JS. This is edge bandwidth, not origin egress, but it adds up on megabyte pages. Consider `prefetch` or `eagerness: "conservative"` on dense menus.
- **Double page-data fetch on load.** If DevTools shows the page's own server-fn JSON fetched right after a cached HTML load (same path, no interaction), trace what triggers it (preload vs re-match of a stale dehydrated match) before shipping. It doubles the transfer of that page.

## PR review checklist

- [ ] New/changed loader: depends only on props + URL? Has `cache` + a `cacheKey` that can't return `null` for anonymous traffic?
- [ ] Anything read from request headers on a cacheable page?
- [ ] `buildSegment` adds only what content truly varies by (no raw geo)?
- [ ] Hidden/variant UI rendered on the server?
- [ ] New per-pageview request: cacheable GET? Creates state for anonymous visitors?
- [ ] `html-anatomy.mjs` before/after on the heaviest page: nothing repeated ×N that could be emitted once?
- [ ] Partials that copy `location.search` strip tracking params?
