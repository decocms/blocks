/**
 * Observability utilities for deco middleware.
 *
 * Pluggable adapters for tracing (spans) and metrics (counters, gauges,
 * histograms). Works with any backend: OpenTelemetry, Sentry, Datadog, etc.
 *
 * Per-request active spans are propagated via an injectable `RequestStore`
 * — by default an AsyncLocalStorage-backed implementation. Tests can swap
 * it via `setObservabilitySpanStore()` to assert span lifecycle without
 * relying on `node:async_hooks` semantics in the test runner.
 *
 * @example
 * ```ts
 * import { configureTracer, configureMeter } from "@decocms/start/middleware";
 * import { trace, metrics } from "@opentelemetry/api";
 *
 * configureTracer({
 *   startSpan: (name, attrs) => {
 *     const span = trace.getTracer("deco").startSpan(name, { attributes: attrs });
 *     return {
 *       end: () => span.end(),
 *       setError: (e) => span.recordException(e),
 *       setAttribute: (k, v) => span.setAttribute(k, v),
 *     };
 *   },
 * });
 *
 * configureMeter({
 *   counterInc: (name, value, labels) => metrics.getMeter("deco").createCounter(name).add(value, labels),
 *   histogramRecord: (name, value, labels) => {
 *     // METRIC_METADATA carries the unit AND the bucket boundaries. Forwarding
 *     // `boundaries` to `advice` is required, not optional: durations are
 *     // recorded in seconds and the SDK's default buckets are milliseconds, so
 *     // an adapter that omits it files everything into the first bucket and
 *     // every quantile reads back as ~0.
 *     const meta = METRIC_METADATA[name];
 *     metrics.getMeter("deco")
 *       .createHistogram(name, {
 *         unit: meta?.unit,
 *         description: meta?.description,
 *         advice: meta?.boundaries
 *           ? { explicitBucketBoundaries: [...meta.boundaries] }
 *           : undefined,
 *       })
 *       .record(value, labels);
 *   },
 * });
 * ```
 */

import * as asyncHooks from "node:async_hooks";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  METRIC_HTTP_CLIENT_REQUEST_DURATION,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from "@opentelemetry/semantic-conventions";
import { logger } from "../sdk/logger";

// ---------------------------------------------------------------------------
// RequestStore — minimal per-request context abstraction. Inlined here so
// the observability module has zero cross-package dependencies and tests
// can inject a custom implementation via `setObservabilitySpanStore`.
// ---------------------------------------------------------------------------

export interface RequestStore<T> {
  get(): T | undefined;
  run<R>(value: T, fn: () => R): R;
}

class NoopRequestStore implements RequestStore<unknown> {
  get(): undefined {
    return undefined;
  }
  run<R>(_value: unknown, fn: () => R): R {
    return fn();
  }
}

const noopRequestStore: RequestStore<unknown> = new NoopRequestStore();

class AlsRequestStore<T> implements RequestStore<T> {
  private readonly als:
    | { getStore(): T | undefined; run<R>(store: T, fn: () => R): R }
    | null;
  constructor() {
    const ALS = (asyncHooks as { AsyncLocalStorage?: new <U>() => {
      getStore(): U | undefined;
      run<R>(store: U, fn: () => R): R;
    } }).AsyncLocalStorage;
    this.als = ALS ? new ALS<T>() : null;
  }
  get(): T | undefined {
    return this.als?.getStore();
  }
  run<R>(value: T, fn: () => R): R {
    return this.als ? this.als.run(value, fn) : fn();
  }
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export interface Span {
  end(): void;
  setError?(error: unknown): void;
  setAttribute?(key: string, value: string | number | boolean): void;
  /**
   * Return W3C trace context for the current span. Used by helpers that
   * need to correlate logs to traces (`logger`) or propagate context to
   * downstream services (`injectTraceContext`). Optional — adapters that
   * can't expose it simply leave it off and callers no-op gracefully.
   */
  spanContext?(): { traceId: string; spanId: string; traceFlags: number };
}

export interface TracerAdapter {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span;
}

// ---------------------------------------------------------------------------
// Shared module state — pinned to globalThis via Symbol.for so multiple
// inlined copies of this module (one per bundled entry file if/when
// bundling is ever reintroduced) converge on the SAME state. Without this
// indirection, `configureMeter()` from one entry's copy writes to a meter
// that `getMeter()` in another entry's copy never sees, and direct-POST
// telemetry silently no-ops.
//
// Pattern borrowed from @opentelemetry/api / Sentry — both solve the same
// "library with multiple entry exports re-bundles internal state modules"
// problem. Cloudflare Workers guarantee one `globalThis` per isolate, so
// there's no risk of cross-isolate bleed. Defensive against future
// bundling changes; harmless when consumers import from src/ as today.
// ---------------------------------------------------------------------------

interface ObservabilityState {
  tracer: TracerAdapter | null;
  meter: MeterAdapter | null;
  spanStore: RequestStore<Span | null>;
}

const STATE_KEY = Symbol.for("@decocms/start/observability/state.v1");

function getState(): ObservabilityState {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      tracer: null,
      meter: null,
      spanStore: new AlsRequestStore<Span | null>(),
    } satisfies ObservabilityState;
  }
  return g[STATE_KEY] as ObservabilityState;
}

