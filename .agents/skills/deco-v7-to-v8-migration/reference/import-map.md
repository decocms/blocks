# Import map: v7 → v8

What `scripts/imports.ts` does with each v7 `@decocms/*` import in the site's `src/`. Source of truth: `V8_API`, `MOVES`, `NAME_HINTS` and `HINTS` in that file; keep these tables in step with them.

## Rewritten by the script

| v7 import | Becomes |
|---|---|
| `@decocms/apps-<x>/loaders/…`, `…/actions/…` that the content calls | the vendored copy in `src/vendor/<app>/…` (relative import) |
| `createInstrumentedFetch` from `@decocms/blocks/sdk/instrumentedFetch` | `createInstrumentedFetch` from `@decocms/blocks/fetch`; `createInstrumentedFetch("x")` becomes `createInstrumentedFetch({ provider: "x" })` |
| `createDecoRouter`, `decoParseSearch`, `decoStringifySearch` (`@decocms/tanstack`) | the same names from `@decocms/tanstack/router` |
| `NavigationProgress`, `StableOutlet` (`@decocms/tanstack`) | the same names from `@decocms/tanstack/react` |
| `decoServerFnFetch` (`@decocms/tanstack/sdk/serverFnFetch`) | `@decocms/tanstack/start` |
| `Image`, `Picture`, `Source` and their props types (`@decocms/blocks/hooks`), on a TanStack site | `@decocms/tanstack/react`, same props and markup. The binding knows no platform, so the script writes `src/imageUrl.ts` (v7's URLs: the platforms' helpers from `@decocms/apps-vtex/image` and `@decocms/apps-shopify/image`, then `decoCdn` with the site's release rules, or its own copy's, and its registered domain and quality) and puts `<ImageUrlProvider value={imageUrl}>` in `createDecoRouter`'s `Wrap` |
| `DRAFT_PARAM`, `DRAFT_COOKIE`, `DRAFT_HEADER`, `draftResponseHeaders`, `STUDIO_ORIGINS`, `STUDIO_FRAME_ANCESTORS`, `isStudioOrigin` (`@decocms/blocks`, a prerelease) | the site's binding root: `@decocms/tanstack` or `@decocms/nextjs` (reported when the site has neither) |
| `@decocms/apps-commerce/<subpath>` (`types`, `types/cart`, `sdk/*`, `utils/*`; also a stray 6.x `@decocms/apps/commerce/<subpath>`) | `@decocms/compat-v7/commerce/<subpath>`: the same files, React-free, v7's output. v7's app runtime (`app-types`, `registry`, `resolve`, `manifest-utils`) is reported |
| `clx` (`@decocms/blocks/sdk/clx`, `/sdk`) | `@decocms/compat-v7/clx` |
| `useScript`, `useScriptAsDataURI`, `inlineScript` (`/sdk/useScript`, `/sdk`) | `@decocms/compat-v7/script`, v7's bytes |
| `detectDevice`, `isMobileUA`, `Device`, `MOBILE_RE`, `TABLET_RE` (`/sdk/detectDevice`, `/sdk/useDevice`, `/sdk`) | `@decocms/compat-v7/device` |
| `useDevice`, `DeviceProvider`, `DeviceContext` (`/sdk/useDevice`, `/sdk`) | `@decocms/compat-v7/tanstack` or `/nextjs`, by binding; the report says how to seed the provider with `requestDevice()` |
| `SectionProps`, `Resolved`, `LoadingFallbackProps`, `Flag` (`@decocms/blocks`, `/types`); the widgets (`ImageWidget`, `Color`, `RichText`, …, `/types/widgets`) | `@decocms/compat-v7/types`, `@decocms/compat-v7/types/widgets` (`deco schema` reads the widget names from there too) |
| `compose`, `withDevice`, `withMobile`, `withSearchParam`, `withSectionLoader` (`@decocms/blocks/cms`) | `@decocms/compat-v7/sections` |
| `registerSectionLoaders({ … })`, `registerNonCriticalSections([…])` | `export const sectionLoaders` and `nonCriticalSections` in the same file, run by `loadSections` in `.deco/index.ts` (`runSectionLoaders` with v7's rules; the nested walk follows the site's 7.x release) |
| `ctx.device` in a v7 loader `(props, req, ctx)` | `detectDevice(req.headers.get("user-agent") ?? "")`, exactly v7's `ctx.device`; any other `ctx.*` read is reported (it throws in v8) |

An import that mixes moved and other names is split; the rest is reported.

## Left alone (already the v8 API)

