---
name: deco-go-live
description: "Go-live and the first 72 hours for a site on @decocms/blocks 8 (mainly TanStack Start behind createDecoWorker from @decocms/tanstack/worker). Covers code and content freeze, the last content import as a draft (deco push --draft, deco check, deco publish), how releases reach the site from the CDN and how to roll back traffic, code and content (deco releases, Studio's make-current), the traffic ramp with abTestingRoutes from @decocms/compat-v7/tanstack/worker, Worker runtime limits (128 MB, shared state, deadlines, telemetry), go-live cache checks, proxied checkout headers (COOP, 304 and bfcache), React/SPA leftovers from Fresh ports, SEO, redirects and analytics parity, a read-only preflight script, and a QA checklist built from an inventory of the site's blocks and routes. Load it before a cutover, after a migration or a framework upgrade, to build a QA pass, or to chase a regression right after launch. Assumes the site already builds and renders."
---

# Go-live check for a v8 site

Most items below come from a real incident on a store that already went live. Walk
it on the candidate (and on the real host) before the first byte of
production traffic, again on cutover day, and once more 24 to 72 hours later.
It is a double check, not a setup guide: wiring is in **deco-tanstack-site**
and **deco-nextjs-site**, the CLI flow in **deco-site-workflow**.

- 🔴 **Blocks go-live**: data leak, site down, checkout or revenue loss.
- 🟡 **Fix before ramping above 0%**: cache, SEO, analytics, performance.
- 🟢 **Watch after go-live**: monitor, compare with the old site.
- 🧪 needs a browser and a person looking at the result.

Record PASS / FAIL / N/A for every line in the go-live ticket. "Didn't check"
is not N/A.

## When to load what

| Reference | Load it when |
|---|---|
| [`references/process.md`](./references/process.md) | Planning the freeze, the last content import, the CMS pass, cutover day or the first 72 hours |
| [`references/content-releases.md`](./references/content-releases.md) | Checking how a publish reaches the site, what it doesn't reach, or writing the rollback plan |
| [`references/traffic-ramp.md`](./references/traffic-ramp.md) | Splitting the production host between the new site and the old origin |
| [`references/worker-runtime.md`](./references/worker-runtime.md) | Memory errors, 524s, data shown to the wrong user, missing telemetry |
| [`references/proxy-headers-checkout.md`](./references/proxy-headers-checkout.md) | A proxied checkout, header differences with the old site, real-host-only bugs, redirect loops |
| [`references/react-spa.md`](./references/react-spa.md) | Something works after F5 but not after a click, hydration errors, stale chunks |
| [`references/seo-analytics.md`](./references/seo-analytics.md) | Tag-manager timing, indexing, soft 404s, the redirect sweep, sitemaps, search behavior |
| [`references/qa-inventory.md`](./references/qa-inventory.md) | Building a QA pass: list the blocks, routes, interactions and integrations first |
| [`references/qa-checklist-template.md`](./references/qa-checklist-template.md) | Filling the QA checklist from that inventory |

Cache keys, profiles and hit-rate work are in **deco-storefront-caching**;
render and upstream performance in **deco-storefront-performance**; parity with
a v7 site in **deco-v7-to-v8-migration**.

## Quick start

```bash
bash <path-to-this-skill>/scripts/preflight.sh \
  <site-repo> https://<candidate-host> https://<old-site-host>
deco schema --check && deco check
```

The script is read-only (greps and curls). It only catches what is greppable
or curl-able.

## 1. Process (→ [process.md](./references/process.md))

- [ ] 🔴 **Code freeze on the old repo** with a date and a recorded `FREEZE_SHA`; every commit since the migration cut reconciled.
- [ ] 🔴 **Content freeze on the old CMS**; last import after the last edit, pushed as a draft, `deco check --draft=<name>` clean, then `deco publish`.
- [ ] 🔴 **Schemas match production**: same props and defaults; five-criteria parity.
- [ ] 🟡 **CMS pass** with the editors before go-live; draft preview works on their hosts.
- [ ] 🟡 **Inventory** of integrations not ported and of A/B tests whose variant code was never ported.

## 2. Content and rollback (→ [content-releases.md](./references/content-releases.md))

- [ ] 🔴 `createCMS({ site })` on production; a cold start renders; no direct imports of `.deco/blocks/*.json` that a publish can't reach.
- [ ] 🔴 `"blocksMajor": 8` in `.deco/schema.gen.json`; `deco schema push` runs on production deploys.
- [ ] 🔴 **Rollback written and rehearsed** for traffic, code and content.
- [ ] 🟡 The content team knows a publish takes about a minute to show.