/**
 * Swap the RequestStore used for active-span propagation.
 *
 * Pass `undefined` to reset to the default AsyncLocalStorage-backed store.
 * Primarily intended for tests that need deterministic span access without
 * setting up an actual ALS context.
 */
export function setObservabilitySpanStore(s: RequestStore<Span | null> | undefined): void {
  getState().spanStore = s ?? new AlsRequestStore<Span | null>();
}

export function configureTracer(t: TracerAdapter) {
  getState().tracer = t;
}

export function getTracer(): TracerAdapter | null {
  return getState().tracer;
}

/** Get the currently active span for the current async context, if any. */
export function getActiveSpan(): Span | null {
  return getState().spanStore.get() ?? null;
}

/** Set an attribute on the active span, if one exists. */
export function setSpanAttribute(key: string, value: string | number | boolean) {
  getActiveSpan()?.setAttribute?.(key, value);
}

/**
 * Inject the active span's W3C trace context into outbound request headers
 * as a `traceparent` header (RFC W3C-tracecontext format
 * `version-traceId-parentId-flags`). Call this from outbound `fetch`
 * wrappers (e.g. `createInstrumentedFetch` in `@decocms/apps`) so upstream
 * services that participate in OTel can correlate their spans with ours.
 *
 * No-op when no active span exists, when the active span has no
 * `spanContext()` adapter method, or when the trace/span IDs aren't
 * populated. Never throws.
 *
 * @example
 * ```ts
 * import { injectTraceContext } from "@decocms/start/sdk/observability";
 *
 * async function tracedFetch(url: string, init?: RequestInit) {
 *   const headers = new Headers(init?.headers);
 *   injectTraceContext(headers);
 *   return fetch(url, { ...init, headers });
 * }
 * ```
 */
export function injectTraceContext(headers: Headers): void {
  const ctx = getActiveSpan()?.spanContext?.();
  if (!ctx || !ctx.traceId || !ctx.spanId) return;
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0");
  headers.set("traceparent", `00-${ctx.traceId}-${ctx.spanId}-${flags}`);
}

