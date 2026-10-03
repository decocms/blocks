---
name: deco-v7-to-v8-migration
description: Moves a v7 Deco site (@decocms/blocks 7.x with @decocms/tanstack or @decocms/nextjs, @decocms/blocks-admin, @decocms/apps-*) onto the next major (@decocms/blocks 8, thin @decocms/apps-* clients). Runs the one-time migration script (block map with legacy aliases, vendored app loaders, content in .deco/blocks, secret re-encryption, import report), then guides the manual work it reports. Use when a site's package.json depends on @decocms/blocks ^7, @decocms/tanstack, @decocms/nextjs or @decocms/blocks-admin and should move to v8. Replaces the unpublished @decocms/blocks-migrate package.
---

# Deco v7 → v8 Migration

Moves a v7 site onto the next major in two parts: a script that does the mechanical, content-safe part in one pass, and a list of manual steps it prints. Proven on `deco-sites/storefront-tanstack` (Shopify, TanStack Start) and `deco-sites/blog-tanstack` (TanStack Start).

The spec is the docs page **Migrating from v7** (`/next/renames-and-migrations`). When this skill and the docs disagree, the docs win.

## When this applies

- `package.json` depends on `@decocms/blocks` `^7`, and on `@decocms/tanstack` or `@decocms/nextjs`, `@decocms/blocks-admin`, `@decocms/blocks-cli` or v7 `@decocms/apps-*`.
- Saved content lives in `.deco/blocks/*.json`, or the site serves it at `/.decofile`.

Not for sites still on `@decocms/start@6.x` (upgrade to 7.x first with `decocms-v6-to-v7-upgrade`) or on Fresh/Deno (migrate to TanStack first with `deco-to-tanstack-migration`; both live on the 7.x branch).

## Prerequisites

1. A clean working tree: the script edits files in place.
2. `DECO_CRYPTO_KEY` (the v7 secret key) in the environment, and `.deco/secrets.pub` committed (see `/next/secrets`). Without them, v7 secrets are reported, not re-encrypted.
3. **Install `@decocms/blocks@^8` before running the script.** A v7 site already has `@decocms/blocks@7`, which lacks the `/cli` and `/protocol/keys` subpaths the script imports. Keep the v7 `@decocms/apps-*` packages installed until the script has run: it vendors the app loaders your content calls from `node_modules`.
4. `typescript` resolvable from the site (the import codemod parses `src/` with it). Every TanStack and Next site already has it.

## Run

The script is `scripts/main.ts` in this skill. It resolves `@decocms/blocks` relative to its own files, so run it where that resolves to v8.

**From a `decocms/blocks` checkout on the v8 line** (its `node_modules` has v8):

```bash
DECO_CRYPTO_KEY=… bun <blocks>/.agents/skills/deco-v7-to-v8-migration/scripts/main.ts --root <site>
# under Node: npx tsx <blocks>/.agents/skills/deco-v7-to-v8-migration/scripts/main.ts --root <site>
```

**From an installed copy of the skill** (outside the repo): copy `scripts/` into the site so it resolves the site's `@decocms/blocks@8`, run it, then delete the copy:

```bash
cd <site> && bun add @decocms/blocks@^8
cp -R <skill>/scripts .deco-migrate
DECO_CRYPTO_KEY=… bun .deco-migrate/main.ts --root .
rm -rf .deco-migrate
```

| Flag | What it does |
|---|---|
| `--root <dir>` | The app root, the folder with the site's `package.json`. Default: `.` |
| `--decofile <file>` | Content to split into `.deco/blocks` when the site has none: the JSON the v7 site serves at `/.decofile`. |

What it does, in order (`scripts/migrate.ts`):

1. **content**: saved blocks into `.deco/blocks`, v7 generated files removed, the seven legacy names outside the alias table rewritten (`reference/legacy-names.md`), A/B tests keyed on a random matcher get its saved-block name as `experiment`;
2. **secrets**: v7 secrets re-encrypted with `.deco/secrets.pub`;
3. **block map**: `.deco/index.ts` with each block under a short name plus an alias under its v7 name, after vendoring the app loaders and actions the content calls into `src/vendor`;
4. **imports**: the codemod over `src/` (`reference/import-map.md`);
5. **scripts**: `predev`/`prebuild` run `deco schema && deco content` (`&& deco check`).

Commit the script's output unedited as its own commit (`chore: run the v7-to-v8 migration`), so reviewers can tell generated changes from hand-written ones.

## Review the report

The script prints **Done** and **Left to do**, grouped by step. Every "Left to do" line names the subject (a type, a file, an import) and where its replacement lives in the docs. Work through it top to bottom; nothing it lists was changed.

## Manual steps (what the report leaves)

1. **Dependencies.** Depend on `@decocms/blocks@^8` and the v8 `@decocms/apps-<platform>` client. Remove `@decocms/tanstack`/`@decocms/nextjs`, `@decocms/blocks-admin`, `@decocms/blocks-cli`, `@decocms/apps-commerce`, `@decocms/apps-website` and `@decocms/apps-blog` once nothing imports them, and drop the v7 codegen from `build`.
2. **Render pages with `createCMS`.** Follow the framework guide (`/next/tanstack-start-descriptors`, `/next/nextjs`): `createCMS` over the content, `matchRoute`, one promise per block, a view registry. Delete the v7 setup files, admin routes and `/deco/*` handlers.
3. **Move framework code into the site** (`reference/gotchas.md`): edge cache, image, SEO/head, device detection, cookies, cart/user/wishlist flows, commerce loaders and converters.
4. **Replace `/deco/invoke`** with server functions (TanStack `createServerFn`) or Next server actions/route handlers.
5. **Fix the content `deco check` rejects**: fields no type declares, `.tsx`-named preview blocks, v7 app blocks (apps are code now), `requestToParam` blocks in string fields.
6. **Telemetry and analytics**: the `telemetry` option of `createCMS` (`/next/telemetry`); the built-in analytics block with `AnalyticsScript`/`track` from `@decocms/blocks/analytics` (the report carries GTM/GA4 IDs over).

## Verify

```bash
bunx deco schema && bunx deco content && bunx deco check   # 0 errors
bun run typecheck && bun run build
```

Then compare the migrated site with the v7 one page by page (a parity harness: SSR HTML, JSON-LD, analytics calls, cache headers, third-party requests). Encode every difference the product owner approves as an explicit rule, never a blanket ignore (`reference/parity.md`).

## DO NOT

- Add compat shims that re-create v7 APIs (`useCart` from a package, `invoke`, `RequestContext`, a fake `@decocms/tanstack`). What v7's packages did is site code now; copy it in and own it.
- Strip `"use client"` from components that need hooks, events or browser APIs to make them render.
- Rename saved type names. Content stores them; keep the v7 name as an alias (`/next/renames-and-migrations#rename-a-type-with-an-alias`).
- Hand-edit the script's output in the same commit as the run.

## Reference

- `reference/import-map.md`: every v7 import and its v8 replacement.
- `reference/legacy-names.md`: the alias table and the seven rewritten names.
- `reference/gotchas.md`: what the site migrations taught.
- `reference/parity.md`: approved v7 → v8 differences.
- `scripts/`: the migration (`main.ts` entry). Its tests run with the repo's `bun run test`.
