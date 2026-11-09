# Traps that kill hit rate or raise egress

Check them in this order. The first ones make pages uncacheable, and an uncacheable page costs on
every visit: a 6 MB page served from the cache costs no render, a 150 KB page never cached costs
one render and one set of upstream calls per view. Later traps also give misleading signals until
the earlier ones are fixed.

Each trap has a symptom, a probe (commands in `verification.md`), and a fix.

## 1. The page is never stored

**Symptom.** `X-Cache: BYPASS` on every request to a public page. Read `X-Cache-Reason`:

| Reason | What to look at |
|---|---|
| `private-response` | A `Set-Cookie` on the render (a loader or section writing a cookie), or `Cache-Control: private/no-store` from a route or a server function. Find who sets it. Move cookie writes to a POST handler or private server function. |
| `private` | `buildSegment` returned `loggedIn: true`. Check which cookie it reads. A cookie every returning visitor has (cart, checkout, session id) makes almost all traffic private. Read the cookie the sign-in flow sets, never "any cookie present". |
| `status:<code>` | The render was not a 200. A 404 for a real page means routing; a redirect status means the page itself redirects. |
| `degraded` | A loader failed and the page set `x-deco-degraded`. Fix the upstream, or the condition that sets it. |
| `profile:<name>` | The URL matched `private` or `none`, or a profile with edge `fresh` 0. Check `pageProfile` for a rule that is too broad. |

No `X-Cache` at all on a page means `pageCache` never ran: a preview (draft cookie or
`?__draft=`), an `Authorization` header, a `HEAD` request, `vite dev`, or your `routes` answered it.

## 2. Tracking-param poisoning

**Symptom.** One visitor's `gclid` or `utm_*` value shows up in the HTML other visitors get;
attribution is wrong; or ad traffic misses while plain traffic hits.

**Cause.** The key drops tracking params (`cache-keys.md`), but the page was rendered from the raw
URL. Anything that echoes the URL (canonical or `og:url` built from the request, analytics
payloads, pagination links, router state embedded in the HTML) carries the value. The example
stores that render under the clean key, so everyone gets it.

Server functions have the same problem one level down: the page path inside `payload` can carry
tracking params. The example strips only `skuId` and `idsku` from it.

**Probe.** Request `?gclid=POISON42` until it is stored, then the clean URL, and grep for
`POISON42`. It must be 0.

**Fix, in order of preference.**
1. Do not echo the raw query into the page. Build canonical and pagination URLs from the
   parameters the page uses.
2. In `pageCache`, let a request that carried a tracking param read the clean entry but never
   write it (skip `store`). This was v7's guard; the v8 example does not do it, so add it yourself
   if your pages echo the URL.
3. Strip tracking params from page paths inside the server-function `payload` in
   `canonicalPayload`, and from any URL the browser builds from `location.search` for a
   client-side fetch.

## 3. The key splits for nothing

**Symptom.** Hit rate low on pages that are clearly public, with many distinct `X-Cache-Segment`
or URL variants per path.

- **Region.** A `buildSegment` part from the CDN's geo header splits every URL by region. Keep
  only parts the HTML varies by.
- **Device.** Fine when mobile and desktop HTML differ. Wasteful when they don't.
- **Unlisted query params.** A new campaign param, a sort default spelled two ways, a crawler that
  stacks filters in random order. Look at the raw URLs behind the misses.
- **Assignments.** Every running test multiplies entries. Retire finished tests.

## 4. `Vary` splits or blocks the cache

`Vary` tells every cache in the path to keep one copy per value of each listed request header.
`Vary: Cookie` or `Vary: User-Agent` on a public page means one copy per visitor or per browser
build in any cache that honors it. `Vary: If-None-Match` (seen from static-file servers) splits by
ETag, which defeats a year-long TTL.

The example sets `Vary: Accept-Encoding` on the answers it gives from its cache or a fresh store,
replacing what the app sent. A `BYPASS` answer keeps the app's `Vary`, and so do your `routes`
answers and static files. Previews get `Vary: Cookie`, which is correct for them. Probe public
URLs and static files for any other token.

