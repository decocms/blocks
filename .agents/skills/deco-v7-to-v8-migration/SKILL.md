---
name: deco-v7-to-v8-migration
description: "@decocms/blocks 8 (the next major): moves a v7 Deco site (@decocms/blocks 7.x with @decocms/tanstack or @decocms/nextjs, @decocms/blocks-admin, @decocms/blocks-cli, v7 @decocms/apps-*) onto @decocms/blocks 8, the v8 bindings (@decocms/tanstack 8, @decocms/nextjs 8) and the thin @decocms/apps-* clients. Runs the one-time migration script (scripts/main.ts: block map with legacy aliases, vendored app loaders, content in .deco/blocks, v7 secrets listed for the deploy platform, import report), then guides the manual work it reports. Use when a site's package.json depends on @decocms/blocks ^7, @decocms/tanstack, @decocms/nextjs or @decocms/blocks-admin and should move to v8; when the report lists /deco/invoke calls, createDecoWorkerEntry, RequestContext, useCart or other v7 imports to replace; when deco check rejects migrated content; or when a migrated page, draft preview, editor form or parity run differs from v7. Replaces the unpublished @decocms/blocks-migrate package."
---

# Deco v7 → v8 Migration

A script does the mechanical, content-safe part in one pass and prints the manual steps. Proven on `deco-sites/storefront-tanstack`, `deco-sites/demo-storefront`, `deco-sites/blog-tanstack` and four private VTEX storefronts (two ejected FastStore on Next.js, one TanStack Start, one non-ejected FastStore).

The spec is the docs page **Migrating from v7** (`/next/renames-and-migrations`). When this skill and the docs disagree, the docs win.

## When this applies

- `package.json` depends on `@decocms/blocks` `^7`, and on `@decocms/tanstack` or `@decocms/nextjs`, `@decocms/blocks-admin`, `@decocms/blocks-cli` or v7 `@decocms/apps-*`.
- Saved content lives in `.deco/blocks/*.json`, or the site serves it at `/.decofile`.

**FastStore storefronts that aren't ejected** (FastStore owns the Next.js app) keep v7's seam with v8 behind it: follow [`references/faststore.md`](./references/faststore.md) for steps 2, 3 and 6. **Native or mobile apps** (bundled JSON, native rendering): the script still runs, but most manual steps don't apply; follow [`references/native-apps.md`](./references/native-apps.md).

