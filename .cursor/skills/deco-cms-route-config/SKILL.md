---
name: deco-cms-route-config
description: Configure CMS-driven routes in @decocms/tanstack using cmsRouteConfig, cmsHomeRouteConfig, and admin routes. Covers the catch-all route ($.tsx), homepage route (index.tsx), admin protocol routes (meta, render, invoke), ignoreSearchParams for variant selection, staleTime/gcTime configuration, cache headers, and head/SEO setup. Use when creating a new Deco site, migrating routes from Fresh, or debugging route-level caching issues.
---

# CMS Route Configuration in @decocms/tanstack

Reusable route configuration factories that live in `@decocms/tanstack`. Sites use thin wrappers that delegate to these factories, keeping route files small and consistent across all Deco sites.

**Import split (two packages, different export-map shapes):**
- **Runtime functions and components** — `cmsRouteConfig`, `cmsHomeRouteConfig`, `decoMetaRouteConfig`, `decoRenderRouteConfig`, `decoInvokeRouteConfig` (7.9.1+ factories; the `decoMetaRoute`/`decoRenderRoute`/`decoInvokeRoute` literals remain for back-compat), `loadCmsPage`, `loadCmsHomePage`, `loadDeferredSection`, `DecoPageRenderer`, `CmsPage`, `NotFoundPage` — import from `@decocms/tanstack` (package root only; `packages/tanstack/package.json`'s `exports` map has just `.`, `./vite`, `./daemon` — there is no `./routes`, `./hooks`, or `./cms` subpath).
- **Types and SEO/section primitives** — `ResolvedSection`, `DeferredSection`, `PageSeo`, `registerSeoSections`, `extractSeoFromProps`, `extractSeoFromSections`, `resolvePageSeoBlock` — import from `@decocms/blocks/cms`, a separate package.

## When to Use This Skill

- Setting up routes for a new Deco TanStack storefront
- Migrating Fresh routes to TanStack Start
- Debugging why variant changes trigger server re-fetches
- Configuring cache headers per page type
- Setting up admin protocol routes (meta, render, invoke)
- Understanding the relationship between `loaderDeps`, `staleTime`, and server-side caching

---

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

---

## Catch-All CMS Route (`$.tsx`)

The catch-all route handles all CMS-managed pages (PDP, PLP, institutional pages, etc.).

### Site File (minimal)

```typescript
// src/routes/$.tsx
import { createFileRoute } from "@tanstack/react-router";
import {
  cmsRouteConfig,
  loadDeferredSection,
  DecoPageRenderer,
  NotFoundPage,
} from "@decocms/tanstack";
import type { ResolvedSection, DeferredSection } from "@decocms/blocks/cms";

const routeConfig = cmsRouteConfig({
  siteName: "My Store",
  defaultTitle: "My Store - Default Title",
  defaultDescription: "My Store — best products with the best prices.",
  ignoreSearchParams: ["skuId"],
});

type PageData = {
  resolvedSections: ResolvedSection[];
  deferredSections: DeferredSection[];
  name: string;
  path: string;
  params: Record<string, string>;
} | null;

export const Route = createFileRoute("/$")({
  ...routeConfig,
  component: CmsPage,
  notFoundComponent: NotFoundPage,
});

function CmsPage() {
  const data = Route.useLoaderData() as PageData;
  const { _splat } = Route.useParams();
  const actualPath = `/${_splat ?? ""}`;

  if (!data) return <NotFoundPage />;

  return (
    <DecoPageRenderer
      sections={data.resolvedSections ?? []}
      deferredSections={data.deferredSections ?? []}
      pagePath={actualPath}
      loadDeferredSectionFn={(d) => loadDeferredSection({ data: d }) as Promise<ResolvedSection | null>}
    />
  );
}
```

**CRITICAL**: `cmsRouteConfig` already includes `routeCacheDefaults("product")`, cache headers, and full SEO head metadata. Spread the entire config — do NOT cherry-pick individual fields.

### `cmsRouteConfig` Options

```typescript
interface CmsRouteOptions {
  siteName: string;              // Used in page title: "Page Name | siteName"
  defaultTitle: string;          // Fallback title when CMS page has no name
  defaultDescription?: string;   // Fallback description when no SEO section contributes one
  ignoreSearchParams?: string[]; // Search params excluded from loaderDeps (default: ["skuId"])
  pendingComponent?: () => any;  // Skeleton shown during SPA navigation
}
```

### `ignoreSearchParams` — Critical for Variants

`ignoreSearchParams: ["skuId"]` tells TanStack Router that `?skuId` changes should NOT trigger a loader re-fetch:

```typescript
loaderDeps: ({ search }) => {
  const filtered = Object.fromEntries(
    Object.entries(search ?? {}).filter(([k]) => !ignoreSet.has(k)),
  );
  return { search: Object.keys(filtered).length ? filtered : undefined };
},
```

The `loader` only sees `deps.search` (which excludes `skuId`), so it builds the CMS path without `?skuId`:

```typescript
loader: async ({ params, deps }) => {
  const basePath = "/" + (params._splat || "");
  const searchStr = deps.search
    ? "?" + new URLSearchParams(deps.search).toString()
    : "";
  return loadCmsPage({ data: basePath + searchStr });
},
```

### Cache Headers — Dynamic per Page Type

```typescript
headers: ({ loaderData }) => {
  const profile = loaderData?.cacheProfile ?? "listing";
  return cacheHeaders(profile);
},
```

The `cacheProfile` is determined by `detectCacheProfile(basePath)` inside `loadCmsPage`:

| URL Pattern | Profile | Edge TTL |
|-------------|---------|----------|
| `*/p` | product | 5 min |
| `/s`, `?q=` | search | 60s |
| `/cart`, `/checkout` | private | none |
| Everything else | listing | 2 min |

### Head/SEO — Automatic from CMS `page.seo` + Section Registry

The framework's `buildHead()` function generates full `<head>` metadata from two sources:

**Primary: `page.seo` field** — The top-level `seo` block in CMS page JSONs is resolved eagerly by `resolvePageSeoBlock()`. Lazy/Deferred wrappers are always unwrapped (SEO must never be deferred for crawlers). Commerce loaders within the seo block are resolved (e.g., PDP product data). Section loaders transform the resolved props into standard SEO fields.

**Secondary: Registered SEO sections** — Sections in `page.sections` registered via `registerSeoSections()` contribute SEO as a fallback. Page-level `page.seo` always takes precedence.

Generated tags:
- `<title>` from page.seo → section SEO → page name + siteName → defaultTitle
- `<meta name="description">` from page.seo → section SEO → defaultDescription
- `<link rel="canonical">` from page.seo canonical
- `<meta property="og:*">` Open Graph tags (title, description, image, type, url)
- `<meta name="twitter:*">` Twitter Card tags
- `<meta name="robots">` noindex/nofollow when `noIndexing: true`

Title/description templates from the CMS (e.g., `"%s | STORE NAME"`) are applied automatically. The `head()` function is built into `cmsRouteConfig` — sites do NOT need to implement their own.

---

## Homepage Route (`index.tsx`)

Hardcoded to `/` path — no params, no deps.

### Site File

```typescript
// src/routes/index.tsx
import { createFileRoute } from "@tanstack/react-router";
import {
  cmsHomeRouteConfig,
  loadDeferredSection,
  DecoPageRenderer,
} from "@decocms/tanstack";
import type { ResolvedSection, DeferredSection } from "@decocms/blocks/cms";

export const Route = createFileRoute("/")({
  ...cmsHomeRouteConfig({
    defaultTitle: "My Store - Homepage",
    defaultDescription: "My Store — best products with the best prices.",
    siteName: "My Store",
  }),
  component: HomePage,
});

function HomePage() {
  const data = Route.useLoaderData() as {
    resolvedSections: ResolvedSection[];
    deferredSections: DeferredSection[];
  } | null;
  if (!data) return null;

  return (
    <DecoPageRenderer
      sections={data.resolvedSections ?? []}
      deferredSections={data.deferredSections ?? []}
      pagePath="/"
      loadDeferredSectionFn={(d) => loadDeferredSection({ data: d }) as Promise<ResolvedSection | null>}
    />
  );
}
```

`cmsHomeRouteConfig` already includes `routeCacheDefaults("static")`, `cacheHeaders("static")`, and full SEO head metadata. Do NOT add additional cache or head config.

### `cmsHomeRouteConfig` Options

```typescript
interface CmsHomeRouteOptions {
  defaultTitle: string;
  defaultDescription?: string;   // Fallback description
  siteName?: string;             // For OG title composition (defaults to defaultTitle)
  pendingComponent?: () => any;
}
```

---

## Admin Protocol Routes

These routes enable the Deco CMS admin (admin.deco.cx) to communicate with the storefront:

### Meta Route — Schema & Manifest

```typescript
// src/routes/deco/meta.ts
import { createFileRoute } from "@tanstack/react-router";
import { decoMetaRouteConfig } from "@decocms/tanstack";

export const Route = createFileRoute("/deco/meta")(decoMetaRouteConfig());
```

### Render Route — Section Preview

```typescript
// src/routes/deco/render.ts
import { createFileRoute } from "@tanstack/react-router";
import { decoRenderRouteConfig } from "@decocms/tanstack";

export const Route = createFileRoute("/deco/render")(decoRenderRouteConfig());
```

### Invoke Route — Loader/Action Execution

```typescript
// src/routes/deco/invoke.$.ts
import { createFileRoute } from "@tanstack/react-router";
import { decoInvokeRouteConfig } from "@decocms/tanstack";

export const Route = createFileRoute("/deco/invoke/$")(decoInvokeRouteConfig());
```

### Important: Never Pass the Shared Literals by Reference (dev-HMR footgun)

`@decocms/tanstack` also exports module-scope literals (`decoMetaRoute`, `decoRenderRoute`, `decoInvokeRoute`, kept for back-compat). Never hand one directly to `createFileRoute`:

```typescript
// BAD — bricks dev HMR: router-core's update() mutates the SHARED literal
// (Object.assign injects id/path); the first execution pollutes it, and any
// HMR partial re-execution of this file then throws
// "Route cannot have both an 'id' and a 'path' option" — every route 500s
// until the dev server restarts.
export const Route = createFileRoute("/deco/meta")(decoMetaRoute);

// GOOD — factory returns a fresh object per call (7.9.1+)
export const Route = createFileRoute("/deco/meta")(decoMetaRouteConfig());

// ALSO FINE — spread the literal into a new object (works on any version)
export const Route = createFileRoute("/deco/meta")({ ...decoMetaRoute });
```

---

## Framework Exports

`@decocms/tanstack` has a single flat root import — verify against `packages/tanstack/package.json`'s `exports` map (`.`, `./vite`, `./daemon` only) and `packages/tanstack/src/index.ts` (the root barrel):

```typescript
// @decocms/tanstack
export {
  cmsRouteConfig,        // Catch-all CMS route config factory (includes full SEO head)
  cmsHomeRouteConfig,    // Homepage route config factory (includes full SEO head)
  loadCmsPage,           // Server function for CMS page resolution
  loadCmsHomePage,       // Server function for homepage resolution
  loadDeferredSection,   // Server function for on-scroll section loading
  CmsPage,               // Generic CMS page component
  NotFoundPage,          // Generic 404 component
  decoMetaRouteConfig,   // Admin meta route config factory (7.9.1+, preferred)
  decoRenderRouteConfig, // Admin render route config factory (7.9.1+, preferred)
  decoInvokeRouteConfig, // Admin invoke route config factory (7.9.1+, preferred)
  decoMetaRoute,         // Admin meta route config literal (back-compat — spread it, never pass by reference)
  decoRenderRoute,       // Admin render route config literal (back-compat)
  decoInvokeRoute,       // Admin invoke route config literal (back-compat)
  withSiteGlobals,       // Site-wide global sections merge helper
  DecoPageRenderer,      // Section-list renderer (+ deferred-section loading)
  DecoRootLayout,
  NavigationProgress,
  PreviewProviders,
  SectionList,
  SectionRenderer,
  StableOutlet,
  createDecoWorkerEntry,
  setupTanstackFastDeploy,
  createDecoRouter,
  decoParseSearch,
  decoStringifySearch,
  type CreateDecoRouterOptions,
};
```

**Not exported from the `@decocms/tanstack` root** (they exist in `packages/tanstack/src/routes/index.ts`'s internal barrel, but that path isn't part of the public `exports` map, so it isn't importable from site code): `CmsRouteOptions`, `Device`, `CmsPagePendingFallback`, `deferredSectionLoader`, `setSectionChunkMap`, `SiteGlobalsLoaderData`. If you need the `Device` type, import it from `@decocms/blocks/sdk/useDevice` instead (a valid subpath in `packages/blocks/package.json`'s `exports` map).

```typescript
// @decocms/blocks/cms
export {
  registerSeoSections,    // Register section keys that contribute page SEO (secondary source)
  extractSeoFromProps,    // Extract SEO fields from any section's props
  extractSeoFromSections, // Extract SEO from registered sections (used internally)
  resolvePageSeoBlock,    // Resolve page.seo CMS block eagerly (used internally)
  resolveDecoPage,
  runSectionLoaders,
  runSingleSectionLoader,
  type PageSeo,           // { title, description, canonical, image, noIndexing, jsonLDs, type }
  type ResolvedSection,
  type DeferredSection,
  // ... all existing exports — see packages/blocks/src/cms/index.ts
};
```

---

## Common Errors

### `Cannot find module '@decocms/tanstack'` or `'@decocms/blocks/cms'`

TypeScript server needs restart after adding new exports to `package.json`. In VSCode/Cursor:
- Cmd+Shift+P → "TypeScript: Restart TS Server"
- Or restart the dev server

### `Route cannot have both an 'id' and a 'path' option`

A route file passed a shared config literal by reference (e.g. `createFileRoute("/deco/meta")(decoMetaRoute)`) and dev HMR re-executed it against the now-mutated literal. Use the factory (`decoMetaRouteConfig()`, 7.9.1+) or spread: `{ ...decoMetaRoute }`. Restart the dev server once after fixing — the polluted module stays cached until then.

### `Property 'resolvedSections' does not exist on type 'never'`

TypeScript inference limitation with `createServerFn` + `useLoaderData()`. The `page` could be `null`. Add a null check:

```typescript
function CmsPage() {
  const page = Route.useLoaderData();
  if (!page) return <NotFoundPage />;
  return <DecoPageRenderer sections={page.resolvedSections} />;
}
```

### Root Route (`__root.tsx`) — Keep Site-Specific

The root route contains site-specific elements that should NOT be in the framework:
- HTML lang attribute
- Favicon
- CSS stylesheet imports
- Font loading
- Theme configuration
- QueryClient setup
- **Default description and OG site_name/locale** — root-level `head()` should include fallback `<meta name="description">`, `og:site_name`, and `og:locale`. Child routes (from `cmsRouteConfig`) override these when section SEO provides better values.

```typescript
// src/routes/__root.tsx
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "My Store - Default Title" },
      { name: "description", content: "My Store — default description for all pages." },
      { property: "og:site_name", content: "My Store" },
      { property: "og:locale", content: "pt_BR" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  component: RootLayout,
});
```

**Do NOT include a `Device.Provider` with hardcoded values.** For client-side device detection, use `useSyncExternalStore` + `window.matchMedia`. For server-side, use section loaders via `registerSectionLoaders` (they receive the request and can detect UA).

---

## SEO Architecture

SEO in @decocms/tanstack works across four layers:

### 1. CMS `page.seo` Block (primary source)

CMS page JSONs have a top-level `seo` field separate from `sections`. This is the **primary** SEO data source, processed by `resolvePageSeoBlock()` in `resolve.ts`.

**Key behavior: Lazy/Deferred wrappers are always unwrapped.** SEO metadata must be in the initial SSR HTML for crawlers. The original Fresh/Deno framework did NOT do this, causing PDP pages to have zero SSR SEO when `page.seo` was wrapped in `Lazy.tsx`. We fix this by design.

Resolution pipeline:
1. Unwrap Lazy/Deferred (unlimited depth)
2. Follow named block references
3. Evaluate multivariate flags
4. Resolve all nested `__resolveType` (commerce loaders for product data)
5. Return `ResolvedSection` in `DecoPageResult.seoSection`

In `cmsRoute.ts`, the seoSection is enriched by its section loader, then:
- `extractSeoFromProps()` picks title/description/canonical/image/noIndexing/jsonLDs/type
- `titleTemplate` / `descriptionTemplate` from the CMS block are applied (e.g., `"%s | STORE NAME"`)

### 2. Page-Level Meta (framework `head()`)

`cmsRouteConfig` and `cmsHomeRouteConfig` generate `<head>` metadata automatically from the merged `PageSeo` object (page.seo primary + sections secondary). Includes title, description, canonical, OG (title, description, image, type, url), Twitter Card, and robots.

### 3. Section-Contributed SEO (secondary source, `registerSeoSections`)

Sections in `page.sections` that also contribute SEO metadata register themselves in `setup.ts`:

```typescript
import { registerSeoSections } from "@decocms/blocks/cms";

registerSeoSections([
  "site/sections/SEOPDP.tsx",     // Product structured data + meta
  "site/sections/SEOPLP.tsx",     // Category/search meta
]);
```

These sections must have a **section loader** that returns props with SEO fields:

```typescript
interface PageSeo {
  title?: string;
  description?: string;
  canonical?: string;
  image?: string;
  noIndexing?: boolean;
  jsonLDs?: Record<string, any>[];
  type?: string;    // og:type: "website", "product", etc.
}
```

After `runSectionLoaders`, the framework scans registered SEO sections and extracts these fields. Page.seo fields take precedence when both sources provide the same field.

### 4. Structured Data (section component)

JSON-LD (`<script type="application/ld+json">`) is rendered by the section component itself — NOT in `<head>`. The section receives `jsonLDs` in its props and renders them:

```typescript
// src/components/ui/Seo.tsx
export default function Seo({ jsonLDs }: Props) {
  if (!jsonLDs?.length) return null;
  return (
    <>
      {jsonLDs.map((jsonLD, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLD) }}
        />
      ))}
    </>
  );
}
```

### SEO Data Flow

```
CMS Page JSON
  ├─ page.sections[] → resolveDecoPage → runSectionLoaders
  │    → extractSeoFromSections() (secondary SEO source)
  │
  └─ page.seo → resolvePageSeoBlock (unwrap Lazy, resolve commerce loaders)
       → runSingleSectionLoader (SEOPDP transforms jsonLD → title/desc/etc.)
       → extractSeoFromProps() → apply titleTemplate/descriptionTemplate
       → PRIMARY PageSeo

  Merged PageSeo = { ...sectionSeo, ...pageSeo }
  → cmsRouteConfig head() → emits <title>, <meta>, <link>, OG, Twitter, robots
  → Section component renders JSON-LD in page body
```

### Checklist for New Sites

1. **`__root.tsx`**: Include fallback `description`, `og:site_name`, `og:locale`
2. **`$.tsx` / `index.tsx`**: Pass `siteName`, `defaultTitle`, `defaultDescription` to `cmsRouteConfig` / `cmsHomeRouteConfig`
3. **`setup.ts`**: Register section loaders for any site SEO sections (e.g., SEOPDP) that appear in `page.seo` CMS blocks
4. **`setup.ts`**: Optionally call `registerSeoSections([...])` for sections in `page.sections` that contribute SEO
5. **`Seo.tsx`**: Component renders JSON-LD (NOT meta tags — framework handles those)
6. **Device**: Use `matchMedia` for client-side, section loaders for server-side — NO hardcoded `Device.Provider`
7. **CMS audit**: Verify PDP `page.seo` blocks are NOT wrapped in `Lazy.tsx` with no inner section — the framework unwraps Lazy, but the inner section must exist

---

## `staleTime` / `gcTime` Configuration

### Production

Set by `routeCacheDefaults(profile)` based on page type (from `cacheHeaders.ts`):

| Profile | staleTime | gcTime |
|---------|-----------|--------|
| static | 5 min | 30 min |
| product | 1 min | 5 min |
| listing | 1 min | 5 min |
| search | 30s | 2 min |
| cart | 0 | 0 |
| private | 0 | 0 |
| none | 0 | 0 |

### Development

`staleTime: 5_000` (5 seconds) — not zero!

With `staleTime: 0`, TanStack Router re-fetches on every navigation even if `loaderDeps` returns identical deps. This causes:
- Double-fetch on variant changes (despite `ignoreSearchParams`)
- Prefetch + click = 2 server calls

Setting 5s staleTime allows rapid interactions (variant clicks, back/forward) to use cached data while still reflecting changes within a few seconds.

---

## Related Skills

| Skill | Purpose |
|-------|---------|
| `deco-variant-selection-perf` | Variant selection optimization using replaceState |
| `deco-cms-layout-caching` | Layout section caching in CMS resolve |
| `deco-edge-caching` | Cloudflare edge caching with workerEntry |
| `.agents/skills/deco-to-tanstack-migration` | Fresh → TanStack Start migration playbook (broader architecture map, phase-based) |
