# Worker / Cloudflare / Build Gotchas

> TanStack worker entry stripping, setup ordering, AsyncLocalStorage, cache, npm.


## 9. Build Succeeds but Runtime Fails

After import rewrites, always test: build → dev → visit pages → test interactive features.


## 10. npm link for Local Dev

```bash
cd apps-start && npm link
cd ../blocks && npm link
cd ../my-store && npm link @decocms/apps @decocms/start
```


## 12. No Compat Layers

After migration: no `src/compat/`, only `~/*` alias, zero compat files in packages.


## 13. AsyncLocalStorage in Client Bundles

Use namespace import + runtime conditional (or the `deco-server-only-stubs` Vite plugin).


## 14. TanStack Start Ignores Custom Worker Entry Code

**Severity**: CRITICAL -- cache logic, admin routes, and any custom request interception will silently not work in production.

TanStack Start's Cloudflare adapter **completely ignores** the `export default` in `server.ts`. It generates its own Worker entry that calls `createStartHandler(defaultStreamHandler)` directly. Custom logic inside `createServerEntry({ async fetch(request) { ... } })` is also stripped by Vite/Rollup in production builds.

**Symptom**: Admin routes like `/live/_meta` return HTML instead of JSON. Edge caching (Cache API, X-Cache headers) doesn't work despite being implemented. Every request hits the origin at full SSR cost. The `Cache-Control` headers from route-level `headers()` functions appear correctly (because TanStack applies them), but the custom `X-Cache` header and cache storage never execute.

**Diagnosis**: Search the built `dist/server/worker-entry-*.js` bundle for your custom code (e.g., `X-Cache`, `caches.open`, `_cache/purge`). If absent, TanStack stripped it.

**Fix**: Create a **separate** `src/worker-entry.ts` file that wraps TanStack Start's built handler. Wrangler is told to use this file via `main: "./src/worker-entry.ts"` in the site's `wrangler.jsonc`.

```typescript
// src/worker-entry.ts
import "./setup";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createDecoWorkerEntry } from "@decocms/start/sdk/workerEntry";
import { handleMeta, handleDecofileRead, handleDecofileReload, handleRender, corsHeaders } from "@decocms/start/admin";

const serverEntry = createServerEntry({
  async fetch(request) {
    return await handler.fetch(request);
  },
});

export default createDecoWorkerEntry(serverEntry, {
  admin: { handleMeta, handleDecofileRead, handleDecofileReload, handleRender, corsHeaders },
});
```

The `main` field is set centrally so a future migration of the entry path
applies to every site at once (single PR to the template). There is no
per-site override file; if a single site truly needs a different
entry path, change the template (and accept that all sites get it) or add a
substitution token like `$WORKER_ENTRY_PATH` and feed it from a per-site env.

This ensures admin route interception AND edge caching survive the build because they're in the Worker's own fetch handler, outside of TanStack's build pipeline.


## 19. `import "./setup"` Ordering (CRITICAL)

`import "./setup"` MUST be the first import in both `server.ts` and `worker-entry.ts`. Without it, server functions in Vite split modules execute before `setBlocks()` has been called, causing `resolveDecoPage` to return null → 404 on client-side navigation.

**Symptom**: SSR works fine (F5), but clicking links shows "No CMS page block matches this URL".


## 20. loadDeferredSection Must Use POST

Without this, the admin shows "Incorrect type. Expected 'array'" for fields that contain loader references in the `.decofile`.


## 24. new URL() with Relative Paths Fails in Workers

`new URL("/product/p")` works in browsers (uses `window.location` as base) but throws `Invalid URL` in Workers/Node because there's no implicit base.

**Fix**: Always provide a base URL:
```typescript
const parsed = new URL(url, "https://localhost");
return parsed.pathname + parsed.search;
```


## 25. Global Variables Throw ReferenceError

Code that references undeclared globals (e.g., `userAddressData` injected by VTEX scripts) will throw `ReferenceError: X is not defined` in Workers where those scripts don't run.

**Fix**: Access via `globalThis`:
```typescript
const data = (globalThis as any).userAddressData;
if (data && Array.isArray(data)) { /* use data */ }
```


## 26. Section-Type Props Use __resolveType Format

In the new `@decocms/start`, section-type props from the CMS arrive as `{ __resolveType: "site/sections/Foo.tsx", ...props }`, NOT the old `{ Component, props }` format. Components that render section props must handle this.

