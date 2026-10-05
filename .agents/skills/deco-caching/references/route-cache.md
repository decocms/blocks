# Route-level cache — `headers()` and `routeCacheDefaults`

## Route Setup

```ts
import { createFileRoute } from "@tanstack/react-router";
import { cacheHeaders, routeCacheDefaults } from "@decocms/blocks/sdk/cacheHeaders";

export const Route = createFileRoute("/")({
  ...routeCacheDefaults("static"),
  headers: () => cacheHeaders("static"),
  loader: () => loadPage(),
  component: HomePage,
});
```

For the CMS catch-all route:

```ts
export const Route = createFileRoute("/$")({
  ...routeCacheDefaults("listing"),
  headers: () => cacheHeaders("listing"),
  loader: async ({ params }) => { /* ... */ },
  component: CmsPage,
});
```

The worker-entry overrides the route's Cache-Control with the correct profile for each URL (PDP gets `product`, search gets `search`, etc.), so the route's `headers()` is a fallback. Client-side navigation data (`/_serverFn/...` GETs) is also classified by the worker, using the page path embedded in the server-fn payload, so it gets the same profile as the page's HTML.


## Client-Side Route Caching (routeCacheDefaults)

Without `routeCacheDefaults`, every SPA navigation triggers a fresh server request even if the data was just loaded. This is the most common cause of "slow navigation" reports.

The catch-all route `$.tsx` MUST include `routeCacheDefaults`:

```ts
export const Route = createFileRoute("/$")({
  ...routeCacheDefaults("listing"),   // <-- client-side cache: staleTime Infinity (5s in dev), 5min gc
  loaderDeps: routeConfig.loaderDeps,
  loader: routeConfig.loader,
  headers: ({ loaderData }) => {
    return cacheHeaders(loaderData?.cacheProfile ?? "listing");
  },
  component: CmsPage,
});
```

The homepage should use `cmsHomeRouteConfig` which already includes `routeCacheDefaults("static")`:

```ts
export const Route = createFileRoute("/")({
  ...cmsHomeRouteConfig({ defaultTitle: "My Store" }),
  component: HomePage,
});
```

### What `routeCacheDefaults` actually returns

Production: `{ staleTime: Infinity, gcTime: <profile client.gcTime> }` for every profile. Dev (`NODE_ENV=development` or `DECO_CACHE_DISABLE=true`): `{ staleTime: 5_000, gcTime: 30_000 }`. `Infinity` is deliberate: TanStack Router dehydrates SSR data with `updatedAt: 0`, so any finite `staleTime` refetches `/_serverFn/loadCmsPage` right after hydration and doubles origin load (decocms/blocks#355); data freshness is the edge cache's job. Full table: `deco-cms-route-config` → `references/client-cache-timing.md`.

For CMS pages, prefer the `cmsRouteConfig` / `cmsHomeRouteConfig` factories from `@decocms/tanstack` over hand-assembling `routeCacheDefaults` + `headers` as above — they already spread `routeCacheDefaults("product")` / `("static")` and pick `cacheHeaders(loaderData.cacheProfile)` per page.
