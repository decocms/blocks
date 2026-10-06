---
name: deco-v7-to-v8-migration
description: Moves a v7 Deco site (@decocms/blocks 7.x with @decocms/tanstack or @decocms/nextjs, @decocms/blocks-admin, @decocms/apps-*) onto the next major (@decocms/blocks 8, thin @decocms/apps-* clients). Runs the one-time migration script (block map with legacy aliases, vendored app loaders, content in .deco/blocks, secret re-encryption, import report), then guides the manual work it reports. Use when a site's package.json depends on @decocms/blocks ^7, @decocms/tanstack, @decocms/nextjs or @decocms/blocks-admin and should move to v8. Replaces the unpublished @decocms/blocks-migrate package.
---

# Deco v7 → v8 Migration

Moves a v7 site onto the next major in two parts: a script that does the mechanical, content-safe part in one pass, and a list of manual steps it prints. Proven on `deco-sites/storefront-tanstack` (Shopify, TanStack Start), `deco-sites/blog-tanstack` (TanStack Start), a Next.js App Router storefront on VTEX, a TanStack Start storefront on VTEX and a non-ejected FastStore storefront on VTEX (hundreds of saved blocks, private).

The spec is the docs page **Migrating from v7** (`/next/renames-and-migrations`). When this skill and the docs disagree, the docs win.

## When this applies

- `package.json` depends on `@decocms/blocks` `^7`, and on `@decocms/tanstack` or `@decocms/nextjs`, `@decocms/blocks-admin`, `@decocms/blocks-cli` or v7 `@decocms/apps-*`.
- Saved content lives in `.deco/blocks/*.json`, or the site serves it at `/.decofile`.

**FastStore storefronts that aren't ejected** (FastStore owns the Next.js app; v7 monkey-patched its content requests) keep that seam with v8 behind it: follow `reference/faststore.md` for steps 2, 3 and 6.

**Native or mobile apps** whose v7 package only generated Studio's files (bundled JSON, native rendering) also apply. The script still runs, but most manual steps don't: follow `reference/native-apps.md`.

Not for sites still on `@decocms/start@6.x` (upgrade to 7.x first with `decocms-v6-to-v7-upgrade`) or on Fresh/Deno (migrate to TanStack first with `deco-to-tanstack-migration`; both live on the 7.x branch).

## Prerequisites

1. A clean working tree: the script edits files in place.
2. `DECO_CRYPTO_KEY` (the v7 secret key) in the environment, and `.deco/secrets.pub` committed (see `/next/secrets`). Without them, v7 secrets are reported, not re-encrypted.
3. **Install `@decocms/blocks@^8.1` before running the script.** Not `^8`: the `8.0.0` on npm is an accidental v7 build with no `/cli`. A v7 site already has `@decocms/blocks@7`, which lacks the `/cli` and `/protocol/keys` subpaths the script imports. Keep the v7 `@decocms/apps-*` packages installed until the script has run: it vendors the app loaders your content calls from `node_modules`.
4. `typescript` resolvable from the site (the import codemod parses `src/` with it). Every TanStack and Next site already has it.

## Run

The script is `scripts/main.ts` in this skill. It resolves `@decocms/blocks` relative to its own files, so run it where that resolves to v8.