## 3. Traffic ramp (→ [traffic-ramp.md](./references/traffic-ramp.md))

- [ ] 🔴 At 0%, the **fallback bucket** works through the worker: the worker 404s `/live/*` and `/deco/*` before the split, so old pages that call them break.
- [ ] 🔴 `shouldBypassAB` returns `true` for routes only the new site has.
- [ ] 🟡 Both buckets smoke-tested with `?_deco_bucket=worker|fallback`, including existing proxies.

## 4. Worker runtime (→ [worker-runtime.md](./references/worker-runtime.md))

- [ ] 🔴 **No per-user state at module scope** (`new QueryClient()` outside `getRouter`, module `Map`s with user data).
- [ ] 🔴 **Memory under ~80% of 128 MB** in a load test; big responses streamed; no content in the bundle.
- [ ] 🟡 **Every upstream await has a deadline**; shared promises have one too.
- [ ] 🟡 Observability and CMS telemetry on; `service.version` set to the commit.
- [ ] 🟢 Memory compared after every `@decocms/*` bump.

## 5. Cache (→ **deco-storefront-caching**)

- [ ] 🔴 **A signed-in shopper never gets a stored anonymous page**; nothing per-user is stored.
- [ ] 🟡 Anonymous pages set no cookie except the first-visit `deco_vid`, and the second request is `X-Cache: HIT`.
- [ ] 🟡 The cache key drops the paid-media parameters your traffic carries.
- [ ] 🟡 A failed loader marks the page degraded (`x-deco-degraded`) instead of caching "not found".

## 6. Proxy, headers, checkout (→ [proxy-headers-checkout.md](./references/proxy-headers-checkout.md))

- [ ] 🔴 **Header diff old × new** on store pages and the proxied checkout; the worker's default COOP overridden where the old site sent none.
- [ ] 🔴 **The proxied checkout never answers 304** from a stored copy; 🧪 bfcache tested on a deployed preview.
- [ ] 🔴 Third-party checkout scripts **byte-compared** with the old site.
- [ ] 🔴 **Real-host-only bugs** checked with the production `Host`.
- [ ] 🟡 No self-redirect loops on encoded paths.

## 7. React / SPA (→ [react-spa.md](./references/react-spa.md))

- [ ] 🔴 🧪 **Cart write then immediate navigation** to checkout keeps the change.
- [ ] 🔴 Fresh leftovers grep is clean (`window.STOREFRONT`, `hx-*`, `value=` without `onChange`).
- [ ] 🟡 🧪 Every inline-script component works when reached by **SPA click**.
- [ ] 🟡 🧪 Product → product by SPA: gallery keyed, no React #310; hook-order lint on.
- [ ] 🟡 🧪 Zero React #418 on mobile with the tag manager on.
- [ ] 🟡 Stale-chunk reload guard; intent-preload payload measured.
- [ ] 🟢 Old service worker unregistered by a self-unregistering `sw.js`.

## 8. SEO, analytics, search (→ [seo-analytics.md](./references/seo-analytics.md))

- [ ] 🔴 **Tag manager loads from `<head>` without a gesture gate**; checkout cookies match the old site.
- [ ] 🔴 On the real host at 0%: **no `noindex`, no `Disallow: /`**; real 404 status codes.
- [ ] 🟡 Every analytics vendor mounted and receiving events the next day.
- [ ] 🟡 No duplicate `from` in the redirects block (`deco check` does not catch them), and a **sweep of every rule** against the old site.
- [ ] 🟡 Sitemap served by a real route and streamed.
- [ ] 🟡 Facet change resets `page`; autocomplete uses the typed term.

## 9. Cutover day and after (→ [process.md](./references/process.md#cutover-day))

- [ ] 🔴 Deploy freeze during the window.
- [ ] 🔴 Split config before the route; smoke with each bucket forced.
- [ ] 🟡 Cache warmed by fetching **pages** with mobile and desktop user agents.
- [ ] 🟡 Traffic ladder with written gates.
- [ ] 🟢 Compare with the **same hour the day before**; keep removed endpoints alive for the HTML cache TTL; keep porting old-repo drift.

## Related

- **deco-site-workflow**: `deco pull`, `push`, `drafts`, `publish`, `releases`, `schema push`.
- **deco-variants**: tests and campaigns, preview links with `__test` / `__campaign`.
- **ecommerce-qa** (decocms/storefront-skills): end-to-end purchase tests with `@decocms/qa`.
- **tools-reconcile-snapshot** (decocms/migrations; planned to move to the blocks 7.x branch as **deco-reconcile-snapshot**): old-repo drift since the cut.
