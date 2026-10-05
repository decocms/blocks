---
name: deco-cms-route-config
description: CMS-driven routes for TanStack Start sites on @decocms/tanstack — cmsRouteConfig ($.tsx catch-all), cmsHomeRouteConfig (index.tsx), the admin protocol route factories (decoMetaRouteConfig/decoRenderRouteConfig/decoInvokeRouteConfig), and the SEO/section primitives they use from @decocms/blocks/cms. Covers route options, ignoreSearchParams for variant selection, per-page cache headers, client staleTime/gcTime (routeCacheDefaults), head/SEO generation from page.seo and registered SEO sections, __root.tsx, and what is and is not exported. Load when creating or migrating a site's route files, when variant clicks or hydration trigger extra server fetches, when a route 500s with "cannot have both an 'id' and a 'path'", when SEO tags are missing from SSR HTML, or when an import from @decocms/tanstack does not resolve.
---

# CMS Route Configuration in @decocms/tanstack

Reusable route configuration factories that live in `@decocms/tanstack`. Sites use thin wrappers that delegate to these factories, keeping route files small and consistent across all Deco sites.

**Import split (two packages, different export-map shapes):**
- **Runtime functions and components** — `cmsRouteConfig`, `cmsHomeRouteConfig`, `decoMetaRouteConfig`, `decoRenderRouteConfig`, `decoInvokeRouteConfig` (admin-route factories, 7.10.0+; the former `decoMetaRoute`/`decoRenderRoute`/`decoInvokeRoute` literal exports were removed — see `references/admin-routes.md`), `loadCmsPage`, `loadCmsHomePage`, `loadDeferredSection`, `DecoPageRenderer`, `CmsPage`, `NotFoundPage` — import from the `@decocms/tanstack` root. The package also has dedicated `./sdk/*` subpaths for things kept off the root on purpose (e.g. `deferredSectionLoader` at `@decocms/tanstack/sdk/deferredSectionLoader`); there is no `./routes`, `./hooks`, or `./cms` subpath. Details in `references/exports.md`.
- **Types and SEO/section primitives** — `ResolvedSection`, `DeferredSection`, `PageSeo`, `registerSeoSections`, `extractSeoFromProps`, `extractSeoFromSections`, `resolvePageSeoBlock` — import from `@decocms/blocks/cms`, a separate package.


## When to Use This Skill

- Setting up routes for a new Deco TanStack storefront
- Migrating Fresh routes to TanStack Start
- Debugging why variant changes trigger server re-fetches
- Configuring cache headers per page type
- Setting up admin protocol routes (meta, render, invoke)
- Understanding the relationship between `loaderDeps`, `staleTime`, and server-side caching


## Route Architecture

```
Site Routes (thin wrappers)          Framework (@decocms/tanstack)
─────────────────────────           ──────────────────────────────────
src/routes/$.tsx          ───────→  cmsRouteConfig()
src/routes/index.tsx      ───────→  cmsHomeRouteConfig()
src/routes/deco/meta.ts   ───────→  decoMetaRouteConfig()
src/routes/deco/render.ts ───────→  decoRenderRouteConfig()
src/routes/deco/invoke.$.ts ─────→  decoInvokeRouteConfig()
src/routes/__root.tsx     ×         Site-specific (fonts, theme, CSS)
```


## When to load what

| Reference | Load it when |
|---|---|
| [`references/page-routes.md`](./references/page-routes.md) | Writing `$.tsx` / `index.tsx` / `__root.tsx`: factory options, `ignoreSearchParams` for variants, per-page cache headers and the URL→profile table, how `head()` is built, the `never`-typed loader-data error |
| [`references/admin-routes.md`](./references/admin-routes.md) | Wiring `/deco/meta`, `/deco/render`, `/deco/invoke`, or a route 500s with "Route cannot have both an 'id' and a 'path' option" after HMR |
| [`references/seo.md`](./references/seo.md) | SEO tags missing or wrong: `page.seo` resolution (Lazy unwrapping), `registerSeoSections`, JSON-LD rendering, the new-site SEO checklist |
| [`references/client-cache-timing.md`](./references/client-cache-timing.md) | Deciding or debugging `staleTime` / `gcTime` — why production `staleTime` is `Infinity`, and the dev 5s window |
| [`references/exports.md`](./references/exports.md) | An import doesn't resolve, or you need to know whether a symbol is public (`@decocms/tanstack` root vs `./sdk/*` subpaths vs internal-only; `@decocms/blocks/cms`) |

## Rules that apply to every route file

- **Spread the factory, don't cherry-pick.** `cmsRouteConfig` / `cmsHomeRouteConfig` already carry `loaderDeps`, `loader`, `headers`, `head`, and `routeCacheDefaults(...)`; picking fields loses the ones that make caching and SEO work together.
- **Admin routes: call the factory every time.** `createFileRoute(...)(decoMetaRouteConfig())` — never share one options object between two `createFileRoute` calls, because router-core mutates it and the next HMR re-execution throws.
- **`__root.tsx` stays site-owned** (lang, fonts, CSS, theme, QueryClient, fallback description / `og:site_name` / `og:locale`). No hardcoded `Device.Provider`.

## Related Skills

| Skill | Purpose |
|-------|---------|
| `deco-variant-selection-perf` | Variant selection optimization using replaceState |
| `deco-cms-layout-caching` | Layout section caching in CMS resolve |
| `deco-edge-caching` | Cloudflare edge caching with workerEntry |
| `deco-to-tanstack-migration` (decocms/migrations) | Fresh → TanStack Start migration playbook (broader architecture map, phase-based) |
