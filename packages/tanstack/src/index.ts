export {
  cmsHomeRouteConfig,
  cmsRouteConfig,
  CmsPage,
  decoInvokeRouteConfig,
  decoMetaRouteConfig,
  decoRenderRouteConfig,
  loadCmsHomePage,
  loadCmsPage,
  loadDeferredSection,
  NotFoundPage,
  withSiteGlobals,
} from "./routes";
export {
  DecoPageRenderer,
  DecoRootLayout,
  DraftPreviewIndicator,
  NavigationProgress,
  PreviewProviders,
  SectionList,
  SectionRenderer,
  StableOutlet,
} from "./hooks";
export { createDecoWorkerEntry } from "./sdk/workerEntry";
export { setupTanstackFastDeploy } from "./setupFastDeploy";
export {
  createDecoRouter,
  decoParseSearch,
  decoStringifySearch,
} from "./sdk/router";
export type { CreateDecoRouterOptions } from "./sdk/router";
export {
  buildSpeculationRules,
  DEFAULT_EXCLUDED_HREF_MATCHES,
} from "./sdk/speculationRules";
export type {
  SpeculationAction,
  SpeculationEagerness,
  SpeculationRulesConfig,
} from "./sdk/speculationRules";
// createInvokeFn is intentionally NOT re-exported from this root barrel.
// Its body contains a `createServerFn(...).handler(...)` call that is not a
// top-level variable declarator (it's returned from a factory function) --
// TanStack Start's compiler statically scans every file it processes for
// this pattern and throws "createServerFn must be assigned to a variable!"
// on ANY occurrence, whether or not the factory is ever actually called.
// Re-exporting it here would pull sdk/createInvoke.ts into the module graph
// of every site that imports anything else from this barrel (which is
// every site, for DecoRootLayout etc.), tripping that check even though
// createInvokeFn itself is never invoked at runtime -- it exists purely as
// a source-of-truth template that blocks-cli's generate-invoke.ts statically
// parses (never imports) to emit real top-level createServerFn declarations
// into each site's own src/server/invoke.gen.ts. Import it from the
// dedicated "@decocms/tanstack/sdk/createInvoke" subpath instead.
// decoServerFnFetch is intentionally NOT re-exported from this root barrel
// either. A site wires it in `src/start.ts`, which is part of the CLIENT
// bundle; importing it from here would drag `createDecoWorkerEntry` (and the
// whole server graph behind it) into that bundle. Import it from the dedicated
// "@decocms/tanstack/sdk/serverFnFetch" subpath instead.
