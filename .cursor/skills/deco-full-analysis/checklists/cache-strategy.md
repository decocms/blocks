# Cache Strategy Checklist

7 learnings from real Deco sites. Check these during analysis.

> Verified against `packages/runtime/src/sdk/cachedLoader.ts` (`@decocms/runtime`). The
> `cache`/`cacheKey` export pattern below still matches the current `LoaderModule`
> interface exactly (`cache?: CachePolicy | { maxAge: number }`, `cacheKey?: (props) =>
> string | null`, where `CachePolicy = "no-store" | "no-cache" | "stale-while-revalidate"`).
> A module with these exports becomes a cached function via
> `createCachedLoaderFromModule(name, mod)`. **Correction to an earlier version of this
> note**: `.deco/blocks/*.json` is still a real, current, on-disk convention — most real
> sites (confirmed: faststore-fila, casaevideo-tanstack, bagaggio-tanstack) load CMS page/
> section content from a `.deco/blocks/` directory snapshot, either via `@decocms/cli`'s
> `generate-blocks.ts`/`sync-blocks-to-kv.ts` codegen or `@decocms/runtime/cms`'s
> `loadDecofileDirectory` helper. Passing an inline `blocks` object directly to
> `createSiteSetup({ blocks: {...} })` in `src/setup.ts` is a second, simpler pattern used
> by minimal fixtures (`examples/tanstack-smoke`) — both are valid, check which one a given
> site actually uses before auditing. There's no framework-enforced `loaders/**/*.ts`
> directory — custom loaders live wherever a given site puts them (commonly `src/loaders/`,
> per the CLI's migration templates, but this isn't a hard convention). See the audit-command
> fixes below.

## Loader Caching

### 1. Stale-While-Revalidate Pattern
**Check**: Do custom loaders have cache configuration?

```typescript
// Good: Has caching
export const cache = "stale-while-revalidate";

export const cacheKey = (props: Props) =>
  `${props.productId}-${props.locale}`;

export default async function loader(props: Props) {
  // ...
}
```

### 2. Deterministic Cache Keys
**Check**: Are cache keys based on unique identifiers?

```typescript
// Bad: Uses full URL (includes tracking params)
export const cacheKey = (props: Props, req: Request) => req.url;

// Good: Uses only relevant data
export const cacheKey = (props: Props) => {
  const facets = [...(props.facets || [])].sort();
  return `${props.query}-${facets.join(",")}`;
};
```

**Common mistakes**:
- Including UTM parameters in cache key
- Including session/user-specific data
- Using unsorted arrays (order changes = cache miss)

### 3. Loader Deduplication via Shared Blocks
**Check**: Are the same loaders configured inline in multiple page/section blocks?

```json
// Bad: Same loader config inline for Home, PLP, and PDP in the CMS blocks object
// (in src/setup.ts's `blocks`, or the remote decofile behind @decocms/admin)
{ "loader": { "productId": "..." } }

// Good: Reference a shared named block
{ "__resolveType": "$PDP-Main-Loader" }
```

Benefits:
- Single cache entry for same data
- Easier to update
- Better hit rate

Note: this only applies to CMS-configured loader references inside page/section
blocks (resolved via `__resolveType`). It's unrelated to the `cache`/`cacheKey`
exports above, which cache a loader's own function calls regardless of how many
blocks reference it.

## Rate Limiting

### 4. Bot-Specific Rate Limiting
**Check**: Do bots and users share rate limits?

```typescript
// In site-specific server middleware. There's no dedicated "add a rate-limit
// hook here" API in either package — for a Next.js site this is the standard
// Next `middleware.ts` at the project root; for a TanStack Start / Cloudflare
// Workers site this is your own wrapper around the fetch handler that calls
// `createDecoWorkerEntry()` (packages/tanstack/src/sdk/workerEntry.ts) — that
// function's options (`DecoWorkerEntryOptions`) don't expose a generic
// per-request hook, so custom logic like this wraps the handler it returns.
const isBot = req.headers.get("user-agent")?.includes("bot");

if (isBot) {
  // Apply stricter rate limiting for bots
  const botRateLimit = await checkBotRateLimit(ip);
  if (botRateLimit.exceeded) {
    return new Response("Too Many Requests", { status: 429 });
  }
}
```

