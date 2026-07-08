# Merging `@decocms/apps` into `decocms/blocks` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `apps-start`'s 9 concern areas into `packages/apps-*` inside `decocms/blocks`, importing the new split packages directly (no more `@decocms/start` compat shims needed in consumer sites), released in the existing `v7` lockstep version train.

**Architecture:** Mechanical migration — `git mv` each concern's source tree into its own new package, rewrite every `@decocms/start/*` import to the correct new package/subpath per the proven mapping below, add a `package.json` matching the existing 5 packages' shape, verify. Two structural cleanups happen alongside: matcher/flag duplication between `apps-website` and `@decocms/blocks` gets resolved (delete duplicates, port the 2 real gaps), and the 3 UI components move into `@decocms/blocks/hooks`.

**Tech Stack:** Same as the rest of the monorepo — Bun workspaces, TypeScript, Vitest, plain `.ts`/`.tsx` source exports (no bundling), the existing `v7` semantic-release/OIDC pipeline (already fully dynamic via `packages/*` globs — verified in Task 1, no root config changes needed).

**Source design doc:** `docs/apps-monorepo-migration-design.md` (this plan implements it — read it first for the *why* behind each decision below).

## Global Constraints

- Every new package name is `@decocms/apps-<concern>`, published alongside the existing 5 at the same lockstep version (via `scripts/sync-versions.mjs`, which already dynamically globs `packages/*` — confirmed, no changes needed there or in `.releaserc.v7.json`'s `publishCmd`, also glob-based).
- Every new package's `dependencies` uses `"workspace:*"` for `@decocms/blocks`/`@decocms/blocks-admin`/`@decocms/tanstack` (matching the existing 5 packages' pattern) — `sync-versions.mjs` rewrites these to the real version at publish time.
- Every new package needs a `repository` field (`{"type": "git", "url": "https://github.com/decocms/blocks.git", "directory": "packages/apps-<concern>"}`) — required for npm provenance verification (this exact requirement broke the first real publish of the original 5 packages; don't repeat that).
- One-way dependency rule: `apps-*` packages may depend on `@decocms/blocks`/`@decocms/blocks-admin`/`@decocms/tanstack`, never the reverse. `apps-*` packages do not depend on each other.
- **Proven old→new import mapping** (evidenced from `casaevideo-tanstack`'s actual, verified migration commits `7133613`, `55e353d`, `9585417`, `9393bf9` — apply exactly, don't re-derive from scratch):

  | Old (`@decocms/start/...`) | New | Notes |
  |---|---|---|
  | `cms` | `@decocms/blocks/cms` (server) or `@decocms/blocks/cms/client` (client-bundled — check for `useState`/`useEffect`/`Suspense`/`lazy` or other browser-only signals) | |
  | `sdk/cachedLoader` | `@decocms/blocks/sdk/cachedLoader` | |
  | `sdk/cacheHeaders` | `@decocms/blocks/sdk/cacheHeaders` | |
  | `sdk/cookie` | `@decocms/blocks/sdk/cookie` | |
  | `sdk/crypto` | `@decocms/blocks/sdk/crypto` | |
  | `sdk/instrumentedFetch` | `@decocms/blocks/sdk/instrumentedFetch` | |
  | `sdk/invoke` | `@decocms/blocks/sdk/invoke` | |
  | `sdk/observability` | `@decocms/blocks/sdk/observability` | |
  | `sdk/requestContext` | `@decocms/blocks/sdk/requestContext` | |
  | `sdk/retry` | `@decocms/blocks/sdk/retry` | |
  | `sdk/signal` | `@decocms/blocks/sdk/signal` | |
  | `sdk/useDevice` | `@decocms/blocks/sdk/useDevice` | |
  | `sdk/useId` | `@decocms/blocks/sdk/useId` | |
  | `sdk/useScript` | `@decocms/blocks/sdk/useScript` | |
  | `sdk/useSuggestions` | `@decocms/blocks/sdk/useSuggestions` | |
  | `sdk/clx` | `@decocms/blocks/sdk/clx` | |
  | `sdk/router` | `@decocms/tanstack` (root export, `createDecoRouter`) | |
  | `hooks` (barrel) | Split by symbol: `RenderSection` → `@decocms/blocks/hooks`; `SectionRenderer`/`DecoRootLayout`/`DecoPageRenderer`/`PreviewProviders` → `@decocms/tanstack` (root) | Old package merged these into one barrel; genuinely split across two new ones |
  | `routes` | `@decocms/tanstack` (root export — `cmsRouteConfig`, `cmsHomeRouteConfig`, `deferredSectionLoader`) | |
  | `scripts/generate-invoke` | `@decocms/blocks-cli/scripts/generate-invoke` | Filesystem path reference, not a package specifier — matches existing `blocks-cli/generate-*` pattern |
  | `sdk/createInvoke` (`createInvokeFn`) | **Real gap** — not on any new package's public surface yet. Task 7 adds `createInvokeFn` to `@decocms/tanstack`'s exports properly (the site-level compat shim reimplemented it verbatim as a stopgap; this migration does the real fix instead). | |
  | `apps` | **Confirmed** (Task 1): `@decocms/blocks-admin/apps/autoconfig`. `apps-start`'s `registry.ts` doc comment describes `@decocms/start`'s `autoconfigApps()` consuming `APP_REGISTRY`; `packages/blocks-admin/src/apps/autoconfig.ts` exports an equivalent `autoconfigApps(blocks, registry)` with matching signature/purpose (its own doc comment even shows the old call site: `import { autoconfigApps } from "@decocms/start/apps/autoconfig"`). Matches the mapping already documented in this repo's `CLAUDE.md` "Package Exports" table. | |

- **Registry redesign (decided mid-Task-2, after implementation surfaced a real conflict):** `apps-start`'s `registry.ts` was a single static `APP_REGISTRY` array whose entries dynamically imported every platform's `mod.ts` as sibling relative paths (`./shopify/mod`, `./vtex/mod`, etc.) — only possible because every platform lived in one package. Split by platform, no single `apps-*` package can hold that array without depending on every other `apps-*` package, violating the one-way/no-apps-to-apps rule. **Resolution:** `@decocms/apps-commerce/registry` keeps only the shared `AppRegistryEntry`/`AppRegistry` **types** (no runtime array). Each platform package that has a registrable app (`apps-vtex`, `apps-shopify`, `apps-resend`, `apps-blog` — the 4 apps-start's registry actually covered) exports its **own** single-entry registry from its own `./registry` subpath (e.g. `@decocms/apps-vtex/registry` exports `VTEX_REGISTRY_ENTRY: AppRegistryEntry`, pointing `module: () => import("./mod")` at its own sibling `mod.ts` — a same-package relative import, no cross-package edge at all). Sites compose their own array by importing only the platform entries they actually use:
  ```ts
  import { autoconfigApps } from "@decocms/blocks-admin/apps/autoconfig";
  import { VTEX_REGISTRY_ENTRY } from "@decocms/apps-vtex/registry";
  import { RESEND_REGISTRY_ENTRY } from "@decocms/apps-resend/registry";
  await autoconfigApps(generatedBlocks, [VTEX_REGISTRY_ENTRY, RESEND_REGISTRY_ENTRY]);
  ```
  This applies to Tasks 7 (vtex), 8 (shopify), 12 (resend), 13 (blog) — each adds a `registry.ts` exporting its own entry with the same metadata (`blockKey`, `displayName`, `category`, `description`) apps-start's original array had for that platform (see the git history of `packages/apps-commerce/src/registry.ts` for the exact per-platform values once Task 2 lands). apps-magento/algolia/salesforce/website did not have entries in apps-start's original registry — no registry.ts needed for those unless a later requirement adds one.

- **`manifest.gen.ts` is committed, not gitignored** (decided mid-Task-6): apps-start's own `scripts/generate-manifests.ts` covers `vtex`, `shopify`, `resend`, `website` (confirmed by reading that script), and each `manifest.gen.ts` file's own header says "checked into source control... updated via: npm run generate:manifests" — despite the `.gen.ts` suffix matching this repo's blanket `*.gen.ts` gitignore rule (that rule exists for genuinely-ephemeral per-checkout artifacts like `examples/tanstack-smoke/src/routeTree.gen.ts`, a different category of file). `.gitignore` now has a scoped exception: `!packages/apps-*/src/manifest.gen.ts`. Tasks 7 (vtex), 8 (shopify), 12 (resend) will each have their own `manifest.gen.ts` to move and commit — `git add` it like any other source file, the gitignore exception already covers it, no per-task gitignore edit needed. Porting `scripts/generate-manifests.ts` itself (for future regeneration convenience, adapted for the new per-package layout) is explicitly deferred as a follow-up, not part of this plan — the file's *content* is what matters for these tasks, and it's already correct as copied from apps-start.

- Verification bar for every migration task: `bun install` clean, `bun run typecheck` clean (whole workspace, not just the new package), `bun run test` clean (whole workspace), then a final end-to-end pass (Task 14) against a real site.
- BSD sed's `\b` word boundary silently fails in some contexts (hit this twice already this session) — use `perl -pi -e` for bulk import rewrites, or a pattern that doesn't rely on `\b`, and always verify with a final grep that zero old-name references remain.

## File Structure

```
packages/
  apps-commerce/    src/{types,app-types,resolve,manifest-utils,utils/*,sdk/*,registry}.ts
  apps-vtex/         src/{index,commerceLoaders,mod,client,types,middleware}.ts, actions/, loaders/, utils/, hooks/
  apps-shopify/      src/{index,mod,client}.ts, loaders/, actions/, utils/
  apps-magento/      src/{index,client,types,middleware}.ts, loaders/, actions/, utils/, hooks/
  apps-algolia/      src/{index,client,types}.ts, loaders/
  apps-salesforce/   src/{index,types}.ts, utils/, loaders/products/
  apps-resend/       src/{index,mod,client,types}.ts, actions/send.ts
  apps-blog/         src/{index,mod,types,commerceLoaders}.ts, loaders/, core/
  apps-website/      src/{index,mod,client,types}.ts, components/, loaders/ (matchers/ and flags/ deliberately absent — see Tasks 4-5)
  blocks/src/matchers/builtins.ts   (Task 4 adds date; site deliberately skipped, see Task 4)
  blocks/src/flags/                 (Task 5, new)
  blocks/src/hooks/                 (Task 3 adds JsonLd, Image, Picture)
```

Each `packages/apps-*/` also gets: `package.json` (exports map + deps, see per-task content below), `tsconfig.json` (copy an existing package's, e.g. `packages/blocks-admin/tsconfig.json`, adjust `include`), and its Vitest tests moved alongside their source files (co-located `*.test.ts`, matching the existing convention).

---

### Task 1: Migration tooling + verify assumptions

**Files:**
- Create: `scripts/migrate-apps-import.mjs`
- Reference (read-only): a fresh clone of `decocms/apps-start` at `/tmp/apps-start-migrate` (or wherever's convenient — this is scratch, not committed)

**Interfaces:**
- Produces: `migrate-apps-import.mjs <dir>` — a CLI script every later task invokes to rewrite `@decocms/start/*` imports inside a given directory per the Global Constraints mapping table.

- [ ] **Step 1: Clone apps-start fresh for reference**

```bash
rm -rf /tmp/apps-start-migrate
git clone git@github.com:decocms/apps-start.git /tmp/apps-start-migrate
cd /tmp/apps-start-migrate && git log -1 --format="%H %ci"
```

Record the commit hash — every later task's file counts/content should be checked against this exact snapshot, not a possibly-newer one, so the whole migration is internally consistent.

- [ ] **Step 2: Verify the `@decocms/start/apps` mapping**

```bash
cd ~/code/deco-start && git log --oneline --all -- packages/blocks-admin/src/apps/autoconfig.ts | tail -5
grep -n "apps/autoconfig\|autoconfigApps" packages/blocks-admin/src/apps/autoconfig.ts | head -10
```

Compare against `/tmp/apps-start-migrate/registry.ts`'s doc comment (references `autoconfigApps()`). If `blocks-admin/src/apps/autoconfig.ts` exports an equivalent `autoconfigApps` (or the registry-consuming function `registry.ts` describes), confirm `@decocms/start/apps` → `@decocms/blocks-admin/apps/autoconfig` and update the Global Constraints table mapping from "Unconfirmed" to confirmed. If no equivalent exists, that's a real gap — note it in Task 2's registry.ts migration (below) rather than guessing.

- [ ] **Step 3: Write the import-rewrite script**

```js
#!/usr/bin/env node
// scripts/migrate-apps-import.mjs
// Rewrites @decocms/start/* imports to the correct new package per the
// proven mapping in docs/apps-monorepo-migration-plan.md's Global
// Constraints. Usage: node scripts/migrate-apps-import.mjs <dir>
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const MAPPING = [
  ["@decocms/start/cms", "@decocms/blocks/cms"], // client usages fixed up by hand per Global Constraints
  ["@decocms/start/sdk/cachedLoader", "@decocms/blocks/sdk/cachedLoader"],
  ["@decocms/start/sdk/cacheHeaders", "@decocms/blocks/sdk/cacheHeaders"],
  ["@decocms/start/sdk/cookie", "@decocms/blocks/sdk/cookie"],
  ["@decocms/start/sdk/crypto", "@decocms/blocks/sdk/crypto"],
  ["@decocms/start/sdk/instrumentedFetch", "@decocms/blocks/sdk/instrumentedFetch"],
  ["@decocms/start/sdk/invoke", "@decocms/blocks/sdk/invoke"],
  ["@decocms/start/sdk/observability", "@decocms/blocks/sdk/observability"],
  ["@decocms/start/sdk/requestContext", "@decocms/blocks/sdk/requestContext"],
  ["@decocms/start/sdk/retry", "@decocms/blocks/sdk/retry"],
  ["@decocms/start/sdk/signal", "@decocms/blocks/sdk/signal"],
  ["@decocms/start/sdk/useDevice", "@decocms/blocks/sdk/useDevice"],
  ["@decocms/start/sdk/useId", "@decocms/blocks/sdk/useId"],
  ["@decocms/start/sdk/useScript", "@decocms/blocks/sdk/useScript"],
  ["@decocms/start/sdk/useSuggestions", "@decocms/blocks/sdk/useSuggestions"],
  ["@decocms/start/sdk/clx", "@decocms/blocks/sdk/clx"],
  ["@decocms/start/sdk/router", "@decocms/tanstack"],
  ["@decocms/start/routes", "@decocms/tanstack"],
  ["@decocms/start/scripts/generate-invoke", "@decocms/blocks-cli/scripts/generate-invoke"],
];

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node scripts/migrate-apps-import.mjs <dir>");
  process.exit(1);
}

function walk(d) {
  for (const entry of readdirSync(d)) {
    const p = join(d, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      walk(p);
    } else if ([".ts", ".tsx"].includes(extname(p))) {
      let content = readFileSync(p, "utf8");
      let changed = false;
      for (const [oldPath, newPath] of MAPPING) {
        // Match the old specifier only when followed by a non-identifier
        // char (quote, slash) so e.g. "@decocms/start/cms" doesn't
        // false-positive-match inside "@decocms/start/cmsFoo".
        const re = new RegExp(
          oldPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + String.raw`(['"/])`,
          "g",
        );
        if (re.test(content)) {
          content = content.replace(re, `${newPath}$1`);
          changed = true;
        }
      }
      if (changed) {
        writeFileSync(p, content);
        console.log(`rewrote: ${p}`);
      }
    }
  }
}

walk(dir);
console.log("Done. Now grep for any remaining @decocms/start references and fix by hand:");
console.log(`  grep -rn "@decocms/start" ${dir}`);
```

- [ ] **Step 4: Verify the script on a throwaway copy**

```bash
cp -r /tmp/apps-start-migrate/vtex /tmp/vtex-test
node scripts/migrate-apps-import.mjs /tmp/vtex-test
grep -rn "@decocms/start" /tmp/vtex-test | grep -v "@decocms/start/apps\|@decocms/start/hooks\|@decocms/start/sdk/createInvoke" | wc -l
```

Expect `0` (everything in the mapping table gets rewritten). The 3 excluded patterns (`apps`, `hooks` barrel, `createInvoke`) are the ones needing manual per-file judgment per the Global Constraints notes — confirm they still show up (proving the script correctly left them alone rather than mis-rewriting).

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-apps-import.mjs
git commit -m "feat(scripts): add apps-start import-rewrite tool for the monorepo merge"
```

---

### Task 2: `@decocms/apps-commerce` (foundational — migrate first, other packages may depend on its types)

**Files:**
- Create: `packages/apps-commerce/` (from `/tmp/apps-start-migrate/commerce/`, excluding `components/`)
- Create: `packages/apps-commerce/package.json`
- Modify: none outside the new package yet (Task 3 handles the UI component split-out)

**Interfaces:**
- Produces: `@decocms/apps-commerce` — `commerce/types`, `app-types`, `resolve`, `manifest-utils`, `utils/*`, `sdk/*`, plus `registry.ts` relocated from apps-start's repo root but **reduced to types only** (`AppRegistryEntry`, `AppRegistry`) — see the Global Constraints "Registry redesign" note. The static `APP_REGISTRY` array with per-platform entries does NOT move here; each platform package exports its own entry instead (Tasks 7, 8, 12, 13).

- [ ] **Step 1: Move the files**

```bash
mkdir -p packages/apps-commerce/src
git mv /tmp/apps-start-migrate/commerce/types packages/apps-commerce/src/types 2>/dev/null || cp -r /tmp/apps-start-migrate/commerce/types packages/apps-commerce/src/types
# (repeat cp -r for app-types.ts, resolve.ts, manifest-utils.ts, utils/, sdk/ —
#  these come from a separate clone, not this repo, so `git mv` doesn't apply;
#  use cp -r then `git add` the new location)
cp /tmp/apps-start-migrate/commerce/app-types.ts packages/apps-commerce/src/
cp /tmp/apps-start-migrate/commerce/resolve.ts packages/apps-commerce/src/
cp /tmp/apps-start-migrate/commerce/manifest-utils.ts packages/apps-commerce/src/
cp -r /tmp/apps-start-migrate/commerce/utils packages/apps-commerce/src/
cp -r /tmp/apps-start-migrate/commerce/sdk packages/apps-commerce/src/
cp /tmp/apps-start-migrate/registry.ts packages/apps-commerce/src/
```

- [ ] **Step 2: Rewrite imports**

```bash
node scripts/migrate-apps-import.mjs packages/apps-commerce
grep -rn "@decocms/start" packages/apps-commerce
```

Fix any remaining matches by hand per the Global Constraints notes (expect `apps`-related references inside `registry.ts`'s doc comment, and possibly none elsewhere — `commerce/` is mostly pure types/utils with few framework touchpoints).

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "@decocms/apps-commerce",
  "version": "0.0.0",
  "type": "module",
  "description": "Deco commerce apps: shared types, app-registry, and portable commerce utilities",
  "repository": {
    "type": "git",
    "url": "https://github.com/decocms/blocks.git",
    "directory": "packages/apps-commerce"
  },
  "main": "./src/types/commerce.ts",
  "exports": {
    "./types": "./src/types/commerce.ts",
    "./app-types": "./src/app-types.ts",
    "./resolve": "./src/resolve.ts",
    "./manifest-utils": "./src/manifest-utils.ts",
    "./utils/*": "./src/utils/*.ts",
    "./sdk/*": "./src/sdk/*.ts",
    "./registry": "./src/registry.ts"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run --root ../.. packages/apps-commerce/",
    "typecheck": "tsc --noEmit",
    "lint:unused": "knip"
  },
  "dependencies": {
    "@decocms/blocks": "workspace:*"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "knip": "^5.86.0",
    "typescript": "^5.9.0"
  },
  "publishConfig": {
    "registry": "https://registry.npmjs.org",
    "access": "public"
  }
}
```

- [ ] **Step 4: Add `tsconfig.json`** (copy `packages/blocks-admin/tsconfig.json`, verify `include`/`compilerOptions` need no adjustment — same shape as every other package)

- [ ] **Step 5: Verify**

```bash
bun install
cd packages/apps-commerce && bun run typecheck && bun run test
cd ../.. && bun run typecheck  # whole workspace — confirm no new cross-package breakage
```

- [ ] **Step 6: Commit**

```bash
git add packages/apps-commerce
git commit -m "feat(apps-commerce): migrate commerce/ + registry.ts from apps-start"
```

---

### Task 3: Move `JsonLd`/`Image`/`Picture` into `@decocms/blocks/hooks`

**Files:**
- Create: `packages/blocks/src/hooks/JsonLd.tsx`, `packages/blocks/src/hooks/Image.tsx`, `packages/blocks/src/hooks/Picture.tsx` (from `/tmp/apps-start-migrate/commerce/components/{JsonLd,Image,Picture}.tsx`)
- Modify: `packages/blocks/src/hooks/index.ts` (add 3 exports)

**Interfaces:**
- Produces: `JsonLd`, `Image`, `Picture` importable from `@decocms/blocks/hooks` (existing subpath, per the design's resolved decision to reuse it rather than add `blocks/commerce`).

- [ ] **Step 1: Copy the 3 components**

```bash
cp /tmp/apps-start-migrate/commerce/components/JsonLd.tsx packages/blocks/src/hooks/
cp /tmp/apps-start-migrate/commerce/components/Image.tsx packages/blocks/src/hooks/
cp /tmp/apps-start-migrate/commerce/components/Picture.tsx packages/blocks/src/hooks/
```

- [ ] **Step 2: Rewrite their imports**

```bash
node scripts/migrate-apps-import.mjs packages/blocks/src/hooks
grep -n "@decocms/start\|@decocms/apps" packages/blocks/src/hooks/{JsonLd,Image,Picture}.tsx
```

These 3 files likely import commerce types (`Product`, etc.) from what's now `@decocms/apps-commerce/types` — but `@decocms/blocks` must NOT depend on `@decocms/apps-commerce` (violates the one-way dependency rule: `apps-*` depends on `blocks`, never the reverse). Read each file's actual type usage; if it only needs structural/duck-typed shapes (e.g. an object with `image`/`url` fields), inline a minimal local type instead of importing from commerce. If it genuinely needs the full `Product`/`ImageObject` schema.org shape, that's a real design conflict to flag back rather than silently work around — note it in the commit message either way.

- [ ] **Step 3: Wire the barrel export**

```ts
// packages/blocks/src/hooks/index.ts — add these lines
export { default as JsonLd } from "./JsonLd";
export { default as Image } from "./Image";
export { default as Picture } from "./Picture";
```

(Verify the actual export shape — `export default` vs named — against the copied files' real content before writing this; apps-start's `package.json` exports map lists them as `.tsx` default-ish paths but confirm rather than assume.)

- [ ] **Step 4: Verify**

```bash
cd packages/blocks && bun run typecheck && bun run test
```

- [ ] **Step 5: Commit**

```bash
git add packages/blocks/src/hooks
git commit -m "feat(blocks): add JsonLd/Image/Picture to hooks (moved from apps-start commerce/components)"
```

---

### Task 4: Port `date` matcher into `blocks/matchers/builtins.ts` (`site` evaluated and skipped — see below)

**Files:**
- Modify: `packages/blocks/src/matchers/builtins.ts` (add `date` and `site` matcher functions + registration)
- Modify: `packages/blocks/src/matchers/builtins.test.ts` (add tests for the 2 new matchers)
- Reference (read-only, don't copy): `/tmp/apps-start-migrate/website/matchers/{date,site}.ts` — port their logic, adapting to `builtins.ts`'s existing function shape (see `cookieMatcher` in that file for the pattern: `(rule: Record<string, unknown>, ctx: MatcherContext): boolean`)

**Interfaces:**
- Consumes: `MatcherContext`, `registerMatcher` from `../cms/resolve` (already imported in `builtins.ts`).
- Produces: `date` and `site` matcher types registered the same way the existing 10 are, reachable via `registerBuiltinMatchers()`.

- [ ] **Step 1: Read the source matchers to port**

```bash
cat /tmp/apps-start-migrate/website/matchers/date.ts
cat /tmp/apps-start-migrate/website/matchers/site.ts
```

- [ ] **Step 2: Add both matcher functions to `builtins.ts`**, following the exact pattern already there (e.g. `cookieMatcher`) — same rule-shape/context-shape conventions, registered inside `registerBuiltinMatchers()` alongside the existing 10.

- [ ] **Step 3: Add tests** to `builtins.test.ts` mirroring the existing coverage style for the other 10 matchers (check true/false/edge cases matching what `date.ts`/`site.ts`'s own apps-start tests covered, if any exist at `/tmp/apps-start-migrate/website/__tests__/`).

- [ ] **Step 4: Verify**

```bash
cd packages/blocks && bun run typecheck && bun run test
```

- [ ] **Step 5: Commit**

```bash
git add packages/blocks/src/matchers
git commit -m "feat(blocks): port date + site matchers from apps-start (closes the last matcher gap)"
```

This closes the matcher-parity gap identified during design — after this, `apps-website`'s own `matchers/` directory (13 remaining files, all now duplicates) gets deleted in Task 6, not carried into the new package.

**`site` matcher deliberately skipped (decided mid-Task-4):** apps-start's `site.ts` matches against `MatchContext.siteId` — a numeric "deco website ID," meaningful only in a multi-tenant setup where one CMS/admin account manages multiple distinct sites and a block needs to know which one it's currently rendering for. Grepped the whole monorepo: `MatcherContext` (`packages/blocks/src/cms/resolve.ts`) has no site-identity field at all, and single-tenant is this framework's entire model (one deployment = one site) — there is no multi-site concept anywhere for `siteId` to distinguish between. Porting this matcher would mean inventing a `MatcherContext.siteId` field with no real source of truth to populate it from, for a feature no current or planned site can use. Not carried forward — if genuine multi-tenancy is ever added to the framework, this matcher (and the `MatcherContext` field it needs) can be revisited then, with a real design for where `siteId` comes from.

A real, useful side-effect found while implementing `date`: `builtins.ts` already had a pre-existing bug where the `"website/matchers/date.ts"` `__resolveType` string was mis-registered pointing at `cronMatcher`'s inclusive (`>=`/`<=`) window logic instead of `date.ts`'s actual strict (`>`/`<`) semantics — fixed as part of this task.

---

### Task 5: New `@decocms/blocks/flags` subpath

**Files:**
- Create: `packages/blocks/src/flags/` (from `/tmp/apps-start-migrate/website/flags/`: `audience.ts`, `everyone.ts`, `flag.ts`, `multivariate.ts`, `multivariate/`)
- Modify: `packages/blocks/package.json` (add `"./flags": "./src/flags/flag.ts"` and `"./flags/*": "./src/flags/*.ts"` — verify the actual entry-point file name against what's copied; `flag.ts` is a guess based on the directory listing, confirm before finalizing the exports map)

**Interfaces:**
- Produces: `@decocms/blocks/flags` — feature-flag primitives, same matcher-adjacent resolution mechanism as `@decocms/blocks/matchers`.

- [ ] **Step 1: Copy the files**

```bash
mkdir -p packages/blocks/src/flags
cp -r /tmp/apps-start-migrate/website/flags/* packages/blocks/src/flags/
```

- [ ] **Step 2: Rewrite imports**

```bash
node scripts/migrate-apps-import.mjs packages/blocks/src/flags
grep -rn "@decocms/start" packages/blocks/src/flags
```

- [ ] **Step 3: Add the export map entry** to `packages/blocks/package.json`'s `exports` (exact subpath names depend on what Step 1 actually copies — inspect the files' real top-level exports before writing the final map, don't assume the directory listing alone tells you the full public surface).

- [ ] **Step 4: Verify**

```bash
cd packages/blocks && bun run typecheck && bun run test
```

- [ ] **Step 5: Commit**

```bash
git add packages/blocks/src/flags packages/blocks/package.json
git commit -m "feat(blocks): add flags subpath (moved from apps-start website/flags)"
```

---

### Task 6: `@decocms/apps-website` (reduced scope — matchers/flags already extracted)

**Files:**
- Create: `packages/apps-website/` from `/tmp/apps-start-migrate/website/`, **excluding** `matchers/` (deleted, Task 4 superseded it) and `flags/` (moved, Task 5)
- Create: `packages/apps-website/package.json`

**Interfaces:**
- Consumes: `@decocms/blocks/hooks` (for `JsonLd`/`Image`/`Picture` if any `website/sections`|`components` render them), `@decocms/blocks/matchers`, `@decocms/blocks/flags` (if `website/mod.ts`'s autoconfig wiring references matcher/flag registration — check before assuming it doesn't need these as deps).
- Produces: `@decocms/apps-website` — `mod.ts` (autoconfig entry, SEO defaults/theme wiring), `sections/` (Seo, SeoV2, Analytics), `components/` (Theme, Video, Analytics, OneDollarStats), `loaders/` (environment, secret, secretString, fonts/), `types.ts`, `client.ts`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p packages/apps-website/src
cp -r /tmp/apps-start-migrate/website/{index.ts,mod.ts,client.ts,types.ts,manifest.gen.ts} packages/apps-website/src/
cp -r /tmp/apps-start-migrate/website/{sections,components,loaders,utils} packages/apps-website/src/
# matchers/ and flags/ deliberately NOT copied — see Tasks 4-5
rm -rf packages/apps-website/src/matchers packages/apps-website/src/flags  # in case any stray refs got pulled in by a glob copy above
```

- [ ] **Step 2: Rewrite imports**

```bash
node scripts/migrate-apps-import.mjs packages/apps-website
grep -rn "@decocms/start\|@decocms/apps/website/matchers\|@decocms/apps/website/flags" packages/apps-website
```

Any remaining references to the old `website/matchers/*` or `website/flags/*` paths (from `mod.ts`'s own internal wiring, if it directly imports specific matcher/flag files rather than going through a registration function) need manual rewriting to `@decocms/blocks/matchers`/`@decocms/blocks/flags`.

- [ ] **Step 3: Write `package.json`** (exports map derived from apps-start's current one, `website/*` entries only, paths adjusted to drop the now-absent `matchers`/`flags` entries):

```json
{
  "name": "@decocms/apps-website",
  "version": "0.0.0",
  "type": "module",
  "description": "Deco generic-site app: SEO, analytics, theme, and content utilities shared across every commerce backend",
  "repository": {
    "type": "git",
    "url": "https://github.com/decocms/blocks.git",
    "directory": "packages/apps-website"
  },
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./mod": "./src/mod.ts",
    "./client": "./src/client.ts",
    "./types": "./src/types.ts",
    "./components/*": "./src/components/*.tsx",
    "./loaders/*": "./src/loaders/*.ts",
    "./loaders/fonts/*": "./src/loaders/fonts/*.ts",
    "./utils/*": "./src/utils/*.ts",
    "./sections/*": "./src/sections/*.tsx",
    "./sections/Seo/*": "./src/sections/Seo/*.tsx"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run --root ../.. packages/apps-website/",
    "typecheck": "tsc --noEmit",
    "lint:unused": "knip"
  },
  "dependencies": {
    "@decocms/blocks": "workspace:*",
    "@decocms/apps-commerce": "workspace:*"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "knip": "^5.86.0",
    "typescript": "^5.9.0"
  },
  "publishConfig": {
    "registry": "https://registry.npmjs.org",
    "access": "public"
  }
}
```

- [ ] **Step 4: Verify**

```bash
bun install
cd packages/apps-website && bun run typecheck && bun run test
```

- [ ] **Step 5: Commit**

```bash
git add packages/apps-website
git commit -m "feat(apps-website): migrate website/ from apps-start (matchers/flags extracted to blocks)"
```

---

### Task 7: `@decocms/apps-vtex`

**Files:**
- Create: `packages/apps-vtex/` from `/tmp/apps-start-migrate/vtex/` (105 files: `index.ts`, `commerceLoaders.ts`, `mod.ts`, `client.ts`, `types.ts`, `middleware.ts`, `actions/`, `actions/analytics/`, `loaders/`, `loaders/intelligentSearch/`, `loaders/legacy/`, `loaders/workflow/`, `utils/`, `hooks/`)
- Create: `packages/apps-vtex/package.json`
- Modify: `packages/tanstack/src/index.ts` (or wherever its public exports live) — add `createInvokeFn`, the real gap identified in Global Constraints (currently only reimplemented as a site-level shim in `casaevideo-tanstack`)

**Interfaces:**
- Consumes: `@decocms/apps-commerce` (types/utils), `@decocms/blocks/cms`, `@decocms/blocks/sdk/*`, `@decocms/tanstack` (`createInvokeFn`, once Step 2 adds it).

- [ ] **Step 1: Add `createInvokeFn` to `@decocms/tanstack`'s public exports**

```bash
grep -n "createInvokeFn" packages/tanstack/src/sdk/createInvoke.ts
```

Read the file — it exists in `packages/tanstack/src/sdk/createInvoke.ts` already (per Global Constraints: "lives at `deco-start/packages/tanstack/src/sdk/createInvoke.ts` but isn't exported from `@decocms/tanstack`'s `package.json` `exports` map or root barrel" — confirmed via `casaevideo-tanstack`'s shim README). Add it to `packages/tanstack/src/index.ts`'s barrel export and confirm `packages/tanstack/package.json`'s `exports` map already covers the root `.` path (it should, per existing pattern).

- [ ] **Step 2: Move the vtex files**

```bash
mkdir -p packages/apps-vtex/src
cp -r /tmp/apps-start-migrate/vtex/* packages/apps-vtex/src/
```

- [ ] **Step 3: Rewrite imports**

```bash
node scripts/migrate-apps-import.mjs packages/apps-vtex
grep -rn "@decocms/start" packages/apps-vtex
```

Fix remaining `sdk/createInvoke` references by hand: `import { createInvokeFn } from "@decocms/start/sdk/createInvoke"` → `import { createInvokeFn } from "@decocms/tanstack"`.

- [ ] **Step 4: Write `package.json`** (exports map = every `./vtex/*` entry from apps-start's current `package.json`, with the `vtex/` prefix stripped since it's now the package root):

```json
{
  "name": "@decocms/apps-vtex",
  "version": "0.0.0",
  "type": "module",
  "description": "Deco commerce app: VTEX integration",
  "repository": {
    "type": "git",
    "url": "https://github.com/decocms/blocks.git",
    "directory": "packages/apps-vtex"
  },
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./commerceLoaders": "./src/commerceLoaders.ts",
    "./mod": "./src/mod.ts",
    "./client": "./src/client.ts",
    "./types": "./src/types.ts",
    "./actions": "./src/actions/index.ts",
    "./actions/*": "./src/actions/*.ts",
    "./actions/analytics/*": "./src/actions/analytics/*.ts",
    "./loaders": "./src/loaders/index.ts",
    "./loaders/*": "./src/loaders/*.ts",
    "./utils": "./src/utils/index.ts",
    "./utils/*": "./src/utils/*.ts",
    "./loaders/intelligentSearch/*": "./src/loaders/intelligentSearch/*.ts",
    "./loaders/legacy/*": "./src/loaders/legacy/*.ts",
    "./loaders/workflow/*": "./src/loaders/workflow/*.ts",
    "./inline-loaders/productDetailsPage": "./src/loaders/intelligentSearch/productDetailsPage.ts",
    "./inline-loaders/productListingPage": "./src/loaders/intelligentSearch/productListingPage.ts",
    "./inline-loaders/productList": "./src/loaders/productListFull.ts",
    "./inline-loaders/productListShelf": "./src/loaders/intelligentSearch/productList.ts",
    "./inline-loaders/relatedProducts": "./src/loaders/legacy/relatedProductsLoader.ts",
    "./inline-loaders/suggestions": "./src/loaders/intelligentSearch/suggestions.ts",
    "./inline-loaders/minicart": "./src/loaders/minicart.ts",
    "./inline-loaders/workflowProducts": "./src/loaders/workflow/products.ts",
    "./hooks": "./src/hooks/index.ts",
    "./hooks/*": "./src/hooks/*.ts",
    "./middleware": "./src/middleware.ts"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run --root ../.. packages/apps-vtex/",
    "typecheck": "tsc --noEmit",
    "lint:unused": "knip"
  },
  "dependencies": {
    "@decocms/blocks": "workspace:*",
    "@decocms/apps-commerce": "workspace:*",
    "@decocms/tanstack": "workspace:*"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "knip": "^5.86.0",
    "typescript": "^5.9.0"
  },
  "publishConfig": {
    "registry": "https://registry.npmjs.org",
    "access": "public"
  }
}
```

- [ ] **Step 5: Add `packages/apps-vtex/src/registry.ts`** (per the Global Constraints "Registry redesign" note — this package's own single-entry registry, replacing the old `apps-commerce`-hosted array entry for VTEX):

```ts
import type { AppRegistryEntry } from "@decocms/apps-commerce/registry";

export const VTEX_REGISTRY_ENTRY: AppRegistryEntry = {
  blockKey: "deco-vtex",
  module: () => import("./mod"),
  displayName: "VTEX",
  category: "commerce",
  description: "VTEX IO commerce integration",
};
```

Add `"./registry": "./src/registry.ts"` to `package.json`'s `exports` map, and `"@decocms/apps-commerce": "workspace:*"` to `dependencies` if not already present (it should already be there from Step 4's `package.json` content above).

- [ ] **Step 6: Verify**

```bash
bun install
cd packages/apps-vtex && bun run typecheck && bun run test
cd ../.. && bun run typecheck  # whole workspace
```

- [ ] **Step 7: Commit**

```bash
git add packages/apps-vtex packages/tanstack
git commit -m "feat(apps-vtex): migrate vtex/ from apps-start; export createInvokeFn from @decocms/tanstack"
```

---

### Task 8: `@decocms/apps-shopify`

**Files:**
- Create: `packages/apps-shopify/` from `/tmp/apps-start-migrate/shopify/` (36 files: `index.ts`, `mod.ts`, `client.ts`, `loaders/`, `actions/`, `actions/cart/`, `actions/user/`, `utils/`)
- Create: `packages/apps-shopify/package.json`, `packages/apps-shopify/tsconfig.json`

**Interfaces:**
- Consumes: `@decocms/apps-commerce` (types/utils), `@decocms/blocks/cms`, `@decocms/blocks/sdk/*`, `@decocms/tanstack` (`createInvokeFn` — already exported as of Task 7, no further action needed here).

- [ ] **Step 1: Move the files**

```bash
mkdir -p packages/apps-shopify/src
cp -r /tmp/apps-start-migrate/shopify/* packages/apps-shopify/src/
```

- [ ] **Step 2: Rewrite imports**

```bash
node scripts/migrate-apps-import.mjs packages/apps-shopify
grep -rn "@decocms/start" packages/apps-shopify
```

Fix any remaining matches by hand per the Global Constraints mapping table (same categories as Task 7: `apps`, `hooks` barrel, `sdk/createInvoke`).

- [ ] **Step 3: Write `package.json`** (exports map = apps-start's `./shopify/*` entries with the prefix stripped):

```json
{
  "name": "@decocms/apps-shopify",
  "version": "0.0.0",
  "type": "module",
  "description": "Deco commerce app: Shopify integration",
  "repository": {
    "type": "git",
    "url": "https://github.com/decocms/blocks.git",
    "directory": "packages/apps-shopify"
  },
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./mod": "./src/mod.ts",
    "./client": "./src/client.ts",
    "./loaders/*": "./src/loaders/*.ts",
    "./actions/*": "./src/actions/*.ts",
    "./actions/cart/*": "./src/actions/cart/*.ts",
    "./actions/user/*": "./src/actions/user/*.ts",
    "./utils/*": "./src/utils/*.ts"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run --root ../.. packages/apps-shopify/",
    "typecheck": "tsc --noEmit",
    "lint:unused": "knip"
  },
  "dependencies": {
    "@decocms/blocks": "workspace:*",
    "@decocms/apps-commerce": "workspace:*",
    "@decocms/tanstack": "workspace:*"
  },
  "peerDependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "knip": "^5.86.0",
    "typescript": "^5.9.0"
  },
  "publishConfig": { "registry": "https://registry.npmjs.org", "access": "public" }
}
```

- [ ] **Step 4: Add `tsconfig.json`** (copy `packages/blocks-admin/tsconfig.json`, adjust `include` if needed — same shape as every other package)

- [ ] **Step 5: Add `packages/apps-shopify/src/registry.ts`** (per the Global Constraints "Registry redesign" note):

```ts
import type { AppRegistryEntry } from "@decocms/apps-commerce/registry";

export const SHOPIFY_REGISTRY_ENTRY: AppRegistryEntry = {
  blockKey: "deco-shopify",
  module: () => import("./mod"),
  displayName: "Shopify",
  category: "commerce",
  description: "Shopify Storefront API commerce integration",
};
```

Add `"./registry": "./src/registry.ts"` to `package.json`'s `exports` map.

- [ ] **Step 6: Verify**

```bash
bun install
cd packages/apps-shopify && bun run typecheck && bun run test
cd ../.. && bun run typecheck  # whole workspace
```

- [ ] **Step 7: Commit**

```bash
git add packages/apps-shopify
git commit -m "feat(apps-shopify): migrate shopify/ from apps-start"
```

---

### Task 9: `@decocms/apps-magento`

**Files:**
- Create: `packages/apps-magento/` from `/tmp/apps-start-migrate/magento/` (31 files: `index.ts`, `client.ts`, `types.ts`, `middleware.ts`, `loaders/`, `actions/`, `utils/`, `hooks/`)
- Create: `packages/apps-magento/package.json`, `packages/apps-magento/tsconfig.json`

**Interfaces:**
- Consumes: `@decocms/apps-commerce`, `@decocms/blocks/cms`, `@decocms/blocks/sdk/*`, `@decocms/tanstack` (`createInvokeFn`).

- [ ] **Step 1: Move the files**

```bash
mkdir -p packages/apps-magento/src
cp -r /tmp/apps-start-migrate/magento/* packages/apps-magento/src/
```

- [ ] **Step 2: Rewrite imports**

```bash
node scripts/migrate-apps-import.mjs packages/apps-magento
grep -rn "@decocms/start" packages/apps-magento
```

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "@decocms/apps-magento",
  "version": "0.0.0",
  "type": "module",
  "description": "Deco commerce app: Magento integration",
  "repository": { "type": "git", "url": "https://github.com/decocms/blocks.git", "directory": "packages/apps-magento" },
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./client": "./src/client.ts",
    "./types": "./src/types.ts",
    "./middleware": "./src/middleware.ts",
    "./loaders/*": "./src/loaders/*.ts",
    "./actions/*": "./src/actions/*.ts",
    "./utils/*": "./src/utils/*.ts",
    "./hooks/*": "./src/hooks/*.ts"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run --root ../.. packages/apps-magento/",
    "typecheck": "tsc --noEmit",
    "lint:unused": "knip"
  },
  "dependencies": {
    "@decocms/blocks": "workspace:*",
    "@decocms/apps-commerce": "workspace:*",
    "@decocms/tanstack": "workspace:*"
  },
  "peerDependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "knip": "^5.86.0",
    "typescript": "^5.9.0"
  },
  "publishConfig": { "registry": "https://registry.npmjs.org", "access": "public" }
}
```

- [ ] **Step 4: Add `tsconfig.json`** (copy `packages/blocks-admin/tsconfig.json`)

- [ ] **Step 5: Verify**

```bash
bun install
cd packages/apps-magento && bun run typecheck && bun run test
cd ../.. && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/apps-magento
git commit -m "feat(apps-magento): migrate magento/ from apps-start"
```

---

### Task 10: `@decocms/apps-algolia`

**Files:**
- Create: `packages/apps-algolia/` from `/tmp/apps-start-migrate/algolia/` (5 files: `index.ts`, `client.ts`, `types.ts`, `loaders/`)
- Create: `packages/apps-algolia/package.json`, `packages/apps-algolia/tsconfig.json`

**Interfaces:**
- Consumes: `@decocms/apps-commerce`, `@decocms/blocks/cms`, `@decocms/blocks/sdk/*`. Note the optional `algoliasearch` peer dependency from apps-start's `package.json` (`peerDependenciesMeta: { algoliasearch: { optional: true } }`) — carry that forward.

- [ ] **Step 1: Move the files**

```bash
mkdir -p packages/apps-algolia/src
cp -r /tmp/apps-start-migrate/algolia/* packages/apps-algolia/src/
```

- [ ] **Step 2: Rewrite imports**

```bash
node scripts/migrate-apps-import.mjs packages/apps-algolia
grep -rn "@decocms/start" packages/apps-algolia
```

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "@decocms/apps-algolia",
  "version": "0.0.0",
  "type": "module",
  "description": "Deco commerce app: Algolia search integration",
  "repository": { "type": "git", "url": "https://github.com/decocms/blocks.git", "directory": "packages/apps-algolia" },
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./client": "./src/client.ts",
    "./types": "./src/types.ts",
    "./loaders/*": "./src/loaders/*.ts"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run --root ../.. packages/apps-algolia/",
    "typecheck": "tsc --noEmit",
    "lint:unused": "knip"
  },
  "dependencies": {
    "@decocms/blocks": "workspace:*",
    "@decocms/apps-commerce": "workspace:*"
  },
  "peerDependencies": { "react": "^19.0.0", "react-dom": "^19.0.0", "algoliasearch": "^5" },
  "peerDependenciesMeta": { "algoliasearch": { "optional": true } },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "algoliasearch": "^5.53.0",
    "knip": "^5.86.0",
    "typescript": "^5.9.0"
  },
  "publishConfig": { "registry": "https://registry.npmjs.org", "access": "public" }
}
```

- [ ] **Step 4: Add `tsconfig.json`** (copy `packages/blocks-admin/tsconfig.json`)

- [ ] **Step 5: Verify**

```bash
bun install
cd packages/apps-algolia && bun run typecheck && bun run test
cd ../.. && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/apps-algolia
git commit -m "feat(apps-algolia): migrate algolia/ from apps-start"
```

---

### Task 11: `@decocms/apps-salesforce`

**Files:**
- Create: `packages/apps-salesforce/` from `/tmp/apps-start-migrate/salesforce/` (11 files: `index.ts`, `types.ts`, `utils/`, `loaders/products/`)
- Create: `packages/apps-salesforce/package.json`, `packages/apps-salesforce/tsconfig.json`

**Interfaces:**
- Consumes: `@decocms/apps-commerce`, `@decocms/blocks/cms`, `@decocms/blocks/sdk/*`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p packages/apps-salesforce/src
cp -r /tmp/apps-start-migrate/salesforce/* packages/apps-salesforce/src/
```

- [ ] **Step 2: Rewrite imports**

```bash
node scripts/migrate-apps-import.mjs packages/apps-salesforce
grep -rn "@decocms/start" packages/apps-salesforce
```

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "@decocms/apps-salesforce",
  "version": "0.0.0",
  "type": "module",
  "description": "Deco commerce app: Salesforce Commerce Cloud integration",
  "repository": { "type": "git", "url": "https://github.com/decocms/blocks.git", "directory": "packages/apps-salesforce" },
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/types.ts",
    "./utils/*": "./src/utils/*.ts",
    "./loaders/products/*": "./src/loaders/products/*.ts"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run --root ../.. packages/apps-salesforce/",
    "typecheck": "tsc --noEmit",
    "lint:unused": "knip"
  },
  "dependencies": {
    "@decocms/blocks": "workspace:*",
    "@decocms/apps-commerce": "workspace:*"
  },
  "peerDependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "knip": "^5.86.0",
    "typescript": "^5.9.0"
  },
  "publishConfig": { "registry": "https://registry.npmjs.org", "access": "public" }
}
```

- [ ] **Step 4: Add `tsconfig.json`** (copy `packages/blocks-admin/tsconfig.json`)

- [ ] **Step 5: Verify**

```bash
bun install
cd packages/apps-salesforce && bun run typecheck && bun run test
cd ../.. && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/apps-salesforce
git commit -m "feat(apps-salesforce): migrate salesforce/ from apps-start"
```

---

### Task 12: `@decocms/apps-resend`

**Files:**
- Create: `packages/apps-resend/` from `/tmp/apps-start-migrate/resend/` (7 files: `index.ts`, `mod.ts`, `client.ts`, `types.ts`, `actions/send.ts`)
- Create: `packages/apps-resend/package.json`, `packages/apps-resend/tsconfig.json`

**Interfaces:**
- Consumes: `@decocms/blocks/cms`, `@decocms/blocks/sdk/*`. Does not need `@decocms/apps-commerce` — email sending has no commerce-type dependency (confirmed by apps-start's own `package.json`: `resend/*` exports don't touch `commerce/*`).

- [ ] **Step 1: Move the files**

```bash
mkdir -p packages/apps-resend/src
cp -r /tmp/apps-start-migrate/resend/* packages/apps-resend/src/
```

- [ ] **Step 2: Rewrite imports**

```bash
node scripts/migrate-apps-import.mjs packages/apps-resend
grep -rn "@decocms/start" packages/apps-resend
```

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "@decocms/apps-resend",
  "version": "0.0.0",
  "type": "module",
  "description": "Deco app: Resend transactional email integration",
  "repository": { "type": "git", "url": "https://github.com/decocms/blocks.git", "directory": "packages/apps-resend" },
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./mod": "./src/mod.ts",
    "./client": "./src/client.ts",
    "./types": "./src/types.ts",
    "./actions/send": "./src/actions/send.ts"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run --root ../.. packages/apps-resend/",
    "typecheck": "tsc --noEmit",
    "lint:unused": "knip"
  },
  "dependencies": {
    "@decocms/blocks": "workspace:*",
    "@decocms/apps-commerce": "workspace:*"
  },
  "peerDependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "knip": "^5.86.0",
    "typescript": "^5.9.0"
  },
  "publishConfig": { "registry": "https://registry.npmjs.org", "access": "public" }
}
```

Note: `@decocms/apps-commerce` is added here solely for the `AppRegistryEntry` **type** import in Step 5 below (type-only, erased at compile time — does not pull `apps-commerce`'s runtime code into this package's bundle) — not because resend has any actual commerce-type dependency, which it still doesn't.

- [ ] **Step 4: Add `tsconfig.json`** (copy `packages/blocks-admin/tsconfig.json`)

- [ ] **Step 5: Add `packages/apps-resend/src/registry.ts`** (per the Global Constraints "Registry redesign" note):

```ts
import type { AppRegistryEntry } from "@decocms/apps-commerce/registry";

export const RESEND_REGISTRY_ENTRY: AppRegistryEntry = {
  blockKey: "deco-resend",
  module: () => import("./mod"),
  displayName: "Resend",
  category: "email",
  description: "Transactional email via Resend",
};
```

Add `"./registry": "./src/registry.ts"` to `package.json`'s `exports` map.

- [ ] **Step 6: Verify**

```bash
bun install
cd packages/apps-resend && bun run typecheck && bun run test
cd ../.. && bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/apps-resend
git commit -m "feat(apps-resend): migrate resend/ from apps-start"
```

---

### Task 13: `@decocms/apps-blog`

**Files:**
- Create: `packages/apps-blog/` from `/tmp/apps-start-migrate/blog/` (19 files: `index.ts`, `mod.ts`, `types.ts`, `commerceLoaders.ts`, `loaders/`, `core/`)
- Create: `packages/apps-blog/package.json`, `packages/apps-blog/tsconfig.json`

**Interfaces:**
- Consumes: `@decocms/apps-commerce`, `@decocms/blocks/cms`, `@decocms/blocks/sdk/*`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p packages/apps-blog/src
cp -r /tmp/apps-start-migrate/blog/* packages/apps-blog/src/
```

- [ ] **Step 2: Rewrite imports**

```bash
node scripts/migrate-apps-import.mjs packages/apps-blog
grep -rn "@decocms/start" packages/apps-blog
```

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "@decocms/apps-blog",
  "version": "0.0.0",
  "type": "module",
  "description": "Deco app: blog content and CMS integration",
  "repository": { "type": "git", "url": "https://github.com/decocms/blocks.git", "directory": "packages/apps-blog" },
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./mod": "./src/mod.ts",
    "./types": "./src/types.ts",
    "./commerceLoaders": "./src/commerceLoaders.ts",
    "./loaders/*": "./src/loaders/*.ts",
    "./core/*": "./src/core/*.ts"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run --root ../.. packages/apps-blog/",
    "typecheck": "tsc --noEmit",
    "lint:unused": "knip"
  },
  "dependencies": {
    "@decocms/blocks": "workspace:*",
    "@decocms/apps-commerce": "workspace:*"
  },
  "peerDependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "knip": "^5.86.0",
    "typescript": "^5.9.0"
  },
  "publishConfig": { "registry": "https://registry.npmjs.org", "access": "public" }
}
```

- [ ] **Step 4: Add `tsconfig.json`** (copy `packages/blocks-admin/tsconfig.json`)

- [ ] **Step 5: Add `packages/apps-blog/src/registry.ts`** (per the Global Constraints "Registry redesign" note):

```ts
import type { AppRegistryEntry } from "@decocms/apps-commerce/registry";

export const BLOG_REGISTRY_ENTRY: AppRegistryEntry = {
  blockKey: "deco-blog",
  module: () => import("./mod"),
  displayName: "Blog",
  category: "content",
  description: "Blog posts, categories, and authors from CMS collections",
};
```

Add `"./registry": "./src/registry.ts"` to `package.json`'s `exports` map.

- [ ] **Step 6: Verify**

```bash
bun install
cd packages/apps-blog && bun run typecheck && bun run test
cd ../.. && bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/apps-blog
git commit -m "feat(apps-blog): migrate blog/ from apps-start"
```

---

### Task 14: End-to-end verification against `faststore-fila`

**Files:**
- Modify: `~/code/faststore-fila/package.json` (add `@decocms/apps-vtex` as a real dependency, `link:` to the local monorepo checkout for pre-publish verification — same pattern used before the original 5 packages' first npm publish)
- No other faststore-fila changes expected — this is a smoke test, not a migration (faststore-fila doesn't currently use `@decocms/apps` at all; if it needs to for this test, wire the minimum viable VTEX loader call to prove data flows, don't build out a full feature)

**Interfaces:**
- Consumes: `@decocms/apps-vtex` end-to-end, exercising real VTEX API calls through the newly-migrated code path.

- [ ] **Step 1: Whole-workspace verification in deco-start first**

```bash
cd ~/code/deco-start
bun install
bun run typecheck   # all 14 packages
bun run test         # all 14 packages, including apps-start's migrated Vitest suites
```

- [ ] **Step 2: Link into faststore-fila and exercise a real VTEX call**

```bash
cd ~/code/faststore-fila
# Add "@decocms/apps-vtex": "link:@decocms/apps-vtex" to package.json, bun install
# Write/run a minimal script (or reuse an existing VTEX loader call site if
# one already exists in this repo) that calls a real @decocms/apps-vtex
# loader against the site's actual configured VTEX account, confirms real
# product/category data comes back — not just that the import resolves.
```

- [ ] **Step 3: Report findings**

Document (in a commit message or a short note, not necessarily a new doc) whether the real VTEX call succeeded, and any gaps found that Tasks 1-13 didn't anticipate — this is exactly the kind of thing that surfaced 3 real bugs (`node:async_hooks`, `@opentelemetry/semantic-conventions`, the circular `sdk/otel.ts` import) during the original 5-package migration, purely by actually running the code against a real site instead of trusting typecheck alone.

- [ ] **Step 4: Remove the `link:` dependency** once verified (real npm publish happens after this plan executes and Trusted Publisher entries are configured on npmjs.com for all 9 new packages — a manual step, flagged here, not part of this plan's automatable scope).

---

### Task 15: Deprecation notice on the old `apps-start` repo

**Files:**
- Modify: `apps-start` repo's `README.md` (separate repo, `git@github.com:decocms/apps-start.git` — not part of `decocms/blocks`, requires its own clone/PR)

**Interfaces:** None — documentation only, no code change.

- [ ] **Step 1: Confirm Task 14 passed** — do not deprecate the old repo until the new packages are actually verified working end-to-end. This task is explicitly last for that reason.

- [ ] **Step 2: Clone and edit**

```bash
git clone git@github.com:decocms/apps-start.git /tmp/apps-start-deprecate
cd /tmp/apps-start-deprecate
git checkout -b docs/deprecation-notice
```

Add a notice at the very top of `README.md` (above the existing first heading):

```md
> **This repo is no longer actively developed.** `@decocms/apps` has moved into
> the `decocms/blocks` monorepo, split by platform: `@decocms/apps-vtex`,
> `@decocms/apps-shopify`, `@decocms/apps-magento`, `@decocms/apps-algolia`,
> `@decocms/apps-salesforce`, `@decocms/apps-resend`, `@decocms/apps-blog`,
> `@decocms/apps-website`, `@decocms/apps-commerce`. New sites should depend
> on those instead. The `@decocms/apps` package on npm keeps working for
> existing consumers — it is not unpublished or deprecated on npm, only this
> repo's active development has stopped. See
> https://github.com/decocms/blocks/blob/v7/docs/apps-monorepo-migration-design.md
> for the full rationale.

```

- [ ] **Step 3: Open a PR, do not merge without human review** — this is a real, visible change to a repo other engineers may be actively looking at; unlike the code migration tasks, this isn't something to auto-merge even under subagent-driven execution.

---

## Manual step required before real publish (not part of this plan's task list)

Before Task 14's `link:`-based verification can become a real npm dependency in any site, someone with npmjs.com access needs to configure a Trusted Publisher entry (repo: `decocms/blocks`, workflow: `.github/workflows/release.yml`) for each of the 9 new packages — same one-time setup done for the original 5. Flagging explicitly so it isn't forgotten once the code-side work is done.