**Fix**: Create a `RenderSection` bridge component that:
1. Checks for `section.Component` (old format) and renders directly
2. Checks for `section.__resolveType` (new format), resolves via `getSection()` from `@decocms/start/cms`, and renders with `React.lazy` + `Suspense`


## 27. jsdom Must Be Replaced in Workers

`jsdom` is a heavy Node.js dependency that cannot run in Cloudflare Workers. Components using it for HTML sanitization must use `dompurify` instead.

**Fix**: Replace `import { JSDOM } from "jsdom"` with:
```typescript
import DOMPurify from "dompurify";
const clean = typeof document !== "undefined" ? DOMPurify.sanitize(html) : html;
```


## 28. Deno npm: Prefix Must Be Removed

Imports like `import Color from "npm:colorjs.io"` use the Deno-specific `npm:` prefix. Vite/Node don't understand it.

**Fix**: Remove the `npm:` prefix and install the package: `npm install colorjs.io`.


## 30. Stale Edge Cache After Deploy Requires Explicit Purge

**Severity**: MEDIUM — causes "Failed to fetch dynamically imported module" errors

After deploying a new build to Cloudflare Workers, the edge cache may still serve old HTML that references previous JS bundle hashes. This causes module import failures.

**Fix**: After every deploy, purge the cache:
1. Set a `PURGE_TOKEN` secret. Add `SECRET_PURGE_TOKEN` to the site repo's
   GitHub Secrets, then trigger the centralized `Sync worker secrets`
   workflow (`workflow_dispatch` → `apply`). This pushes it to the Cloudflare
   worker via `wrangler secret put PURGE_TOKEN`. **Do not** run
   `npx wrangler secret put` manually per-site — the central workflow keeps
   GitHub and Cloudflare in sync.
2. Call the purge endpoint: `POST /_cache/purge` with `Authorization: Bearer <token>` and body `{"paths":["/"]}`
3. Currently this lives in each storefront's per-site `deploy.yml` (D6 centralization was reverted; D6.3 Workers Builds replacement is in flight).


## 44. Runtime Module Import Kills Lazy-Loaded Sections

**Severity**: HIGH — sections silently disappear, data appears in RSC streaming but component renders nothing

Vite tree-shakes unused imports in production builds, so a section file that imports a non-existent module may pass `npm run build` without errors. But at runtime, when the section is dynamically imported via `registerSections`'s lazy `() => import("./sections/X")`, ALL imports in the module execute. A missing file kills the entire section module.

**Symptom**: Product shelves or other sections disappear. HTML size drops significantly. Product data appears in React streaming data (`$R[...]` notation) but zero product cards render as actual HTML. No error in the build log.

**Example**:
```typescript
// sections/Product/ProductShelf.tsx
import LoadingCard from "~/components/product/loadingCard";  // file doesn't exist!
export { default, loader } from "~/components/product/ProductShelf";

export function LoadingFallback() {
  return <LoadingCard />;  // only used here — tree-shaken in build
}
```

Build passes because `LoadingFallback` is a named export that nothing imports. But at runtime, the dynamic `import("./sections/Product/ProductShelf")` executes the module, hits the missing `loadingCard` import, and the entire section fails to load.

**Fix**: Create the missing file, even if it's a minimal stub:
```typescript
// components/product/loadingCard.tsx
export default function LoadingCard() {
  return <div className="animate-pulse bg-base-200 h-[400px] w-[200px] rounded" />;
}
```

**Prevention**: After copying files from the original repo, verify all imports resolve:
```bash
npx tsc --noEmit  # catches missing modules that Vite's tree-shaking hides
```


## 45. GitHub Packages npm Requires Auth Even for Public Packages

**Severity**: MEDIUM — blocks dependency installation for new contributors and CI

GitHub Packages' npm registry (`npm.pkg.github.com`) requires authentication even for public packages. This is a known limitation that GitHub has not resolved. Attempting to `npm install` a public `@decocms/*` package without a token returns `401 Unauthorized`.

**Workaround A (recommended for development)**: Use `github:` Git URL syntax instead of npm registry references. This bypasses the npm registry entirely and uses Git HTTPS (no auth needed for public repos):

```json
{
  "@decocms/apps": "github:decocms/apps-start",
  "@decocms/start": "github:decocms/blocks#main"
}
```

**Important**: The repo name in the `github:` URL must match the actual GitHub repo name, not the npm package name. `@decocms/start` was published from repo `decocms/deco-start` (now `decocms/blocks`), NOT `decocms/start`.