**From a `decocms/blocks` checkout on the v8 line** (clone it and run `bun install` there first; the script resolves `@decocms/blocks` from that checkout's `node_modules`):

```bash
DECO_CRYPTO_KEY=… bun <blocks>/.agents/skills/deco-v7-to-v8-migration/scripts/main.ts --root <site>
# under Node: npx tsx <blocks>/.agents/skills/deco-v7-to-v8-migration/scripts/main.ts --root <site>
```

**From an installed copy of the skill** (outside the repo): copy `scripts/` into the site so it resolves the site's `@decocms/blocks@8`, run it, then delete the copy:

```bash
cd <site> && bun add @decocms/blocks@^8.1
cp -R <skill>/scripts .deco-migrate
DECO_CRYPTO_KEY=… bun .deco-migrate/main.ts --root .
rm -rf .deco-migrate
```

| Flag | What it does |
|---|---|
| `--root <dir>` | The app root, the folder with the site's `package.json`. Default: `.` |
| `--decofile <file>` | Content to split into `.deco/blocks` when the site has none: the JSON the v7 site serves at `/.decofile`. |

What it does, in order (`scripts/migrate.ts`):

1. **content**: saved blocks into `.deco/blocks`, v7 generated files removed, v7 async-rendering wrappers (`website/sections/Rendering/Lazy.tsx`, `SingleDeferred.tsx`, `Deferred.tsx`) unwrapped to the sections they held (v8 has no async rendering), the seven legacy names outside the alias table rewritten (`reference/legacy-names.md`), A/B tests keyed on a random matcher get its saved-block name as `experiment`;
   **settings**: site settings folded into the `CMS` block (`.deco/blocks/CMS.json`, type `cms-settings`): the v7 Site block's (`Site`/`site`) `previewHosts` → `preview.hosts` (the field moves, ports kept, each entry trimmed and lowercased as v7 compared it; an entry that isn't a host is reported; on TanStack Start the `<site>.deco.site` and `<site>.deco-cx.workers.dev` hosts v7 always added for `DECO_SITE_NAME` are added too, or reported when the name isn't found), a literal `collectorAddress` on `OneDollarStats` → `analytics.collector`, and an earlier prerelease's `Telemetry.json`/`Analytics.json` → their sections, field for field and variants included (the old files are deleted). It keeps what `CMS.json` already has, writes nothing when there's nothing to fold, and a second run changes nothing. The report lists the environment-only settings to move by hand (`DECO_ALLOWED_PREVIEW_HOSTS`, `DECO_OTEL_*` sampling, `DECO_ANALYTICS_ENABLED`/`ONEDOLLAR_ENABLED`/`ONEDOLLAR_COLLECTOR`);
2. **secrets**: v7 secrets re-encrypted with `.deco/secrets.pub`;
3. **block map**: `.deco/index.ts` with each block under a short name plus an alias under its v7 name, after vendoring the app loaders and actions the content calls into `src/vendor`;
4. **imports**: the codemod over `src/` (`reference/import-map.md`);
5. **scripts**: `predev`/`prebuild` run `deco schema && deco content` (`&& deco check`).

Commit the script's output unedited as its own commit (`chore: run the v7-to-v8 migration`), so reviewers can tell generated changes from hand-written ones.

## Review the report

The script prints **Done** and **Left to do**, grouped by step. Every "Left to do" line names the subject (a type, a file, an import) and where its replacement lives in the docs. Work through it top to bottom; nothing it lists was changed.

## Manual steps (what the report leaves)

1. **Dependencies.** Depend on `@decocms/blocks@^8.1` and the v8 `@decocms/apps-<platform>` client. Remove `@decocms/tanstack`/`@decocms/nextjs`, `@decocms/blocks-admin`, `@decocms/blocks-cli`, `@decocms/apps-commerce`, `@decocms/apps-website` and `@decocms/apps-blog` once nothing imports them, and drop the v7 codegen from `build`. On Next.js, add `@decocms/blocks` to `transpilePackages` in `next.config`: the `8.1.0-next.*` prereleases publish TypeScript source (`exports` → `src/*.ts`), v7's `withDeco` wrapper used to add it, and without it a clean install fails `next build` with `Module parse failed: Unexpected token`.
2. **Render pages with `createCMS`.** Follow the framework guide (`/next/tanstack-start-descriptors`, `/next/nextjs`): `createCMS` over the content, `matchRoute`, one promise per block, a view registry. Delete the v7 setup files, admin routes and `/deco/*` handlers.
3. **Move framework code into the site** (`reference/gotchas.md`): edge cache, image, SEO/head, device detection, cookies, cart/user/wishlist flows, commerce loaders and converters.
4. **Replace `/deco/invoke`** with server functions (TanStack `createServerFn`) or Next server actions/route handlers. One exported server function per loader or action the browser called, and each call site imports the one it calls: `invoke.site.loaders.spin(props)` becomes `$siteLoadersSpin({ data: props })`. Don't rebuild the `invoke.x.y` tree or a string-keyed dispatcher over the commerce-loader map (see DO NOT); the server function calls its handler directly. Details in `reference/gotchas.md` (`/deco/invoke` → server functions).
5. **Fix the content `deco check` rejects**: fields no type declares, `.tsx`-named preview blocks, v7 app blocks (apps are code now), `requestToParam` blocks in string fields.
6. **Telemetry, analytics and previews**: the `telemetry` option of `createCMS` (`/next/telemetry`), with switches and rates in the `telemetry` section of `CMS.json`; `AnalyticsScript` with `const { analytics } = await cms.settings()` and `track` from `@decocms/blocks/analytics`; drafts through `await cms.draftPointer(request)` / `cms.draftCookie(request)`, which serve the release on hosts outside `preview.hosts` (list the dev host, `localhost`, too: v8 ignores `DECO_ALLOWED_PREVIEW_HOSTS`) (with no `previewHosts`, v7 allowed previews only on a TanStack site's `<site>.deco.site` and `<site>.deco-cx.workers.dev`, or nowhere; here every host may preview unless you list some, `/next/releases-and-drafts#allow-previews-per-host`). The report carries GTM/GA4 IDs over).

## Verify

```bash
bunx deco schema && bunx deco content && bunx deco check   # 0 errors
bun run typecheck && bun run build
```

A v7 site often carries type errors of its own. Count them on the v7 commit first, and report the v8 count against it per file: name every remaining error in a file the migration touched instead of claiming there are none. Fix them with type-only changes, and rerun `deco schema` + `deco check` after each: a section's `Props` type *is* its editor form, so repairing a broken type import there (one that resolved to `any`) changes the schema and can make `deco check` reject saved content. Leave such an error, or fix the content with it, never silently. Don't fix an error by giving code that never ran (an undefined variable in a component) real values: that changes what renders.

Run it once more **without any local link** (a `decocms/blocks` checkout linked into `node_modules` ships compiled `dist/`, the npm package may not): a clean `install --frozen-lockfile && build` from the committed lockfile, the way CI and the deploy run it. Then `git diff .deco/schema.gen.json`: the build regenerates it, so commit what the committed dependency's CLI writes, or every clean build leaves the tree dirty. If it differs from the linked checkout's, check both against v7's forms; when the published one is the worse, list a follow-up to bump once the fix is released.

**Probe drafts by hand** on the dev server and on a production build: `?__draft=<pointer>` on an allowed host renders the draft and sets the cookie, the cookie alone keeps the next page in the draft, a host outside `preview.hosts` and a malformed pointer get the release, `?__draft=off` clears the cookie. A parity harness can't catch a dead draft path when v7's was dead too: both sides render the release.

Then compare the migrated site with the v7 one page by page (a parity harness: SSR HTML, JSON-LD, analytics calls, cache headers, third-party requests). Compare the editor forms as well (v7 `meta.gen.json` vs v8 `schema.gen.json`): many differences are stale v7 files or v7 heuristics v8 drops on purpose, a few are CLI bugs to fix. Encode every difference the product owner approves as an explicit rule, never a blanket ignore. Keep explained-but-unapproved ones as `pending`, and have a strict compare fail on them (`reference/parity.md`).

## DO NOT

- Add compat shims that re-create v7 APIs (`useCart` from a package, `invoke`, `RequestContext`, a fake `@decocms/tanstack`). What v7's packages did is site code now; copy it in and own it. A site-local `invoke` object with v7's paths, or a `runInvoke("site/loaders/…")` dispatcher, is the same shim.
- Strip `"use client"` from components that need hooks, events or browser APIs to make them render.
- Rename saved type names. Content stores them; keep the v7 name as an alias (`/next/renames-and-migrations#rename-a-type-with-an-alias`).
- Hand-edit the script's output in the same commit as the run.

## Reference

- `reference/import-map.md`: every v7 import and its v8 replacement.
- `reference/legacy-names.md`: the alias table and the seven rewritten names.
- `reference/gotchas.md`: what the site migrations taught.
- `reference/parity.md`: how to approve differences, the pending state, editor-form causes, approved differences so far.
- `reference/native-apps.md`: apps that bundle content and render natively.
- `reference/faststore.md`: FastStore storefronts that aren't ejected (vendored runtime, content-client patch, drafts on Pages Router SSG).
- `scripts/`: the migration (`main.ts` entry). Its tests run with the repo's `bun run test`.