## 5. Redirects

CMS redirects are answered by the worker before your `routes` and before `pageCache`. They carry
no `Cache-Control`, leave with `CDN-Cache-Control: no-store`, and are measured on one
`http.route`, `redirect`, with `cache` `BYPASS`.

Each one is a Worker invocation, not a page render: no commerce upstream is called, and the
redirects block body is kept per isolate once fetched. That is cheap. It only matters when
main-navigation links point at a redirecting URL, so every click pays a round trip. Fix the links
first.

If you cache redirects in front of the worker, cache only those that stay on the same host and
protocol and do not point at themselves. A cached leg of a redirect loop freezes the loop.

## 6. Hidden variants rendered in full

**Symptom.** The HTML carries N copies of a grid or menu, and CSS or an A/B script shows one.
`html-anatomy.mjs` lists the same blob N times.

**Fix.** Render the active variant on the server. Each other variant is an empty wrapper that
loads its content through a cacheable GET only when it becomes visible. A `display:none` element
never intersects, so it never loads. "Render everything, hide with CSS" is acceptable only for
something as small as a label. `deco-variants` covers variants that stay cacheable.

## 7. Calls on every page view that can't be cached, or that create state

**Symptom.** Every view fires a POST or a `no-store` GET, or a cookieless visitor gets a new
upstream cart (`Set-Cookie` for a cart id on a request with no cookies).

**Fix.**
- No cart cookie means no cart: return an empty cart without calling the upstream.
- Keep that response private anyway (`markPrivate()`): the URL is shared, and an empty cart
  stored for one visitor would be served to a shopper who has items.
- Don't fire a session or profile POST when there is no auth cookie and nothing to change.
- Check third-party scripts in the browser's network panel. Some create carts too.

## 8. Payload bloat that compression hides

**Symptom.** Pages of several MB raw. Compressed size looks fine, but every miss renders and
transfers it, every client-side navigation fetches its data again, and parse and hydration time
grow. A cache HIT does not mean a small response.

Usual causes, as `html-anatomy.mjs` ranks them:
- Full product objects in serialized page data when a card needs ten fields. Map to a small card
  model in the loader, before anything is cached or rendered.
- The same product serialized once per size or color button. Emit it once and reference it by id.
- Analytics payloads per card (`data-event` attributes). Send the shared part once.
- One script inlined per component instance. Emit the code once; pass each instance's props.

`deco-storefront-performance` has the trimming method and which fields each consumer reads.

## 9. Traffic you asked the browser to make

- Fetches on mount for UI that is closed (drawers, store locators). Fetch on open.
- Prefetch or prerender rules your site adds. A hover can download a whole page and its scripts.
  Keep them conservative on dense menus.
- A page's own data fetched again right after a cached HTML load, with no interaction. Find what
  triggers it before shipping; it doubles the transfer of that page.

## 10. Crawlers

A crawler stacking filter combinations creates unique URLs that never hit. One measured audit
found about a quarter of bandwidth came from crawlers. That is a WAF and bot-management job
(`deco-bot-management`, `deco-cloudflare-waf` in decocms/skills), not a cache key change.

## PR review checklist

- [ ] A new or changed loader on a cacheable page depends only on props and the URL's real
      params. No request headers other than cookies for private data.
- [ ] A loader that can fail or return nothing sets `x-deco-degraded`.
- [ ] No cookie written while rendering a cacheable page.
- [ ] `buildSegment` adds only parts the HTML varies by. `loggedIn` reads the sign-in cookie.
- [ ] No raw query string echoed into the HTML.
- [ ] Variant UI: only the active variant rendered on the server.
- [ ] New per-view request: a cacheable GET, and it creates no state for anonymous visitors.
- [ ] `html-anatomy.mjs` before and after on the heaviest page: nothing repeated N times.
- [ ] Changed key: lookup, store and purge still use the same function; tests updated.