**Workaround B (recommended for production)**: Publish to npmjs.com instead. Only npm's public registry supports truly zero-auth public package installation.

**Workaround C (if you must use GitHub Packages)**: Generate a GitHub PAT with `read:packages` scope and configure:
```bash
npm config set //npm.pkg.github.com/:_authToken <YOUR_TOKEN>
```

Or in project `.npmrc` with an env var (for CI):
```
@decocms:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

**Tradeoff with `github:` syntax**: No semver resolution — `npm update` is meaningless. Pin to a tag for stability: `github:decocms/blocks#v0.14.2`. Without a tag, you get HEAD of the default branch.


## 46. Deploy / Wrangler Config (interim, D6.3 in flight)

**Status (2026-05-07)**: D6.2's centralized App-mediated dispatch was
**reverted** in favour of Cloudflare Workers Builds owning the deploy
pipeline per-worker. The Workers Builds onboarding plan is being
designed in a follow-up PR. Until it lands, this section describes the
**interim state**: each storefront retains its own per-site inline
`deploy.yml` workflow (the original pre-D6 setup), with its own
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets.

Site repos **do** commit a per-site `wrangler.jsonc` during the interim
period. The `deco-wrangler` CLI no longer ships from `@decocms/start`.

### What changes when Workers Builds onboarding ships

When the D6.3 replacement lands, expect:

- Per-storefront CF Builds connection (one dashboard click per worker).
- Per-site `.github/workflows/deploy.yml` removed; CF Builds takes over
  on push.
- `wrangler.jsonc` continues to live in the site repo, but a `deco-build`
  CLI in `@decocms/start` regenerates the bindings (KV, R2, etc.) from a
  central template at build time so customers can't add bindings to
  other tenants' resources.
- `name` field in `wrangler.jsonc` is enforced by CF (verified against
  `baggagio-tanstack` 2026-05-07 — a malicious `name` value is ignored
  and CF auto-opens a PR to fix it).

Until then, do NOT scaffold caller stubs that reference
`decocms/blocks/.github/workflows/*.yml@vN` — those workflows are
gone.


## 47. Observability (5.0+, Cloudflare-native)

**Status (2026-05-08)**: As of `@decocms/start@5.0.0`, the framework
ships **no in-Worker OTLP exporter**. Logs and traces flow to the
Cloudflare dashboard via the platform's native `observability` block
in `wrangler.jsonc`. Metrics flow to Analytics Engine. There's no
external destination by default — the CF dashboard is the destination.

### What `instrumentWorker` actually does

```ts
import { instrumentWorker } from "@decocms/start/sdk/observability";

export default instrumentWorker(decoWorker, {
  serviceName: "<site-name>",
});
```

- Bridges `withTracing(name, fn, attrs)` calls to the `@opentelemetry/api`
  global tracer. CF Workers Tracing picks the spans up.
- Stamps `deco.runtime.version`, `deco.apps.version`, `deployment.environment`
  on every span and every structured log record (via
  `spanAttributeFloor` + `setLoggerAttributeFloor`).
- Wires the AE meter adapter against the `DECO_METRICS` binding when
  the binding is present in `env`. Falls back to a no-op meter if the
  binding is missing — `recordRequestMetric` / `recordCacheMetric`
  silently drop.

`instrumentWorker` no longer accepts: `enableAppSideOtlpLogs`,
`otlpEndpoint`, `otlpHeaders`, `otlpMinSeverity`, `samplingConfig`,
`exportIntervalMillis`. These were removed in 5.0 alongside the OTLP
transport.

### Required wrangler.jsonc shape

```jsonc
{
  "observability": {
    "enabled": true,                // master switch — without it CF captures NOTHING
    "logs":   { "enabled": true, "invocation_logs": true,
                "head_sampling_rate": 1,    "persist": true },
    "traces": { "enabled": true,
                "head_sampling_rate": 0.01, "persist": true }
  },
  "analytics_engine_datasets": [
    { "binding": "DECO_METRICS", "dataset": "deco_metrics_<site>" }
  ],
  "version_metadata": { "binding": "CF_VERSION_METADATA" }
}
```

`enabled: true` at the top level is the master switch — without it
Cloudflare captures nothing, regardless of the sub-block flags.
Discovered the hard way during the lebiscuit canary cutover.

Apply via the codemod:

```bash
npx -p @decocms/start deco-cf-observability         # dry-run
npx -p @decocms/start deco-cf-observability --write # apply
```

