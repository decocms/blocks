# Layer 3 — layout section-loader cache (`runSectionLoaders`, `@decocms/blocks`)

Caches the output of section loaders (the `export const loader` functions) for layout sections.

Source: `layoutCache` / `layoutInflight` in `packages/blocks/src/cms/sectionLoaders.ts`.

The snippet below shows the control flow. In the current code the store is `createCacheStore("layout-loaders")` rather than a bare `Map`, and the key is `layoutLoaderCacheKey(component, request)` = `<component>::<device>`, not the component key alone. This is the cache that actually carried the device leak (the section's own loader produces `isMobile`; the Layer 2 resolution never sees it), which is why device was added to its key.

```typescript
const layoutSections = new Set<string>();
const layoutCache = new Map<string, { data: ResolvedSection; ts: number }>();
const layoutInflight = new Map<string, Promise<ResolvedSection>>();

export async function runSectionLoaders(
  sections: ResolvedSection[],
  request: Request,
): Promise<ResolvedSection[]> {
  return Promise.all(
    sections.map(async (section) => {
      const key = section.Component;
      const loaderFn = loaderRegistry.get(key);

      if (isLayoutSection(key)) {
        // Check cache
        const cached = layoutCache.get(key);
        if (cached && Date.now() - cached.ts < LAYOUT_CACHE_TTL) {
          return cached.data;
        }
        // Check inflight
        const inflight = layoutInflight.get(key);
        if (inflight) return inflight;

        const promise = runLoader(section, loaderFn, request).then((result) => {
          layoutCache.set(key, { data: result, ts: Date.now() });
          return result;
        });
        layoutInflight.set(key, promise);
        promise.finally(() => layoutInflight.delete(key));
        return promise;
      }

      return loaderFn ? runLoader(section, loaderFn, request) : section;
    }),
  );
}
```
