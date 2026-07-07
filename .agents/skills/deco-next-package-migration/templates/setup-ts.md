# `setup.ts` Template

Worked example derived directly from faststore-fila's `src/sdk/deco/setup.ts`, genericized: site-specific names (product-fetch helpers, PDP prop types) are replaced with placeholder comments. The `ensureSetup` / `resolveCmsPage` / `resolveCmsPageByPath` structure is kept verbatim — that's the reusable part of the pattern, proven end-to-end against a real production site.

The real file also contained a ~50-line workaround (`pageFacetsByPath` / `buildPageFacetsByPath` / `extractRawSelectedFacets`) for one specific commerce-search resolver that this runtime doesn't register, which silently resolved to `null` instead of erroring. That's not just VTEX-specific noise to discard — it's an instance of a reusable gotcha class (an unregistered `__resolveType` silently resolving to `null`) that's generalized into the section-loaders comment below, since any backend's migration can hit the same failure mode with a different resolver name.

```typescript
/**
 * Server-side Deco setup. Loads the site's `.deco/blocks/*.json` snapshot
 * (or generated blocks — see `loadDecofileDirectory` vs. a static import
 * in step 1 below) into the Deco runtime, then overrides specific page
 * blocks with curated content if the site needs that. App Router server
 * components call `resolveCmsPageByPath(path)` (cached) to resolve a page.
 *
 * Section components are registered as a module-load side effect of
 * importing `./sections`, which runs on both server and client bundles —
 * necessary so `getResolvedComponent` finds the same components on both
 * sides of hydration.
 */

import { cache } from 'react'
import {
  extractSeoFromSections,
  registerLayoutSections,
  registerSectionLoaders,
  registerSeoSections,
  resolveDecoPage,
  runSectionLoaders,
  setBlocks,
  setResolveErrorHandler,
} from '@decocms/blocks/cms'
// Only needed if the site loads a directory of pre-existing legacy block
// JSON files (e.g. a `.deco/blocks/` snapshot exported from an old admin).
// Sites with build-time-generated blocks (a single blocks.gen.ts/.json)
// import that module directly and pass it to `setBlocks` instead.
import { loadDecofileDirectory } from '@decocms/blocks/cms/loadDecofileDirectory'

// --- site-specific: curated block overrides, if any ------------------
// import { homeBlock, HOME_BLOCK_KEY } from './curated/home'
// import { pdpBlock, PDP_BLOCK_KEY } from './curated/pdp'

// Named import (not side-effect-only) so bundlers keep the module under
// a project-level `sideEffects: false`. The registration loop inside
// `./sections` registers every component into the runtime's registry at
// module load.
import { SECTIONS as _SECTIONS } from './sections'
void _SECTIONS

let setupPromise: Promise<void> | null = null

export function ensureSetup(): Promise<void> {
  if (setupPromise) return setupPromise
  setupPromise = (async () => {
    const allBlocks = await loadDecofileDirectory('.deco/blocks')
    // --- site-specific: merge in curated block overrides, if any ------
    // allBlocks[HOME_BLOCK_KEY] = homeBlock as unknown as Record<string, unknown>
    // allBlocks[PDP_BLOCK_KEY] = pdpBlock as unknown as Record<string, unknown>
    setBlocks(allBlocks)

    setResolveErrorHandler((error, resolveType, context) => {
      // eslint-disable-next-line no-console
      console.error(`[deco] ${context} "${resolveType}" failed:`, error)
    })

    // Layout sections (e.g. header/footer) render on every page and
    // should be cached across navigations instead of re-resolved per
    // request. List every section key the site's layout uses, including
    // any legacy key variants a pre-existing decofile snapshot might use
    // for the same logical section.
    registerLayoutSections([
      // 'site/sections/Header/Header.tsx',
      // 'site/sections/Footer/Footer.tsx',
    ])

    // `extractSeoFromSections` (used in `resolveCmsPage` below) only pulls
    // real title/description out of section types registered here — skip
    // this and every page's SEO silently resolves to `{}`. Determine the
    // real set by scanning the site's own `.deco/blocks/pages-*.json` (or
    // equivalent) for the resolveType(s) used in each page's top-level
    // `seo` field.
    registerSeoSections([
      // 'commerce/sections/Seo/SeoV2.tsx',
    ])

    // Section loaders enrich CMS-resolved props with server-side data
    // (product listings, PDP data, anything the section needs that isn't
    // in the decofile). Each loader is `(props, req) => Promise<props>`.
    // --- site-specific: register one entry per section that needs
    // server-side data. Example shape, not literal code:
    //
    //   registerSectionLoaders({
    //     'site/sections/Product/SearchResult.tsx': async (props, req) => {
    //       // fetch product listing based on props.page.selectedFacets
    //       // (or whatever facet/filter state this site's search section
    //       // encodes), return { ...props, _server: { ...fetchedData } }
    //     },
    //     'site/sections/ProductDetails.tsx': async (props, req) => {
    //       // parse an identifier (slug/id) out of the matched request
    //       // path, fetch product data, return { ...props, _server: data }
    //       // — or return `props` unchanged if not found, so the page can
    //       // respond 404 itself.
    //     },
    //   })
    //
    // Gotcha class worth checking for regardless of backend: if a section's
    // CMS-authored props reference a `__resolveType` for some upstream
    // commerce/search resolver that this runtime doesn't have registered
    // (e.g. it belonged to a different platform integration than the one
    // this runtime ships loaders for), the runtime logs an "unhandled
    // resolver" warning and silently resolves that prop to `null` instead
    // of erroring. If a page depended on that prop's real value (e.g. a
    // filter/facet selection baked into a decofile snapshot), the section
    // loader above will see `null` and produce a page that "works" but
    // renders unfiltered/default data — no exception, no stack trace, just
    // wrong output. If wiring up the real resolver is out of scope for the
    // migration, the section loader can read the same field straight out
    // of the raw (pre-resolution) block JSON as a narrow bypass, rather
    // than `null`-checking and giving up. Confirm this is still happening
    // by grepping the dev server's console output for "[CMS] Unhandled
    // resolver" while exercising a page that depends on such a field.
    registerSectionLoaders({})
  })()
  return setupPromise
}

