# Layer 2 — layout resolution cache (`resolveDecoPage`, `@decocms/blocks`)

Caches the fully resolved CMS output for layout sections. This is the most impactful layer because layout sections often contain embedded commerce loaders (Header with product shelves) that make expensive API calls.

Source: `resolvedLayoutCache` / `resolvedLayoutInflight` in `packages/blocks/src/cms/resolve.ts`. Which sections count as layout: see `layout-registering-sections.md`.

## How It Works

The snippets below show the control flow. Two details differ in the current code: the store is `createCacheStore("resolved-layouts")` (a bounded in-memory tier, optionally backed by the shared CacheStorage), not a bare `Map`, with a `RESOLVE_CACHE_TTL` of 5 minutes; and the cache key is `layoutCacheKey(blockKey, matcherCtx)` = `<blockKey>::<device>`, where `blockKey` is the top-level block reference (e.g. `"Header - 01"`), not the final section path. See `layout-registering-sections.md` for why device is in the key.

In `resolveDecoPage`, before resolving each raw section:

1. Check if the raw block eventually resolves to a registered layout section (walks up to 5 levels of block references like `"Header - 01"` → `"Header"` → `site/sections/Header/Header.tsx`)
2. If layout: check `resolvedLayoutCache` → return cached result if fresh
3. If inflight: return existing promise (dedup concurrent resolutions)
4. Otherwise: resolve normally, cache result for 5 minutes

```typescript
const resolvedLayoutCache = new Map<string, { sections: ResolvedSection[]; ts: number }>();
const resolvedLayoutInflight = new Map<string, Promise<ResolvedSection[]>>();
const LAYOUT_CACHE_TTL = 5 * 60_000; // 5 minutes

// Inside resolveDecoPage:
const layoutKey = isRawSectionLayout(section);
if (layoutKey) {
  const cached = getCachedResolvedLayout(layoutKey);
  if (cached) return cached;

  const inflight = resolvedLayoutInflight.get(layoutKey);
  if (inflight) return inflight;

  const promise = resolveRawSection(section, rctx).then((results) => {
    setCachedResolvedLayout(layoutKey, results);
    return results;
  });
  resolvedLayoutInflight.set(layoutKey, promise);
  promise.finally(() => resolvedLayoutInflight.delete(layoutKey));
  return promise;
}
```

## `isRawSectionLayout` — Walking Block References

CMS blocks often reference other blocks:
- `"Header - 01"` → resolves to `"Header"` → resolves to `{ __resolveType: "site/sections/Header/Header.tsx" }`

```typescript
function isRawSectionLayout(section: RawSection): string | null {
  // Walk up to 5 levels of block indirection
  let current = section;
  for (let depth = 0; depth < 5; depth++) {
    const resolveType = current.__resolveType;
    if (isLayoutSection(resolveType)) return resolveType;
    const block = decofileData?.[resolveType];
    if (!block || typeof block !== "object") return null;
    current = block as RawSection;
  }
  return null;
}
```


## Regression Test: Shared-Object Index Corruption (`layoutCacheRace.test.ts`)

`packages/blocks/src/cms/layoutCacheRace.test.ts` is a permanent regression test guarding a real production incident, not a hypothetical. `resolveDecoPage`'s layout-section cache (Layer 2 above) returns the **same cached object** to every concurrent caller that resolves to the same layout section (e.g. Footer). Each caller then stamps its own page's flat position onto that object's `.index` field so `mergeSections` can sort eager + deferred sections back into CMS order.

The bug: an earlier version of this stamping step mutated the shared cached object **in place** instead of cloning it first. If two concurrent requests needed the same cached layout section at *different* flat positions (page A has Footer at index 0, page B has Footer at index 2), whichever request's stamp landed last won — and both requests then observed that same, possibly-wrong-for-them index. This shipped in `@decocms/start@6.12.1` and caused a same-day production rollback on two live sites (intermittent "footer renders above other sections" under concurrent traffic) before being fixed in 6.12.2 by cloning the wrapper object (`{ ...section, index }`) before stamping, so the shared cache/in-flight objects are never touched.

If you ever see this test fail, do not "fix" it by relaxing the assertion — it is asserting exactly the invariant that broke production once already. See `CLAUDE.md` (repo root) for the full incident writeup.