export async function withTracing<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const s = getState();
  if (!s.tracer) return fn();

  const span = s.tracer.startSpan(name, attributes);

  try {
    const result = await s.spanStore.run(span, fn);
    span.end();
    return result;
  } catch (error) {
    span.setError?.(error);
    span.end();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

type Labels = Record<string, string | number | boolean>;

export interface MeterAdapter {
  counterInc(name: string, value?: number, labels?: Labels): void;
  gaugeSet?(name: string, value: number, labels?: Labels): void;
  histogramRecord?(name: string, value: number, labels?: Labels): void;
}

export function configureMeter(m: MeterAdapter) {
  getState().meter = m;
}

export function getMeter(): MeterAdapter | null {
  return getState().meter;
}

/**
 * Pre-defined metric names. Where the OTel community SemConv defines a
 * canonical metric we use the constant imported from
 * `@opentelemetry/semantic-conventions` (e.g.
 * `METRIC_HTTP_SERVER_REQUEST_DURATION`) — never write the string ourselves.
 * Browse: https://opentelemetry.io/docs/specs/semconv/http/http-metrics/
 *
 * Concepts the OTel community does NOT define (cache hits, CMS resolve,
 * per-loader latency) use the Deco extension namespace `deco.*` in dotted
 * notation, matching the OTel attribute-naming convention.
 *
 * Unit / value handling: emitters declare the unit honestly via the
 * METRIC_METADATA map below; the framework never converts numeric values.
 * Consumers (otel-ingest collector, future Go Collector swap, query
 * layers) apply UCUM conversions if their target backend requires a
 * specific unit (e.g. canonical OTel `s` for HTTP durations).
 */
export const MetricNames = {
  // OTel SemConv (stable).
  HTTP_SERVER_REQUEST_DURATION: METRIC_HTTP_SERVER_REQUEST_DURATION,
  HTTP_CLIENT_REQUEST_DURATION: METRIC_HTTP_CLIENT_REQUEST_DURATION,
  // Deco extensions — no canonical OTel metric exists for these concepts.
  // Single cache counter dimensioned by `deco.cache.status` — follows the OTel
  // semconv pattern (cf. nfs.server.repcache.requests + .status). deco-cx/deco
  // uses the same name so both frameworks aggregate together.
  // Labels on this counter use short keys (status/profile/layer/provider) —
  // the metric name already provides the deco.cache.* namespace.
  CACHE_REQUESTS: "deco.cache.requests",
  RESOLVE_DURATION: "deco.cms.resolve.duration",
  LOADER_DURATION: "deco.loader.duration",
  LOADER_ERRORS: "deco.loader.errors",
} as const;

/**
 * Explicit bucket boundaries, in SECONDS, for every duration histogram declared
 * in {@link METRIC_METADATA}.
 *
 * These exist because the unit and the buckets are configured in two different
 * places and had drifted apart. The record helpers divide by 1000, so values
 * arrive in seconds — correct per SemConv. But the OTel SDK's *default*
 * boundaries are `[0, 5, 10, 25, 50, 75, 100, 250, 500, 1000]`, which are
 * milliseconds. An adapter that calls `createHistogram(name)` without an
 * `advice` therefore files every sub-5-second observation into the first bucket.
 *
 * Measured on the production ClickHouse before this change: 99.8%–99.95% of all
 * observations on `http.server.request.duration` (78.7M/hour),
 * `http.client.request.duration`, `deco.loader.duration` and
 * `deco.cms.resolve.duration` sat in bucket 1, so every quantile read back as
 * ~0 and the latency dashboards had to fall back to tail-sampled traces.
 *
 * Values are the SemConv-recommended defaults for HTTP duration histograms.
 */
export const DURATION_BUCKET_BOUNDARIES_SECONDS: readonly number[] = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.075,
  0.1,
  0.25,
  0.5,
  0.75,
  1,
  2.5,
  5,
  7.5,
  10,
];

/**
 * Per-metric metadata emitted in the OTLP payload's `description` and
 * `unit` fields. Durations are normalized to **seconds at the source** (OTel
 * semconv), matching the deco-cx/deco framework — NOT converted downstream in
 * the collector. Callers still pass milliseconds; the record helpers divide.
 *
 * `boundaries`, when present, MUST be forwarded to the histogram's `advice` at
 * creation time — the unit alone does not tell the SDK how to bucket, and its
 * defaults assume milliseconds. See
 * {@link DURATION_BUCKET_BOUNDARIES_SECONDS}.
 *
 * Keep keys aligned with `MetricNames` values so a missing entry is a
 * type error at compile time when a new metric ships without metadata.
 */
export const METRIC_METADATA: Record<
  string,
  { description: string; unit: string; boundaries?: readonly number[] }
