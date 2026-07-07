# Loader Optimization Checklist

33 learnings from real Deco sites. Check these during analysis.

## Critical Patterns

### 1. Lazy Section Wrapping
**Check**: Are below-fold sections with heavy loaders wrapped in `Lazy`?
- BuyTogether, ProductShelf, Reviews, SimilarProducts
- Any section that fetches data and isn't above the fold

```json
// Good: Wrapped in Lazy
{
  "__resolveType": "website/sections/Rendering/Lazy.tsx",
  "section": { "__resolveType": "site/sections/Product/BuyTogether.tsx" }
}
```

### 2. AbortController Timeout
**Check**: Do external API calls have timeout protection?
- Reviews APIs, recommendation APIs, third-party services
- Add `AbortController` with reasonable timeout (5-10s)

```typescript
// Good: Has timeout
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000);
const response = await fetch(url, { signal: controller.signal });
```

### 3. Client-Side Data Fetching for Below-Fold
**Check**: Are PDP loaders blocking on below-fold content?
- There's no "island" concept anymore — the modern equivalent is wrapping the
  section in `website/sections/Rendering/Lazy.tsx` in the CMS content (still
  literally checked for — see `isCmsDeferralWrapped` in `packages/runtime/src/cms/resolve.ts`
  and `.agents/skills/deco-to-tanstack-migration/references/async-rendering.md`).
  A `Lazy`-wrapped section is shallow-resolved on the server (no data fetch) and
  only fully resolved + loaded client-side when it scrolls into view.
- Don't block SSR on non-critical data — same principle, different mechanism

### 4. Remove Sync Product Loaders from Header
**Check**: Does Header have product loaders that block render?
- Headers should be fast and static
- Header is typically in `alwaysEager` in `setup.ts` (see `hydration-fix.md`) —
  it can't be `Lazy`-wrapped without a UX tradeoff, so keep it loader-free or
  give it its own cheap, cached loader instead of pulling product data

## VTEX-Specific

### 5. Simulation Behavior
**Check**: Is VTEX simulation set correctly?

**Not verified against current source** — VTEX-specific loader internals
(`createVtexCommerceLoaders()`, `createCachedPDPLoader()`) live in
`@decocms/apps`, a separate repo not vendored in this monorepo, so I couldn't
confirm whether `simulationBehavior` is still a config knob with these exact
values. Treat the concept (simulation trades pricing accuracy for speed) as
still generally sound, but verify the actual option name/shape against
`@decocms/apps/vtex/commerceLoaders` in the target site before prescribing it.

| Setting | Use Case |
|---------|----------|
| `skip` | Maximum performance, no real-time pricing |
| `only1P` | Balanced - first-party simulation only |
| `default` | Full simulation (slower) |

### 6. Intelligent Search Migration
**Check**: Are you using legacy loaders?
- The import path changed even if the concept didn't: VTEX commerce loaders
  now come from `createVtexCommerceLoaders()` in `@decocms/apps/vtex/commerceLoaders`
  (npm package), keyed like `"vtex/loaders/intelligentSearch/productListingPage.ts"`
  — see `packages/cli/scripts/migrate/templates/commerce-loaders.ts` for a worked
  example of wiring these into a site's `COMMERCE_LOADERS` map. `deco-sites/std`
  (Deno CDN import) is dead regardless of platform.
- Replace legacy cross-selling with Intelligent Search

### 7. Legacy Loader Fallback
**Check**: Do category paths fail to resolve?
- If Intelligent Search fails, try Legacy VTEX loader as fallback

## Loader Architecture

### 8. Loader Deduplication via Blocks
**Check**: Are common loaders duplicated across pages?
- Use shared loader blocks instead of inline configurations
- Centralizes PDP/PLP loaders for cache deduplication

```json
// Good: Reference a shared named block by its plain name (the `$live/...`
// prefix is stale — verified against packages/runtime/src/cms/resolve.ts,
// named-block refs resolve directly by name, no prefix)
{ "__resolveType": "PDP-Main-Loader" }
```

