# Layer 1 — page in-flight dedup (`loadCmsPage`, `@decocms/tanstack`)

Prevents concurrent `loadCmsPage` calls for the same path (e.g., prefetch + click happening simultaneously).


Source: `pageInflight` in `packages/tanstack/src/routes/cmsRoute.ts`.

```typescript
const pageInflight = new Map<string, Promise<PageResult>>();

export const loadCmsPage = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => data as LoadCmsPageInput)
  .handler(async (ctx) => {
    const { path: fullPath, resolveGlobals } = parseLoadCmsPageInput(ctx.data);

    const clientNav = isClientNavigation(fullPath, getRequestUrl());
    const inflightKey =
      (clientNav ? `__nav:${fullPath}` : fullPath) + (resolveGlobals ? "" : "|noGlobals");
    const existing = pageInflight.get(inflightKey);
    if (existing) return existing;

    const promise = loadCmsPageInternal(fullPath, resolveGlobals).finally(() =>
      pageInflight.delete(inflightKey),
    );
    pageInflight.set(inflightKey, promise);
    return promise;
  });
```

### Why the full path (with query), not `basePath`

An earlier version of this doc (and of the code) keyed on `basePath` (no query), reasoning that the CMS page structure is the same regardless of `?skuId=X`, so `/product/p?skuId=1` and `/product/p?skuId=2` could share one inflight promise. That was wrong for search and filtered PLPs: `/s?q=a` and `/s?q=b` shared one promise and returned wrong/empty results. The key is now the **full path including the query string**.

Variant clicks still don't double-fetch, but for a different reason: `cmsRouteConfig`'s `ignoreSearchParams` (default `["skuId"]`) strips `skuId` from `loaderDeps` before the loader ever builds the path (see `deco-cms-route-config`).

Two more parts of the key, both because this map is module-global and the shared payload carries `pageUrl`, `flags` and `device` from whichever request won the race:

- `__nav:` prefix — an SSR request and a client-navigation request for the same path never share a promise; they are the pair whose `derivePageUrl` inputs differ most.
- `|noGlobals` suffix — a `resolveGlobals: false` request never shares a promise with a `resolveGlobals: true` one.

## Symptom: `staleTime: 0` causes re-fetch despite `loaderDeps` filtering

In dev mode, if `routeCacheDefaults` returns `{ staleTime: 0, gcTime: 0 }`, TanStack Router always re-fetches even when `loaderDeps` returns the same deps.

**Fix** (already in the framework — `routeCacheDefaults` in `packages/blocks/src/sdk/cacheHeaders.ts` does this; only relevant if a site overrides it): set a minimum staleTime in dev:

```typescript
// In cacheHeaders.ts → routeCacheDefaults()
if (isDev) return { staleTime: 5_000, gcTime: 30_000 };
```
