# Framework-agnostic entrypoints for `@decocms/start`

**Status:** Draft
**Date:** 2026-05-10
**Author:** tlgimenes (with Claude)
**Tracking issue:** [decocms/deco-start#163](https://github.com/decocms/deco-start/issues/163)

## Problem

`@decocms/start` ships raw TypeScript source — every `package.json` export points at a `./src/**/*.ts` file. Vite's dev server transpiles these transparently; webpack (Next.js, CRA, Rspack-with-default-config) does not, and rejects the package's first line:

```
./node_modules/@decocms/start/src/cms/index.ts
Module parse failed: Unexpected token (1:7)
> export type { DecoPage, Resolvable } from "./loader";
```

A `transpilePackages: ['@decocms/start']` workaround in `next.config.js` resolves the parse error, but a second, deeper blocker surfaces: the package's primary loader (`loadCmsPage`) is a TanStack Start `createServerFn` whose handler depends on `getRequestUrl()` / `getCookies()` / `getRequestHeader()` from `@tanstack/react-start/server`. These primitives read from a TanStack-managed `AsyncLocalStorage` request context that Next.js never populates. The function throws immediately.

A third leak: importing anything from `@decocms/start/cms` into a Next page module pulls `cms/loader.ts` into the client bundle, which transitively imports `node:async_hooks`. Webpack rejects the `node:` scheme:

```
Module build failed: UnhandledSchemeError: Reading from "node:async_hooks" is not handled by plugins
```

The package is currently unusable from any non-Vite host.

## Goals

1. Webpack/Next.js consumers can `import { resolveDecoPage, registerSectionsSync, loadCmsPage } from "@decocms/start/..."` without `transpilePackages` workarounds, custom loaders, or stub configurations.
2. Existing TanStack Start consumers (the current 5.x storefronts) see no behavioral change and no required code changes.
3. The boundaries between framework-agnostic code and framework-coupled code are explicit, enforced by tooling, and impossible to silently re-tangle.
4. A first-party Next.js (App Router) adapter exists, exercises the boundary, and validates that the framework-agnostic core is genuinely framework-agnostic.

## Non-goals

- A separate `@decocms/core` npm package. One package, multiple entrypoints.
- Next.js Pages Router support. App Router only.
- Remix / SvelteKit / other adapters. The boundary makes them possible; we don't write them.
- Replacing the existing Vite plugin or its `node:async_hooks` client stubs.

## Design

### Three import tiers in one package

```
@decocms/start
├── /core      ← framework-agnostic. CMS resolution, registry, blocks, matchers,
│                 schema, plain SDK utilities. ZERO imports from @tanstack/*,
│                 next/*, or node:async_hooks (top-level). Accepts MatcherContext
│                 as an argument.
│
├── /tanstack  ← TanStack Start adapter (today's behavior, repackaged).
│                 createServerFn-wrapped loaders, @tanstack/react-router
│                 components, middleware, workerEntry, vite plugin.
│                 Imports from /core; never from /next.
│
└── /next      ← Next.js App Router adapter (new).
                  loadCmsPage(req), buildMatcherContextFromNext(req),
                  handleDecoAdminRoute, DecoPage server component, /next/client
                  for client-safe surface. Imports from /core; never from /tanstack.
```

**Hard rules:**

1. `core/**` may not import `@tanstack/*`, `next`, `next/*`, `node:async_hooks` (top-level), or anything from `tanstack/**` / `next/**`.
2. `next/**` may not import `tanstack/**`.
3. `tanstack/**` may not import `next/**`.
4. Existing top-level exports (`@decocms/start/cms`, `/routes`, `/hooks`, `/sdk/*`, `/admin`, `/middleware`, `/vite`) stay as-is and re-export from the appropriate tier. No breakage for current TanStack consumers.

### File moves into `src/core/`

Behavior-preserving relocation, plus a `node:async_hooks` purge. Three current sites use `AsyncLocalStorage` directly:

- `src/cms/loader.ts` — blocks-override storage (already has a graceful no-op fallback).
- `src/sdk/requestContext.ts` — per-request signal/device/headers store (primary user).
- `src/middleware/observability.ts` — OpenTelemetry span storage per request.

All three migrate to an injectable `RequestStore` interface:

```ts
// src/core/runtime/requestStore.ts
export interface RequestStore<T> {
  get(): T | undefined;
  run<R>(value: T, fn: () => R): R;
}
export const noopRequestStore: RequestStore<unknown>;
```

The TanStack tier supplies an ALS-backed `RequestStore` (lazily importing `node:async_hooks`); the Next.js tier supplies one that takes the request as an explicit argument.

| Current | New | Notes |
|---|---|---|
| `src/cms/loader.ts` | `src/core/cms/loader.ts` | Replace ALS with injected `RequestStore`. |
| `src/cms/registry.ts` | `src/core/cms/registry.ts` | **Fixes gotcha #1**: `registerSectionsSync` also writes a trivial loader into `registry`, so `getSection()` finds sync sections. |
| `src/cms/{resolve,applySectionConventions,index}.ts` | `src/core/cms/*` | Already framework-agnostic. |
| `src/sdk/{clx,cn,signal,encoding,http,cookie,retry,useId,crypto,urlUtils,normalizeUrls,mergeCacheControl,cacheHeaders,sitemap,redirects,abTesting,wrapCaughtErrors,csp,useDevice,useHydrated,useScript,useSuggestions,analytics,composite,otel,otelAdapters,observability,instrumentedFetch,logger,serverTimings,invoke}.ts` | `src/core/sdk/*` | All framework-agnostic. `signal` keeps its `@tanstack/store` peer dep — non-runtime store. |
| `src/matchers/*` | `src/core/matchers/*` | Already runtime-agnostic. |
| `src/types/*` | `src/core/types/*` | Already runtime-agnostic. |
| `src/admin/*` | `src/core/admin/*` | Uses request/response only via standard Web APIs. |

### File moves into `src/tanstack/`

Today's behavior, no API changes:

| Current | New |
|---|---|
| `src/routes/cmsRoute.ts` (createServerFn wrappers, getRequestUrl/getCookies/...) | `src/tanstack/routes/cmsRoute.ts` |
| `src/routes/{components,index}.tsx` | `src/tanstack/routes/*` |
| `src/hooks/{DecoPageRenderer,DecoRootLayout,StableOutlet,NavigationProgress,LiveControls,LazySection,SectionErrorFallback}.tsx` | `src/tanstack/hooks/*` |
| `src/middleware/*` | `src/tanstack/middleware/*` |
| `src/sdk/{workerEntry,router,createInvoke,requestContext,cookiePassthrough,setupApps}.ts` | `src/tanstack/sdk/*` (touch createServerFn or TanStack request context) |
| `src/vite/plugin.js` | `src/tanstack/vite/plugin.js` |

### New `src/core/` API surface (the unblock primitives)

```ts
// src/core/cms/loadCmsPagePure.ts
export async function loadCmsPagePure(
  fullPath: string,
  ctx: MatcherContext,
): Promise<DecoPageResult | null>;
//
// Same body as today's loadCmsPageInternal, with all getRequest*/getCookies/setHeader
// calls removed. Inputs taken as arguments. Returns the resolved page; caller is
// responsible for any header-setting (X-Deco-Cacheable, etc.) using the returned
// metadata field result.cacheMetadata.
```

```ts
// src/core/cms/resolveDeferredSectionPure.ts
export async function resolveDeferredSectionPure(
  fullPath: string,
  sectionKey: string,
  ctx: MatcherContext,
  opts?: { rawProps?: unknown },
): Promise<ResolvedSection | null>;
```

`MatcherContext` is extended with optional `headers` and `request` fields:

```ts
export interface MatcherContext {
  userAgent: string;
  url: string;
  path: string;
  cookies: Record<string, string>;
  headers?: Record<string, string>;  // NEW (optional)
  request?: Request;                  // NEW (optional, standard Web Request)
}
```

The TanStack tier's existing `loadCmsPage` becomes a thin shim: it grabs `getRequestUrl()` / `getCookies()` / `getRequest()` / `getRequestHeader()`, builds a `MatcherContext`, calls `loadCmsPagePure`, then sets response headers from the result's metadata. Same external behavior.

### New `src/next/` (App Router only)

```ts
// src/next/index.ts
export { loadCmsPage } from "./loadCmsPage";
//   (req: NextRequest) => Promise<DecoPageResult | null>
export { buildMatcherContextFromNext } from "./ctx";
//   (req: NextRequest) => MatcherContext
export { handleDecoAdminRoute } from "./adminRoute";
//   App Router route.ts handler for /live/_meta, /.decofile, /deco/render, /deco/invoke
export { DecoPage } from "./DecoPage";
//   RSC server component + thin client wrapper
```

```ts
// src/next/client.ts — client-safe surface
// Built so the transitive import graph never reaches node:async_hooks.
export { LazySection, SectionErrorFallback, LiveControls } from "./client/*";
export { useDevice, useHydrated, signal } from "@decocms/start/core";
```

`handleDecoAdminRoute` is a single function consumers call from a Next.js App Router `route.ts`:

```ts
// app/(deco)/[[...path]]/route.ts (consumer's site)
import { handleDecoAdminRoute } from "@decocms/start/next";
export const GET = handleDecoAdminRoute;
export const POST = handleDecoAdminRoute;
```

### Build & publishing pipeline

Switch from `tsc` (declaration-only, no `dist/`) to `tsup` for JS emit + `tsc` for `.d.ts`. `tsup`/esbuild handles JSX, multi-entry parallel builds, and `.js` extension rewriting; `tsc` remains the source of truth for declarations.

```jsonc
// package.json scripts
"build:js":    "tsup",
"build:types": "tsc -p tsconfig.build.json",
"build":       "bun run build:js && bun run build:types",
"prepublishOnly": "bun run build"
```

```ts
// tsup.config.ts
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/core/**/index.ts",
    "src/core/sdk/**/*.ts",
    "src/core/admin/index.ts",
    "src/tanstack/index.ts",
    "src/tanstack/{routes,hooks,middleware,vite,sdk}/**/*.ts",
    "src/next/index.ts",
    "src/next/client.ts",
    "src/next/admin.ts",
    "scripts/*.ts",
  ],
  format: ["esm", "cjs"],   // ESM primary; CJS for require() consumers
  dts: false,               // tsc handles .d.ts
  splitting: false,         // preserve file boundaries (subpath imports must remain stable)
  sourcemap: true,
  external: [
    "@tanstack/*", "react", "react-dom", "next", "vite",
    "node:async_hooks", "node:stream", "node:fs", "node:crypto",
  ],
  esbuildOptions(opts) { opts.jsx = "automatic"; opts.platform = "neutral"; },
});
```

Every existing export in `package.json` rewrites to the conditional-exports form pointing at `dist/`:

```jsonc
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "require": "./dist/index.cjs"
  },
  "./cms":      { "types": "./dist/core/cms/index.d.ts", "import": "...", "require": "..." },
  "./core":     { ... "./dist/core/index.{js,cjs,d.ts}" ... },
  "./tanstack": { ... "./dist/tanstack/index.{js,cjs,d.ts}" ... },
  "./next":     { ... "./dist/next/index.{js,cjs,d.ts}" ... },
  "./next/client": { ... "./dist/next/client.{js,cjs,d.ts}" ... }
  // ... all existing /sdk/*, /admin/*, /hooks, /routes, /middleware, /vite paths
}
```

`"main"` → `./dist/index.cjs`; `"module"` → `./dist/index.js`; `"types"` → `./dist/index.d.ts`. Drop `"main": "./src/index.ts"`.

```jsonc
"files": ["dist", "scripts/*.cjs", "scripts/*.js", "README.md", "LICENSE"]
```

Source `.ts` files stop shipping to npm.

### `node:async_hooks` client-bundle leak

Two-part fix:

1. **`src/core/runtime/asyncStorage.ts`** — synchronous `RequestStore` interface with a no-op default. Never imports `node:async_hooks` at the module top level.
2. **`src/tanstack/runtime/alsRequestStore.ts`** — implements the interface using `node:async_hooks` (lazy `await import()`). TanStack consumers wire this in at app boot. Vite's existing client stub continues to neutralize the import for client bundles.
3. **`src/next/client.ts`** — re-exports only modules whose transitive graph never reaches the ALS store. Validated by a build-time graph check (below).

### Bin scripts

The four `bin` entries (`deco-migrate`, `deco-post-cleanup`, `deco-htmx-analyze`, `deco-cf-observability`) currently point at `.ts` files and depend on `tsx` at install time. Compile to `dist/scripts/*.cjs` with `#!/usr/bin/env node` shebang and re-point `bin`. `tsx` stays for development.

### Boundary enforcement

Three layers, so the tiers can't silently re-tangle:

**1. Per-directory `biome.json`** with `noRestrictedImports`:

- `src/core/biome.json` forbids `@tanstack/*`, `next`, `next/*`, top-level `node:async_hooks`.
- `src/tanstack/biome.json` forbids `next`, `next/*`.
- `src/next/biome.json` forbids `@tanstack/react-start`, `@tanstack/react-router`.

**2. `scripts/check-tier-boundaries.ts`** — walks `dist/` after build, parses each module's imports, asserts:

- `dist/core/**` doesn't import `@tanstack/*`, `next`, `next/*`, `node:async_hooks`.
- `dist/next/**` doesn't import from `dist/tanstack/**` and vice versa.
- `dist/next/client.{js,cjs}`'s transitive graph excludes `node:async_hooks`.

Runs as part of `bun run check`; CI gating.

**3. `knip` config** updated so unused exports inside the new tiers are flagged.

### Migration sequence (one PR per step, each independently shippable)

1. **PR 1 — Build pipeline only.** Add `tsup`, emit `dist/`, switch `package.json` exports to `dist/`. No source moves. Webpack consumers can already import the package after this PR. Released first as `5.1.0-beta.N` under the `beta` npm tag, then promoted to `5.1.0` on `latest` once validated against a real storefront's CI.
2. **PR 2 — Carve out `src/core/`.** Move framework-agnostic files. Add `/core` export tier. Re-point existing exports through `core/`. Ships as `5.2.0`. Existing consumers see no change.
3. **PR 3 — Carve out `src/tanstack/`.** Move TanStack-coupled files. Add `/tanstack` export tier. Existing `/routes`, `/hooks`, `/middleware`, `/vite` exports become re-exports of `tanstack/*`. Includes the `registerSectionsSync` registry-fallback fix. Ships as `5.3.0`.
4. **PR 4 — Add `loadCmsPagePure` + `resolveDeferredSectionPure` + extended `MatcherContext`** (with `headers` / `request`) in `core`. Refactor TanStack `loadCmsPage` to delegate. Ships as `5.4.0`.
5. **PR 5 — Add `src/next/`.** App Router adapter: `loadCmsPage(req)`, `buildMatcherContextFromNext(req)`, `handleDecoAdminRoute`, `DecoPage` server component, `next/client` entry. Includes a Next.js App Router fixture in `tests/fixtures/next-app/` exercised in CI. Ships as `5.5.0`.
6. **PR 6 — Boundary enforcement.** Per-directory `biome.json` configs and `scripts/check-tier-boundaries.ts`. Wire into `check` script and CI. Ships as `5.6.0`.
7. **PR 7 — Docs.** README section explaining the three tiers, a "Using `@decocms/start` from Next.js" guide, and an updated `CLAUDE.md` reflecting the new boundaries.

### Validation gates (must pass before merging each PR)

- `bun run build` produces `dist/` with the expected entry points.
- A Next.js App Router fixture (`tests/fixtures/next-app/`) builds successfully under webpack with `moduleResolution: "bundler"`. PR 1 introduces the fixture; later PRs extend it.
- A second fixture with `moduleResolution: "node"` proves the explicit conditional exports resolve under legacy resolvers.
- `scripts/check-tier-boundaries.ts` passes (introduced in PR 6, advisory before).
- Existing migration test suite passes against a real storefront (`run-migration` skill) — proves no regression for current TanStack consumers.
- PR 1 is published under a `beta` npm tag first; promoted to `latest` only after a real storefront's CI green-lights it.

## Risks

| Risk | Mitigation |
|---|---|
| Breaking current TanStack consumers via export-resolution differences (e.g., `require` resolving to something different than `import`) | PR 1 ships under `beta`; validated against a real storefront's CI before promotion. |
| `tsup` chokes on the Vite plugin (`src/vite/plugin.js`) or on `.tsx` JSX | Vite plugin is plain JS, copy through unchanged; JSX validated by `target: "esnext"` + `jsx: automatic`. PR 1 includes a smoke test that imports each emitted entry. |
| `node:async_hooks` lazy-import doesn't actually keep webpack happy | PR 5's CI fixture builds a Next.js App Router client bundle and asserts no `node:async_hooks` resolution attempt; build fails if it leaks. Fallback: separate `client.ts` file with no transitive `requestContext.ts` import. |
| `MatcherContext` extension breaks third-party matchers | `headers` / `request` fields are optional (`?:`); existing matchers destructuring `{ userAgent, url, path, cookies }` continue to work. |
| Schema generation (`generate-schema.ts`) reads `src/` paths that have moved | PR 2/3 update the script's path roots and re-run against a sample site to verify JSON Schema output is byte-identical. |
| Admin protocol handlers in `core/admin/` accidentally pull in TanStack | Boundary check in PR 6 catches it; until then, manual review on each PR. |
| `next/client` pulls in `node:async_hooks` transitively | PR 5's CI fixture asserts no `node:async_hooks` in the client bundle; build fails if it leaks. |
| Build-time regressions (~10s for dual ESM/CJS) | Acceptable for now; revisit if CI time becomes a bottleneck. ESM-only fallback is a one-line config change. |

## Open questions resolved during brainstorming

- **Tier names:** `/core`, `/tanstack`, `/next`. (Not `/agnostic`, `/tan`, `/nextjs`.)
- **Next.js router scope:** App Router only. Pages Router deferred.
- **Scope of this plan:** All three pieces (build + tier split + Next.js adapter) ship together (across multiple PRs).
- **`registerSectionsSync` fix:** auto-register a trivial loader into `registry` so `getSection()` finds sync sections. No deprecation — current behavior is a footgun.
- **`MatcherContext`:** extended with optional `headers` and `request`.
- **Admin handler in `/next`:** in scope (`handleDecoAdminRoute`).
- **Build tool:** `tsup` for JS, `tsc` for `.d.ts`.
- **Module formats:** dual ESM + CJS.
