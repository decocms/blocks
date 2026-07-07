# Merging `@decocms/apps` into the `decocms/blocks` Monorepo — Design

> Design only. No implementation yet — this doc captures the decisions made in the 2026-07-07 design session so a later planning pass has a stable spec to work from.

## Motivation

`@decocms/apps` (published from a separate repo, `decocms/apps-start`) provides commerce-platform integrations (VTEX, Shopify, Magento, Algolia, Salesforce) and generic site utilities (SEO, analytics, matchers, flags) that every deco storefront depends on. It has its own independent release cadence and has not been republished against the new split packages (`@decocms/blocks`, `@decocms/blocks-admin`, `@decocms/blocks-cli`, `@decocms/tanstack`, `@decocms/nextjs`) — it still internally imports the old, pre-split `@decocms/start` package's subpath surface.

This has caused the same problem three times in one day: `casaevideo-tanstack`, `baggagio-tanstack`, and `lebiscuit-tanstack` all need `@decocms/apps` migrated onto the split packages, but since `@decocms/apps` itself hasn't moved, every site has to hand-roll a local compatibility shim (`vendor/decocms-start-compat/`) that intercepts `@decocms/apps`'s old-package imports and forwards them to the new ones. That's real, repeated, throwaway work per site.

Moving `@decocms/apps` into the `decocms/blocks` monorepo — split by platform, released in the same lockstep version train as `blocks`/`blocks-admin`/`blocks-cli`/`tanstack`/`nextjs` — eliminates the shim entirely: `@decocms/apps-vtex` (etc.) would import `@decocms/blocks/cms` directly, verified against the real thing in the same CI run that builds `@decocms/blocks`, at the same version, every time.

## Package taxonomy

Three prefixes, three distinct meanings — deliberately not unified under one prefix:

- **`@decocms/blocks-*`** — the CMS framework itself. Things that are structural extensions of block/CMS resolution: `@decocms/blocks` (core), `@decocms/blocks-admin` (admin protocol routes), `@decocms/blocks-cli` (codegen).
- **`@decocms/apps-*`** — platform/commerce integrations. Things a site *installs* to talk to a specific backend or get optional functionality: VTEX, Shopify, Magento, Algolia, Salesforce, Resend, Blog, Website, generic Commerce types.
- **`@decocms/nextjs`, `@decocms/tanstack`** — React metaframework bindings. Unprefixed, standalone names (already established, unchanged by this design).

Explicitly rejected: naming the new packages `@decocms/blocks-vtex` etc. Commerce integrations aren't extensions of block resolution — conflating the two prefixes would blur a real architectural distinction for the sake of surface consistency.

## New packages

Split by platform/concern, migrated from `apps-start`'s current directory structure (file counts as of 2026-07-07):

| New package | Concern | Size |
|---|---|---|
| `@decocms/apps-vtex` | VTEX commerce integration | 105 files |
| `@decocms/apps-website` | Generic site app: SEO/Analytics sections, Theme/Video components, matchers *(reduced — see below)*, flags moved out, loaders (env/secret/fonts) | 51 files, shrinking |
| `@decocms/apps-shopify` | Shopify integration | 36 files |
| `@decocms/apps-magento` | Magento integration | 31 files |
| `@decocms/apps-commerce` | Shared commerce types/utils (UI components removed — see below) | 23 files, shrinking |
| `@decocms/apps-blog` | Blog content | 19 files |
| `@decocms/apps-salesforce` | Salesforce integration | 11 files |
| `@decocms/apps-resend` | Email (Resend) | 7 files |
| `@decocms/apps-algolia` | Algolia search | 5 files |

All 9 migrate in one pass (not phased by usage) — most of the work is mechanical file relocation + import rewriting, not new logic, so there's little marginal cost to doing the platforms with no current in-house consumer (Shopify, Magento, Algolia, Salesforce) alongside VTEX.

**Dependency rule** (extends the existing one-way graph already documented in `CLAUDE.md`): every `apps-*` package may depend on `@decocms/blocks` / `@decocms/blocks-admin` / `@decocms/tanstack`, never the reverse. `apps-*` packages do not depend on each other.

## Content redistribution (not a straight file move)

Investigating `apps-website` during design surfaced real, pre-existing duplication worth cleaning up as part of this move, not carrying forward:

