/**
 * Client-safe subset of `@decocms/blocks/cms`.
 *
 * `@decocms/blocks/cms` (the full barrel in `./index.ts`) re-exports
 * `loader.ts` and `resolve.ts`, which transitively import `node:async_hooks`
 * and `node:fs/promises`. Bundling ANY export from that barrel for a browser
 * target — even one that itself has zero Node dependencies, like
 * `getResolvedComponent` — drags the whole module graph in, since ES module
 * imports are evaluated at the file level, not per-export. Turbopack rejects
 * this outright in production builds ("the chunking context does not
 * support external modules"); webpack has historically let it through
 * uncaught, which just defers the failure to whoever notices the bloated
 * client bundle or a runtime error.
 *
 * This entry point exists so Client Components can import section-registry
 * lookups (e.g. to resolve and render a section by name, given data already
 * fetched server-side) without pulling in the resolver/loader machinery.
 *
 * Verified client-safe by import-graph inspection, transitively:
 * - `registry.ts` imports only React types.
 * - `sectionMixins.ts` imports `useDevice.ts`, which goes through
 *   `requestContext.ts` — that module's only `node:async_hooks` dependency
 *   (`requestContextStorage.ts`) is itself swapped for a no-op browser stub
 *   via this package's `"browser"` export condition (see
 *   `sdk/requestContextStorage.browser.ts`), so it's already safe for a
 *   browser bundle.
 * - `schema.ts` has no imports at all.
 *
 * Deliberately NOT re-exported here: `loader.ts`, `resolve.ts`,
 * `sectionLoaders.ts`, `loadDecofileDirectory.ts`, `blockSource.ts`, and
 * `applySectionConventions.ts` (which itself pulls in `resolve.ts` and
 * `sectionLoaders.ts` for section-registration setup). Those are resolver/
 * storage concerns that only make sense server-side — import them from
 * `@decocms/blocks/cms` instead.
 */
export type { OnBeforeResolveProps, SectionModule, SectionOptions } from "./registry";
export {
  getResolvedComponent,
  getSection,
  getSectionOptions,
  getSectionRegistry,
  getSyncComponent,
  listRegisteredSections,
  preloadSectionComponents,
  preloadSectionModule,
  registerOnBeforeResolveProps,
  registerSection,
  registerSections,
  registerSectionsSync,
  setResolvedComponent,
} from "./registry";
export type { SectionLoaderFn } from "./sectionLoaders";
export { compose, withDevice, withMobile, withSearchParam, withSectionLoader } from "./sectionMixins";
export type {
  ActionConfig,
  AppSchemas,
  BlockPropsSchema,
  LoaderConfig,
  MatcherConfig,
  MetaResponse,
} from "./schema";
export {
  composeMeta,
  getRegisteredLoaders,
  getRegisteredMatchers,
  inferLoaderTags,
  registerActionSchema,
  registerActionSchemas,
  registerAppSchemas,
  registerLoaderSchema,
  registerLoaderSchemas,
  registerMatcherSchema,
  registerMatcherSchemas,
} from "./schema";
