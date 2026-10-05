# How layout caching stacks with the other caches, and what it buys

Layout sections (Header, Footer, Theme, etc.) appear on every page but rarely change — caching them eliminates the biggest source of redundant API calls. Symptoms that bring you here: server logs show repeated `intelligent-search/product_search` calls for Header shelves on every navigation; variant changes trigger full CMS resolution including Header/Footer; `[CMS]` logs show the same sections being resolved multiple times; PDP load takes >2s and most time is spent on layout section loaders; or you are setting up a new Deco site and want optimal caching from the start.

## The 3 layers that serve layout sections

```
Request → loadCmsPage (pageInflight dedup)
  └→ resolveDecoPage
       ├→ Layout sections → resolvedLayoutCache (5min TTL) + resolvedLayoutInflight
       └→ Content sections → resolve normally
  └→ runSectionLoaders
       ├→ Layout sections → layoutCache (5min TTL) + layoutInflight
       └→ Content sections → run loader normally
```

| Layer | Package | File | What it caches | TTL | Key | Reference |
|-------|---------|------|----------------|-----|-----|-----------|
| **Page inflight** | `@decocms/tanstack` | `src/routes/cmsRoute.ts` | Entire `loadCmsPage` result | In-flight only | Full path incl. query (`__nav:` prefix for client navigation, `\|noGlobals` suffix) | `route-page-inflight-dedup.md` |
| **Layout resolution** | `@decocms/blocks` | `src/cms/resolve.ts` | Fully resolved CMS props for layout sections | 5 min | `<block reference key>::<device>` | `layout-resolution-cache.md` |
| **Layout loaders** | `@decocms/blocks` | `src/cms/sectionLoaders.ts` | Section loader output for layout sections | 5 min | `<component key>::<device>` | `layout-loader-cache.md` |

Note the package split: Layer 1 (`pageInflight`) lives in `@decocms/tanstack` (it's TanStack-route plumbing), while Layers 2 and 3 live in `@decocms/blocks` (framework-agnostic CMS resolution internals). They aren't in the same package.

## Integration with `vtexCachedFetch` SWR

Layout caching prevents re-execution of section loaders and CMS resolution for 5 minutes. But the underlying VTEX API calls also benefit from the `vtexCachedFetch` SWR cache (3 min TTL — VTEX's binding of the shared `createFetchCache`, see `swr-fetch-cache.md`):

```
Request → Layout cache (5 min TTL)
  └→ MISS → resolveDecoPage → section loaders
       └→ vtexCachedFetch → fetchWithCache (3 min TTL)
            └→ MISS → actual VTEX API call
```

This means even after the layout cache expires, the underlying API data may still be fresh in the fetch cache. The two caches work together:

| Layer | TTL | Scope |
|-------|-----|-------|
| Layout resolution cache | 5 min | Full section output (props + enrichment) |
| Layout section loader cache | 5 min | Section loader output only |
| `fetchWithCache` SWR | 3 min | Individual HTTP responses |
| `cachedLoader` SWR | 30-120s | Commerce loader results |

### Cart Cross-Selling on PLP — Not an Issue

Analysis confirmed that cart drawer cross-selling is **CMS-based** (products configured in admin), not API-based. The Header loader only runs `usePriceSimulationBatch` (a POST, which only runs when `userInfo` cookie exists with a CEP). On first visit without the cookie, no simulation runs at all.

---

## Performance Impact

Before layout caching (variant change on PDP):
- **~30 VTEX API calls** per navigation (Header shelves × 2 resolutions)
- **2-3 seconds** delay

After layout caching + `vtexCachedFetch` SWR:
- **~8 VTEX API calls** on first load (only product-specific: PDP loader, cross-selling, simulation)
- **~0-2 VTEX API calls** on subsequent navigations (everything served from SWR caches)
- **<1 second** for cached navigations
