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

See `references/import-mapping.md` for the full table. Summary: `@decocms/start/core`'s CMS functions (`setBlocks`, `registerSectionLoaders`, etc.) move to `@decocms/blocks/cms` under the *same names* — these did not change across the package split, only the import path. `@decocms/start/next`'s `createDecoAdminRouteHandlers`/`loadCmsPage` have no direct equivalent — `@decocms/nextjs` splits the admin protocol into one function per concern (`metaGET`, `decofileGET`/`decofilePOST`, `invokePOST`, `renderGET`/`renderPOST`) instead of one dispatcher, and page-level CMS resolution goes through `@decocms/blocks/cms`'s `resolveDecoPage` + `extractSeoFromSections` directly (or `@decocms/nextjs`'s generic `createDecoPage` helper, if the site doesn't need custom SEO-merging/curated-block-override logic). `@decocms/start/node`'s `loadAllDecofileBlocks` has no equivalent — if the site loads a directory of pre-existing legacy block JSON files (not build-time-generated ones), use `@decocms/blocks/cms/loadDecofileDirectory` (new).

## Steps

1. **Dependencies**: remove the old `@decocms/start` pin, add `@decocms/blocks`, `@decocms/blocks-admin`, and (if the site uses Next.js pages/route handlers directly rather than its own wrapper) `@decocms/nextjs`. During development before anything is published, use `bun link` against a local `blocks` checkout — see `docs/fast-deploy.md`'s general local-dev-linking pattern, or this migration's own Task 2 for the exact commands.
2. **Section registration**: swap `@decocms/start/core`'s `registerSection`/`registerSectionsSync` imports for `@decocms/blocks/cms` — same names, no other changes needed.
3. **CMS setup/resolution**: rewrite the site's setup wrapper against `@decocms/blocks/cms`'s `setBlocks`/`setResolveErrorHandler`/`registerLayoutSections`/`registerSectionLoaders` (same names) plus `resolveDecoPage`/`extractSeoFromSections` (replacing `loadCmsPage`) and, if needed, `loadDecofileDirectory` (replacing `loadAllDecofileBlocks`). See `templates/setup-ts.md` for a full worked example derived from the faststore-fila migration. Keep the wrapper's own exported function names and return shapes unchanged wherever possible — this is what let faststore-fila's page files avoid any changes at all.
4. **Admin routes**: `@decocms/nextjs` exports one function per admin concern rather than one dispatcher — rewrite the site's admin-route wrapper as thin per-concern re-exports. See `templates/admin-routes.md`. Any route the old dispatcher served that has no `@decocms/blocks-admin`/`@decocms/nextjs` equivalent (live-editing dev tunnel: file-watch SSE, JSON-Patch file mutation) should be deleted or replaced with a simple non-daemon stub (e.g. a readiness check reading `loadBlocks()`'s size directly) — these were deliberately scoped out of the current package split, not omitted by oversight.
5. **Validate end-to-end against a real dev server**, not just unit tests — specifically the site's actual `.deco/blocks`-derived content (a real page path, not a synthetic fixture), since the on-disk block format and its resolution are exactly the surface most likely to have a real, only-visible-at-runtime discrepancy (see this migration's own Task 6).

## Gotchas

- `resolveDecoPage`'s return shape (`DecoPageResult`) is `{name, path, params, blockKey, resolvedSections, deferredSections, seoSection}` — note `seoSection` is a *resolved section*, not a plain `{title, description}` object. Call `extractSeoFromSections([result.seoSection].filter(Boolean))` to get a plain SEO object.
- `findPageByPath` matches on each page block's `.path` field, not on the blocks map's key — so a `loadDecofileDirectory`-style loader can assign any unique key per file without needing to reverse-engineer the original admin's exact key-naming convention.
- Next.js App Router route folder naming is asymmetric between `_` and `.` prefixes, and it's easy to get backwards: `_`-prefixed folders (e.g. `_healthcheck`) must be URL-encoded as `%5Ffoldername`, because Next treats a literal `_folder` as a private folder and excludes it from routing. Dot-prefixed folders (e.g. `.decofile`) must do the **opposite** — keep the literal dot. The URL-encoded form (`%2E…`) is NOT decoded by Next App Router (verified against Next 16.2.6 / Turbopack) — it resolves to the catchall route instead of the intended handler. This is a Next.js routing constraint, unrelated to the blocks package split, and was already handled in whatever site is being migrated (verify it still is, post-migration).
