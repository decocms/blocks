---
name: deco-next-package-migration
description: Migrates a Next.js App Router site off the abandoned @decocms/start@5.x /next, /core, /node export tiers onto the current @decocms/blocks, @decocms/blocks-admin, and @decocms/nextjs packages. Use when a site's package.json pins @decocms/start to a 5.x-next prerelease, or imports from @decocms/start/next, @decocms/start/core, or @decocms/start/node.
---

# Deco Next.js Package Migration

Moves a Next.js site off the reverted `@decocms/start@5.x` framework-agnostic-entrypoints tiers onto the current package split. Proven on faststore-fila, a production Next.js 15 App Router VTEX FastStore storefront with a pre-existing `.deco/blocks/*.json` legacy content snapshot.

## When this applies

- `package.json` has `"@decocms/start": "5.x-next.*"` or similar prerelease pin
- Code imports from `@decocms/start/next`, `@decocms/start/core`, or `@decocms/start/node`
- The site has its own `src/sdk/deco/`-style wrapper layer (or equivalent) around the framework, rather than using the framework's route/page helpers directly

## Import mapping

See `references/import-mapping.md` for the full table. Summary: `@decocms/start/core`'s CMS functions (`setBlocks`, `registerSectionLoaders`, etc.) move to `@decocms/blocks/cms` under the *same names* — these did not change across the package split, only the import path. Replace `@decocms/start/next`'s `createDecoAdminRouteHandlers` with `createDecoRouteHandlers` from `@decocms/nextjs/routeHandlers`, plus `createDecoPreviewPage` from `@decocms/nextjs` for RSC-aware gallery previews. Page-level CMS resolution goes through `@decocms/blocks/cms`'s `resolveDecoPage` + `extractSeoFromSections` directly (or `@decocms/nextjs`'s generic `createDecoPage` helper, if the site doesn't need custom SEO-merging/curated-block-override logic). `@decocms/start/node`'s `loadAllDecofileBlocks` has no equivalent — if the site loads a directory of pre-existing legacy block JSON files (not build-time-generated ones), use `@decocms/blocks/cms/loadDecofileDirectory` (new).

## Steps

1. **Dependencies**: remove the old `@decocms/start` pin, add `@decocms/blocks`, `@decocms/blocks-admin`, and (if the site uses Next.js pages/route handlers directly rather than its own wrapper) `@decocms/nextjs`. Before a release exists, verify with packed tarballs for the full package set rather than symlinks; webpack/Turbopack package resolution can behave differently under `bun link`.
2. **Section registration**: swap `@decocms/start/core`'s `registerSection`/`registerSectionsSync` imports for `@decocms/blocks/cms` — same names, no other changes needed.
3. **CMS setup/resolution**: rewrite the site's setup wrapper against `@decocms/blocks/cms`'s `setBlocks`/`setResolveErrorHandler`/`registerLayoutSections`/`registerSectionLoaders` (same names) plus `resolveDecoPage`/`extractSeoFromSections` (replacing `loadCmsPage`) and, if needed, `loadDecofileDirectory` (replacing `loadAllDecofileBlocks`) — though for Next.js the recommended block source is now the static-import manifest from `@decocms/blocks-cli`'s `generate-blocks-manifest.ts` (`createNextSetup({ blocks, blocksDir: false })`), which puts the block JSONs in Next's module graph so CMS content hot-reloads in `next dev` and deploys skip the `outputFileTracingIncludes` hack; see `templates/setup-ts.md`'s key-patterns note 5 and `@decocms/nextjs`'s README. See `templates/setup-ts.md` for a full worked example derived from the faststore-fila migration. Keep the wrapper's own exported function names and return shapes unchanged wherever possible — this is what let faststore-fila's page files avoid any changes at all.
4. **Admin routes and RSC previews**: mount the protocol catch-all with `createDecoRouteHandlers({ setup })` from the `/routeHandlers` subpath, then mount `createDecoPreviewPage({ setup })` at the framework-owned `app/deco/preview/[[...path]]/page.tsx` route. Do not add a preview-path option or choose another route. This page boundary is required for sections containing Client Components; the route handler's plain `renderToString` renderer cannot invoke Next client-reference proxies. See `templates/admin-routes.md`. Delete or replace old live-editing dev-tunnel routes that still have no package equivalent.
5. **Validate end-to-end against a real production build**, not just unit tests or `next dev` — specifically the site's actual `.deco/blocks`-derived content and an interactive Client Component preview. Follow the production verification in `templates/admin-routes.md`.

## Gotchas

- `resolveDecoPage`'s return shape (`DecoPageResult`) is `{name, path, params, blockKey, resolvedSections, deferredSections, seoSection}` — note `seoSection` is a *resolved section*, not a plain `{title, description}` object. Call `extractSeoFromSections([result.seoSection].filter(Boolean))` to get a plain SEO object.
- `findPageByPath` matches on each page block's `.path` field, not on the blocks map's key — so a `loadDecofileDirectory`-style loader can assign any unique key per file without needing to reverse-engineer the original admin's exact key-naming convention.
- Next.js App Router route folder naming is asymmetric between `_` and `.` prefixes, and it's easy to get backwards: `_`-prefixed folders (e.g. `_healthcheck`) must be URL-encoded as `%5Ffoldername`, because Next treats a literal `_folder` as a private folder and excludes it from routing. Dot-prefixed folders (e.g. `.decofile`) must do the **opposite** — keep the literal dot. The URL-encoded form (`%2E…`) is NOT decoded by Next App Router (verified against Next 16.2.6 / Turbopack) — it resolves to the catchall route instead of the intended handler. This is a Next.js routing constraint, unrelated to the blocks package split, and was already handled in whatever site is being migrated (verify it still is, post-migration).
- Do not remove `"use client"` from an interactive section to make Studio previews render. Static wrappers may remain Server Components, but hooks, event handlers, browser APIs, and client-only context require a Client Component boundary. Route preview GETs through `createDecoPreviewPage` so Next's RSC renderer handles that boundary.
- In `route.ts`, import `createDecoRouteHandlers` from `@decocms/nextjs/routeHandlers`, never the package root. Route handlers are evaluated against the react-server build; the root barrel also exposes component code and can fail during module evaluation. Importing the root is correct in the RSC preview `page.tsx`.
