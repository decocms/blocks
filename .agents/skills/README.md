# Skills — framework & package knowledge for decocms/blocks

Agent skills for the packages in this repo (`@decocms/blocks`, `@decocms/blocks-admin`,
`@decocms/blocks-cli`, `@decocms/tanstack`, `@decocms/nextjs`, `@decocms/apps-*`). Claude Code
discovers them through the `.claude/skills` symlink, which points here.

Scope: how *these packages* work and how a site uses them. Two kinds of knowledge live elsewhere,
and skills here refer to them by name instead of copying them:

- **Migration knowledge** (Fresh/Deno → TanStack Start, package upgrades, per-site playbooks) lives in
  **decocms/migrations** — e.g. `deco-to-tanstack-migration`.
- **Generic craft** (writing style, perf auditing, tooling not specific to these packages) lives in
  **decocms/skills**.

## Adding a skill

```bash
cp -r .agents/skills/template .agents/skills/<name>
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
| [`deco-apps-vtex-review/`](deco-apps-vtex-review/SKILL.md) | Audit checklist for the VTEX integration in @decocms/apps-vtex (packages/apps-vtex, the TanStack/Next-agnostic port of deco-cx/apps vtex). Covers Set-Cookie propagation (vtexFetchWithCookies → RequestContext → invoke.gen.ts forwardResponseCookies and @decocms/blocks-admin's /deco/invoke), VtexIdclientAutCookie headers (buildAuthCookieHeader), expectedOrderFormSections, salesChannel (sc) injection, Intelligent Search session cookies, HttpOnly auth, hooks/transform/schema.org parity with deco-cx/apps, and the validation greps. Load when reviewing or porting apps-vtex code, when the cart empties after add-to-cart, when logged-in calls 401/403, when prices or products are wrong for a sales channel, or when cart responses are missing sections. |
| [`deco-cms-layout-caching/`](deco-cms-layout-caching/SKILL.md) | Server-side caching of layout sections (Header, Footer, Theme) across @decocms/blocks (resolvedLayoutCache in cms/resolve.ts, layoutCache in cms/sectionLoaders.ts, registerLayoutSections / unregisterLayoutSections, device-segmented keys) and @decocms/tanstack (pageInflight dedup in loadCmsPage). Covers how each layer keys and expires, what a layout section may and may not vary on, the shared-object index regression test, and how these caches stack with the VTEX fetch cache. Load when every navigation re-fires the same VTEX/intelligent-search calls for Header shelves, when a layout section shows another visitor's variant, when layoutCacheRace.test.ts fails, or when setting up layout caching on a new site. |
| [`deco-cms-route-config/`](deco-cms-route-config/SKILL.md) | CMS-driven routes for TanStack Start sites on @decocms/tanstack — cmsRouteConfig ($.tsx catch-all), cmsHomeRouteConfig (index.tsx), the admin protocol route factories (decoMetaRouteConfig/decoRenderRouteConfig/decoInvokeRouteConfig), and the SEO/section primitives they use from @decocms/blocks/cms. Covers route options, ignoreSearchParams for variant selection, per-page cache headers, client staleTime/gcTime (routeCacheDefaults), head/SEO generation from page.seo and registered SEO sections, __root.tsx, and what is and is not exported. Load when creating or migrating a site's route files, when variant clicks or hydration trigger extra server fetches, when a route 500s with "cannot have both an 'id' and a 'path'", when SEO tags are missing from SSR HTML, or when an import from @decocms/tanstack does not resolve. |
| [`deco-edge-caching/`](deco-edge-caching/SKILL.md) | Edge and layered caching for TanStack Start storefronts on Cloudflare Workers — createDecoWorkerEntry from @decocms/tanstack (Cache API, device/segment/geo keys, tracking-param handling, BUILD_HASH versioning, purge endpoints, X-Cache diagnostics) and the cache-profile system in @decocms/blocks/sdk/cacheHeaders (cacheHeaders, detectCacheProfile, registerCachePattern, registerPrivatePaths, setCacheProfile, routeCacheDefaults) plus createCachedLoader from @decocms/blocks/sdk/cachedLoader. Load when setting up or debugging worker-entry caching, tuning Cache-Control or per-page-type TTLs (PDP, PLP, search, home), a private page might be cached, cache HIT/MISS rates look wrong, or you need to purge. |
| [`deco-migrate-script/`](deco-migrate-script/SKILL.md) | Developing the Fresh/Deno to TanStack Start migrator (deco-migrate) in @decocms/blocks-cli — its code layout under packages/blocks-cli/scripts/migrate, the MigrationContext it threads through phases, how to add or extend a transform, template, analyzer, phase or smoke check, the single-source rules (Tailwind rename tables), the deco-post-cleanup audit internals, and the tests. Use when changing the migrator or debugging it at the code level. For RUNNING a migration (flags, phases from the user side, reading the report, what is manual afterwards) use the tools-migrate-script skill in decocms/migrations. |
| [`deco-server-functions-invoke/`](deco-server-functions-invoke/SKILL.md) | How server functions (invoke) work in TanStack Start storefronts built on @decocms/tanstack — the @decocms/blocks-cli generate-invoke stage that turns @decocms/apps-vtex's invoke.ts into top-level createServerFn declarations in the site's src/server/invoke.gen.ts. Covers why createServerFn must be top-level (the root cause of CORS errors on VTEX calls), the three-layer architecture (apps-vtex pure functions, blocks-cli generator, site invoke.gen.ts + hand-written invoke.ts), Set-Cookie forwarding so the cart keeps its orderForm, and the comparison with deco-cx/deco's Proxy+HTTP invoke. Load when cart/checkout calls hit VTEX from the browser with CORS errors, the cart "forgets" items, an invoke.vtex.actions.X is missing, the generator fails, or you are adding a server action or wiring invoke on a new site. |
| [`deco-storefront-egress-guardrails/`](deco-storefront-egress-guardrails/SKILL.md) | Find, fix and prevent the storefront patterns that silently burn origin egress and edge cache hit rate on Deco sites (TanStack Start on @decocms/tanstack, and legacy Fresh/Deno). Use when a site's origin/bandwidth cost is high, a PLP/PDP is never a cache HIT, pages are megabytes of HTML, tracking params (gclid/utm) show up in cached pages, the cache is split per region, or when reviewing a PR/migration for these regressions. Ships a zero-dependency HTML anatomy script. |
| [`deco-vtex-fetch-cache/`](deco-vtex-fetch-cache/SKILL.md) | SWR in-memory fetch cache for VTEX API responses in @decocms/apps. Ported from deco-cx/deco runtime/fetch/fetchCache.ts. Provides in-flight deduplication + stale-while-revalidate for all VTEX GET requests. Covers fetchWithCache utility, vtexCachedFetch client function, LRU eviction, TTL by HTTP status, integration with intelligentSearch and cross-selling calls. Use when adding caching to VTEX API calls, debugging stale responses, or understanding how the fetch cache layer works. |
| [`run-migration/`](run-migration/SKILL.md) | Run the Fresh/Deno → TanStack Start migrator from this repo against a target site workspace. Resets the target to its Fresh/Deno state (origin/main), then runs the local migration script. Use for testing the migrator on real sites. For sites ALREADY on TanStack that just need the @decocms/start@6.x → split-7.x package upgrade, use the upgrades-decocms-v6-to-v7 skill (decocms/migrations) instead. |
| [`vtex-cart-v2/`](vtex-cart-v2/SKILL.md) | Cart v2 for VTEX storefronts in @decocms/apps-vtex (contract types in @decocms/apps-commerce/types/cart) — lazy cart creation, per-operation sections (what VTEX computes) vs projection (what the browser receives), the cart/* loaders, the *V2 checkout actions, the createCart hook factory and the optional createCartQuery (TanStack Query) adapter. Framework-agnostic; covers wiring in TanStack Start (@decocms/tanstack, generated invoke) and Next.js (@decocms/nextjs, handleInvoke). Load when building or refactoring a minicart/badge/add-to-cart to cut VTEX cart traffic, choosing a projection, wiring createCart into a site, or migrating component by component off the legacy useCart/createUseCart. |

_10 skill(s). This table is generated by `scripts/skills-readme.ts` — edit the skill, not the row._
<!-- skills:end -->
