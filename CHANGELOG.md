# Changelog

All notable changes to `@decocms/start` are documented here.

The project follows [Conventional Commits](https://www.conventionalcommits.org/)
and [semver](https://semver.org/). Releases are cut by semantic-release on
merges to `main`; this file is the human-curated breaking-change ledger.
For per-release auto-generated notes (every commit, every fix), see
[GitHub Releases](https://github.com/decocms/deco-start/releases).

## Unreleased — `?sc=` restored on orderForm mutations (`@decocms/apps-vtex`)

### Behavior change — writes now carry the configured sales channel

Six orderForm mutations were reaching VTEX without `sc`, so the API fell back to
the account default: `updateOrderFormAttachment`, `updateItemAttachment`,
`removeItemAttachment`, `updateItemPrice`, `updateOrderFormProfile` and
`setShippingPostalCode`. Their `deco-cx/apps` counterparts all send it (verified
against `vtex/actions/cart/*.ts` in both `0.133.28` and `0.159.3`); the port
dropped it. They now use the same `scParam()` the rest of the file already does.

**What changes for you — and it is not a subset.** `initVtexFromBlocks()`
defaults to `salesChannel: vtexBlock.salesChannel || "1"`, so effectively every
VTEX site has a channel configured. These six writes therefore start carrying
`?sc=` everywhere, not only on sites that set the field explicitly. Previously
they used the account default silently — a 200 and a well-formed orderForm
either way, so nothing surfaced.

Why that is a smaller change than it sounds: `getOrCreateCart` **already** sends
`sc`, so the orderForm these calls write to was already created in the
configured channel. The six were the inconsistent ones; they now agree with the
cart they mutate. A store whose configured channel equals its account default —
the common case, `sc=1` — sees byte-identical results. A store where the two
differ sees the writes move to the configured channel, which is the bug being
fixed.

Verified against a live VTEX account that all six endpoints accept `?sc=`:
`attachments/marketingData`, `attachments/shippingData`, `profile`,
`items/:i/attachments/:a` and `items/:i/price` return 200 with the same payload
shape with and without it. Adding the parameter cannot turn a working call into
a failing one.

**Multi-channel caveat.** `scParam()` reads the channel from the app config, not
from the request's `vtex_segment` (which is where `deco-cx/apps` takes it,
`segment.payload.channel`). On a store where the segment channel can differ from
the configured one, these writes now pin to the configured one. That gap is
pre-existing and applies to every `sc`-sending call in the file; sourcing the
channel from the segment is a candidate follow-up.

Deliberately left without `sc`, to match `deco-cx/apps`: `addOffering`,
`removeOffering`, `updateSelectableGifts`, `clearOrderFormMessages`.

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
