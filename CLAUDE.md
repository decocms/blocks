# CLAUDE.md

Guidance for AI assistants working in this repo.

## Project Overview

This is **blocks** (repo `decocms/blocks`): a Bun workspace monorepo housing the framework layer for [deco.cx](https://deco.cx) storefronts. It used to be a single npm package, `@decocms/start`, published as a tsup-bundled dist tier. That package was reverted at v5.2.2 after tsup bundling caused module-state duplication (two separate module instances of what should have been one singleton — e.g. the CMS registry — existing simultaneously in the same process). This repo is the fix: real package boundaries, plain `.ts` source exports, no bundler in the loop.

**None of these packages are published yet** (all sit at `0.0.0`). Consuming sites link against a local checkout via `bun link` — see "Local dev / linking a site" below.

## Migration tooling policy (constitutional)

This repo also hosts the migration scripts + skills that move Deco storefronts from Fresh/Deno to TanStack Start. That work is governed by signed-off architectural decisions (D1–D5) and a strict priority order — see [`.cursor/rules/migration-tooling-policy.mdc`](./.cursor/rules/migration-tooling-policy.mdc) (always-loaded) and [`MIGRATION_TOOLING_PLAN.md`](./MIGRATION_TOOLING_PLAN.md) (full record). Defer to the plan when in doubt. This governs the migration *scripts and skills*, not the package split itself.

## Tech Stack

- Package manager / workspace: Bun (`bun install`, `bun run --filter`)
- Runtime targets: Cloudflare Workers (`@decocms/tanstack`) and Node/RSC (`@decocms/nextjs`)
- Framework bindings: TanStack Start / TanStack Router, Next.js App Router
- UI: React 19
- Build (site-side): Vite (TanStack) — `@decocms/nextjs` has no Vite dependency, it's RSC-native
- Test runner: Vitest, workspace-root config (`vitest.config.ts`), each package's `test` script runs `vitest run --root ../.. packages/<name>`

## Common Commands

```bash
bun install
bun run build        # tsc -> dist/, per package
bun run typecheck     # tsc --noEmit, per package
bun run test          # vitest run, per package
bun run check         # typecheck + lint + lint:unused
```

No dev server at the repo root — these are libraries. `examples/tanstack-smoke` and `examples/nextjs-smoke` are real, runnable consumers (`cd examples/<name> && bun run dev`).

## Architecture: five packages, one-way dependency graph

```
packages/
├── runtime/    @decocms/blocks   — CMS core. Zero deco-package deps.
├── admin/      @decocms/blocks-admin     — admin protocol + createAdminSetup.  depends on: runtime
├── cli/        @decocms/blocks-cli       — codegen + migration scripts.       depends on: runtime
├── tanstack/   @decocms/tanstack  — TanStack Start + CF Workers binding. depends on: runtime, admin, cli
└── next/       @decocms/nextjs      — Next.js App Router binding.        depends on: runtime, admin
examples/
├── tanstack-smoke/   real TanStack Start app consuming runtime+admin+tanstack
└── next-smoke/       real Next.js app consuming runtime+admin+next
.agents/skills/
├── deco-to-tanstack-migration/   Fresh/Preact/Deno -> TanStack Start (site-code migration)
├── deco-migrate-script/          the automated 8-phase script backing the above
└── deco-next-package-migration/  old single-package @decocms/start -> the split, for Next.js sites
```

**The dependency graph is one-way and load-bearing.** `runtime` never imports from `admin`/`cli`/`tanstack`/`next`. `tanstack` and `next` never import from each other. When splitting a concern between packages, check which side of this graph it belongs on before writing code — a circular need (Phase 1's `createSiteSetup` originally needed both runtime-only and admin-only options) is resolved by splitting the function, not by adding a back-edge.

No `tsconfig.json` `references` arrays anywhere in `packages/*` — cross-package imports resolve to `.ts` source directly (`moduleResolution: bundler`), which is also what makes the package split's central guarantee ("no package bundles another's compiled output") actually hold. Adding a `references` field back in reintroduces a real TS6305 build-ordering bug that was root-caused and removed early in this repo's history — don't add it back.

### Package Exports

Every export maps to a source file — no dist indirection. Representative subset (see each package's `package.json` `exports` map for the full list):

| Import path | Package | File |
|---|---|---|
| `@decocms/blocks/cms` | blocks | `src/cms/index.ts` — full barrel: resolver, loader, registry. Server-only (transitively imports `node:async_hooks` via `loader.ts`/`resolve.ts`) — bundling it for a browser target fails (Turbopack rejects outright; webpack has historically let it through uncaught). |
| `@decocms/blocks/cms/client` | blocks | `src/cms/client.ts` — client-safe subset: section registry lookups (`getResolvedComponent`, `registerSection`, etc.), `sectionMixins`, `schema`. Use this from Client Components / browser-bundled code; use `@decocms/blocks/cms` from server-only code. Verified via a real esbuild browser-target bundle in `src/cms/client.browserBundle.test.ts`, not just `tsc` — that's the only way this class of bug reliably surfaces. |
| `@decocms/blocks/setup` | blocks | `src/setup.ts` |
| `@decocms/blocks/sdk/*` | blocks | `src/sdk/*.ts` |
| `@decocms/blocks/hooks` | blocks | `src/hooks/index.ts` |
| `@decocms/blocks-admin` (root) | blocks-admin | `src/admin/index.ts` |
| `@decocms/blocks-admin/setup` | blocks-admin | `src/createAdminSetup.ts` |
| `@decocms/blocks-admin/apps/autoconfig` | blocks-admin | `src/apps/autoconfig.ts` |
| `@decocms/tanstack` (root) | tanstack | `src/index.ts` (re-exports routes, hooks, worker entry, router sdk) |
| `@decocms/tanstack/vite` | tanstack | `src/vite/plugin.js` (plain JS, no `.d.ts` yet) |
| `@decocms/nextjs` (root) | nextjs | `src/index.ts` |
| `@decocms/blocks-cli/generate` | blocks-cli | `scripts/generate.ts` — the unified incremental orchestrator (runs blocks/manifest/sections/loaders/invoke/schema as one command over a two-tier cache: committed content-hash digest records in `.deco/generate.digests.json` — commit it, fresh clones then cache-hit — plus a gitignored local stat memo in `.deco/.cache/stat-memo.json`; sites scaffold `"generate": "tsx node_modules/@decocms/blocks-cli/scripts/generate.ts <flags>"` instead of chaining the individual scripts) |
| `@decocms/blocks-cli/generate-blocks` | blocks-cli | `scripts/generate-blocks.ts` — the ONLY other blocks-cli exports-map entry, kept because `@decocms/tanstack`'s vite plugin tsImports it (programmatic `generateBlocks` + `readBlockDelta`). The remaining `scripts/generate-*.ts` / `scripts/migrate*.ts` files ship in the package but are internal implementation details of `./generate` — reachable as literal filesystem paths (e.g. `node_modules/@decocms/blocks-cli/scripts/generate-schema.ts`), not as module specifiers; CLIs are exposed via `bin` |

### Key Boundaries

- `@decocms/blocks` must NOT import from `admin`/`cli`/`tanstack`/`next`, and must NOT contain framework-specific code (no TanStack Router types, no Next.js types, no Cloudflare-Workers-only APIs at the type level).
- `@decocms/tanstack` and `@decocms/nextjs` must NOT import from each other.
- `@decocms/apps` (commerce integrations — separate repo) must NOT contain UI components or framework-binding code.
- Site repos must NOT contain compat/wrapper directories reimplementing what a package already exports — if something's missing from a package's public surface, that's a gap in the package, not a reason to hand-roll a workaround in every site (see "Known gaps in package exports" below).

## Fast Deploy (KV-first content) — `@decocms/tanstack` only

Decouples CMS content updates from code deploys: content served from Cloudflare KV (`decofile:current` + `index:revision`) with the bundled `blocks.gen` as fallback. Whole-snapshot swap — each isolate loads the decofile once and swaps the in-memory map via `setBlocks()`, so the synchronous resolver is unchanged. Gated on explicit opt-in — requires both `DECO_FAST_DEPLOY=1` and the `DECO_KV` binding; inert otherwise.

This is deliberately **not** available in `@decocms/nextjs` — edge KV + Cloudflare Workers caching is a `tanstack`-specific concern, not something `next`'s Node/RSC target needs or should carry. Read path: `packages/blocks/src/cms/blockSource.ts`, `packages/blocks-admin/src/admin/decofile.ts` (`setFastDeployKVGetter` — dependency injection so `admin` doesn't need a hard KV dependency), `packages/tanstack/src/setupFastDeploy.ts`. Full guide + cross-repo contracts: [`docs/fast-deploy.md`](./docs/fast-deploy.md).

## Admin Protocol

Communicates with `admin.deco.cx` via:

- `GET /live/_meta` — JSON Schema + manifest (content-hash ETag)
- `GET /.decofile` — site content blocks
- `POST /deco/render` — section/page preview in iframe
- `POST /deco/invoke` — loader/action execution

Both bindings expose the same four handlers from `@decocms/blocks-admin` (`handleMeta`, `handleDecofileRead`/`handleDecofileReload`, `handleRender`, `handleInvoke`), but wire them up differently:

- **TanStack**: admin routes MUST be handled inside `createDecoWorkerEntry` (`@decocms/tanstack`), NOT inside TanStack's `createServerEntry` — Vite strips custom fetch logic from server entries in production builds.
- **Next.js**: mount `createDecoRouteHandlers({ setup })` from the `@decocms/nextjs/routeHandlers` subpath at `app/deco/[[...deco]]/route.ts`, and mount `createDecoPreviewPage({ setup })` from the root package at the fixed `app/deco/preview/[[...path]]/page.tsx` route. The catch-all serves the protocol and always redirects preview GETs to `/deco/preview`; that framework-owned path is not configurable. POST render requests retain the plain-HTML handler.

The separate Next preview page is load-bearing. `handleRender` uses `react-dom/server.renderToString`, which cannot invoke the client-reference proxies Next creates for modules marked `"use client"`; only Next's App Router/RSC renderer can compose Server Components with those Client Components and emit hydration metadata. Do not fix preview failures by stripping `"use client"` from components that need hooks, events, browser APIs, or client-only context. Also keep route-handler imports on the `/routeHandlers` subpath: importing the root barrel from `route.ts` pulls client component code into a react-server-only module graph and can fail at import time.

Schema is composed at runtime: `@decocms/blocks-cli`'s `generate-schema.ts` produces section schemas, `composeMeta()` (in `@decocms/blocks/cms`) injects page schemas and framework definitions.

## Request-scoped state: `RequestContext` (client-bundle-safe)

`@decocms/blocks/sdk/requestContext` binds per-request state (request, abort signal, device info, flags) via `AsyncLocalStorage`. The tricky part: `AsyncLocalStorage` comes from `node:async_hooks`, which breaks Next's client webpack bundle if statically imported from anything reachable by a `"use client"` file.

Fixed via conditional package exports on `@decocms/blocks/sdk/requestContextStorage` — `workerd`/`node`/`default` resolve to the real `AsyncLocalStorage`-backed implementation, `browser` resolves to a no-op stub with the identical shape (`{ run, getStore }`). **Condition order matters and is a real footgun**: `workerd`/`node` must be listed *before* `browser` in the exports map, because Cloudflare Workers builds activate a condition set that includes `browser` too (`["workerd", "worker", "browser"]`) — if `browser` came first, a real Workers production deploy would silently get the no-op stub instead of the real backend, breaking cookies/abort-signal/device-detection with no build error. This is exactly the kind of dual-instance-state bug the whole package split exists to eliminate — if you touch this file, verify the condition order empirically (Node's own `--conditions` flag, or a clean-room reproduction of `PACKAGE_TARGET_RESOLVE`), don't just eyeball it.

There's a permanent regression test for a related-but-distinct historical bug at `packages/blocks/src/cms/layoutCacheRace.test.ts`: `resolveDecoPage`'s layout-section cache (Header/Footer) returns a shared object to every concurrent caller, and mutating `.index` on it in place (rather than cloning first) let one request's flat position overwrite another's — this shipped in `@decocms/start@6.12.1` and caused a same-day production rollback on two live sites before being fixed in 6.12.2. If you ever see this test fail, do not "fix" it by relaxing the assertion — it's asserting exactly the invariant that broke production once already.

## Known gaps in package exports (documented, not yet fixed)

A few symbols have real, intended-for-external-use implementations that aren't reachable from any package's public barrel or `exports` map. Sites currently work around this with local shim files rather than patching the package (tracked, not yet resolved):

- `@decocms/tanstack`: `deferredSectionLoader` (in `src/routes/cmsRoute.ts`, exported from the internal `src/routes/index.ts` barrel but not the root), `getRequestCookieHeader`/`forwardResponseCookies` (`src/sdk/cookiePassthrough.ts`), `createInvokeFn` (`src/sdk/createInvoke.ts`).
- `@decocms/blocks-cli`: `./scripts/generate-sections` and `./scripts/generate-loaders` have no `exports` map entry (only `generate-blocks`/`generate-schema`/`generate-invoke` do), even though the script files exist. Consumers reference them by literal filesystem path.

If you're the one wiring up a new site and hit one of these, the fix belongs in the package (add the export), not another copy-pasted local shim — check this list first.

## Migration Skills

Three, each with a distinct scope:

1. **`deco-to-tanstack-migration`** (`.agents/skills/`) — the site-code migration playbook, Fresh/Preact/Deno → TanStack Start/React/Workers. Import rewrites, Deco-framework elimination, commerce type migration, platform hooks (useCart/useUser/useWishlist), Vite config, documented gotchas.
2. **`deco-migrate-script`** — the automated script backing (1): 8 phases (analyze → scaffold → transform → cleanup → report → verify → bootstrap → compile), invoked via `@decocms/blocks-cli`'s `scripts/migrate.ts`.
3. **`deco-next-package-migration`** — a different migration: moving a site *off the old single-package `@decocms/start`* (the abandoned `/next`, `/core`, `/node` tiers specifically) *onto the current split*, for sites building on `@decocms/nextjs`. Has its own import-mapping reference and worked `setup.ts`/admin-routes templates, proven end-to-end against a real production Next.js site.

Don't conflate (1)/(2) with (3) — the first pair migrates a site's *framework* (Fresh → TanStack), the third migrates a site's *package dependency* on an already-TanStack-or-Next site.

## Important Constraints

1. **No compat layers in a package** — if a site needs a symbol a package should export, add the export; don't let sites accumulate local reimplementations (see "Known gaps" above).
2. **`AsyncLocalStorage`** — see the `RequestContext` section above. Never add a bare `node:async_hooks` import to any file reachable from a `"use client"` boundary; route through the existing conditional-exports pattern.
3. **Preview shell** — must include `data-theme="light"` for DaisyUI v4 color variables.
4. **Next preview rendering** — Client Components must render through `createDecoPreviewPage`; plain `renderToString` cannot execute Next client references. Preserve legitimate `"use client"` boundaries.
5. **Base64 encoding** — `toBase64()` must produce padded output matching `btoa()` — admin uses `btoa()` for definition refs.
6. **ETag** — content-based DJB2 hash, not string length.
7. **Dependency graph direction** — see "Key Boundaries" above; this is enforced by convention, not tooling, so review new imports across package boundaries carefully.
