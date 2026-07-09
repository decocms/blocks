---
name: decocms-v6-to-v7-upgrade
description: Upgrades an already-TanStack site from the monolithic @decocms/start@6.x + @decocms/apps@5.x to the split 7.x packages (@decocms/blocks, @decocms/tanstack, @decocms/blocks-admin, @decocms/blocks-cli, @decocms/apps-*). Use when a TanStack Start site's package.json pins @decocms/start to 6.x and/or @decocms/apps to 5.x. Not for Fresh/Deno sites (use the Fresh→TanStack migrator) and not for Next.js sites (use deco-next-package-migration).
---

# @decocms 6.x → 7.x Split-Package Upgrade (TanStack sites)

Moves a TanStack Start site off the two monoliths onto the split packages:

- `@decocms/start@6.x` → `@decocms/blocks` (framework core), `@decocms/tanstack` (TanStack binding), `@decocms/blocks-admin` (admin/preview), `@decocms/blocks-cli` (generators + migration tooling, devDep)
- `@decocms/apps@5.x` → per-vendor `@decocms/apps-*` — add **only** the splits the site actually imports

Proven on three production storefronts: lebiscuit-tanstack (commits `73daa3b` → `b5fdf69` → `6d311d8`, the canonical sequence), miess-01-tanstack (PR #86), granadobr-tanstack (PR #69). Target `^7.6.0` at minimum; `^7.7.0` removes two workarounds (noted below).

## The commit sequence

Do this as **three separate commits** in this order — each leaves the repo in a reviewable, explainable state, and the typecheck-baseline diff (see Verification) is only meaningful per-step.

### Commit 1 — dependency swap

Remove:

```
"@decocms/start": "6.x",
"@decocms/apps": "^5.x",
```

Add (`@decocms/blocks-admin` and `@decocms/blocks-cli` as devDependencies is fine; sites have shipped both ways — match how the site treats other build-time deps):

```
"@decocms/blocks": "^7.6.0",
"@decocms/tanstack": "^7.6.0",
"@decocms/blocks-admin": "^7.6.0",
"@decocms/blocks-cli": "^7.6.0",
```

plus only the `@decocms/apps-*` splits the site imports. Grep first:

```bash
grep -rhoE '@decocms/apps/[a-z-]+' src/ | sort -u
```

Mapping per commerce platform: `@decocms/apps/vtex` → `@decocms/apps-vtex`, and likewise `apps-magento`, `apps-algolia`, `apps-salesforce`, `apps-shopify`. Almost every site also needs `@decocms/apps-commerce` (shared types/sdk/utils) and `@decocms/apps-website` (Seo, analytics components). Real splits used: lebiscuit/miess = vtex + commerce + website; granadobr = vtex + magento + algolia + salesforce + commerce + website.

In the same commit, repoint every `generate:*` script from `@decocms/start/scripts/*` to `node_modules/@decocms/blocks-cli/scripts/*`:

```
"generate:blocks":   "tsx node_modules/@decocms/blocks-cli/scripts/generate-blocks.ts",
"generate:schema":   "tsx node_modules/@decocms/blocks-cli/scripts/generate-schema.ts --site <site>",
"generate:invoke":   "tsx node_modules/@decocms/blocks-cli/scripts/generate-invoke.ts",
"generate:sections": "tsx node_modules/@decocms/blocks-cli/scripts/generate-sections.ts",
"generate:loaders":  "tsx node_modules/@decocms/blocks-cli/scripts/generate-loaders.ts",
```

(`generate:routes` stays `tsr generate` — that's TanStack's, not ours. Preserve any site-specific flags like `--exclude` lists.)

Also update `vite.config.ts` `resolve.dedupe`: replace `["@decocms/start", "@decocms/apps"]` with the full list of split package names the site now depends on.

### Commit 2 — mechanical import rewrite

Pure codemod, no behavior change. The complete old→new subpath table is in [references/import-mapping.md](references/import-mapping.md). The shape of it:

- `@decocms/start/sdk/<x>` → `@decocms/blocks/sdk/<x>` (same subpath, ~15 modules: invoke, logger, clx, useScript, cacheHeaders, requestContext, …)
- `@decocms/start/cms` → `@decocms/blocks/cms` (server) — but the client-safe registry accessors (`getSection`, `getSectionRegistry`) move to `@decocms/blocks/cms/client`
- **setup split**: `createSiteSetup` from `@decocms/blocks/setup` (sections, blocks, productionOrigins, initPlatform, onResolveError) + `createAdminSetup` from `@decocms/blocks-admin/setup` (meta, css, fonts, previewWrapper). Drop any `customMatchers: [registerBuiltinMatchers]` passthrough — `createSiteSetup` registers builtin matchers unconditionally now.
- **hooks barrel split**: `RenderSection` (and the framework-generic hooks) → `@decocms/blocks/hooks`; the TanStack-bound components (`DecoPageRenderer`, `DecoRootLayout`, `SectionRenderer`, `PreviewProviders`) → `@decocms/tanstack` root
- **routes/router/workerEntry** → `@decocms/tanstack` root: `cmsRouteConfig`, `cmsHomeRouteConfig`, `loadCmsPage`, `loadCmsHomePage`, `loadDeferredSection`, `decoInvokeRoute`, `decoMetaRoute`, `decoRenderRoute`, `withSiteGlobals`, `createDecoRouter`, `createDecoWorkerEntry`; `@decocms/start/vite` → `@decocms/tanstack/vite`
- `@decocms/apps/<vendor>/<x>` → `@decocms/apps-<vendor>/<x>` (identical subpaths), except `@decocms/apps/commerce/components/{Image,Picture}` → `@decocms/blocks/hooks`

Verify with the typecheck-baseline diff (below) before committing.

### Commit 3 — generated artifacts to `.deco/`

blocks-cli 7.x defaults generator output to `.deco/` instead of `src/server/{cms,admin}/`:

- `git mv src/server/cms/blocks.gen.json .deco/blocks.gen.json` (likewise `blocks.gen.ts`, `loaders.gen.ts`, `src/server/admin/meta.gen.json` → `.deco/meta.gen.json`); regenerate `sections.gen.ts` at `.deco/sections.gen.ts`
- Repoint the imports in `src/setup.ts` (and any commerce-loaders wiring) at `../.deco/*`
- Delete the emptied `src/server/cms/` + `src/server/admin/` directories, and drop any stale knip ignore entries for them
- **`src/server/invoke.gen.ts` STAYS in `src/`** — generate-invoke's output default is intentionally unchanged. Its placement is empirically load-bearing: moved under `.deco/`, TanStack Start's server-function compiler generates client stubs fine but the server half 500s on every `/_serverFn/` call. Do not "tidy" it into `.deco/`.

### Commit 4 (or folded into 3) — bump, regenerate, verify

Bump all `@decocms/*` to the final target range, `bun install`, run the full `generate:*` chain, and confirm the tree is clean afterwards (regeneration must be idempotent). Then run the Verification gates below.

## Edge cases (all hit in real migrations)

- **`useHydrated`**: `@decocms/start/sdk/useHydrated` was a one-line re-export. Import `useHydrated` from `@tanstack/react-router` directly — the split packages deliberately don't expose it.
- **`cookiePassthrough`**: publicly exported since 7.6.0 at `@decocms/tanstack/sdk/cookiePassthrough` (`getRequestCookieHeader`, `forwardResponseCookies`) — use it, no shim. If you're studying a pre-7.6 migration for reference, you'll see local shims of it; beware the failure mode that pattern caused (lebiscuit `0e63679`): the shim imports `@tanstack/react-start/server` at module scope, and any *client-bundled* file importing it (section components, registry loaders) fails vite's import-protection at production build. Server-only helpers must only be imported from server-only modules; components should read `request.headers.get("cookie")` from the request their loader already receives.
- **`deferredSectionLoader`**: publicly exported since 7.7.0 at `@decocms/tanstack/sdk/deferredSectionLoader` — pass it straight to `<DecoPageRenderer loadDeferredSectionFn={...} />`. On 7.6.x it was unreachable from any public subpath and every site carried a byte-identical local shim (`src/sdk/deco/deferredSectionLoader.ts`) wrapping the public `loadDeferredSection`; delete that shim when on ^7.7.0.
- **`generate:invoke` apps-dir (pre-7.7 only)**: the published `@decocms/apps-vtex` tarball nests sources under `src/`, and 7.6.x generate-invoke only probed the package root — so the default resolution failed on any npm-installed site and needed `--apps-dir node_modules/@decocms/apps-vtex/src` (granadobr `a32320a`). Fixed in blocks-cli 7.7.0 (probes `<pkg>/invoke.ts` then `<pkg>/src/invoke.ts`); on ^7.7.0 drop the flag. Either way, consider keeping `generate:invoke` OUT of the build chain — `invoke.gen.ts` is committed, and regeneration is an explicit dev action.
- **`neverDefer` hand-patch (pre-7.7 only)**: 7.6.x generate-sections emitted `neverDefer: true` entries without declaring the field on the emitted `SectionMetaEntry` interface, so the generated file failed typecheck for any site with a `export const neverDefer = true` section (miess's `Product/SearchResult.tsx`) and needed a hand-patch that every regeneration wiped. Fixed in blocks-cli 7.7.0 — regenerate on ^7.7.0 and drop the patch.
- **Site-local generators** (granadobr's `scripts/generate-site-globals.ts` pattern — client-side site-globals snapshot to survive the vite plugin stubbing `blocks.gen.ts` to `{}` in the client bundle): repoint their INPUT at `.deco/blocks.gen.json`, relocate their OUTPUT under `.deco/` (e.g. `.deco/site-globals.gen.ts`), and verify the framework vite plugin's client-stub suffix matching doesn't catch the new output name — the plugin stubs any id ending in `blocks.gen.ts` or `meta.gen.{json,ts}` out of the client bundle, so never name a site generator's output `*blocks.gen.ts` (`site-globals.gen.ts` is safe; the generated globals file must reach the client bundle intact, that's its entire purpose).
- **Double-encoded page filenames** in `.deco/blocks/`: 6.x-era sync produced some filenames percent-encoded twice (multiple writers, different encodings). 7.x generate-blocks single-decodes the winning file's stem — matching the runtime's `parseBlockId` (one `decodeURIComponent`) — so keys self-heal on regeneration. If the generator warns about key collisions, delete the stale duplicate files it lists under `ignore:`.

## Verification gates

Run all of these; "it typechecks" alone is not a pass.

1. **Clean install**: `bun install` succeeds and the lockfile contains zero `@decocms/start` / `@decocms/apps` (monolith) entries.
2. **Regeneration idempotent**: run the full `generate:*` chain (and `bun run build`), then `git status` — the tree must be clean. Diffs mean a generator default moved or an artifact wasn't relocated.
3. **Typecheck diff-vs-baseline, not absolute zero**: capture `tsc --noEmit` output on the pre-migration commit, again after each migration commit, and diff the error sets. Sites have pre-existing errors (granadobr's baseline was 258); the gate is **zero new errors**, not zero errors.
4. **Build passes**: `bun run build` (this is what catches server-only imports leaking into client bundles).
5. **Dev smoke**: `bun run dev`, then `/` (page renders with sections), `/live/_meta` (200, schema JSON), `/.decofile` (200, decofile JSON).
6. **Parity diff of preview vs current deployment**: the `/live/_meta` schema must be structurally identical to production's, and the `/.decofile` diff must contain only drift explained by newer `.deco/` sync commits — anything else is a migration regression.

## Reference material

- [references/import-mapping.md](references/import-mapping.md) — the complete old→new import specifier table
- Site evidence: lebiscuit-tanstack `73daa3b`/`b5fdf69`/`6d311d8` (canonical sequence), miess-01-tanstack PR #86 (`388305d` neverDefer patch), granadobr-tanstack PR #69 (`a32320a` apps-dir workaround, `generate-site-globals.ts`)