> = {
  [MetricNames.HTTP_SERVER_REQUEST_DURATION]: {
    description: "Duration of HTTP server requests handled at the Worker entry point.",
    unit: "s",
    boundaries: DURATION_BUCKET_BOUNDARIES_SECONDS,
  },
  [MetricNames.HTTP_CLIENT_REQUEST_DURATION]: {
    description: "Duration of outbound HTTP client requests (commerce, generic fetch).",
    unit: "s",
    boundaries: DURATION_BUCKET_BOUNDARIES_SECONDS,
  },
  [MetricNames.CACHE_REQUESTS]: {
    description: "Cache lookups, dimensioned by status (hit/stale/miss/bypass).",
    unit: "{request}",
  },
  [MetricNames.RESOLVE_DURATION]: {
    description: "Duration of `deco.cms.resolvePage` — CMS route to block tree resolution.",
    unit: "s",
    boundaries: DURATION_BUCKET_BOUNDARIES_SECONDS,
  },
  [MetricNames.LOADER_DURATION]: {
    description: "Per-loader execution duration, emitted by cachedLoader.",
    unit: "s",
    boundaries: DURATION_BUCKET_BOUNDARIES_SECONDS,
  },
  [MetricNames.LOADER_ERRORS]: {
    description: "Per-loader error count.",
    unit: "{error}",
  },
};

/**
 * Map an HTTP status code to its canonical class label (`2xx` / ... /
 * `5xx`). Out-of-range numbers (e.g. -1 from a thrown fetch) fall back
 * to `"unknown"` so dashboards don't break on edge cases.
 *
 * Exported because callers occasionally need the same mapping for
 * non-metric purposes (logging, tail enrichment).
 */