1. **UI components** (`JsonLd`, `Image`, `Picture`, currently exported from `apps-start`'s `commerce/components/`) move into `@decocms/blocks` (exact subpath — `blocks/hooks` vs. a new `blocks/commerce` — to be resolved during planning). They're generic commerce-page primitives, not platform-specific, and `CLAUDE.md` already documents "`@decocms/apps` must NOT contain UI components" as a boundary rule this repo apparently drifted past. This move makes the rule true again instead of quietly ignoring it a second time.

2. **Matchers**: `apps-website/matchers/*` (15 files: `always`, `cookie`, `cron`, `date`, `device`, `environment`, `host`, `location`, `multi`, `negate`, `pathname`, `queryString`, `random`, `site`, `userAgent`) mostly duplicate matcher logic **already ported into `@decocms/blocks`** during an earlier split — 4 handled inline in `cms/resolve.ts` (`always`, `never`, `device`, `random`), 9 more in `matchers/builtins.ts` (`cookie`, `cron`, `host`, `pathname`, `queryString`, `location`, `userAgent`, `environment`, `multi`, `negate` — that file's own doc comment says "matching deco-cx/apps website/matchers/*"). Only `date` and `site` are missing from `@decocms/blocks`.
   - **Action**: delete the 13 duplicate files from what becomes `apps-website`; port `date` and `site` into `packages/blocks/src/matchers/builtins.ts` to close the real gap.
3. **Flags** (`audience`, `everyone`, `multivariate`) are matcher-adjacent — same "how does a block vary per visitor" resolution mechanism as matchers, not really an optional installable app the way VTEX or Analytics tracking is.
   - **Action**: move into `@decocms/blocks` (new `blocks/flags` subpath, mirroring `blocks/matchers`), not into `apps-website`.
4. **Sections (Seo, Analytics), components (Theme, Video, OneDollarStats), loaders (environment/secret/fonts)** stay in `apps-website` — genuinely optional, composable CMS content a site chooses to install, not core resolution mechanism.

## Migration mechanics

1. `git mv` each `apps-start` concern directory into `packages/apps-<name>/src/` (or equivalent), preserving file history isn't a hard requirement — match the precedent set by the `runtime`→`live`→`blocks` renames this session, which used clean copies over history-preserving merges.
2. Scripted import-rewrite pass across all 9 new packages: every `@decocms/start/*` reference → the correct new package, using the same mapping already proven working in `casaevideo-tanstack`'s migration (`@decocms/start/cms` → `@decocms/blocks/cms` or `@decocms/blocks/cms/client` depending on client/server boundary; `@decocms/start/sdk/*` → `@decocms/blocks/sdk/*`; etc. — see `.agents/skills/deco-next-package-migration/references/import-mapping.md` and `casaevideo-tanstack`'s actual migration commit for the concrete, verified mapping).
3. Each new package gets its own `package.json` (`exports` map, `repository` field — required for npm provenance verification, learned that the hard way during the original 5-package publish), test config, etc., matching the pattern of the existing 5 packages.
4. `apps-start`'s own Vitest test suite moves with its files and should keep passing with import paths updated.

## Release integration

All 9 new packages join the existing `sync-versions.mjs` lockstep — one version number across all packages, released together via the existing `v7` OIDC-based release pipeline on every push. This is the whole point: `@decocms/apps-vtex@7.2.0` and `@decocms/blocks@7.2.0` are built, tested, and published in the same CI run, so they can never drift out of compatibility again.

Each new package needs, before its first real publish: an `exports` map, a `repository` field, and a trusted-publisher entry configured on npmjs.com (same OIDC setup as the original 5 — no stored token).

This does give up `apps-start`'s current two-channel `main`/`next` prerelease model (opt-in validation for risky commerce-integration changes before they hit every consumer). Explicitly accepted as a tradeoff for lockstep consistency, per this session's direction — flagged here in case it becomes a problem in practice and is worth revisiting.

## Fate of `apps-start` (the old repo)

Not deleted. Once the new `apps-*` packages are live and verified against at least one real site, `apps-start`'s `README.md` gets a deprecation notice pointing at the new packages. The old `@decocms/apps` npm package keeps being available (not unpublished) for any site that hasn't migrated yet. No further active development happens there — new work goes into `decocms/blocks`.

## Verification plan

Same bar as every package split so far this session: `bun install`, full typecheck, full test suite (the migrated Vitest tests), then a real site wired against the new packages to confirm actual functionality — not just that it compiles. `faststore-fila` is the natural first target (local, already on the split packages, real VTEX credentials already configured) to prove `apps-vtex` end-to-end before touching any other site.

## Explicitly deferred

`baggagio-tanstack` and `lebiscuit-tanstack`'s migrations off legacy `@decocms/start` were paused mid-flight when this design work started (both repos reverted cleanly to their pre-migration state — nothing committed). They resume **after** `@decocms/apps-vtex` exists, migrating directly onto it — skipping the compat-shim step entirely, since the whole point of this design is to make that shim unnecessary going forward.
