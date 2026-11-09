# SEO, analytics and search parity

Analytics and SEO break **silently** at cutover: no error, no 5xx, just a
lower number in a dashboard days later. Compare with the old site, not with
expectations. On-page SEO (titles, canonical, JSON-LD) is written in
**deco-site-authoring**; this file is the go-live comparison.

## Tag manager timing

**What happened:** a performance change loaded the tag manager only on the
first user gesture. Shoppers reached checkout without the cookies its tags set
(an A/B tool, consent, affiliates, about 15 ad platforms). Orders per visitor
fell from 0.51% to 0.41%: **about 20% of orders**. Even ungated, the snippet
sat at 68% of the HTML and started at 2.2 to 2.7 s.

- Load the tag manager from `<head>`, as the old site did, with no gesture or idle gate. Accept the lab-score cost unless a conversion test says otherwise.
- Don't load the same script twice (eagerly and from a component).
- SPA: your own page-view event must fire again on client navigation. `DecoDocument` ships v7's `DECO.events` bus and `dataLayer`, and an observer that dispatches the events elements declare with `data-event` (on view, or on click with `data-event-trigger="click"`); it watches the DOM with a `MutationObserver`, so elements a navigation adds are covered.
- Send tracker payloads in the format the old site used. On one store `add_to_cart` was dropped silently (1 of 587 buyers tracked, against 635 of 679 before).

```bash
grep -rnE "requestIdleCallback|first.?interaction|pointerdown|onFirstGesture" src | grep -iE "gtm|tag|analytics"
curl -s "$CANDIDATE/" | grep -o "googletagmanager.com/gtm.js[^\"']*" | head -1
```

🧪 Playwright with no gesture: the tag-manager script is requested within
about 500 ms of the first byte, as on the old site. After the same journey on
both stacks, compare `document.cookie` names at checkout entry.

## Vendors that stop silently

| What happened | Fix |
|---|---|
| the analytics section was never rendered after the port (two stores) | render the tag manager in the root document; its `<noscript>` right after `<body>` |
| a vendor the old framework mounted on its own sent zero events, and A/B results were lost | mount every vendor explicitly in the root document |
| a vendor's `defer` script, while the vendor was down, held `DOMContentLoaded` for ~211 s | load third-party scripts `async` |
| UTMs did not reach the order form's marketing data | read, merge, write before checkout |

```bash
curl -s "$CANDIDATE/" | grep -oE "googletagmanager|<vendor-marker>" | sort | uniq -c
```

The day after go-live, check each vendor's own report against the same day
last week.

## Indexability and status codes

- **At ratio 0 the public host served `noindex` and `Disallow: /`** because the old site decided indexability from its own hostname. The v8 split handler sends `x-forwarded-host`; confirm the old site reads it. Check this **before** creating the route ([traffic-ramp.md](./traffic-ramp.md#traps)).
- Previews are `noindex` on purpose: any request with `?__draft=` (`off` included) or the draft cookie answers `X-Robots-Tag: noindex, nofollow`. A crawler never has the cookie, but a shared preview link does carry `?__draft=`.
- Soft 404s: a catch-all that renders "not found" with HTTP 200. On TanStack, a route sets the response's status with the `x-page-status` header (`PAGE_STATUS_HEADER`), which the worker turns into the status. A status set while rendering does not reach the response.
- A loader failure must not be cached as "not found": a page whose loader failed sets `x-deco-degraded` (`DEGRADED_HEADER`) and a page cache never stores it (**deco-storefront-caching**).
- Pagination `rel=next/prev` and canonical lost in the port: compare the head of a listing's page 2 on both sides.

```bash
curl -s -A Googlebot "https://$HOST/robots.txt" | head
curl -s -A Googlebot "https://$HOST/" | grep -io '<meta[^>]*robots[^>]*>'
curl -sI "https://$HOST/" | grep -i x-robots-tag                  # nothing on a published page
for p in /category-that-does-not-exist /product-that-does-not-exist/p /blog; do
  curl -s -o /dev/null -w "$p %{http_code}\n" "$CANDIDATE$p"; done  # compare with the old site
```

## Redirect sweep

On v8 the routed redirects are the rules of the one saved block of type
`redirects` (`Redirects` by convention). The worker answers them before any
route. Rules from the old site behave differently in a few places:

- **Earlier rule wins.** Two rules for the same path (or two templates of one shape) are a conflict: `deco check` reports each pair as an error, and routing keeps the earlier one. A CSV that relied on "last one wins" changes destinations; on one store reordering changed 88 of them.
- **Self-loops are dropped.** A rule whose `to` is the path its `from` matches is ignored.
- **Query-scoped sources match exactly.** `from: "/shoes?map=c"` matches only that exact query string and wins over a path-only `/shoes`.
- **The visitor's query string is carried over** unless the rule sets `discardQueryParameters`, so `gclid` survives.
- **A full URL in `from`** (`https://…`) never matches a request path. Rewrite it as a path or drop it.
- **Status:** `permanent: true` is 301, otherwise 307; `status` (301, 302, 307 or 308) wins.
- **Old block types are not routed.** `deco check` warns about v7 redirect blocks (`website/loaders/redirect.ts`, `website/loaders/redirects.ts`), per-rule `redirect` blocks and a second `redirects` block. Fold them into the one block.

```bash
deco check 2>&1 | grep -iE "redirect|matches the same URLs|is also the"
```

Then sweep **every** rule against the old site in production (status and
final `Location`), not a sample:

```bash
jq -r '.. | objects | select(has("from") and has("to")) | .from' .deco/blocks/Redirects.json \
  | grep -vE ':|\*' | while read -r from; do
  a=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "$OLD$from")
  b=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "$CANDIDATE$from")
  [ "${a/$OLD/}" = "${b/$CANDIDATE/}" ] || echo "DIFF $from | $a | $b"
done
```

(Templates with `:name` or `*` are skipped by the `grep`; test a few by hand.)

## Sitemaps

- The old framework's sitemap handlers do not exist on v8. Serve the sitemap from a real route, or from `createDecoWorker({ routes })`. A static `public/sitemap.xml` left in the repo masks a missing route.
- Stream sitemap responses. `.text()` on the whole XML ran the worker out of memory on two stores.

```bash
curl -s "$CANDIDATE/sitemap.xml" | grep -o "<loc>[^<]*" | sed 's/<loc>//' | head -200 | while read -r u; do
  curl -s -o /dev/null -w "%{http_code} $u\n" "$u"; done | grep -v "^200"
```

## Search and listing behavior

From one store's fixes after launch:

- A facet change must **delete `page`** and keep `q`, `sort` and other params. Filtering from page 2 returned 0 results.
- "Did you mean" only on a confirmed zero total of an unfiltered, first-page text search. Never rewrite filtered URLs.
- Autocomplete must query the **typed term**, and fall back to the top suggestion only when it is empty.
- Some search APIs reject large page sizes (one returned 400 above 50). Batch SKU lists, and filter out missing products after sorting: one missing SKU broke a whole wishlist.
- Total counts that include out-of-stock items while the grid shows only in-stock ones confuse pagination.
- Empty CMS rules render empty boxes. Guard empty text in code.
