# Import map: v7 → v8

What `scripts/imports.ts` does with each v7 `@decocms/*` import in the site's `src/`. Source of truth: `V8_API` and `HINTS` in that file; keep this table in step with them.

## Rewritten by the script

| v7 import | Becomes |
|---|---|
| `@decocms/apps-<x>/loaders/…`, `…/actions/…` that the content calls | the vendored copy in `src/vendor/<app>/…` (relative import) |
| `createInstrumentedFetch` from `@decocms/blocks/sdk/instrumentedFetch` | `createInstrumentedFetch` from `@decocms/blocks/fetch`; `createInstrumentedFetch("x")` becomes `createInstrumentedFetch({ provider: "x" })` |

## Left alone (already the v8 API)

`@decocms/blocks` (the root's v8 names: `createCMS`, `matchRoute`, `remoteLoader`, `draftPointer`, `Blocks`, `Lazy`, `Seo`, …), `@decocms/blocks/fetch`, `/analytics`, `/secrets`, `/cli`.

## Reported, with where the replacement lives (first match wins)

| v7 import | Replacement |
|---|---|
| `@decocms/start`, `@decocms/start/*` | a 6.x import: upgrade the site to 7.x first |
| `@decocms/blocks/sdk/cachedLoader` | gone: an upstream cache is your own `fetch`, passed to `createInstrumentedFetch` (`/next/caching#upstream-data`) |
| `…/invoke`, `createInvoke`, `@decocms/blocks/sdk/invoke` | `/deco/invoke` is gone: call upstream clients from server functions or route handlers (`/next/renames-and-migrations#loaders-actions-and-invoke`) |
| `@decocms/blocks-admin/*` | v8 sites serve no admin endpoints; the site editor uses the content protocol (`/next/studio-compatibility`) |
| `@decocms/blocks-cli/*` | codegen is the `deco` CLI in `@decocms/blocks`: `deco schema`, `deco content`, `deco check` (`/next/cli`) |
| `@decocms/blocks/setup`, `@decocms/blocks/cms/*` | `createCMS` from `@decocms/blocks`, with the block map in `.deco/index.ts` (`/next/content#create-the-cms`) |
| `@decocms/blocks/sdk/instrumentedFetch` (other names) | `createInstrumentedFetch({ provider, fetch?, retry?, circuitBreaker? })` from `@decocms/blocks/fetch` |
| `@decocms/blocks/sdk/otel`, `/sdk/observability`, `/sdk/logger`, `/middleware/observability` | the `telemetry` option of `createCMS` (`/next/telemetry`) |
| `@decocms/blocks/types/widgets` | type the field as a `string` with a `@format` tag (`/next/schema#widgets`) |
| `…/Analytics`, `…/OneDollarStats`, `@decocms/blocks/sdk/analytics` | `AnalyticsScript` and `track` from `@decocms/blocks/analytics`, with the built-in `analytics` block (`/next/analytics`) |
| `@decocms/apps-salesforce`, `@decocms/apps/salesforce` | `@decocms/apps-sfmc-personalization` |
| `@decocms/apps-commerce`, `@decocms/apps/commerce` | converters, hooks and shared commerce types live in your platform template (copy them into the site) |
| `@decocms/apps-website`, `@decocms/apps/website` | SEO, sitemaps, redirects live in your platform template |
| any other `@decocms/apps-<x>`, `@decocms/apps/<x>` | apps are thin upstream clients: call `create<X>Client` from your own code (`/next/upstream-clients`) |
| `@decocms/tanstack`, `@decocms/nextjs` | the v7 framework binding: v8 has none; drop the dependency and follow your framework's guide (`/next/tanstack-start-descriptors`, `/next/nextjs`) |
| anything else under `@decocms/*` | no v8 equivalent |

## What sites ended up writing themselves

From the storefront and blog migrations, the reported imports above were replaced by site code like this:

| v7 import | Site code |
|---|---|
| `Image`, `Picture` (`@decocms/blocks/hooks`) | `src/vendor/blocks/Image.tsx`, a copy that keeps v7's exact CDN URLs |
| `useDevice`, `detectDevice` (`@decocms/blocks/sdk/*`) | `src/sdk/device.ts` with v7's user-agent patterns |
| `getCookies`/`setCookie`, `RequestContext` | read the request and write response headers explicitly, or a site-owned `AsyncLocalStorage` (`src/request-state.server.ts`) |
| `useCart`/`useUser`/`useWishlist`, cart loaders (`@decocms/apps-<x>`) | `src/vendor/<platform>/…` copies, sending through the v8 client (`createShopifyClient`, …) |
| commerce types, offer/price helpers (`@decocms/apps-commerce`) | `src/vendor/commerce` |
| `Seo`, JSON-LD components | the site's head builder (`src/head.ts`) and `src/vendor/blocks` |
| edge cache, cache headers (`@decocms/tanstack` worker entry) | the site's worker entry (`src/server`, `src/worker-entry.ts`) |
