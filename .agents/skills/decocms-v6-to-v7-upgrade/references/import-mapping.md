# 6.x → 7.x import mapping (TanStack sites)

Derived from lebiscuit-tanstack `b5fdf69` (verified against casaevideo-tanstack), extended by granadobr-tanstack `f593251`. Apply as a mechanical rewrite; nothing here changes runtime behavior.

## Framework core → `@decocms/blocks`

Same subpath, new package root:

| Old | New |
|---|---|
| `@decocms/start/sdk/invoke` | `@decocms/blocks/sdk/invoke` |
| `@decocms/start/sdk/logger` | `@decocms/blocks/sdk/logger` |
| `@decocms/start/sdk/retry` | `@decocms/blocks/sdk/retry` |
| `@decocms/start/sdk/clx` | `@decocms/blocks/sdk/clx` |
| `@decocms/start/sdk/cachedLoader` | `@decocms/blocks/sdk/cachedLoader` |
| `@decocms/start/sdk/cacheHeaders` | `@decocms/blocks/sdk/cacheHeaders` |
| `@decocms/start/sdk/instrumentedFetch` | `@decocms/blocks/sdk/instrumentedFetch` |
| `@decocms/start/sdk/otel` | `@decocms/blocks/sdk/otel` |
| `@decocms/start/sdk/redirects` | `@decocms/blocks/sdk/redirects` |
| `@decocms/start/sdk/requestContext` | `@decocms/blocks/sdk/requestContext` |
| `@decocms/start/sdk/signal` | `@decocms/blocks/sdk/signal` |
| `@decocms/start/sdk/useDevice` | `@decocms/blocks/sdk/useDevice` |
| `@decocms/start/sdk/useId` | `@decocms/blocks/sdk/useId` |
| `@decocms/start/sdk/useScript` | `@decocms/blocks/sdk/useScript` |
| `@decocms/start/sdk/useSuggestions` | `@decocms/blocks/sdk/useSuggestions` |
| `@decocms/start/sdk/abTesting` | `@decocms/blocks/sdk/abTesting` |
| `@decocms/start/matchers/builtins` | `@decocms/blocks/matchers/builtins` (but see setup note below — usually just delete the import) |
| `@decocms/start/types/widgets` | `@decocms/blocks/types/widgets` |
| `@decocms/start` root barrel (type-only re-exports) | `@decocms/blocks/types` |

## CMS module — server vs client split

| Old | New |
|---|---|
| `@decocms/start/cms` — server-side: `loadBlocks`, `setBlocks`, `registerCommerceLoaders`, `applySectionConventions`, `resolveDecoPage`, `ResolvedSection` type, … | `@decocms/blocks/cms` |
| `@decocms/start/cms` — client-safe registry accessors: `getSection`, `getSectionRegistry` (imported by client-bundled renderers) | `@decocms/blocks/cms/client` |

## Setup — split into two factories

| Old | New |
|---|---|
| `@decocms/start/setup` → `createSetup(...)`-style single call | `createSiteSetup` from `@decocms/blocks/setup` (framework-generic: `sections`, `blocks`, `productionOrigins`, `initPlatform`, `onResolveError`) **plus** `createAdminSetup` from `@decocms/blocks-admin/setup` (admin-only: `meta`, `css`, `fonts`, `previewWrapper`) |
| `customMatchers: [registerBuiltinMatchers]` option + its `matchers/builtins` import | **Delete.** `createSiteSetup` calls `registerBuiltinMatchers()` unconditionally in its internal bootstrap |
| `@decocms/start/admin` | `@decocms/blocks-admin` (root) |

## Hooks barrel — split by binding

| Old (`@decocms/start/hooks`) export | New |
|---|---|
| `RenderSection` (framework-generic) | `@decocms/blocks/hooks` |
| `DecoPageRenderer`, `DecoRootLayout`, `SectionRenderer`, `PreviewProviders` (TanStack-bound) | `@decocms/tanstack` (root) |

## Routes / router / worker entry → `@decocms/tanstack` root

| Old | New |
|---|---|
| `@decocms/start/routes` → `cmsRouteConfig`, `cmsHomeRouteConfig`, `loadCmsPage`, `loadCmsHomePage`, `loadDeferredSection`, `decoInvokeRoute`, `decoMetaRoute`, `decoRenderRoute`, `withSiteGlobals` | `@decocms/tanstack` (root). In route files prefer the `decoMetaRouteConfig()`/`decoRenderRouteConfig()`/`decoInvokeRouteConfig()` factories (7.9.1+) — passing a literal by reference (`createFileRoute(...)(decoMetaRoute)`) lets router-core's mutating `update()` pollute the shared object and brick dev HMR; on older versions spread it (`{ ...decoMetaRoute }`) |
| `@decocms/start/routes` → `deferredSectionLoader` | `@decocms/tanstack/sdk/deferredSectionLoader` (public since 7.7.0; on 7.6.x, local shim wrapping `loadDeferredSection` — see SKILL.md) |
| `@decocms/start/sdk/router` → `createDecoRouter` | `@decocms/tanstack` (root) |
| `@decocms/start/sdk/workerEntry` → `createDecoWorkerEntry` | `@decocms/tanstack` (root) |
| `@decocms/start/vite` | `@decocms/tanstack/vite` |
| `@decocms/start/sdk/cookiePassthrough` → `getRequestCookieHeader`, `forwardResponseCookies` | `@decocms/tanstack/sdk/cookiePassthrough` (public since 7.6.0) |
| `@decocms/start/sdk/createInvoke` → `createInvokeFn` | `@decocms/tanstack/sdk/createInvoke` (dedicated subpath; deliberately NOT on the root barrel — see that file's comment) |
| `@decocms/start/sdk/useHydrated` | `useHydrated` from **`@tanstack/react-router`** directly (the old subpath was a one-line re-export; not exposed by the split packages) |

## Apps → per-vendor packages

Identical subpaths under the new package name:

| Old | New |
|---|---|
| `@decocms/apps/vtex`, `@decocms/apps/vtex/*` (client, middleware, mod, types, loaders/*, actions/*, hooks/*, utils/*, commerceLoaders, inline-loaders/*) | `@decocms/apps-vtex`, `@decocms/apps-vtex/*` |
| `@decocms/apps/magento(/*)` | `@decocms/apps-magento(/*)` |
| `@decocms/apps/algolia(/*)` | `@decocms/apps-algolia(/*)` |
| `@decocms/apps/salesforce(/*)` | `@decocms/apps-salesforce(/*)` |
| `@decocms/apps/shopify(/*)` | `@decocms/apps-shopify(/*)` |
| `@decocms/apps/commerce/{sdk,types,utils}/*` | `@decocms/apps-commerce/*` |
| `@decocms/apps/commerce/components/Image`, `.../components/Picture` | **`@decocms/blocks/hooks`** (moved into the framework hooks barrel, not apps-commerce) |
| `@decocms/apps/website/*` (`components/Seo`, `components/OneDollarStats`, `client`, …) | `@decocms/apps-website/*` |

## Not imports, but part of the same rewrite commit

- `vite.config.ts` / `vite.config.dev.ts` `resolve.dedupe`: `["@decocms/start", "@decocms/apps"]` → the full split-package name list the site depends on.
- If developing against a locally-linked deco-start checkout (pre-publish), add `tsconfig.json` `paths` overrides for `@tanstack/react-router` & friends to avoid dual-package type-identity mismatches through the symlink. Remove once on published versions.
