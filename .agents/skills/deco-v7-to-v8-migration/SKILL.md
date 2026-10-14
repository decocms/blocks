---
name: deco-v7-to-v8-migration
description: "@decocms/blocks 8 (the next major): moves a v7 Deco site (@decocms/blocks 7.x with @decocms/tanstack or @decocms/nextjs, @decocms/blocks-admin, @decocms/blocks-cli, v7 @decocms/apps-*) onto @decocms/blocks 8, the v8 bindings (@decocms/tanstack 8, @decocms/nextjs 8) and the thin @decocms/apps-* clients. Runs the one-time migration script (scripts/main.ts: block map with legacy aliases, vendored app loaders, content in .deco/blocks, secret re-encryption, import report), then guides the manual work it reports. Use when a site's package.json depends on @decocms/blocks ^7, @decocms/tanstack, @decocms/nextjs or @decocms/blocks-admin and should move to v8; when the report lists /deco/invoke calls, createDecoWorkerEntry, RequestContext, useCart or other v7 imports to replace; when deco check rejects migrated content; or when a migrated page, draft preview, editor form or parity run differs from v7. Replaces the unpublished @decocms/blocks-migrate package."
---

# Deco v7 → v8 Migration

Moves a v7 site onto the next major in two parts: a script that does the mechanical, content-safe part in one pass, and a list of manual steps it prints. Proven on `deco-sites/storefront-tanstack`, `deco-sites/demo-storefront` (a redesign of storefront-tanstack's v7 tree) and `deco-sites/blog-tanstack` (TanStack Start), plus four private storefronts: two Next.js App Router (ejected FastStore), one TanStack Start and one non-ejected FastStore, all on VTEX.

The spec is the docs page **Migrating from v7** (`/next/renames-and-migrations`). When this skill and the docs disagree, the docs win.

## When this applies

- `package.json` depends on `@decocms/blocks` `^7`, and on `@decocms/tanstack` or `@decocms/nextjs`, `@decocms/blocks-admin`, `@decocms/blocks-cli` or v7 `@decocms/apps-*`.
- Saved content lives in `.deco/blocks/*.json`, or the site serves it at `/.decofile`.

**FastStore storefronts that aren't ejected** (FastStore owns the Next.js app; v7 monkey-patched its content requests) keep that seam with v8 behind it: follow [`reference/faststore.md`](reference/faststore.md) for steps 2, 3 and 6. **Native or mobile apps** whose v7 package only generated Studio's files (bundled JSON, native rendering): the script still runs, but most manual steps don't; follow [`reference/native-apps.md`](reference/native-apps.md).

Not for sites still on `@decocms/start@6.x` (upgrade to 7.x first with `decocms-v6-to-v7-upgrade`) or on Fresh/Deno (migrate to TanStack first with `deco-to-tanstack-migration`). Both live on the `7.x` branch, not on this one.

## Prerequisites

1. A clean working tree: the script edits files in place.
2. `DECO_CRYPTO_KEY` (the v7 secret key) in the environment, and `.deco/secrets.pub` committed (see `/next/secrets`). Without them, v7 secrets are reported, not re-encrypted.
3. **Install `@decocms/blocks@^8.3` before running the script** (not `^8`: `8.0.0` is an accidental v7 build). v7's blocks lacks the `/cli` and `/protocol/keys` the script imports. Keep the v7 `@decocms/apps-*` installed until the script has run: it vendors the app loaders your content calls from `node_modules`.
4. `typescript` resolvable from the site (the import codemod parses `src/` with it).

## Run

The script is `scripts/main.ts` in this skill. It resolves `@decocms/blocks` relative to its own files, so run it where that resolves to v8.

**From a `decocms/blocks` checkout on the v8 line** (run `bun install` there first):

```bash
DECO_CRYPTO_KEY=… bun <blocks>/.agents/skills/deco-v7-to-v8-migration/scripts/main.ts --root <site>
# under Node: npx tsx <blocks>/.agents/skills/deco-v7-to-v8-migration/scripts/main.ts --root <site>
```

**From an installed copy of the skill** (outside the repo): copy `scripts/` into the site so it resolves the site's `@decocms/blocks@8`, run it, then delete the copy:

```bash
cd <site> && bun add @decocms/blocks@^8.3
cp -R <skill>/scripts .deco-migrate
DECO_CRYPTO_KEY=… bun .deco-migrate/main.ts --root .
rm -rf .deco-migrate
```

| Flag | What it does |
|---|---|
| `--root <dir>` | The app root, the folder with the site's `package.json`. Default: `.` |
| `--decofile <file>` | Content to split into `.deco/blocks` when the site has none: the JSON the v7 site serves at `/.decofile`. |

In order: **content** (and site **settings** folded into `.deco/blocks/CMS.json`), **secrets**, **block map**, **imports**, **scripts**. Each step in full: [`reference/script-steps.md`](reference/script-steps.md).

Commit the script's output unedited as its own commit (`chore: run the v7-to-v8 migration`), so reviewers can tell generated changes from hand-written ones.

**A sibling site already migrated?** When the site shares its v7 tree with one that is already on v8 (a fork, a redesign of a template), port the sibling's v8 changes with a three-way merge per file instead of by hand: `git merge-file <site file> <sibling's file after its script run> <sibling's v8 file>`. Conflicts are mostly import lines. Then check what the merge brought that isn't the migration ([`reference/sibling-port.md`](reference/sibling-port.md)).

## Review the report

The script prints **Done** and **Left to do**, grouped by step. Every "Left to do" line names the subject (a type, a file, an import) and where its replacement lives in the docs. Work through it top to bottom; nothing it lists was changed.

## Manual steps

The full text of each step: [`reference/manual-steps.md`](reference/manual-steps.md).

1. **Dependencies**: `@decocms/blocks@^8.3`, the v8 binding at the same version (`@decocms/tanstack` or `@decocms/nextjs`) and the v8 `@decocms/apps-<platform>` client; remove the other v7 packages and codegen once nothing imports them.
2. **Render pages with `createCMS` on the binding** (`/next/tanstack-start-descriptors`, `/next/nextjs`); delete the v7 setup files, admin routes, `/deco/*` handlers and v7 CI jobs.
3. **Worker, drafts, Studio bridge and images from the binding; the rest is site code** ([`reference/framework-code.md`](reference/framework-code.md)).
4. **Replace `/deco/invoke`** with one server function per loader or action the browser called ([`reference/server-functions.md`](reference/server-functions.md)).
5. **Fix the content `deco check` rejects** ([`reference/content.md`](reference/content.md)).
6. **Telemetry, analytics and previews** ([`reference/telemetry.md`](reference/telemetry.md)).

## Verify

```bash
bunx deco schema && bunx deco content && bunx deco check   # 0 errors
bun run typecheck && bun run build
```

Then the rest of [`reference/verify.md`](reference/verify.md): `"blocksMajor": 8` in the committed schema, type errors counted against v7, a clean build without local links, drafts probed by hand, v7 tooling words reworded, and a page-by-page parity run with every approved difference encoded as a rule ([`reference/parity.md`](reference/parity.md)).

## DO NOT

- Add compat shims that re-create v7 APIs (`useCart` from a package, `invoke`, `RequestContext`). What v7's packages did and the bindings don't is site code now; copy it in and own it.
- Copy v7's worker entry, draft middleware, Studio bridge, preview badge or `Image` into the site: `@decocms/tanstack` and `@decocms/nextjs` ship them. A site-local `invoke` object with v7's paths, or a `runInvoke("site/loaders/…")` dispatcher, is the same shim.
- Strip `"use client"` from components that need hooks, events or browser APIs to make them render.
- Rename saved type names. Content stores them; keep the v7 name as an alias (`/next/renames-and-migrations#rename-a-type-with-an-alias`).
- Hand-edit the script's output in the same commit as the run.

## When to load what

| Reference | Load it when |
|---|---|
| [`script-steps.md`](reference/script-steps.md) | You need what each script step did (content, settings, secrets, block map, imports, scripts) |
| [`manual-steps.md`](reference/manual-steps.md) | You work through the report's "Left to do" |
| [`verify.md`](reference/verify.md) | The site builds and you're checking it before review |
| [`import-map.md`](reference/import-map.md) | A v7 import needs its v8 replacement |
| [`legacy-names.md`](reference/legacy-names.md) | A saved `__resolveType` is an alias or one of the seven rewritten names |
| [`parity.md`](reference/parity.md) | Approving differences, the pending state, editor-form causes |
| [`native-apps.md`](reference/native-apps.md) / [`faststore.md`](reference/faststore.md) | The site is a native app, or a FastStore storefront that isn't ejected |

### Gotchas by subject

What the site migrations taught, one subject per file. Commit hashes refer to `deco-sites/storefront-tanstack` and `deco-sites/blog-tanstack` (some carry a "blog" prefix; look a hash up in both); the private sites have none.

| Reference | Subject |
|---|---|
| [`running-the-script.md`](reference/running-the-script.md) | Before the run (install order, vendoring, stale lockfiles), dependencies after |
| [`sibling-port.md`](reference/sibling-port.md) | What a three-way merge from a sibling site brings along |
| [`rendering.md`](reference/rendering.md) | No async rendering, streaming and hydration, awaited blocks, section wrappers, Tailwind |
| [`framework-code.md`](reference/framework-code.md) | The bindings (worker, drafts, Studio, images); SEO, devices, cookies, commerce code, error reporting |
| [`server-functions.md`](reference/server-functions.md) | `/deco/invoke` → server functions |
| [`caching-and-privacy.md`](reference/caching-and-privacy.md) | Per-visitor data, QueryClient scope, draft bypass, hydration waits |
| [`nextjs.md`](reference/nextjs.md) | Next.js App Router: `@decocms/nextjs` drafts and proxy, `list('page')`, head order, Jest |
| [`hosted-releases.md`](reference/hosted-releases.md) | Hosted CMS instead of fast deploy, bundled content, v7 leftovers to delete |
| [`content.md`](reference/content.md) | `deco check` as a deploy gate, content it rejects, editing locally with `deco serve` |
| [`telemetry.md`](reference/telemetry.md) | Telemetry params, resource attributes, dropped v7 bindings, analytics |

`scripts/` is the migration (`main.ts` entry). Its tests run with the repo's `bun run test`.