`@decocms/blocks` (the root's v8 names: `createCMS`, `matchRoute`, `remoteLoader`, `parseDraftPointer`, `Blocks`, `Lazy`, `Seo`, …), `@decocms/blocks/fetch`, `/analytics`, `/secrets`, `/cli`, `/image` (platform-neutral: `createImageUrl`, `decoCdn`, `srcSet`, `parseSrcSet`, `preloadLink`), `/vite`, `/preview` (`DraftBadge`, `StudioBridge`, `StudioPage`); the platforms' image helpers, `@decocms/apps-vtex/image` and `@decocms/apps-shopify/image`; the root of `@decocms/tanstack` 8 (the draft names and Studio's origins) and every subpath (`/worker`, `/server`, `/start`, `/router`, `/react`, `/scope`, and `/vite`'s `decoTanstack`), and of `@decocms/nextjs` 8 (`/proxy`, `/server`, `/image-loader`, `/config`'s `withDeco`, the root's `StudioBridge`, `StudioPage`, `DraftBadge`, draft names and Studio's origins); every `@decocms/compat-v7` entry point.

## Reported, with where the replacement lives (first match wins)

| v7 import | Replacement |
|---|---|
| `@decocms/start`, `@decocms/start/*` | a 6.x import: upgrade the site to 7.x first |
| `@decocms/blocks/sdk/cachedLoader` | gone: an upstream cache is your own `fetch`, passed to `createInstrumentedFetch` (`/next/caching#upstream-data`) |
| `…/invoke`, `createInvoke`, `@decocms/blocks/sdk/invoke` | `/deco/invoke` is gone: one server function per loader or action, imported by each call site, never a rebuilt invoke tree (`/next/renames-and-migrations#loaders-actions-and-invoke`) |
| `@decocms/blocks-admin/*` | v8 sites serve no admin endpoints; the site editor uses the content protocol (`/next/studio-compatibility`) |
| `@decocms/blocks-cli/*` | codegen is the `deco` CLI in `@decocms/blocks`: `deco schema`, `deco content`, `deco check` (`/next/cli`) |
| `@decocms/blocks/setup`, `@decocms/blocks/cms/*` | `createCMS` from `@decocms/blocks`, with the block map in `.deco/index.ts` (`/next/content#create-the-cms`) |
| `@decocms/blocks/sdk/instrumentedFetch` (other names) | `createInstrumentedFetch({ provider, fetch?, retry?, circuitBreaker? })` from `@decocms/blocks/fetch` |
| `@decocms/blocks/sdk/otel`, `/sdk/observability`, `/sdk/logger`, `/middleware/observability` | the `telemetry` option of `createCMS` (`/next/telemetry`) |
| `…/Analytics`, `…/OneDollarStats`, `@decocms/blocks/sdk/analytics` | `AnalyticsScript` and `track` from `@decocms/blocks/analytics`, with the `analytics` section of `cms.settings()` (`/next/analytics`) |
| `@decocms/apps-salesforce`, `@decocms/apps/salesforce` | `@decocms/apps-sfmc-personalization` |
| `@decocms/apps-website`, `@decocms/apps/website` | SEO, sitemaps, redirects live in your platform template |
| any other `@decocms/apps-<x>`, `@decocms/apps/<x>` | apps are thin upstream clients: call `create<X>Client` from your own code (`/next/upstream-clients`) |
| `@decocms/blocks/sdk/cacheHeaders`, `/responseCache`, `/cacheStorage`, `/mergeCacheControl` | on TanStack, `createDecoWorker`'s edge cache (`cacheProfiles` over `DEFAULT_CACHE_PROFILES`); a Next.js site keeps its own |
| `@decocms/blocks/sdk/csp`, `/sdk/redirects` | `createDecoWorker`'s `csp` option; the worker applies CMS redirects |
| `createDecoWorkerEntry` (`@decocms/tanstack`) | `createDecoWorker({ serverEntry, cms, site, buildHash })` from `@decocms/tanstack/worker` (`reference/framework-code.md`) |
| `DecoRootLayout`, `PreviewProviders`, `DraftPreviewIndicator` (`@decocms/tanstack`) | `DecoDocument` from `@decocms/tanstack/react` |
| `cmsRouteConfig`, `loadCmsPage`, `DecoPageRenderer`, … (`@decocms/tanstack`) | `createCMS` and `matchRoute` (`/next/tanstack-start-descriptors`), the draft from `contentClient(cms)` (`@decocms/tanstack/server`) |
| `decoInvokeRouteConfig`, `decoMetaRouteConfig`, `decoRenderRouteConfig` | delete: the worker answers 404 on v7's admin paths |
| `setupTanstackFastDeploy`, `kvLoader` | `createCMS({ site, token })` (`reference/hosted-releases.md`) |
| `@decocms/tanstack/vite` (`decoVitePlugin`) | `decoTanstack({ buildHash })` from `@decocms/tanstack/vite` |
| `@decocms/tanstack/sdk/startEntry`, `/sdk/cdnSegment`, `/sdk/cookiePassthrough` | `decoServerFnFetch` in `createStart`; the worker's `segment`; the worker's Set-Cookie handling |
| `createDecoPage`, `DecoPageRenderer`, `DecoRootLayout`, … (`@decocms/nextjs`) | `createCMS` (`/next/nextjs`); `bindDraft` and `contentClient` from `@decocms/nextjs/server`; `StudioBridge` in the root layout |
| `DraftPreviewIndicator` (`@decocms/nextjs`) | the same name in v8, showing what `bindDraft` bound: call that first |
| `@decocms/nextjs/middleware` | `decideDraft` … `applyDraft` (or `draftProxy`) from `@decocms/nextjs/proxy` |
| `@decocms/nextjs/routeHandlers`, `DECO_REWRITES` | delete: no `/deco/*` handlers in v8 |
| `LiveControls` (`@decocms/blocks/hooks`) | `StudioBridge`: `DecoDocument` mounts it (`DecoPreview` in a site's own document); a Next.js layout renders it from `@decocms/nextjs`, and each page renders `StudioPage` |
| `DraftPreviewBadge` (`@decocms/blocks/preview`, `@decocms/nextjs`) | `DraftBadge` from `@decocms/blocks/preview` |
| `registerImageCdnDomain`, `registerImageQuality`, `getOptimizedMediaUrl`, `getSrcSet` | `createImageUrl({ providers: [vtexCatalog(), shopifyCdn(), decoCdn({ domain, quality, sources: "all", ...byRelease })] })` (`byRelease` by the site's 7.x release, or read from the site's own copy of the helper: `framework-code.md`): `createImageUrl`, `decoCdn` from `@decocms/blocks/image`, `vtexCatalog` from `@decocms/apps-vtex/image`, `shopifyCdn` from `@decocms/apps-shopify/image`; `url(src, opts)` and `srcSet(url, src, opts)`; on TanStack, `ImageUrlProvider` |
| `Image`, `Picture` on a Next.js site | next/image with `createDecoImageLoader` from `@decocms/nextjs/image-loader` |
| other v7 names under `@decocms/tanstack`, `@decocms/nextjs` | the v8 binding has no such name; see the rows above and `reference/framework-code.md` |
| anything else under `@decocms/*` | no v8 equivalent (several have a site-code replacement: the next table) |

## What sites ended up writing themselves

From the storefront and blog migrations, the reported imports with no binding equivalent were replaced by site code like this:

| v7 import | Site code |
|---|---|
| `BreadcrumbJsonLd`, `PLPJsonLd`, `ProductJsonLd` (`@decocms/blocks/hooks`) | `src/vendor/blocks/JsonLd.tsx` |
| `ANALYTICS_SCRIPT` (`@decocms/blocks/sdk/analytics`) on a site with no analytics SDK | on TanStack, nothing: `DecoDocument` renders the `data-event` observer; elsewhere the same observer string in the site's root document, copied from the installed version (7.6x defers it until a Speculation Rules prerender activates) |
| `withABTesting` (`@decocms/blocks/sdk/abTesting`), or a vendored copy | on TanStack Start, `abTestingRoutes({ worker: () => worker, kvBinding, shouldBypassAB, preHandler })` from `@decocms/compat-v7/tanstack/worker`, run first in `createDecoWorker`'s `routes`; the script reports the import (a wrapper becomes a routes handler, so it isn't rewritten). If the KV holds no config for the site's hosts, nothing was split: delete it and the binding instead (`reference/framework-code.md`) |
| `signal` (`@decocms/blocks/sdk/signal`) | delete it when nothing imports the site's re-export; otherwise a local signal |
| `withFetchTimeout`, `FetchFn` (`@decocms/blocks/sdk/fetchTimeout`, 7.6x) in vendored loaders | a local `fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })` (v7's default), or the v8 client's own fetch |
| `getCookies`/`setCookie`, `RequestContext` | read the request and write response headers explicitly, or a site-owned `AsyncLocalStorage` (`src/request-state.server.ts`) |
| `useCart`/`useUser`/`useWishlist`, cart loaders (`@decocms/apps-<x>`) | `src/vendor/<platform>/…` copies, sending through the v8 client (`createShopifyClient`, …) |
| `Seo`, JSON-LD components | the site's head builder (`src/head.ts`) and `src/vendor/blocks` |