### 9. Loader Simplification
**Check**: Are there redundant loaders?
- Remove loaders that only pass through data already available
- Avoid manual `fetch` calls when standard loaders exist

### 10. Cascading Fallback Search
**Check**: Do recommendation loaders return empty?
- Implement fallback: Subcategory → Category → Global
- Prevents empty shelves

## Performance Patterns

### 11. Batch and Debounce
**Check**: Are there high-frequency small API calls?
- Batch review/stock/rating calls into single loader
- Use client-side debouncing

### 12. API Result Limiting
**Check**: Do loaders fetch too much data?
- Always apply limits to review/comment loaders
- Use pagination for large datasets

### 13. Concurrent Batch Fetching
**Check**: Are multi-item lookups sequential?
```typescript
// Bad: Sequential
for (const id of ids) { await fetch(id); }

// Good: Parallel
await Promise.all(ids.map(id => fetch(id)));
```

### 14. Cursor Pagination
**Check**: Do infinite scroll lists use offset pagination?
- Use cursor-based pagination for better scaling

## Custom Loaders

### 15. Global Signal Caching
**Check**: Do multiple components make the same API call?
- Use global signals or shared cache
- Prevents duplicate cashback/loyalty requests

### 16. Retail API Integration
**Check**: Are personalization APIs using correct session IDs?
- Extract visitor/session ID from cookies correctly

### 17. External API Loaders
**Check**: Do loaders have proper error handling?
- The `ctx.invoke("some/loader/key.ts", props)` pattern doesn't apply here —
  verified against `packages/runtime/src/cms/sectionLoaders.ts`: modern section
  loaders are plain `(props, req) => enrichedProps` functions, and custom
  loaders are just regular TS functions called directly (see the
  `COMMERCE_LOADERS` map pattern in `cache-strategy.md`). Prefer calling the
  target loader function directly, or reuse a shared client, over raw `fetch`.
- Add timeout and retry logic

### 18. Slug Normalization
**Check**: Do collection URLs work consistently?
- Normalize slugs and database keys using same logic

## Section Optimization

### 19. Section Deferral
**Check**: Are heavy non-LCP sections deferred?
- Complex headers/footers can use Lazy rendering
- Balance against UX

### 20. Skeleton Fallbacks
**Check**: Do async sections have loading states?
```typescript
export function LoadingFallback() {
  return <div class="skeleton h-64 w-full" />;
}
```

### 21. Deferred Tab Loading
**Check**: Do tabbed components load all tabs on server?
- `isDeferred`/`asResolved` (deco-cx/deco's CMS-level deferred-prop primitives)
  don't exist in `@decocms/runtime`. The current deferred-rendering primitive
  operates at the **section** level, not the individual-prop level (see
  `Lazy.tsx` in item 1 and `async-rendering.md`) — there's no verified
  equivalent for deferring just one prop/tab within an already-eager section.
  For tabs specifically, the more idiomatic fix on React is: fetch each tab's
  data client-side (e.g. on tab activation, via a client component + fetch/query),
  rather than looking for a server-side "defer this one prop" API.

## Quick Audit Commands

```bash
# Find custom loader files without cache config (path is site-specific — there's
# no fixed "loaders/" convention post-split; check src/setup.ts or the loader
# registration file, e.g. server/cms/loaders.gen.ts, for where they actually live)
grep -rL "export const cache" src/loaders/**/*.ts

# Find sections not wrapped in Lazy — check .deco/blocks/*.json first (the
# common on-disk location on real sites), then src/setup.ts's inline `blocks`
# object for sites using that simpler pattern instead. A fast-deploy site's
# live production content can additionally live only in Cloudflare KV, not
# checked into the repo, and won't show up in either.
grep -rn '"__resolveType":.*sections' .deco/blocks/*.json 2>/dev/null | grep -v "Lazy"
grep -n '"__resolveType":.*sections' src/setup.ts | grep -v "Lazy"

# Find raw fetch calls in loaders (no ctx.invoke equivalent anymore — just check
# these have timeout/retry handling, not that they're calling the wrong API)
grep -rn "await fetch" src/loaders/ 2>/dev/null
```