The codemod is idempotent and strips legacy `destinations: ["hyperdx-..."]`
arrays if they're still present from the pre-5.0 era.

### AE datasets are auto-provisioned

Cloudflare creates AE datasets automatically on the first
`writeDataPoint` from a Worker that has the binding declared. No CF
API call needed, no dashboard step. If `DECO_METRICS` is undefined at
request time, the AE meter adapter no-ops silently — that's the only
way metrics drop.

### Future: ClickHouse-collector adapter

A placeholder lives at `src/sdk/otelAdapters/clickhouseCollector.ts`
in the framework. It's a documented stub that throws if called. When
the OTel collector gateway lands (Worker → OTLP/HTTP → collector →
ClickHouse), this file will get the real exporter wiring back. Site
code never wires it today; the symbol exists only so the future API
surface is committed.

---

## #68 Cloudflare Workers Static Assets bypasses in-worker `Cache-Control` logic for matched asset paths

**Severity**: HIGH — fingerprinted static assets (JS/CSS bundles) served with platform-default headers instead of the intended `immutable, max-age=31536000`, silently failing a cache-coverage check.

Cloudflare Workers Static Assets serves matched files (e.g. `/assets/*`) from its own asset-serving layer **before** the Worker's `fetch()` runs, using Cloudflare's own platform-default headers — in-worker header logic (e.g. an `isStaticAsset()` branch explicitly setting `immutable`) never executes for those requests, regardless of how correct the code looks.

**Fix**: set the header at the infrastructure level instead of in-worker — a `public/_headers` file (Cloudflare Pages/Workers convention):
```
/assets/*  Cache-Control: public, max-age=31536000, immutable
```

**Discovery command**:
```bash
curl -sI <deployed-url>/assets/<fingerprinted-file>.js   # run twice, check CF-Cache-Status and Cache-Control
```
MISS→HIT with the wrong `Cache-Control` header confirms the platform bypass (not a code bug in the Worker).

**Empirical evidence (farmrio-storefront)**: a 1.4MB `vendor-router-*.js` chunk flagged by a `cache-coverage` parity check despite code explicitly intending an immutable header; verified MISS→HIT with the correct header after adding `public/_headers`. See `migration/learnings/T22.md`.

---

## #69 Device-segmented edge-cache background revalidation appears to lose the triggering request's User-Agent, poisoning the wrong device segment

**Severity**: HIGH — cross-cutting: affects every section loader using `withDevice()`/`withMobile()`, site-wide, wherever this response cache layer is active.

A response cache keyed with a device segment (`x-cache-segment: mobile|desktop`, derived from User-Agent) plus `stale-while-revalidate` can, under investigation, show the raw SSR `<img>`/device-conditional attributes flip from correct-for-segment to the *other* segment's content over time on the same cached URL — while end-user visual rendering stays correct throughout (client-side `<picture>`/`<source>` selection masks it). Leading hypothesis (not fully pinned to one line in `@decocms/tanstack`'s `workerEntry.ts` `revalidateInBackground()`): the SWR background-revalidation fetch for one segment doesn't preserve the original request's UA, resolves `device` on its own terms, and overwrites the cached entry for the wrong segment.

**Symptom**: a `banner-aspect-ratio`-style check flips between correct and incorrect crop attributes across repeated checks of the same URL, non-deterministically, with no code change in between.

**Fix**: none available at the app level — this is inside the shared caching-middleware layer (`@decocms/tanstack`), not `src/`. Workaround: `parity`'s `--warmup` flag (pre-fetches each URL with a cache-buster immediately before measurement) side-steps the flakiness for verification purposes without fixing the underlying mechanism.

**Discovery command**:
```bash
rg "revalidateInBackground" node_modules/@decocms/tanstack/src/sdk/workerEntry.ts
rg "isDevMode" node_modules/@decocms/blocks/sdk/env.ts   # confirm whether local dev actually bypasses this cache tier
```

