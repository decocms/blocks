# CLAUDE.md

Guidance for AI assistants working in this repo.

## Project Overview

This is **blocks** (repo `decocms/blocks`): a Bun workspace monorepo for the framework layer of [deco.cx](https://deco.cx) sites. This line (`main`) is the **next major (v8)**: one package, `@decocms/blocks`, plus thin upstream clients, `@decocms/apps-*`. The spec is the docs site's `/next/*` pages; when the code and the docs disagree, the docs win.

**v7 lives on the `7.x` branch.** `@decocms/tanstack`, `@decocms/nextjs`, `@decocms/blocks-admin`, `@decocms/blocks-cli`, `@decocms/apps-commerce`, `@decocms/apps-blog`, `@decocms/apps-website` and v7's `@decocms/blocks` modules (`/cms`, `/sdk/*`, `/hooks`, `/setup`, …) are maintained and released there, not here. Don't reintroduce them on this line.

History worth knowing: the framework used to be a single tsup-bundled package, `@decocms/start`, reverted at v5.2.2 because bundling created two module instances of what must be one singleton (the CMS registry). Here no bundler is in the loop: each package is compiled file-for-file by `tsc` (see "How packages build" below), so module boundaries, and the singletons that live in them, are exactly the source's.

## Tech Stack

- Package manager / workspace / test runner: Bun + Vitest (one root `vitest.config.ts`)
- Runtime targets: any (Cloudflare Workers, Node, Bun, browsers for the client-safe parts); `@decocms/blocks` has no framework binding
- React 19: the root runtime uses React types only; `/analytics` uses `createElement` (react is a required peer)
- Lint/format: Biome; unused code: knip (run once from the root over all workspaces)

## Common Commands

```bash
bun install           # also builds every package's dist/ (root `prepare` script)
bun run build         # tsc (TypeScript 7) -> dist/, per package, blocks first
bun run test          # vitest, whole repo: packages, tests/, the migration skill's scripts
bun run typecheck     # tsc --noEmit per package, plus the skill scripts and tests/
bun run examples      # build the packages and the three examples, then typecheck them
bun run check         # typecheck + lint + lint:unused
```

No dev server at the root. `examples/tanstack-smoke`, `examples/tanstack-rsc-smoke` and `examples/nextjs-smoke` are real consumers that depend only on `@decocms/blocks` (`cd examples/<name> && bun run dev`).

## Architecture: one package and thin clients

```
packages/
├── blocks/                     @decocms/blocks — runtime (createCMS, matchRoute, loaders, built-in blocks),
│                               the deco CLI (/cli, bin `deco`) and the content protocol (/protocol/*)
├── apps-vtex/                  @decocms/apps-vtex                 ┐
├── apps-shopify/               @decocms/apps-shopify              │
├── apps-wake/                  @decocms/apps-wake                 │ thin upstream clients built on
├── apps-magento/               @decocms/apps-magento              │ createInstrumentedFetch;
├── apps-algolia/               @decocms/apps-algolia              │ depend only on @decocms/blocks
├── apps-resend/                @decocms/apps-resend               │
└── apps-sfmc-personalization/  @decocms/apps-sfmc-personalization ┘
tests/                          cross-package tests (upstream-client guardrail and conformance)
examples/                       tanstack-smoke, tanstack-rsc-smoke, nextjs-smoke
.agents/skills/
├── deco-v7-to-v8-migration/    the v7 → v8 site migration (SKILL.md, reference/, runnable scripts/)
└── …                           v7 skills; they target v7 sites and the 7.x branch
.cursor/skills/                 framework-agnostic ops skills (site deployment, CDN performance audit, incident report)
docs/runbooks/                  alert runbooks; the provisioned alerts' runbook_url links here, so keep the paths stable
```

v7-only design docs, plans and Cursor skills live on the `7.x` branch. The docs for users are the docs site (`/next/*`), not this repo.

Nothing else is published from this line: the release allowlist in `.releaserc.json` is `blocks` plus the seven `apps-*`.

### How packages build (per-file `tsc`, no bundler)

Every package publishes compiled JavaScript so plain Node (scripts, Playwright, Node servers, Next without `transpilePackages`) can import it; npm never ships only `.ts`. The build is `tsc -p tsconfig.build.json` (via `scripts/tsc.mjs`, which runs the TypeScript 7 native compiler from the root `typescript7` alias): `rootDir: src`, `outDir: dist`, `module`/`moduleResolution: NodeNext`, `declaration` + declaration and source maps, tests and fixtures excluded. Each `src/**/*.ts(x)` becomes exactly one `dist/**/*.js` (+ `.d.ts`), with its imports left as imports.

- **Why no bundler**: a bundle inlines modules, so a package that bundles another (or a bundle loaded next to the unbundled copy) carries a second instance of module state — the `@decocms/start` registry bug. With per-file output there is one `dist/x.js` per `src/x.ts` and every importer gets that one module, as with the source; cross-package imports stay package imports (`@decocms/blocks`), never inlined. Don't add tsup/esbuild/rollup to a package build.
- **Relative imports carry the `.ts` extension** (`from "./run.ts"`, `from "./server/index.ts"`, never extensionless or a bare directory) and `rewriteRelativeImportExtensions` turns them into `.js` in the output; the build's `NodeNext` resolution rejects a specifier Node couldn't resolve. Test files may stay extensionless (they're never emitted).
- **Exports maps**: every subpath is `{ "types": "./dist/….d.ts", "source": "./src/….ts", "default": "./dist/….js" }`; conditional subpaths nest that object under each branch (`/protocol/storage/fs`: `node` before `default`). `files` ships `dist` and `src` (minus tests) so the `source` condition and the declaration maps resolve. Add a subpath to both `src` and the map in that shape (`sdk.test.ts`/`run.test.ts` check it).
- **The `source` condition** lets in-repo tools use `.ts` without a build: `tsconfig.base.json` (`customConditions`) for type-checks and `vitest.config.ts` (`resolve.conditions`) for tests, so a test importing a file by path and one importing `@decocms/blocks` share one module. A consumer that opts into `source` must do so for every environment it builds; mixing `source` and dist in one process loads both copies.
- **The bin runs dist**: `bin/deco.js` imports `dist/v8/cli/main.js` (no tsx). `tests/globalSetup.ts` rebuilds blocks' dist before the suite because the CLI conformance tests spawn the bin.
- **Two TypeScripts**: builds and type-checks use TypeScript 7 (`typescript7`, npm alias of `typescript@7`); the plain `typescript` name stays on 5.x because TypeScript 7 has no JavaScript compiler API, and `deco schema` loads the app's `typescript` peer through that API (as do Next's type-check and a few conformance tests).
- **Release**: `.releaserc.json`'s `prepareCmd` runs `bun run build` after the version sync, and each package's `prepack` rebuilds, so `npm publish` never ships a stale or missing dist. CI (`.github/workflows/ci.yml`) type-checks, builds and imports every built export with plain Node.

### `@decocms/blocks` exports

Each export is built from the source file below (`dist/<same path>.js`, see above).

| Import path | File |
|---|---|
| `@decocms/blocks` | `src/index.ts` — the v8 runtime API only (`createCMS`, `matchRoute`, `remoteLoader`, `draftPointer`, `Blocks`, `Lazy`, …), re-exported from `src/v8/index.ts` as one explicit `export { … } from "./v8/index.ts"` block (a conformance test parses that form) |
| `@decocms/blocks/analytics` | `src/v8/analytics.ts` — `AnalyticsScript`, `track` |
| `@decocms/blocks/fetch` | `src/v8/fetch.ts` — `createInstrumentedFetch` |
| `@decocms/blocks/secrets` | `src/v8/secrets.ts` |
| `@decocms/blocks/cli` | `src/v8/cli/index.ts` — the `deco` CLI (`schema`, `content`, `check`, `serve`), also the bin (`bin/deco.js`, which runs the compiled `dist/v8/cli/main.js` under Node or Bun). CLI-only: the runtime never imports it (`run.test.ts`), so it and the TypeScript compiler never reach an app bundle |
| `@decocms/blocks/protocol` (+ `/keys`, `/server`, `/storage/fs`, `/conformance`) | `src/protocol/**` — the content protocol the site editor uses; browser-safe except `storage/fs` (conditional export: `node` → real, `default` → a stub that throws) |

### Key boundaries

- **The runtime never imports the protocol or the CLI.** `src/v8` modules import only each other (no Node built-ins, no React at runtime except `/analytics`); `src/v8/browserBundle.test.ts` proves it with a real esbuild bundle. The CLI may import the protocol.
- **Clients depend only on `@decocms/blocks`**, with no peers and no framework binding. A client takes settings as arguments (no env reads), never caches, has no hooks, converters or `"use client"` code: those belong in the site's platform template (`tests/upstream-clients.conformance.test.ts`).
- **Cross-package imports are package imports**: type-checks resolve them to `.ts` source through the `source` condition; the build resolves them to the dependency's built `dist/*.d.ts`, which is why `bun run build` builds blocks before the clients. No `tsconfig.json` `references` anywhere: adding them back reintroduces a TS6305 build-ordering bug.
- **No compat layers.** If a site needs something a package should export, add the export; don't let sites (or this repo) re-create v7 APIs as shims.

## v8 core — `packages/blocks/src/v8/`

- **`createCMS` instances are `globalThis` singletons** under `Symbol.for("decocms.blocks.cms:<content identity>[|site|token-hash]")`, so two copies of the package share one content cache (`dualInstance.test.ts`, the regression test for the bug this repo exists to prevent). Never key on the revision, and never put a raw token in a symbol.
- **`lazy` is the resolver's only special case**; everything else is an ordinary block function. Values from the snapshot are copied while walked, so callers and block functions can't mutate shared content.
- **No framework binding, no request scope.** Platform specifics (a Workers KV `Loader`, a Cache API upstream cache passed as `createInstrumentedFetch`'s `fetch`) are template code shown as docs recipes, not package exports. Block functions read the request through the framework's own storage; don't add `requestScope()`, `Deferred`, `BlockList` or other non-CMS helpers to the core.
- **Conformance tests** (`src/v8/__conformance__/`) encode the docs' claims, one test per claim. When the docs change, change the test; don't relax an assertion to make code pass.

## Upstream observability

Every client builds its requests with `createInstrumentedFetch({ provider: "<name>" })` from `@decocms/blocks/fetch`, which measures each request once (`http.client.request.duration` with `provider`/`operation`/`status_class`/`cached`/`retries` labels) and reports to the CMS's telemetry in the same process. Nothing has to be wired at boot: the instrumented fetch is the only way a client reaches the network. An upstream cache is the site's own `fetch` passed as the `fetch` option; a response it serves carries `x-cache: HIT` and is measured with `cached=true`.

`tests/upstream-clients.guardrail.test.ts` checks that every `packages/apps-*` is listed and that its client imports `createInstrumentedFetch` from `@decocms/blocks/fetch` under its provider name and never calls `fetch` directly; Biome denies the bare `fetch` global in `packages/apps-*/src` too. A new client package goes in that test's `CLIENTS`.

## Migration skills

1. **`deco-v7-to-v8-migration`** (this line) — moves a v7 site onto v8: `scripts/main.ts` (run with `bun` or `npx tsx`) writes the block map with legacy aliases, vendors the app loaders the content calls, moves content to `.deco/blocks`, re-encrypts secrets and reports every v7 import with its replacement; `reference/` holds the import map, legacy-name table, gotchas and approved parity patterns. Its tests run with `bun run test`; it imports `@decocms/blocks` (`/cli`, `/protocol/keys`, `/secrets`), so keep those exports stable.
2. **v7 skills** — `deco-to-tanstack-migration`, `deco-migrate-script`, `deco-next-package-migration`, `decocms-v6-to-v7-upgrade`, `deco-reconcile-snapshot`, `vtex-cart-v2`, and `.claude/skills/run-migration`: they target v7 sites and reference code that lives on the `7.x` branch (e.g. `packages/blocks-cli`). They are governed by the migration tooling policy (`.cursor/rules/migration-tooling-policy.mdc`, `MIGRATION_TOOLING_PLAN.md`), which applies to the v7 tooling on 7.x.

## Important constraints

1. **No compat layers** in a package or a migrated site (see Key boundaries).
2. **One instance per process**: anything that must be a singleton lives on `globalThis` under a `Symbol.for` key; packages never bundle each other.
3. **Base64**: `toBase64()` in `src/v8/cli/schema/typeToSchema.ts` must produce padded output matching `btoa()`; the site editor uses `btoa()` for schema definition refs.
4. **Dependency direction**: runtime ← CLI/protocol, and `apps-*` → `@decocms/blocks` only. Enforced by tests (`guides.cli.test.ts` in-11, `sdk.test.ts`) and review.
5. **Upstream observability**: a new client MUST build on `createInstrumentedFetch` and be listed in the guardrail test.
6. **Tests that guard production bugs** (e.g. `dualInstance.test.ts`): if one fails, fix the code, not the assertion.
