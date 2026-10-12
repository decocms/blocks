# What `@decocms/tanstack` and `@decocms/blocks/cms` export for routes

Route code imports from the `@decocms/tanstack` root. The package's `exports` map (`packages/tanstack/package.json`) is `.`, `./vite`, `./daemon`, plus a few dedicated `./sdk/*` subpaths that are kept off the root on purpose: `./sdk/deferredSectionLoader`, `./sdk/createInvoke`, `./sdk/cookiePassthrough`, `./sdk/serverFnFetch`, `./sdk/startEntry`, `./sdk/cdnSegment`. There is no `./routes`, `./hooks` or `./cms` subpath. The root barrel is `packages/tanstack/src/index.ts`:

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
  decoMetaRouteConfig,   // Admin meta route config factory (7.10.0+)
  decoRenderRouteConfig, // Admin render route config factory (7.10.0+)
  decoInvokeRouteConfig, // Admin invoke route config factory (7.10.0+)
  withSiteGlobals,       // Site-wide global sections merge helper
  DecoPageRenderer,      // Section-list renderer (+ deferred-section loading)
  DecoRootLayout,
  DraftPreviewIndicator,
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
  buildSpeculationRules,
  DEFAULT_EXCLUDED_HREF_MATCHES,
  type SpeculationAction,
  type SpeculationEagerness,
  type SpeculationRulesConfig,
};
```

```typescript
// @decocms/tanstack/sdk/deferredSectionLoader — pre-wrapped loadDeferredSection
// matching DecoPageRenderer's loadDeferredSectionFn prop (public since 7.7)
import { deferredSectionLoader } from "@decocms/tanstack/sdk/deferredSectionLoader";
<DecoPageRenderer loadDeferredSectionFn={deferredSectionLoader} />
```

**Not exported from any public `@decocms/tanstack` path** (they exist in `packages/tanstack/src/routes/index.ts`'s internal barrel, which isn't in the `exports` map): `CmsRouteOptions`, `Device`, `CmsPagePendingFallback`, `setSectionChunkMap`, `SiteGlobalsLoaderData`. `deferredSectionLoader` used to be on this list; it is public at `@decocms/tanstack/sdk/deferredSectionLoader` (above), so site-local shims of it can be deleted. If you need the `Device` type, import it from `@decocms/blocks/sdk/useDevice` instead (a valid subpath in `packages/blocks/package.json`'s `exports` map). The pre-7.10.0 admin-route literals (`decoMetaRoute`, `decoRenderRoute`, `decoInvokeRoute`) were removed entirely — only the factories exist.

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


## Common errors

### `Cannot find module '@decocms/tanstack'` or `'@decocms/blocks/cms'`

TypeScript server needs restart after adding new exports to `package.json`. In VSCode/Cursor:
- Cmd+Shift+P → "TypeScript: Restart TS Server"
- Or restart the dev server