**Empirical evidence (farmrio-storefront)**: reproduced non-deterministically via direct Playwright repro (fresh incognito-like `browser.newContext()` per check, device presets matching parity's own `VIEWPORT_PRESETS`) — correct on a fresh server, flipped to wrong after longer uptime, 3/3 repeat. A separate two-tier repro (isolated mechanism-level call to `createDecoWorkerEntry` with an in-memory `caches.default` polyfill, plus 8 sequential live checks spanning a STALE-HIT→HIT sequence) could **not** reproduce actual poisoning under controlled conditions — the live symptom is confirmed real, but the exact trigger remains only a leading hypothesis, not a pinned root cause. See `migration/learnings/T60.md`, `T65.md` (spun off to investigate further).

---

## #70 `registerCacheableSections()`'s cache key omits request-dependent context — no guard against device/cookie/geo cache poisoning if ever combined with a `withDevice()`/`withMobile()` loader

**Severity**: HIGH if triggered — currently a dormant gap, not a reproduced bug in any known site today.

`runCacheableSectionLoader()`'s cache key (`@decocms/blocks/src/cms/sectionLoaders.ts`, `sectionCacheKey(component, props)`) hashes only the section's CMS-resolved `props`, never the triggering `Request` (no UA, cookies, or geo) — a separate, in-process module-global cache tier from the edge HTTP cache (#69). `registerSectionLoaders()` already has a dev-mode guard warning when a `withDevice()`/`withMobile()`/`withSearchParam()`-tagged loader (`__requestDependent`) is also registered as a layout section — but there is no equivalent guard for `registerCacheableSections()`. If a section is ever registered via both a request-dependent mixin AND `registerCacheableSections()`, the first request's resolved props get cached and served to every other device/cookie/geo variant until stale — the same bug *class* as the already-fixed `layoutCacheRace` bug (`@decocms/blocks` 6.12.1→6.12.2), in a different cache tier.

**Discovery command**:
```bash
rg "registerCacheableSections\(" src/setup/section-loaders.ts
rg "withDevice\(|withMobile\(|withSearchParam\(" src/setup/section-loaders.ts   # flag any component name appearing in both lists
```

**Fix**: none applied — confirmed dormant on the one repo checked (no component was registered via both mechanisms). Proposed upstream: extend `registerSectionLoaders()`'s existing dev-mode `__requestDependent` warning to also fire when a request-dependent loader is registered via `registerCacheableSections()`, mirroring the existing layout-section guard.

**Empirical evidence (farmrio-storefront)**: confirmed dormant — the one section registered via `registerCacheableSections()` (`Organization.tsx`, 24h TTL) uses no request-dependent mixin; every `withDevice`/`withMobile` site in the file was confirmed not also cacheable-registered. See `migration/learnings/T65.md`.

---

## #71 Server-only secret/credential code is reachable from the client bundle via the generated invoke dispatch table

**Severity**: BLOCKER (security) — full OAuth/JWT mechanism (or, in one instance, literal secret material) shipped to every visitor's browser bundle.

`src/setup.ts` imports the CMS dynamic-import dispatch registry (`.deco/loaders.gen.ts`) unconditionally, and it's pulled in by an isomorphic router used by both client and server entries. Vite code-splits the dynamic `import()` into its own chunk but still must emit it into `dist/client` because the import is reachable from the client build graph — even though nothing client-side actually calls it (the client only POSTs to `/deco/invoke/...`). Any action/loader reachable through this generic invoke-by-dotted-path table, if it does module-level secret reads, ships to the client bundle.

**Symptom**: `grep` of `dist/client/assets/*.js` matches secret-shaped strings (`BEGIN PRIVATE KEY`, an OAuth/JWT library's internals, or literal admin credentials baked in as source-level constants by the dispatch table) — even when no literal key bytes are present, the entire mechanism (endpoint, algorithm, credential variable names) is exposed to client-side reconnaissance.

**Fix**: convert affected actions to `createServerFn` entries — TanStack's compiler strips handler bodies from the client bundle by design, replacing them with a thin RPC stub. For entries that can't be converted immediately, exclude them from the dispatch table via `generate-loaders.ts`'s `--exclude` flag.

**Discovery command**:
```bash
grep -rlE "BEGIN PRIVATE KEY|SecretLoader|process\.env\.\w*(SECRET|TOKEN|KEY|PASSWORD)" dist/client   # after `npm run build`
```
Also grep every `site/actions/*`/`site/loaders/*` entry in `.deco/loaders.gen.ts` for module-level secret-reading calls.

**Empirical evidence (farmrio-storefront)**: found independently twice — a Google Vertex AI OAuth/JWT code path (`tryOn-*.js` chunk disappeared from `dist/client`, stayed under `dist/server` post-fix) and a third-party admin email + encrypted password embedded as source-level constants (two entries added to the `--exclude` list; grep across `dist/client` JS+sourcemaps clean post-fix). See `migration/learnings/T18.md`, `T19.md`.
