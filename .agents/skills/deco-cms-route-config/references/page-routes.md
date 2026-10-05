# CMS page routes — catch-all (`$.tsx`), homepage (`index.tsx`), root (`__root.tsx`)

The two CMS page factories from `@decocms/tanstack` and the site-owned root route. Spread the factory output; the site only supplies `component` (and `notFoundComponent`).

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
  pendingComponent?: (() => any) | null; // Skeleton during SPA navigation — NO default (see below)
  pendingMs?: number;            // Delay before the pending component shows (default 200)
  pendingMinMs?: number;         // Minimum time it stays once shown (default 300)
  errorComponent?: (props: { error: Error; reset: () => void }) => any; // default CmsPageErrorFallback
  ssr?: boolean | "data-only";   // Route SSR mode (default: full SSR)
  resolveGlobals?: boolean;      // Merge the CMS `Site` block (theme/global/pageSections); default true
}
```

`pendingComponent` has no default on purpose: without one, TanStack keeps the previous page on screen until the new one commits, which at sub-second latencies feels better than a page → skeleton → page swap — and this is a catch-all route, so one skeleton shape would have to serve PDP, PLP, search and institutional pages alike. Prefer a per-shape skeleton or `NavigationProgress` (`@decocms/tanstack`), which gives feedback without replacing the page. `CmsPagePendingFallback` exists in the package as a starting point but is not exported from the public root (see `exports.md`). `errorComponent` defaults to a branded "instability" page with a retry button so an outage degrades instead of a raw 500. Verify the full list against `CmsRouteOptions` in `packages/tanstack/src/routes/cmsRoute.ts`.

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
  return loadCmsPage({ data: { path: basePath + searchStr, resolveGlobals } });
},
```

(`loadCmsPage` takes `{ path, resolveGlobals }`; the inflight dedup key inside it is the **full** path including the query string — see `deco-cms-layout-caching`.)

### Cache Headers — Dynamic per Page Type

```typescript
headers: ({ loaderData }) => {
  const profile = loaderData?.cacheProfile ?? "listing";
  const headers = cacheHeaders(profile);
  // A degraded page (e.g. VTEX outage) is flagged on the DOCUMENT response;
  // the worker treats 200 + X-Deco-Degraded like a 5xx (no store, serve stale)
  if (loaderData?.degraded) headers["X-Deco-Degraded"] = "true";
  return headers;
},
```

The `cacheProfile` is determined by `detectCacheProfile(basePath)` inside `loadCmsPage`:

| URL Pattern | Profile | Edge TTL (`s-maxage`) |
|-------------|---------|----------|
| Private segments — `/cart`, `/checkout`, `/account`, `/login`, `/wishlist`, pt-BR equivalents (`/carrinho`, `/minha-conta`, `/listadedesejos`, …), case-insensitive, optional locale prefix | private | none |
| `/api/*`, `/deco/*`, `/_build*` | none | none |
| `/s`, `/s/*`, `?q=` | search | 60s |
| `*/p` | product | 5 min |
| `/` | static | 15 min |
| Everything else | listing | 2 min |

Evaluated top to bottom, after any site `registerCachePattern` (which can never turn a private path public). Full list and rationale: `PRIVATE_SEGMENTS` / `builtinPatterns` in `packages/blocks/src/sdk/cacheHeaders.ts`, and the `deco-edge-caching` skill.

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
  pendingComponent?: (() => any) | null; // no default — same reasoning as cmsRouteConfig
  pendingMs?: number;            // default 200
  pendingMinMs?: number;         // default 300
  errorComponent?: (props: { error: Error; reset: () => void }) => any;
  resolveGlobals?: boolean;      // default true
}
```


## Root Route (`__root.tsx`) — Keep Site-Specific

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


## Common errors

### `Property 'resolvedSections' does not exist on type 'never'`

TypeScript inference limitation with `createServerFn` + `useLoaderData()`. The `page` could be `null`. Add a null check:

```typescript
function CmsPage() {
  const page = Route.useLoaderData();
  if (!page) return <NotFoundPage />;
  return <DecoPageRenderer sections={page.resolvedSections} />;
}
```
