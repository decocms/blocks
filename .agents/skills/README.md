# Skills — framework & package knowledge for decocms/blocks

Agent skills for the packages in this repo (`@decocms/blocks`, `@decocms/blocks-admin`,
`@decocms/blocks-cli`, `@decocms/tanstack`, `@decocms/nextjs`, `@decocms/apps-*`). Claude Code
discovers them through the `.claude/skills` symlink, which points here.

Scope: how *these packages* work and how a site uses them. Two kinds of knowledge live elsewhere,
and skills here refer to them by name instead of copying them:

- **Migration knowledge** (Fresh/Deno → TanStack Start, package upgrades, per-site playbooks) lives in
  **decocms/migrations** — e.g. `source-deco-fresh`, `target-tanstack-deco`.
- **Generic craft** (writing style, perf auditing, tooling not specific to these packages) lives in
  **decocms/skills**.

## Adding a skill

```bash
cp -r .agents/skill-template .agents/skills/<name>
# edit <name>/SKILL.md (name: must equal the directory) and add references/<subject>.md
bun run skills:check && bun run skills:readme
```

`SKILL.md` is an index: an overview plus a "When to load what" table pointing at
`references/<subject>.md`, one subject per file. The `description` is the only thing an agent reads
when deciding whether to load the skill — say what it covers, when to load it, and which package it
documents.

## Budgets, and why

`bun run skills:check` (`scripts/skills-check.ts`, run in CI) enforces:

| Rule | Why |
|---|---|
| `SKILL.md` ≤ 10KB | It loads first, every time the skill triggers. A body in the index makes every load pay for every subject. |
| Any other `.md` ≤ 15KB | A reference past this has stopped being one subject. Split it by subject — not into a `gotchas.md` junk drawer. |
| Frontmatter keys: `name`, `description`, `license`, `allowed-tools`, `compatibility` | Anything else is ignored by the loader, so it only looks like configuration. |
| `name` == directory name; `description` ≤ 1024 chars | Skill names are a flat global namespace once installed; longer descriptions get truncated. |
| Relative `](./x.md)` links resolve; exactly one `SKILL.md` per skill | A dead link or a nested `SKILL.md` fails silently for the reader. |

The table below is generated from each skill's frontmatter by `bun run skills:readme` — edit the
skill, not the row.

<!-- skills:start -->

### Framework and package skills

