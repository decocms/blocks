# Layer 3 — layout section-loader cache (`runSectionLoaders`, `@decocms/blocks`)

Caches the output of section loaders (the `export const loader` functions) for layout sections.

Source: `layoutCache` / `layoutInflight` in `packages/blocks/src/cms/sectionLoaders.ts`.

The key is `layoutLoaderCacheKey(component, request)` = `<component>::<device>` (device from the User-Agent), never the component alone. This is the cache that actually carried the device leak (the section's own loader produces `isMobile`; the Layer 2 resolution never sees it), which is why device was added to its key. Condensed from `resolveLayoutSection`:

```typescript
const LAYOUT_CACHE_TTL = 5 * 60_000;
const layoutCache = createCacheStore<CachedSection>("layout-loaders");
const layoutInflight = new Map<string, Promise<ResolvedSection>>();

async function resolveLayoutSection(section, loader, request) {
  const key = layoutCache.key(layoutLoaderCacheKey(section.component, request));
  const { index } = section;
  // Re-stamp this page's index on a copy; never mutate the shared entry.
  const withIndex = (s) => (index !== undefined ? { ...s, index } : s);

  const cached = await getCachedLayout(key); // null once expiresAt has passed
  if (cached) return withIndex(cached);

  const existing = layoutInflight.get(key);
  if (existing) return existing.then(withIndex);

  const promise = withInflightTimeout(
    (async () => {
      const enrichedProps = await loader(section.props, request);
      const { index: _idx, ...rest } = section;
      const enriched = { ...rest, props: enrichedProps };
      setCachedLayout(key, enriched); // expiresAt = now + LAYOUT_CACHE_TTL
      return withIndex(enriched);
    })(),
    `layoutSection ${key}`,
  ).finally(() => layoutInflight.delete(key));
  layoutInflight.set(key, promise);
  return promise;
}
```

`runSectionLoaders` calls this for sections where `isLayoutSection(section.component)` and a loader is registered; other sections run their loader normally.