Not for sites on `@decocms/start@6.x` (upgrade to 7.x first: v7's `@decocms/blocks-cli` ships `deco-upgrade-6-to-7`) or on Fresh/Deno (first the `deco-to-tanstack-migration` skill).

## Prerequisites

1. A clean working tree: the script edits files in place.
2. **Install `@decocms/blocks@^8.4` before running the script** (not `^8`: `8.0.0` is an accidental v7 build). Keep the v7 `@decocms/apps-*` installed until the script has run: it vendors the app loaders your content calls from `node_modules`.
3. `typescript` resolvable from the site (the import codemod parses `src/` with it).

## Run

The script is `scripts/main.ts`. It resolves `@decocms/blocks` relative to its own files, so run it where that resolves to v8.

**From a `decocms/blocks` checkout on the v8 line** (run `bun install` there first):

```bash
bun <blocks>/.agents/skills/deco-v7-to-v8-migration/scripts/main.ts --root <site>
# under Node: npx tsx <blocks>/.agents/skills/deco-v7-to-v8-migration/scripts/main.ts --root <site>
```

**From an installed copy of the skill** (outside the repo): copy `scripts/` into the site first ([`references/running-the-script.md`](./references/running-the-script.md)).

| Flag | What it does |
|---|---|
| `--root <dir>` | The app root, the folder with the site's `package.json`. Default: `.` |
| `--decofile <file>` | Content to split into `.deco/blocks` when the site has none: the JSON the v7 site serves at `/.decofile`. |
| `--vtex-invoke keep\|v8` | No default. Needed if the site calls v7's VTEX invoke-map keys (else it stops, listing them): `keep` vendors v7's handler; `v8` uses the v8 client or a stub ([`references/server-functions.md`](./references/server-functions.md)). |

Steps, in order: **content** (redirects, settings and app blocks folded into `.deco/blocks` and `src/clients/`), **secrets**, **block map**, **invoke**, **scaffold**, **imports**, **scripts**. Each step: [`references/script-steps.md`](./references/script-steps.md).

Commit the script's output unedited as its own commit (`chore: run the v7-to-v8 migration`), apart from hand-written changes.

**A sibling site already migrated?** Port its v8 changes with a three-way merge per file ([`references/sibling-port.md`](./references/sibling-port.md)).

## Review the report

The script prints **Done** and **Left to do**, grouped by step. Work through "Left to do" top to bottom: each line names its subject and where the replacement lives.

## Manual steps

The full text of each step: [`references/manual-steps.md`](./references/manual-steps.md).

1. **Dependencies**: `@decocms/blocks@^8.4`, the v8 binding and `@decocms/compat-v7` at the same version, and the v8 `@decocms/apps-<platform>` client; remove v7 packages and codegen once nothing imports them.
2. **Check the page setup the script wrote** (`/next/tanstack-start-descriptors`, `/next/nextjs`), carry over what the site added to v7's page routes, and delete the v7 setup files and CI jobs.
3. **Worker, drafts, Studio and images from the binding; v7's pure helpers from `@decocms/compat-v7`; the rest is site code** ([`references/framework-code.md`](./references/framework-code.md), [`references/site-code.md`](./references/site-code.md)).
4. **Finish `/deco/invoke`**: validate the server functions the script wrote, and replace each stub in `src/migration-stubs.ts` ([`references/server-functions.md`](./references/server-functions.md)).
5. **Fix the content `deco check` rejects** ([`references/content.md`](./references/content.md)).
6. **Telemetry, analytics and previews** ([`references/telemetry.md`](./references/telemetry.md)).

## Verify

```bash
bunx deco schema && bunx deco content && bunx deco check   # 0 errors
bun run typecheck && bun run build
```

Then the rest of [`references/verify.md`](./references/verify.md): the committed schema, type errors counted against v7, drafts probed by hand, and a page-by-page parity run with every approved difference encoded as a rule ([`references/parity.md`](./references/parity.md)).

## DO NOT

- Add compat shims that re-create v7 APIs (`useCart` from a package, `invoke`, `RequestContext`, `ctx`). `@decocms/compat-v7` is the one approved home of v7's pure helpers: import them from it, never copy them in. The rest is site code.
- Copy v7's worker entry, draft middleware, Studio bridge, preview badge or `Image` into the site: the bindings ship them. A site-local `invoke` object or `runInvoke(key)` dispatcher is the same shim.
- Strip `"use client"` from hook, event or browser-API components to render them.
- Rename saved type names. Content stores them; keep the v7 name as an alias (`/next/renames-and-migrations#rename-a-type-with-an-alias`).

## When to load what

| Reference | Load it when |
|---|---|
| [`script-steps.md`](./references/script-steps.md) | You need what each script step did |
| [`manual-steps.md`](./references/manual-steps.md) | You work through the report's "Left to do" |
| [`verify.md`](./references/verify.md) | The site builds and you're checking it before review |
| [`import-map.md`](./references/import-map.md) | A v7 import needs its v8 replacement |
| [`legacy-names.md`](./references/legacy-names.md) | A saved `__resolveType` is an alias or one of the seven rewritten names |
| [`parity.md`](./references/parity.md) | Running the parity harness, approving differences, the pending state |
| [`editor-forms.md`](./references/editor-forms.md) | v7 `meta.gen.json` and v8 `schema.gen.json` forms differ |
| [`native-apps.md`](./references/native-apps.md) / [`faststore.md`](./references/faststore.md) | The site is a native app, or a FastStore storefront that isn't ejected |

### Gotchas by subject

What the site migrations taught, one subject per file. Commit hashes refer to `deco-sites/storefront-tanstack` and `deco-sites/blog-tanstack` (some carry a "blog" prefix; look a hash up in both); the private sites have none.

| Reference | Subject |
|---|---|
| [`running-the-script.md`](./references/running-the-script.md) | Before the run (install order, vendoring, stale lockfiles), running from an installed copy, dependencies after |
| [`sibling-port.md`](./references/sibling-port.md) | What a three-way merge from a sibling site brings along |
| [`rendering.md`](./references/rendering.md) | No async rendering, streaming and hydration, awaited blocks, section wrappers, Tailwind |
| [`framework-code.md`](./references/framework-code.md) | The bindings: worker, drafts, Studio, images |
| [`site-code.md`](./references/site-code.md) | What stays site code: SEO, devices, cookies, commerce code, error reporting, A/B splits |
| [`server-functions.md`](./references/server-functions.md) | `/deco/invoke` → server functions |
| [`caching-and-privacy.md`](./references/caching-and-privacy.md) | Per-visitor data, QueryClient scope, draft bypass, hydration waits |
| [`nextjs.md`](./references/nextjs.md) | Next.js App Router: `@decocms/nextjs` drafts and proxy, `list('page')`, head order, Jest |
| [`hosted-releases.md`](./references/hosted-releases.md) | Hosted CMS instead of fast deploy, bundled content, v7 leftovers to delete |
| [`content.md`](./references/content.md) | `deco check` as a deploy gate, content it rejects, editing the bundled content, moving it to Studio's hosted CMS |
| [`telemetry.md`](./references/telemetry.md) | Telemetry params, resource attributes, dropped v7 bindings, analytics |

`scripts/` is the migration (`main.ts`), tested by the repo's `bun run test`.

## After the migration

Other skills cover the site once it runs on v8:

- **`deco-go-live`**: launch QA beyond the parity run (cache checks, checkout headers, SEO), the traffic ladder and the first 72 hours.
- **`deco-tanstack-site`** / **`deco-nextjs-site`**: the binding's wiring, for changes after the migration.
- **`deco-storefront-caching`**: tuning the site-owned `pageCache`, cache keys and purges.
