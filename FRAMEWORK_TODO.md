# @decocms/blocks / @decocms/tanstack — Framework TODO

Issues and feature gaps discovered during real site migration work. Trimmed during the docs cleanup that accompanied the monorepo split — the "fixed in script" bug-fix trivia table that used to live here was removed (git blame covers it if you ever need it); this keeps only items that are still genuinely open or not obviously superseded by the package split.

---

## Tier 0 — Blocking migrations

### `setup.ts` boilerplate — partially addressed by the package split
- **Was**: every site had a `setup.ts` with identical boilerplate (import.meta.glob, registerSections, setBlocks, registerBuiltinMatchers).
- **Now**: `createSiteSetup()` (`@decocms/blocks/setup`) + `createAdminSetup()` (`@decocms/admin/setup`) absorb most of this. Sites still need a `setup.ts` file that calls them, so the boilerplate isn't zero, but it's a single call each rather than hand-wiring the registry.
- **Still open**: whether to push further (Vite-plugin-injected, zero-file setup) is undecided.

### `SiteTheme` component missing from the framework packages
- **Current**: `apps/website/components/Theme.tsx` was removed upstream; migration scaffolds a local per-site replacement.
- **Ideal**: export `SiteTheme` from `@decocms/blocks` or `@decocms/apps` so sites stop diverging.
- **Not verified against current `@decocms/apps`** — check there before starting work here.

---

## Tier 1 — Developer experience

### `useScript(fn)` hydration mismatch warning — still present
- `useScript` calls `fn.toString()`, which produces different output in SSR vs. client builds (minification, variable renaming). The `[useScript] Using fn.toString() for "..."` warning still fires in real dev sessions (confirmed live in casaevideo-tanstack/bagaggio-tanstack dev logs during the Next.js/split-package migration work).
- **Ideal**: ship `inlineScript(str)` accepting a plain string constant, or make `useScript` stable across builds. See also `docs/next-steps-tanstack-native.md`'s proposal #2, which covers the same gap in more detail — don't build both independently.

### Route files are still boilerplate
- `__root.tsx`, `index.tsx`, `$.tsx`, `deco/meta.ts`, `deco/invoke.$.ts`, `deco/render.ts` are scaffolded identically per site by the migration script.
- **Ideal**: `createDecoRoutes()` or Vite-plugin auto-generation; site only customizes GTM ID, site name, etc.

### `server.ts`, `worker-entry.ts`, `router.tsx` are still boilerplate
- Same shape as above — every site has near-identical server infrastructure files that diverge over time instead of picking up framework improvements automatically.

### `dev:clean` should be built into the framework
- Migration script adds `"dev:clean": "rm -rf node_modules/.vite .wrangler/state .tanstack && vite dev"` per site.
- **Ideal**: a `@decocms/cli` command or Vite plugin hook that auto-cleans stale caches on startup, so developers don't hit mysterious caching bugs without knowing to clean.

---

## Tier 2 — Quality & correctness

### GTM/Analytics SDK duplicated across sites
- Every site still has a custom `Session.tsx`-style analytics SDK (data-event listeners, data-gtm-event listeners, IntersectionObserver) rather than a shared framework export.
- **Ideal**: `@decocms/blocks`/`@decocms/tanstack` exports a `<DecoAnalytics gtmId="GTM-XXX" />` component for `__root.tsx`.

### `useGTMEvent` hook is duplicated per site
- Same story — a local `sdk/useGTMEvent.ts` per site instead of a framework export.

### Negative z-index (`-z-10`) breaks in Tailwind v4 stacking contexts
- React/TanStack wraps sections in `<section>` elements that create new stacking contexts; negative z-index gets trapped inside. The migration script auto-fixes this on images (`-z-N` → `z-0` + `relative z-10` on siblings), but it's a workaround, not a framework fix.
- **Ideal**: a framework-level CSS reset (`section { isolation: auto; }`) so the class of bug can't occur in the first place.

### Tailwind v3 → v4 opacity-class consolidation is incomplete
- The migration script converts adjacent `bg-black bg-opacity-20` → `bg-black/20`, but non-adjacent pairs (e.g. separated by other classes) aren't reliably caught.
- **Ideal**: a lint rule or PostCSS plugin that warns about orphaned `bg-opacity-*` classes.

---

## Tier 3 — Nice to have

### `registerLayoutSections` auto-detection
- Layout sections (Header/Footer) are currently opted in manually (`registerLayoutSections([...])`) or via a `layout = true` convention export.
- **Ideal**: auto-detect layout sections from CMS page structure (a section that appears on every page is probably layout) — would remove a manual `setup.ts` step per new layout section.

### Icon loaders depend on a deleted static file
- `availableIcons.ts`/`icons.ts`-style loaders depended on `static/adminIcons.ts`, which migration deletes entirely — admin loses icon-picker functionality after migration.
- **Ideal**: a built-in icon discovery mechanism (scan `public/sprites.svg` at build time) so the admin icon picker keeps working post-migration.

### `import.meta.glob` section discovery could be smarter
- The glob `./sections/**/*.tsx` discovers all files, including non-section utility exports living alongside real sections.
- **Ideal**: a convention (default export = section) or marker comment to distinguish sections from helpers.

---

## Fast Deploy (KV-first content) — cross-repo follow-ups

Framework + CI scripts for fast-deploy landed in this repo (see [`docs/fast-deploy.md`](./docs/fast-deploy.md)). Remaining work lives in **other** repos:

- **admin.deco.cx (Studio)**: publish a delta envelope to `/.decofile` + call `/_cache/purge`; gate on a per-site `fast_deploy_enabled` capability; dispatch the deco-sync-bot commit off the critical path.
- **Site CI**: provision a KV namespace + `DECO_KV` binding; add a `sync-content-to-kv.yml` workflow; gate `deploy.yml` to code-only changes.
- **Framework follow-up**: module-level `loadBlocks()` consumers (e.g. `loadRedirects` in worker-entry) read the bundled snapshot pre-hydration — move into the request path so they pick up fast-deploy content too.
