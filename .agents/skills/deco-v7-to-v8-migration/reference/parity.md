# Parity: approved v7 → v8 differences

Compare the migrated site with the v7 one with a parity harness (SSR HTML, hydrated DOM, JSON-LD, analytics calls, cache headers, third-party requests, pixels). Any difference fails unless the product owner approved it.

## How to encode an approval

Add it to an `approvedDifferences` list (e.g. in `parity/pages.json`), applied at compare time to both snapshots. Each rule names **one snapshot field**, **the cases it covers**, and **exactly what the new value must be**, so any other change to that field still fails. List the rules applied per case in the summary. Never ignore a field wholesale.

## Approved so far

storefront-tanstack (`5a5a4d4`):

- **JSON-LD in the first SSR HTML** for Lazy-wrapped sections (`ssr.jsonLd`): equal to the hydrated DOM's. Lazy wrappers now render on the server.
- **Extra product image requests** (`thirdPartyRequests`/`harMisses`) on flows that render more images server-side.
- **PLP "show more" page-2 `view_item_list` item indexes.**
- **Fixed cache headers** where v7 sent the wrong ones (the v7 QueryClient bug on `home@mobile`).
- Approved response headers ignored on both sides (`x-powered-by`; `b37a24b`).

blog-tanstack (`9e97455`):

- **Collector beacons recorded as analytics**: the built-in analytics block sends One Dollar Stats beacons straight to the collector instead of loading the SDK; decode them into the same view/event records, and compare `location.pathname` without the query string.
- **Real 404s** for unknown slugs and `/404` (v7 answered 200).