| Skill | What it covers |
|---|---|
| [`apps-nuvemshop/`](apps-nuvemshop/SKILL.md) | @decocms/apps-nuvemshop (packages/apps-nuvemshop): the Nuvemshop/Tiendanube commerce app over the headless Storefront API (storefront-api.tiendanube.com v2026-11) plus the store's own session endpoints and the Admin API. Use when touching nuvemshopGet/nuvemshopPost, PRODUCT_FIELDS/CATEGORY_FIELDS, productListingPage facets/sort (applyListing, sort_by, ?Cor=A\|B), toProduct/variant prices, relatedProducts, the account actions (login/logout/register, user loader, store_session_payload cookie, adminToken, Turnstile), nuvemshopSitemap, createCheckout, or the deco-nuvemshop block; or when products come back with only id/name/handle, a category tree is flat, filters/sorts don't match the theme, links redirect (trailing slash), registration fails silently (reCAPTCHA), login says 'Valide seu e-mail', or add-to-cart (/comprar/) returns 403. |
| [`apps-vtex/`](apps-vtex/SKILL.md) | @decocms/apps-vtex (packages/apps-vtex): the VTEX commerce app — client (vtexFetch, vtexFetchWithCookies, vtexCachedFetch, intelligentSearch), checkout/session/auth actions, catalog/IS/legacy/cart loaders, useCart/useUser/useWishlist and the Cart v2 hooks (createCart, createCartQuery). Use when code mentions orderForm, expectedOrderFormSections, *V2 cart actions, invoke.vtex.*, VtexIdclientAutCookie/buildAuthCookieHeader, salesChannel/sc, vtex_segment, fetchWithCache; or when the cart empties after add-to-cart, logged-in calls 401/403, prices are wrong per sales channel, orderForm sections are missing, a minicart/add-to-cart makes too many VTEX cart API calls, or VTEX responses look stale. Also for apps-vtex PR reviews. Repeated calls across navigations or edge/route/layout caching are deco-caching, not this. |
| [`deco-caching/`](deco-caching/SKILL.md) | Every cache layer of a deco storefront (@decocms/blocks, @decocms/tanstack): worker-entry edge cache and profiles, route staleTime/gcTime, page in-flight dedup, layout caches, loader cache, SWR upstream cache. Use when touching createDecoWorkerEntry, cacheHeaders, detectCacheProfile, routeCacheDefaults, staleTime, gcTime, createCachedLoader, createFetchCache, registerLayoutSections, X-Cache, Cache-Control or /_cache/purge; or when a page is a cache MISS/never HITs, a TTL is wrong, private data is cached, the same upstream call (e.g. a Header/Footer shelf hitting VTEX intelligent search) fires on every navigation, staleTime/gcTime values are asked about, a layout shows another visitor's variant, you need to purge, or the loader cache eats memory. |
| [`deco-cms-route-config/`](deco-cms-route-config/SKILL.md) | @decocms/tanstack route files for a TanStack Start site: cmsRouteConfig ($.tsx catch-all), cmsHomeRouteConfig (index.tsx), __root.tsx, the admin protocol routes (decoMetaRouteConfig/decoRenderRouteConfig/decoInvokeRouteConfig), ignoreSearchParams, routeCacheDefaults (staleTime/gcTime), head/SEO from page.seo. Use when creating or editing src/routes/*, when a variant click or hydration triggers an extra server fetch, a route 500s with 'cannot have both an 'id' and a 'path'', SEO tags are missing from SSR HTML, or an import from @decocms/tanstack does not resolve. |
| [`deco-migrate-script/`](deco-migrate-script/SKILL.md) | Internals of the Fresh/Deno to TanStack Start migrator (deco-migrate) in @decocms/blocks-cli: code layout under packages/blocks-cli/scripts/migrate, MigrationContext, phases, transforms, templates, analyzers, smoke checks, Tailwind rename tables, deco-post-cleanup rules, tests. Use when editing or debugging anything under packages/blocks-cli/scripts/migrate* or adding a transform/rule. For running a migration on a site use tools-migrate-script (decocms/migrations). |
| [`deco-server-functions-invoke/`](deco-server-functions-invoke/SKILL.md) | Server functions (invoke) on @decocms/tanstack: the @decocms/blocks-cli generate stage that turns @decocms/apps-vtex invoke.ts into top-level createServerFn declarations in the site's src/server/invoke.gen.ts, plus the hand-written src/server/invoke.ts. Use when touching invoke.gen.ts/invoke.ts or invoke.vtex.*, when cart/checkout calls hit VTEX from the browser with CORS errors, the cart forgets items (Set-Cookie not forwarded), an invoke action is missing, createServerFn is not top-level, or the generator fails. |
| [`deco-storefront-egress-guardrails/`](deco-storefront-egress-guardrails/SKILL.md) | Audit for storefront patterns that burn origin egress and edge cache hit rate on deco sites (@decocms/tanstack; legacy Fresh/Deno too), with a zero-dependency HTML anatomy script. Use when origin egress or bandwidth cost spikes, HTML of a PLP/PDP/home is megabytes (oversized SSR payload), a PLP/PDP never gets a cache HIT, gclid/utm tracking params leak into cached pages, the cache is split per region, or when reviewing a PR or migration for these regressions. |
| [`run-migration/`](run-migration/SKILL.md) | Dev loop for the migrator in this repo: reset a target site workspace to its Fresh/Deno state (origin/main) and run the local packages/blocks-cli migrate script against it. Use when testing a migrator change on a real site, or asked to 'run the migration' on a site from here. Not for sites already on TanStack that only need the @decocms/start 6.x → 7.x upgrade (use upgrades-decocms-v6-to-v7 in decocms/migrations). |

_8 skill(s). This table is generated by `scripts/skills-readme.ts` — edit the skill, not the row._
<!-- skills:end -->