export function statusClassFor(status: number): string {
  if (typeof status !== "number" || !Number.isFinite(status)) return "unknown";
  if (status < 100 || status >= 600) return "unknown";
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Optional dimensions stamped on `http.server.request.duration` (semconv).
 * Request count and error rate are derived from the histogram's `count` and
 * a `http.response.status_code` filter — the old separate `_total` /
 * `_errors_total` counters were removed. All fields are optional — callers
 * pass what they have, the framework fills in the rest from defaults.
 *
 * Cardinality discipline: every field here is bounded. `route_pattern`
 * comes from the TanStack router (a closed set), `outcome` is the CF
 * Workers Observability enum, `cache_decision` / `cache_layer` are
 * union types declared in this module, `region` is a small set of CF
 * colo codes. Status is unbounded by spec but bounded in practice; the
 * `status_class` label bounds the cardinality further for dashboards
 * that don't need the raw value.
 */
/**
 * Per-request identifiers that MUST NOT be stamped on metric labels.
 * They belong on spans (where they are 1:1 with the entity being
 * observed) and on logs (where they enable cross-channel correlation).
 * Putting them on metric labels collapses aggregation — every request
 * becomes its own histogram data point.
 */
const HIGH_CARDINALITY_BLOCKLIST = new Set<string>([
  "request.id",
  "trace.id",
  "span.id",
  "session.id",
  "user.id",
]);

export interface RequestMetricLabels {
  /** TanStack route pattern (`/_products/$slug/p`) — closed set. */
  route_pattern?: string;
  /** Cloudflare Workers Observability `outcome` (`ok`, `exception`, ...). */
  outcome?: string;
  /** Cache layer + decision when known. */
  cache_decision?: CacheDecision;
  cache_layer?: CacheLayer;
  /** Cloudflare colo (`GRU`, `IAD`, ...). */
  region?: string;
  /**
   * Arbitrary extra labels — callers should avoid this and add fields
   * to the typed surface above instead. Kept as an escape hatch so
   * non-canonical experiments don't require a framework release.
   */
  extra?: Record<string, string | number | boolean>;
}

/**
 * Record an HTTP request metric.
 *
 * Call in middleware after the response is produced. Two-call surface
 * for backward compat:
 *
 *   recordRequestMetric(method, path, status, durationMs)
 *   recordRequestMetric(method, path, status, durationMs, labels)
 *
 * The labels argument is optional — sites that haven't bumped to the
 * Phase 2 metric shape still emit the original three labels
 * (`method`, `route_pattern`, `status`). Adding labels never changes
 * existing labels' values; only adds new ones.
 */
export function recordRequestMetric(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  labels?: RequestMetricLabels,
) {
  const m = getState().meter;
  if (!m) return;
  // Cardinality discipline:
  //   - `method`: small (GET, POST, ...).
  //   - `route_pattern`: closed set (caller-supplied) OR normalized path
  //     (fallback). Either way bounded.
  //   - `status`: full HTTP code (bounded ~50 values in practice).
  //   - `status_class`: 5-element enum (2xx / 3xx / 4xx / 5xx / unknown).
  //   - `outcome`: CF outcome enum (~7 values).
  //   - `cache_decision`: 5-element enum.
  //   - `cache_layer`: 3-element enum (edge / cachedLoader / swr).
  //   - `region`: ~250 CF colo codes worldwide.
  // Total combinations are bounded — safe for unbounded series on
  // ClickHouse but operators should still avoid grouping by `region`
  // unless explicitly needed.
  // semconv attribute keys for the core HTTP dimensions; deco.* for the
  // proprietary extras. Unified with deco-cx/deco so both frameworks land on
  // the same series/labels in ClickHouse.
  const merged: Labels = {
    [ATTR_HTTP_REQUEST_METHOD]: method,
    [ATTR_HTTP_ROUTE]: labels?.route_pattern ?? normalizePath(path),
    [ATTR_HTTP_RESPONSE_STATUS_CODE]: status,
    "deco.http.status_class": statusClassFor(status),
  };
  if (labels?.outcome) merged["deco.http.outcome"] = labels.outcome;
  if (labels?.cache_decision) merged["deco.cache.decision"] = labels.cache_decision;
  if (labels?.cache_layer) merged["deco.cache.layer"] = labels.cache_layer;
  if (labels?.region) merged["deco.http.region"] = labels.region;
  if (labels?.extra) {
    for (const [k, v] of Object.entries(labels.extra)) {
      // Defense-in-depth — refuse to stamp known per-request identifiers
      // on metric labels. These belong on spans and logs only; putting
      // them here makes every request its own histogram data point and
      // destroys aggregation. Caller-supplied `extra` should remain a
      // low-cardinality escape hatch (A/B variant, feature flag, ...).
      if (HIGH_CARDINALITY_BLOCKLIST.has(k)) continue;
      merged[k] = v;
    }
  }
  // OTel canonical HTTP metrics define a single histogram per direction
  // (`http.server.request.duration` for incoming). The request count is
  // derived from the histogram's `count` field; error rate is derived by
  // filtering on `http.response.status_code`. Separate `_total` /
  // `_errors_total` counters were removed because they duplicate
  // histogram-derived signals and aren't part of the canonical spec.
  // Record in seconds (semconv) — caller passes ms.
  m.histogramRecord?.(
    MetricNames.HTTP_SERVER_REQUEST_DURATION,
    durationMs / 1000,
    merged,
  );
}

/**
 * Cache decision label. Mirrors the `X-Cache` response header we set in
 * `workerEntry.ts` so dashboards can join on it.
 *  - `HIT`         — fresh entry returned from cache
 *  - `STALE-HIT`   — stale entry served, async revalidation kicked off (SWR)
 *  - `STALE-ERROR` — stale entry served because origin errored (SIE)
 *  - `MISS`        — cache lookup returned nothing, origin fetched
 *  - `BYPASS`      — request not eligible for caching (private, cookies, etc.)
 */
export type CacheDecision = "HIT" | "STALE-HIT" | "STALE-ERROR" | "MISS" | "BYPASS";

/**
 * Where the cache lives. Phase 2 label expansion (D-11).
 *  - `edge`         — Cloudflare Cache API (HTML pages, server-fn responses)
 *  - `cachedLoader` — In-memory per-isolate via `sdk/cachedLoader.ts`
 *                     (loader-level SWR, dedup, in-flight)
 *  - `swr`          — Apps-side in-memory SWR fetch cache shared by commerce
 *                     clients (VTEX intelligent-search, Magento GraphQL,
 *                     Shopify, etc.) via `sdk/fetchCache.ts`. Provider-agnostic;
 *                     the specific backend rides on `deco.cache.provider`
 *                     (e.g. `vtex` / `magento` / `shopify`), a separate label
 *                     from `deco.cache.profile` (page-type, set by `edge`).
 *                     Renamed from the old `vtex-swr` once the util was shared.
 */
export type CacheLayer = "edge" | "cachedLoader" | "swr";

/**
 * Record a cache hit/miss metric. Also stamps the decision on the active
 * trace span (when one exists) as `deco.cache.decision` / `deco.cache.profile`
 * so operators can filter ClickStack traces by cache decision directly,
 * without joining to metrics.
 *
 * Backward-compatible signature:
 *   recordCacheMetric(hit, profile?, decision?)
 *   recordCacheMetric(hit, profile?, decision?, layer?)
 *   recordCacheMetric(hit, profile?, decision?, layer?, provider?)
 *
 * `decision` is optional — when omitted, the metric still records HIT
 * vs MISS but dashboards can't distinguish SWR/SIE paths. Pass it
 * whenever known. `layer` defaults to `edge` when called from
 * workerEntry; cachedLoader / swr call sites should pass their
 * value explicitly.
 *
 * `profile` and `provider` are DISTINCT dimensions and must not be
 * conflated: `profile` is the page/route type (`product` / `listing` /
 * `search`, set by the `edge` layer) or loader name (`cachedLoader`);
 * `provider` is the commerce backend (`vtex` / `magento` / `shopify`, set
 * by the `swr` layer). Keeping them on separate labels means a
 * `sum by (profile)` panel never blends page-types with backend
 * names. The `swr` layer passes `provider` and leaves `profile` unset.
 */
export function recordCacheMetric(
  hit: boolean,
  profile?: string,
  decision?: CacheDecision,
  layer?: CacheLayer,
  provider?: string,
) {
  // Stamp on the active span FIRST so the attribute survives even if the
  // meter is a no-op (e.g. on tests, or in dev without DECO_METRICS).
  const active = getActiveSpan();
  if (active) {
    if (decision) active.setAttribute?.("deco.cache.status", decision);
    if (profile) active.setAttribute?.("deco.cache.profile", profile);
    if (layer) active.setAttribute?.("deco.cache.layer", layer);
    if (provider) active.setAttribute?.("deco.cache.provider", provider);
  }

  const m = getState().meter;
  if (!m) return;
  // Single counter dimensioned by status — the metric name deco.cache.requests
  // already scopes the label, so the deco.cache. prefix is redundant on labels.
  // Span attribute keeps the full deco.cache.status key (spans mix attrs from
  // many sources, so the namespace is needed there).
  const labels: Labels = {
    status: decision ?? (hit ? "HIT" : "MISS"),
  };
  if (profile) labels["profile"] = profile;
  if (layer) labels["layer"] = layer;
  if (provider) labels["provider"] = provider;
  m.counterInc(MetricNames.CACHE_REQUESTS, 1, labels);
}

/**
 * Labels for the outbound commerce sample recorded on
 * `http.client.request.duration`. Owned by the framework so apps-start (and
 * any future provider package) can register operation strings without owning
 * the histogram declaration. Phase 2 (D-11).
 */
export interface CommerceMetricLabels {
  /** `vtex`, `shopify`, `wake`, ... — small closed set. */
  provider: string;
  /** Per-provider operation, e.g. `intelligent-search.product_search`. */
  operation: string;
  /** Set when known (e.g. from the HTTP response). Bounded enum. */
  status_class?: string;
  /** Whether the underlying fetch was served from a cache. */
  cached?: boolean;
}

/**
 * Record a commerce / outbound-fetch duration sample. No-op when no meter is
 * configured. Emitted on the canonical `http.client.request.duration` metric
 * (semconv) — providers vary by the `provider`/`operation` labels, not by
 * name, so dashboards aggregate cleanly across the fleet.
 */
export function recordCommerceMetric(
  durationMs: number,
  labels: CommerceMetricLabels,
) {
  const m = getState().meter;
  if (!m) return;
  const merged: Labels = {
    provider: labels.provider,
    operation: labels.operation,
  };
  if (labels.status_class) merged.status_class = labels.status_class;
  if (typeof labels.cached === "boolean") merged.cached = labels.cached;
  // Canonical OTel HTTP client metric — outbound commerce calls share the
  // same metric as any other outbound HTTP request; `peer.service` /
  // `commerce.operation` attributes disambiguate consumer queries.
  // Record in seconds (semconv) — caller passes ms.
  m.histogramRecord?.(
    MetricNames.HTTP_CLIENT_REQUEST_DURATION,
    durationMs / 1000,
    merged,
  );
}

/**
 * Record a loader execution sample. Call from `cachedLoader` after the
 * loader resolves or rejects. `cache_status` mirrors `CacheDecision` so
 * dashboards can distinguish HIT (fresh) from STALE-HIT (SWR), STALE-ERROR
 * (SIE fallback), MISS (origin fetch), and BYPASS (dev / no-store).
 */
export function recordLoaderMetric(
  name: string,
  durationMs: number,
  cacheStatus: CacheDecision | "BYPASS",
) {
  const m = getState().meter;
  if (!m) return;
  // Record in seconds (semconv) — caller passes ms.
  m.histogramRecord?.(MetricNames.LOADER_DURATION, durationMs / 1000, {
    "deco.loader.name": name,
    "deco.cache.result": cacheStatus,
  });
}

/**
 * Increment the loader error counter. Call when a loader throws and the
 * error is not swallowed by a SIE fallback.
 */
export function recordLoaderError(name: string) {
  const m = getState().meter;
  if (!m) return;
  m.counterInc(MetricNames.LOADER_ERRORS, 1, { "deco.loader.name": name });
}

/**
 * Collapse dynamic path segments (ids, product slugs) into placeholders so a
 * path can be used as a bounded metric label. Exported so every metric that
 * labels by route (`http.server.request.duration`, `deco.cms.resolve.duration`)
 * shares the exact same normalization — a raw path is unbounded cardinality
 * (one histogram series per URL) and must never reach a metric attribute.
 */
export function normalizePath(path: string): string {
  // Collapse dynamic segments to reduce cardinality
  const collapsed = path
    .replace(/\/[0-9a-f]{8,}/gi, "/:id")
    .replace(/\/\d+/g, "/:id")
    .replace(/\/[^/]+\/p$/, "/:slug/p");

  // Content slugs are the case none of the rules above catch: they carry no
  // digits, no hex id and no `/p` suffix, so a CMS page passes through as its
  // own literal path and becomes its own series.
  //
  //   /mochila-de-couro
  //   /moveis/quarto-infantil
  //   /granado/eau-de-toilette-spritz-100ml
  //
  // Measured on the production ClickHouse, `http.route` reached 20,714
  // distinct values across only 6 tenants — on `http.server.request.duration`,
  // the highest-volume metric in the pipeline (19M rows / 3h).
  //
  // A hyphen is the discriminator. CMS slugs are hyphenated by construction,
  // while framework and API segments are single words (`api`, `sessions`,
  // `deco`, `invoke`, `loaders`, `render`). Dotfile segments such as
  // `.well-known` are excluded so they keep their meaning.
  return collapsed
    .split("/")
    .map((segment) =>
      segment.includes("-") && !segment.startsWith(".") ? ":slug" : segment,
    )
    .join("/");
}

// ---------------------------------------------------------------------------
// Request logging
// ---------------------------------------------------------------------------

const isDev =
  typeof globalThis.process !== "undefined" && globalThis.process.env?.NODE_ENV === "development";

/**
 * Structured request log entry.
 * JSON in production, colorized in development.
 * Includes traceId when available.
 */
export function logRequest(
  request: Request,
  status: number,
  durationMs: number,
  extra?: Record<string, unknown>,
) {
  const url = new URL(request.url);
  // Truncate long paths (e.g. /_serverFn/ base64 payloads) so log messages
  // remain readable. Full path is preserved in the `path` attribute.
  const rawPath = url.pathname;
  const displayPath = rawPath.length > 80 ? `${rawPath.slice(0, 80)}…` : rawPath;
  // Route through the framework logger so the access log fans out to every
  // configured adapter — local stdout via `defaultLoggerAdapter`, OTLP direct-
  // POST via `otlpLog.adapter` when configured (subject to its
  // `DECO_OTEL_LOGS_MIN_LEVEL` threshold). Always debug: filtered in prod
  // (default `warn` minLevel), visible in dev with DECO_OTEL_LOGS_MIN_LEVEL=debug.
  // 5xx errors are already logged at the throw site with full context; the
  // access log is just a dev convenience, not a production alert source.
  logger.debug(`${request.method} ${displayPath} ${status}`, {
    method: request.method,
    path: rawPath,
    status,
    duration_ms: Math.round(durationMs),
    ...extra,
  });
}

// noopRequestStore is kept as a no-op fallback for advanced tests; not
// re-exported because consumers should reach for `setObservabilitySpanStore`
// instead.
void noopRequestStore;
