# QA checklist template

Fill this from the [inventory](./qa-inventory.md). Keep only the sections the
site has, put a real file and a real URL in each row, and add a row for every
site-specific block the template doesn't cover. Mark the purchase path (home →
listing → product → cart → checkout) as P0.

Record PASS / FAIL / N/A per row. "Not checked" is not N/A.

Test every interactive row twice: after a full load (F5) and after reaching
the page by a **SPA click** ([react-spa.md](./react-spa.md)).

## A. Build and content

| # | Test | How to verify | Where |
|---|---|---|---|
| A1 | Build succeeds | the site's build script exits 0 | `vite.config.ts` / `next.config.*` |
| A2 | Schema is current | `deco schema --check` exits 0 | `.deco/schema.gen.json` |
| A3 | Content fits the schema | `deco check` (and `--draft=<name>` for the draft under test): 0 errors | `.deco/blocks` |
| A4 | Every saved block type exists | `deco check` reports no `no saved block or block type` | `.deco/index.ts` |
| A5 | Dev server starts clean | no errors in the terminal or the browser console | worker entry, root route |

## B. Page loads (one row per route template)

| # | Test | How to verify | Route |
|---|---|---|---|
| B1 | Home renders every section | visual check, console clean | `/` |
| B2 | Listing renders the product grid | a real category URL | catch-all |
| B3 | Product page renders every section | a real product URL, one with and one without optional blocks | catch-all |
| B4 | Search renders results and the empty state | a real term, then nonsense | catch-all or search route |
| B5 | Institutional pages render | one per template | catch-all |
| B6 | Not found is a real 404 | `curl -o /dev/null -w '%{http_code}'` on a made-up path → 404 | catch-all |
| B7 | A lazy section loads and its fallback is sane | throttle the network; scroll to it | lazy blocks |

## C. Header

| # | Test | How to verify |
|---|---|---|
| C1 | Announcement bar renders (and rotates, if it does) | visual |
| C2 | Menu opens on mobile, closes on Escape and on the overlay | click, key, click |
| C3 | Mega-menu opens on hover on desktop | hover each top item |
| C4 | Search opens, suggests the **typed** term, submits | type a product name |
| C5 | Minicart opens; the badge counts items | add an item |
| C6 | Login or account entry works | click it, signed out and signed in |

## D. Sliders and carousels (one row per instance)

| # | Test | How to verify |
|---|---|---|
| D1 | Previous and next work | click the arrows |
| D2 | Dots work | click the dots |
| D3 | Autoplay advances, if configured | wait one interval |
| D4 | Listeners are cleaned up | navigate away and back 3×; listener count stays flat |

## E. Product page

| # | Test | How to verify |
|---|---|---|
| E1 | Gallery loads; zoom works | click or hover the main image |
| E2 | Variant picker changes the SKU, price and URL, and stays on the site | pick each dimension |
| E3 | Product → product by SPA click shows the new product's images at once | click a related product |
| E4 | Buy button adds the item, shows a loading state, opens the minicart | click once; double click adds once |
| E5 | Shipping estimate returns options; the URL doesn't change | enter a postal code |
| E6 | Out-of-stock state shows; buy button disabled | an unavailable SKU |
| E7 | Reviews, recommendations, wishlist, share render or fail quietly | each block present on the page |
| E8 | Breadcrumb links work | click each item |

## F. Cart

| # | Test | How to verify |
|---|---|---|
| F1 | Items show image, name, price, quantity | add two different items |
| F2 | Quantity change and remove update the total | +, −, remove |
| F3 | Coupon applies and survives a reload | a valid and an invalid code |
| F4 | Free-shipping progress updates | add items near the threshold |
| F5 | **Change quantity, then go to checkout within 300 ms**: checkout shows the new quantity | WebKit and Chromium |
| F6 | Checkout button reaches checkout with the same cart | compare the order form |

## G. Listing and search

| # | Test | How to verify |
|---|---|---|
| G1 | Filters apply; from page 2 they reset to page 1 | apply a filter on page 2 |
| G2 | Sort reorders and keeps the filters | change sort with a filter on |
| G3 | Pagination or "load more" works and keeps `q` and `sort` | page 2, 3 |
| G4 | Price range filter works | slider or inputs |
| G5 | Empty result shows the fallback | a nonsense term |
| G6 | Cards link to the product; discount flags render | click, visual |
| G7 | Title, description, canonical and `rel=next/prev` match the old site | view source on page 1 and 2 |

## H. Modals and drawers

One row per drawer or modal in the inventory: it opens, closes on Escape,
closes on the overlay and on its close button, and opens again after a SPA
navigation.

## I. Footer

| # | Test | How to verify |
|---|---|---|
| I1 | Newsletter submits and shows success and error | a valid and an invalid email |
| I2 | Links, social icons and payment icons render | visual; links open the right targets |
| I3 | Back-to-top works | click |

## J. Content editing (Studio)

| # | Test | How to verify |
|---|---|---|
| J1 | Each block type in use has a usable form | open one of each in Studio (**deco-cms-schema**) |
| J2 | A draft previews on the hosts editors use | `deco drafts url <name>` → the page shows the draft |
| J3 | A preview is never cached | the draft response has `Cache-Control: max-age=0, no-cache, must-revalidate` and `X-Robots-Tag: noindex, nofollow` |
| J4 | A publish reaches the live site within about a minute | publish a small change; reload |
| J5 | Each running test and campaign renders both sides | preview links with `__test` / `__campaign` (**deco-variants**) |

## K. Analytics

| # | Test | How to verify |
|---|---|---|
| K1 | Tag manager loads from `<head>` without a gesture | network panel, no interaction |
| K2 | Page view fires on load **and** on SPA navigation | `dataLayer` after a click |
| K3 | `view_item`, `select_item`, `add_to_cart` fire with the old payload shape | compare with the old site |
| K4 | Every vendor in the inventory receives events | its own dashboard the next day |

## L. Console and network health

| # | Test | What to look for |
|---|---|---|
| L1 | No hydration errors | React #418, #423, #425; "did not match" warnings |
| L2 | No hook-order errors | React #310 on product → product |
| L3 | No `Cannot read properties of undefined` | a loader result without a guard |
| L4 | No 404 on `/assets/*` after a deploy | keep a tab open across a deploy |
| L5 | No duplicate upstream calls per page | the server log or `http.client.request.duration` per provider (**deco-storefront-performance**) |

## M. Performance and cache sanity

| # | Test | How to verify |
|---|---|---|
| M1 | Browser heap stays flat over 10 SPA navigations | DevTools Memory |
| M2 | Minicart open/close 10× leaves the heap flat | heap snapshots before and after |
| M3 | Anonymous pages send no `Set-Cookie` except the first-visit `deco_vid` | `curl -sI` without cookies |
| M4 | The second anonymous request is a cache hit | `X-Cache: HIT` from the site's page cache (**deco-storefront-caching**) |
| M5 | Lazy sections load their chunk only when needed | network panel while scrolling |

## Adapting it

1. Remove the sections the site doesn't have.
2. Add a section per site-specific feature (configurators, calculators, store locators, wizards): open, use, result, error.
3. Swap platform rows (cart, checkout, shipping) for the site's commerce platform.
4. Add rows for bugs found in earlier rounds.
5. For end-to-end purchase tests that run in CI, see the **ecommerce-qa** skill in decocms/storefront-skills (the `@decocms/qa` engine). Its stack detection was written for older sites; check it recognizes a v8 site before relying on it.