/**
 * Resolve the CMS page for a given request. Returns
 * { name, seo, resolvedSections } — the same shape the dead
 * @decocms/start/next tier's loadCmsPage returned, so page files that
 * already consume this function need no changes.
 *
 * Built directly on @decocms/blocks's resolveDecoPage rather than
 * @decocms/nextjs's createDecoPage helper: createDecoPage assumes a
 * generic single-page-per-URL model, while a site with its own SEO
 * merging (e.g. store-config fallback title/description) or curated
 * block overrides may not fit that generic helper — kept as the site's
 * own thin wrapper instead. If neither applies, prefer createDecoPage
 * and skip this wrapper entirely.
 *
 * Crucially, `resolveDecoPage` only resolves the CMS block tree — it does
 * NOT run the registered section loaders (verified against
 * `packages/tanstack/src/routes/cmsRoute.ts` and
 * `packages/nextjs/src/createDecoPage.tsx`: both leave that to their own
 * callers). Without an explicit `runSectionLoaders` call here, any
 * loaders registered in `ensureSetup` above would never run, and
 * `_server` (or whatever key the site's loaders populate) would never be
 * set — silently breaking any section that depends on server-fetched
 * data.
 */
export async function resolveCmsPage(req: Request) {
  await ensureSetup()
  const url = new URL(req.url)
  const page = await resolveDecoPage(url.pathname, {})
  if (!page) return null

  const resolvedSections = await runSectionLoaders(page.resolvedSections, req)

  const seo = extractSeoFromSections(
    page.seoSection ? [page.seoSection] : [],
  )

  return {
    name: page.name,
    seo,
    resolvedSections,
  }
}

/**
 * Pathname-keyed cached resolver. Multiple callers in the same render
 * (layout + page + generateMetadata) share one fetch. `react.cache` keys
 * on argument identity; a plain string keys cleanly.
 */
export const resolveCmsPageByPath = cache(async (pathname: string) =>
  resolveCmsPage(new Request(`http://localhost${pathname}`))
)
```

## Key patterns

1. **Import-path-only changes are the bulk of the work.** `registerSection`, `registerSectionsSync`, `getResolvedComponent`, `loadBlocks`, `listRegisteredSections`, `setBlocks`, `setResolveErrorHandler`, `registerLayoutSections`, `registerSectionLoaders` all kept their names and signatures across the package split — swap `@decocms/start/core` for `@decocms/blocks/cms` and move on.
2. **`registerSeoSections` is a new call, not a rename.** If the site never called it under the old package, it still needs to be added now — `extractSeoFromSections` silently returns `{}` without it.
3. **`resolveDecoPage` doesn't run section loaders.** The wrapper must call `runSectionLoaders` itself, or server-fetched data never reaches the page.
4. **Keep the wrapper's exported names and return shape stable.** This is what lets page-level code that already calls `resolveCmsPage`/`resolveCmsPageByPath` avoid any changes at all — the whole point of routing the migration through a site-owned wrapper rather than inlining the new package's calls at every call site.
5. **`loadDecofileDirectory` vs. a generated-blocks import** — only reach for `loadDecofileDirectory` if the site has an existing directory of legacy per-page block JSON files to load at runtime. If blocks are generated at build time into one file, import that file and pass it to `setBlocks` directly; no directory loader needed.
6. **An unregistered resolver fails silently, not loudly.** If a section's props reference a `__resolveType` this runtime has no loader for, it resolves to `null` with just a console warning — no thrown error. Any section loader consuming that prop needs to either treat `null` as "feature not wired up yet" explicitly, or (if wiring up the real resolver is out of scope) read the same value straight out of the raw block JSON as a narrow, well-commented bypass. Don't assume a page rendering without errors means its data is correct — check for "unhandled resolver" log lines during end-to-end validation (Step 5 in `SKILL.md`).
