---
name: deco-cms-layout-caching
description: Server-side caching of layout sections (Header, Footer, Theme) across @decocms/blocks (resolvedLayoutCache in cms/resolve.ts, layoutCache in cms/sectionLoaders.ts, registerLayoutSections / unregisterLayoutSections, device-segmented keys) and @decocms/tanstack (pageInflight dedup in loadCmsPage). Covers how each layer keys and expires, what a layout section may and may not vary on, the shared-object index regression test, and how these caches stack with the VTEX fetch cache. Load when every navigation re-fires the same VTEX/intelligent-search calls for Header shelves, when a layout section shows another visitor's variant, when layoutCacheRace.test.ts fails, or when setting up layout caching on a new site.
---

# CMS Layout Section Caching

Multi-layer caching strategy for layout sections (Header, Footer, Theme, etc.) across `@decocms/blocks` and `@decocms/tanstack`. These sections appear on every page but rarely change — caching them eliminates the biggest source of redundant API calls.

## When to Use This Skill

- Server logs show repeated `intelligent-search/product_search` calls for Header shelves on every navigation
- Variant changes trigger full CMS resolution including Header/Footer
- `[CMS]` logs show the same sections being resolved multiple times
- PDP load takes >2s and most time is spent on layout section loaders
- Setting up a new Deco site and want optimal caching from the start


## Architecture: 3 Caching Layers for Layout Sections

```
Request → loadCmsPage (pageInflight dedup)
  └→ resolveDecoPage
       ├→ Layout sections → resolvedLayoutCache (5min TTL) + resolvedLayoutInflight
       └→ Content sections → resolve normally
  └→ runSectionLoaders
       ├→ Layout sections → layoutCache (5min TTL) + layoutInflight
       └→ Content sections → run loader normally
```

| Layer | Package | File | What it caches | TTL | Key |
|-------|---------|------|----------------|-----|-----|
| **Page inflight** | `@decocms/tanstack` | `src/routes/cmsRoute.ts` | Entire `loadCmsPage` result | In-flight only | Full path incl. query (`__nav:` prefix for client navigation, `\|noGlobals` suffix) |
| **Layout resolution** | `@decocms/blocks` | `src/cms/resolve.ts` | Fully resolved CMS props for layout sections | 5 min | `<block reference key>::<device>` |
| **Layout loaders** | `@decocms/blocks` | `src/cms/sectionLoaders.ts` | Section loader output for layout sections | 5 min | `<component key>::<device>` |

Note the package split: Layer 1 (`pageInflight`) lives in `@decocms/tanstack` (it's TanStack-route plumbing), while Layers 2 and 3 live in `@decocms/blocks` (framework-agnostic CMS resolution internals). They aren't in the same package.

## When to load what

| Reference | Load it when |
|---|---|
| [`references/registering-layout-sections.md`](./references/registering-layout-sections.md) | Adding/removing sections from the layout set (`registerLayoutSections`, `export const layout = true`), deciding whether a section is safe to layout-cache, or Header shelves still re-fire every navigation |
| [`references/page-inflight-dedup.md`](./references/page-inflight-dedup.md) | Concurrent `loadCmsPage` calls (prefetch + click), why the dedup key is the full path, or the router re-fetching despite `loaderDeps` |
| [`references/layout-resolution-cache.md`](./references/layout-resolution-cache.md) | How `resolveDecoPage` short-circuits layout blocks, block-reference walking, and the `layoutCacheRace.test.ts` regression (never relax it) |
| [`references/layout-loader-cache.md`](./references/layout-loader-cache.md) | Section-loader output caching for layout sections in `runSectionLoaders` |
| [`references/cache-stack-and-impact.md`](./references/cache-stack-and-impact.md) | How layout caching interacts with `vtexCachedFetch` / `cachedLoader`, and the measured before/after call counts |

## Related Skills

| Skill | Purpose |
|-------|---------|
| `deco-vtex-fetch-cache` | SWR fetch cache for VTEX APIs (`fetchWithCache`, `vtexCachedFetch`) |
| `deco-variant-selection-perf` | Eliminate server calls for same-product variant selection |
| `deco-api-call-dedup` | In-flight deduplication + batching for VTEX API calls |
| `deco-edge-caching` | Cloudflare edge caching configuration |
| `deco-cms-route-config` | CMS route configuration (`@decocms/tanstack`) |
| `deco-to-tanstack-migration` (decocms/migrations) | Migration playbook whose `references/async-rendering.md` documents this same layout-cache/`cmsRoute.ts` machinery in depth (deferred sections, hydration payload size) |