### 5. Granular Rate Limit Tracking
**Check**: Is rate limiting per-endpoint or global?
- Track rate limits per endpoint for critical paths
- Allow more requests to cached endpoints

## SSR Caching

### 6. SSR Promotion Fetching
**Check**: Is promotion data fetched client-side causing CLS?
- Fetch discount/promotion rules on server
- Prevents price flickering

```typescript
// Good: Fetch on server
export default async function ProductCard({ product }: Props) {
  const promotion = await fetchPromotion(product.id);
  const finalPrice = applyPromotion(product.price, promotion);
  return <Card price={finalPrice} />;
}
```

### 7. Related Products Caching
**Check**: Do related product loaders have cache?
- Often high-volume, low-change-rate
- Good candidate for aggressive caching

```typescript
export const cache = "stale-while-revalidate";
export const cacheKey = (props: Props) => `related-${props.productId}`;
```

## Cache Audit Table

Add this to AGENTS.md:

```markdown
## Caching Inventory

| Loader | Cache | Cache Key | Priority |
|--------|-------|-----------|----------|
| `vtex/loaders/intelligentSearch/productListingPage.ts` | ❌ None | - | 🔴 High |
| `site/loaders/product/buyTogether.ts` | ✅ SWR | productId | - |
| `site/loaders/getUserGeolocation.ts` | ❌ None | - | 🟡 Medium |
| `vtex/loaders/categories/tree.ts` | ❌ None | - | 🔴 High |
```

(Loader keys above follow the `vtex/...` / `site/...` naming used when registering
loaders into a `COMMERCE_LOADERS` map — see `createVtexCommerceLoaders()` in
`@decocms/apps/vtex/commerceLoaders`, and the CLI's migration template at
`packages/cli/scripts/migrate/templates/commerce-loaders.ts` for a worked example.)

## Quick Audit Commands

```bash
# Find custom loader files without cache config (adjust the path — there's no
# fixed "loaders/" convention post-split; check src/setup.ts or the site's
# loader-registration file, e.g. server/cms/loaders.gen.ts, to see where they live)
grep -rL "export const cache" src/loaders/**/*.ts

# Find loaders with cache but no cacheKey
grep -rl "export const cache" src/loaders/**/*.ts | xargs grep -L "cacheKey"

# Find where cache wrapping is centrally applied (some sites wrap loaders via
# createCachedLoader/createCachedLoaderFromModule instead of per-file exports —
# check both patterns before concluding a loader is uncached)
grep -rn "createCachedLoader\|createCachedLoaderFromModule" src/

# Find inline loader/section config in CMS blocks (should be shared via a named
# block instead of duplicated). Check .deco/blocks/*.json first — that's the more
# common on-disk location on real sites — then fall back to src/setup.ts's
# inline `blocks` object for sites using that simpler pattern instead. Either
# way, this only finds what's checked into the repo — a fast-deploy site's
# live production content may live only in Cloudflare KV (see
# packages/admin/src/admin/decofile.ts's handleDecofileRead) and isn't
# greppable locally.
grep -rn '"__resolveType"' .deco/blocks/*.json 2>/dev/null | grep -c "loader\|Loader"
grep -n '"loader":' src/setup.ts | grep -v "__resolveType"
```

## Common Cache Durations

| Content Type | Strategy | TTL |
|--------------|----------|-----|
| Product details | SWR | 5 min |
| Category tree | SWR | 1 hour |
| Search results | SWR | 1 min |
| Reviews | SWR | 15 min |
| Static content | SWR | 1 day |
| User-specific | None | - |
