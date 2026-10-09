# Changelog

All notable changes to `@decocms/start` are documented here.

The project follows [Conventional Commits](https://www.conventionalcommits.org/)
and [semver](https://semver.org/). Releases are cut by semantic-release on
merges to `main`; this file is the human-curated breaking-change ledger.
For per-release auto-generated notes (every commit, every fix), see
[GitHub Releases](https://github.com/decocms/deco-start/releases).

## Unreleased — CMS schema: `RequestURLParam` picker, no saved-block mode on plain arrays

Fixes [#644](https://github.com/decocms/blocks/issues/644).

- **`RequestURLParam`** (`@decocms/apps-website/functions/requestToParam`) is
  emitted as deco-cx/deco did: an `anyOf` of "Force param" (string) and the
  `website/functions/requestToParam.ts` block. `composeMeta` now bakes that
  function into `manifest.blocks.functions` / `schema.root.functions`. Sites
  that declared such props as `string` can switch the type back to get the
  "Get params from request parameters" option in the admin; saved values
  resolve exactly as before.
- **`wrapResolvableProperties` no longer wraps every array of objects.** Only
  arrays a loader can fill (product arrays) get `anyOf [Resolvable, inline,
  ...loaders]`. A plain array of objects (> 3 fields) used to gain a "Select
  from saved" mode that deco-cx/deco never offered. Runtime resolution of
  already-saved references is unchanged; only the admin form loses that mode.

## Unreleased — Admin async (⚡) toggle is the source of truth for deferral

### Behavior change — position-based auto-deferral is off by default

Fixes [#266](https://github.com/decocms/deco-start/issues/266). A section is now
deferred (rendered client-side on scroll) **if and only if** the editor marked
it async ⚡ in the admin (wrapped in `website/sections/Rendering/Lazy.tsx` /
`Deferred.tsx`). The framework no longer overrides that decision:

- **`DEFAULT_FOLD_THRESHOLD` changed from `3` to `Infinity`.** Sections are no
  longer auto-deferred by their position on the page. A section the editor left
  ⚡-off renders SSR regardless of its index — fixing SEO copy (e.g. PLP text
  heroes) that was silently moved client-side.
- **The admin ⚡ check now runs first in `shouldDeferSection`,** so it overrides
  the code-level `export const eager` / `neverDefer` / `alwaysEager` flags. A
  section marked ⚡ is always deferred even if its code declares `eager`.
- **`foldThreshold` and the code-level eager flags are now an explicit opt-in.**
  They take effect only when a site sets a finite threshold and only for
  sections the editor did *not* mark ⚡.
- Bots/crawlers still always receive the full SSR page (SEO guarantee), now
  including ⚡-marked sections.

**Migration.** Sites that relied on the implicit `foldThreshold = 3` to keep
HTML small (without marking sections ⚡) have two options:

1. Mark heavy below-the-fold sections (shelves, etc.) async ⚡ in the admin —
   the recommended path; the editor controls SSR vs deferred.
2. Restore the old position-based behavior explicitly in `setup.ts`:
   ```ts
   setAsyncRenderingConfig({ foldThreshold: 3 });
   ```

### New — `deferredTrigger`, for sites coming from Fresh

Deferred sections fetch their real markup on an IntersectionObserver
(`rootMargin: 300px`, one frame after mount). Deco on Fresh does not wait for
scroll: `DispatchAsyncRender` supports `partialTriggerMode: "load"` and
materializes every ⚡ section right after hydration. A migrated site therefore
ships a page whose below-the-fold content — shelves, blog, footer — simply does
not exist until the user scrolls, so below-the-fold analytics impressions never
fire and the document stays short.

`setAsyncRenderingConfig({ deferredTrigger: "load" })` restores the Fresh
behavior: the wrapper calls its loader straight from the mount effect, skipping
the frame gate and the observer.

- **Default is `"intersection"`.** A framework bump changes nothing — including
  at typecheck: the field is optional on the exported `AsyncRenderingConfig`, so
  a literal built outside the package keeps compiling.
- **It is read on the CLIENT.** Set it from a module the browser bundle also
  loads — normally `setup.ts`, imported from `router.tsx`. Setting it from
  server-only code (the worker entry, `server.ts`) leaves the client on
  `"intersection"` with no warning, which looks like the option being ignored.
- **The cost is a request burst**: every deferred section POSTs in the same
  commit, on first load and on each SPA navigation. That is what the frame
  gate + observer exist to avoid, and also exactly what Fresh does. Site-wide
  for now; a per-section override (honouring the `loading` prop the CMS
  `Lazy.tsx` wrapper already carries, which the resolver discards today) would
  be the finer-grained successor.
- Read only by `@decocms/tanstack`; a no-op in `@decocms/nextjs`.

## 5.0.0 — Drop in-Worker OTLP, converge on Cloudflare-native observability

### Breaking — Observability transport rewritten

- **In-Worker OTLP exporter for logs and metrics is gone.**
  - Removed `createOtelLoggerAdapter()`, `createOtelMeterAdapter()`,
    `OtelLoggerAdapterOptions`, `OtelMeterAdapterOptions`.
  - Removed the per-request flush registry: `flushOtelProviders()`,
    `registerOtelFlushHandler()`, `_resetFlushHandlersForTests()`,
    `_getFlushHandlerCountForTests()`.
- **`URLBasedSampler` and the OTel sampler module are gone.**
  - Removed `URLBasedSampler`, `decodeSamplingConfig`,
    `createUrlBasedHeadSampler`, `SamplingConfig`, `SamplingRule`,
    `DEFAULT_SAMPLE_RATIO`, and the entire `@decocms/start/sdk/sampler`
    export. Use Cloudflare's `observability.traces.head_sampling_rate`
    in `wrangler.jsonc` instead.
- **OTLP-related options on `instrumentWorker(handler, options)` are gone.**
  - Removed: `enableAppSideOtlpLogs`, `otlpEndpoint`, `otlpHeaders`,
    `otlpMinSeverity`, `samplingConfig`, `exportIntervalMillis`.
  - Kept: `serviceName`, `analyticsEngineBindingName`,
    `analyticsEngineEnabled`, `decoRuntimeVersion`, `decoAppsVersion`.
  - Sites that previously read `OTEL_EXPORTER_OTLP_ENDPOINT`,
    `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_LOG_MIN_SEVERITY`, or
    `OTEL_SAMPLING_CONFIG` should delete those secrets after deploying
    against `5.0.0`:
    ```bash
    wrangler secret delete OTEL_EXPORTER_OTLP_ENDPOINT \
                           OTEL_EXPORTER_OTLP_HEADERS \
                           OTEL_LOG_MIN_SEVERITY \
                           OTEL_SAMPLING_CONFIG
    ```
- **OpenTelemetry SDK dependencies dropped from `package.json`:**
  `@opentelemetry/api-logs`, `@opentelemetry/exporter-logs-otlp-http`,
  `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/resources`,
  `@opentelemetry/sdk-logs`, `@opentelemetry/sdk-metrics`,
  `@opentelemetry/sdk-trace-base`. Only `@opentelemetry/api` remains —
  it is the bridge between `withTracing()` and the global tracer
  Cloudflare's runtime exposes.

### Required `wrangler.jsonc` change

Sites must set `observability.enabled: true` at the top level of the
`observability` block — the master switch. Without it Cloudflare captures
nothing, regardless of the sub-block flags. Run the codemod to inject
the canonical block:

```bash
npx -p @decocms/start deco-cf-observability --write
```

The canonical block written by `5.0.0`:

```jsonc
"observability": {
  "enabled": true,
  "logs":   { "enabled": true, "invocation_logs": true,
              "head_sampling_rate": 1,   "persist": true },
  "traces": { "enabled": true,
              "head_sampling_rate": 0.1, "persist": true }
}
```

External destinations (HyperDX, Datadog, etc.) are no longer wired by
default. Opt back in via `--destination-logs <slug>` /
`--destination-traces <slug>` if your site forwards to a destination
provisioned in the Cloudflare dashboard.

### Unchanged surface

The instrumentation API site code calls is unchanged:

- `instrumentWorker(handler, options)`
- `withTracing(name, fn, attrs)`, `getActiveSpan`, `setSpanAttribute`
- `recordRequestMetric`, `recordCacheMetric`, `MetricNames`
- `logger.{debug,info,warn,error}`, `serializeError`, `LoggerAdapter`,
  `setLoggerAttributeFloor`
- `createCompositeLogger`, `createCompositeMeter`
- `createAnalyticsEngineMeterAdapter`, `setRuntimeEnv`, `getRuntimeEnv`

The `deco.runtime.version`, `deco.apps.version`, and
`deployment.environment` attribute floor that landed in 4.5.x stays —
stamped on every span and every log record so dashboards keep working
under Cloudflare's platform-managed export.

### Future (not in 5.0.0)

`@decocms/start/sdk/otelAdapters/clickhouseCollector` ships as a
**documented stub that throws**. When the platform-side OTel collector
gateway lands (forwarding to ClickHouse), the real OTLP/HTTP exporter
implementation goes here — composed alongside the AE meter for
dual-emit. The `OtelOptions` shape will gain a single
`clickhouseCollector?: ClickhouseCollectorOptions` field at that point.

### Migration checklist for site maintainers

1. Bump `@decocms/start` to `^5.0.0`.
2. `npx -p @decocms/start deco-cf-observability --write`
3. `wrangler deploy`
4. Verify CF dashboard captures logs + traces (~5 min):
   Workers & Pages → `<site>` → Observability
5. `wrangler secret delete OTEL_EXPORTER_OTLP_ENDPOINT
   OTEL_EXPORTER_OTLP_HEADERS OTEL_LOG_MIN_SEVERITY
   OTEL_SAMPLING_CONFIG`
