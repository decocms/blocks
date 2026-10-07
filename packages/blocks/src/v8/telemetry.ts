/**
 * Telemetry: OpenTelemetry over OTLP/HTTP (JSON, gzipped), with no SDK. See
 * /next/telemetry and /next/telemetry-internals.
 *
 * - **Where** comes from code: `createCMS({ telemetry })`, or the standard
 *   `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` (and the
 *   per-signal `OTEL_EXPORTER_OTLP_{METRICS,LOGS,TRACES}_ENDPOINT`) when it's
 *   left out. v7's `DECO_OTEL_*` names are read as aliases; the standard name
 *   wins when both are set. `false` sends nothing.
 * - **How much** comes from content: the `telemetry` section of the CMS
 *   settings (`cms.settings()`, the release's `CMS` block), capped by
 *   `telemetry.limits`. The CMS reads it outside any request, when the
 *   release changes and then at most once a minute.
 * - Metrics are aggregated in memory (delta histograms); error logs and traces
 *   are sampled. Batches leave in the background (after the response on
 *   Workers, on an unref'd timer elsewhere); a send that fails is retried
 *   once on 429/502/503/504 and otherwise dropped.
 * - Everything is scrubbed before encoding: no query strings, tokens,
 *   cookies or authorization values, and no value a secret block decrypted.
 */
import { hasBackgroundHook, later, runInBackground } from "./background.ts";
import { rate, TELEMETRY_DEFAULTS } from "./builtins/data.ts";
import { isResolutionError } from "./errors.ts";
import { readEnv } from "./identity.ts";
import type { CMSError, Snapshot, Telemetry, TelemetryConfig } from "./types.ts";

/** The hosted Deco CMS collector, for `telemetry: { site, token }`. */
const HOSTED_TELEMETRY_ENDPOINT = "https://otel.decocms.com";

const SINK = Symbol.for("decocms.blocks.telemetry");
const FLUSH_MS = 10_000;
const MAX_LOGS = 200;
const MAX_SPANS = 1_000;
const MAX_SECRETS = 1_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
/** OpenTelemetry's recommended `http.*.request.duration` buckets, in seconds. */
const BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
const DEFAULT_LIMITS = { errorSampleRate: 0.1, traceSampleRate: 0 };

/** The caps on content's sample rates: `telemetry.limits`, defaults 0.1 and 0. */
export function telemetryLimits(config: false | TelemetryConfig | undefined): {
  errorSampleRate: number;
  traceSampleRate: number;
} {
  const limits = config ? config.limits : undefined;
  return {
    errorSampleRate: rate(limits?.errorSampleRate, DEFAULT_LIMITS.errorSampleRate),
    traceSampleRate: rate(limits?.traceSampleRate, DEFAULT_LIMITS.traceSampleRate),
  };
}

type Attributes = Record<string, string | number | boolean | undefined>;

type Signal = "metrics" | "logs" | "traces";

interface Destination {
  /** The base URL each signal's `/v1/<signal>` is appended to; `""` with per-signal URLs only. */
  endpoint: string;
  /** Full per-signal URLs, used as they are (the `OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT` form). */
  signals?: Partial<Record<Signal, string>>;
  headers: Record<string, string>;
  site?: string;
  limits: { errorSampleRate: number; traceSampleRate: number };
}

interface SpanInput {
  name: string;
  kind: "internal" | "server" | "client";
  traceId: string;
  parentSpanId?: string;
  /** Epoch milliseconds. */
  start: number;
  end: number;
  attributes: Attributes;
  error?: boolean;
}

/** What a client reports: block runs (spans when sampled, failures as error logs) and errors. */
export interface ClientTelemetry {
  block(type: string, start: number, end: number, error?: unknown): void;
  error(error: CMSError): void;
}

interface Histogram {
  name: string;
  attributes: Attributes;
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: number[];
}

interface LogRecord {
  time: number;
  message: string;
  attributes: Attributes;
}

/**
 * Where telemetry goes, or `null` for nowhere. `{ site, token }` or
 * `{ endpoint }` with an empty value (an unset environment variable) is off.
 */
export function resolveDestination(
  config: false | TelemetryConfig | undefined,
  site?: string,
): Destination | null {
  if (config === false) return null;
  if (config === undefined || config === null) return destinationFromEnv(site);
  const limits = telemetryLimits(config);
  if ("endpoint" in config) {
    if (typeof config.endpoint !== "string" || !config.endpoint) return null;
    return { endpoint: config.endpoint, headers: { ...config.headers }, site, limits };
  }
  if (!config.site || !config.token) return null;
  return {
    endpoint: HOSTED_TELEMETRY_ENDPOINT,
    headers: { authorization: `Bearer ${config.token}` },
    site: config.site,
    limits,
  };
}

/** v7's names for the standard OTLP variables, read when the standard one is unset. */
const V7_ALIASES = {
  OTEL_EXPORTER_OTLP_HEADERS: "DECO_OTEL_HEADERS",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "DECO_OTEL_METRICS_ENDPOINT",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "DECO_OTEL_LOGS_ENDPOINT",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "DECO_OTEL_TRACES_ENDPOINT",
} as const;

/** The standard variable, else its v7 alias. */
function readOtlpEnv(name: keyof typeof V7_ALIASES | "OTEL_EXPORTER_OTLP_ENDPOINT") {
  return (
    readEnv(name) ||
    (name in V7_ALIASES ? readEnv(V7_ALIASES[name as keyof typeof V7_ALIASES]) : undefined)
  );
}

/**
 * The destination the environment names: the standard OTLP variables, with
 * v7's `DECO_OTEL_*` names as aliases. `DECO_OTEL_AUTH_TOKEN` (v7's secret
 * for the collector) becomes the `authorization` header unless the headers
 * set one. `null` when no endpoint is set.
 */
function destinationFromEnv(site: string | undefined): Destination | null {
  const endpoint = readOtlpEnv("OTEL_EXPORTER_OTLP_ENDPOINT") ?? "";
  const signals: Partial<Record<Signal, string>> = {};
  for (const signal of ["metrics", "logs", "traces"] as const) {
    const url = readOtlpEnv(
      `OTEL_EXPORTER_OTLP_${signal.toUpperCase() as Uppercase<Signal>}_ENDPOINT`,
    );
    if (url) signals[signal] = url;
  }
  if (!endpoint && Object.keys(signals).length === 0) return null;
  const token = readEnv("DECO_OTEL_AUTH_TOKEN");
  const headers = {
    ...(token ? { authorization: token } : {}),
    ...parseKeyValues(readOtlpEnv("OTEL_EXPORTER_OTLP_HEADERS")),
  };
  return { endpoint, signals, headers, site, limits: DEFAULT_LIMITS };
}

export class TelemetryPipeline {
  readonly #destination: Destination;
  #settings: Required<Telemetry> = { ...TELEMETRY_DEFAULTS };
  #release: string | undefined;
  #histograms = new Map<string, Histogram>();
  #logs: LogRecord[] = [];
  #spans: (SpanInput & { spanId: string })[] = [];
  #windowStart = Date.now();
  #scheduled = false;
  /** Values secret blocks decrypted, replaced with `[redacted]` wherever they'd be sent. */
  readonly #secrets = new Set<string>();

  constructor(destination: Destination) {
    this.#destination = destination;
    this.apply(TELEMETRY_DEFAULTS);
  }

  /** Never send `value`: it's replaced with `[redacted]` in every log, span and label. */
  redact(value: string): void {
    if (value.length > 0 && this.#secrets.size < MAX_SECRETS) this.#secrets.add(value);
  }

  /** The release being served: its revision labels batches. */
  useRelease(snapshot: Snapshot): void {
    this.#release = snapshot.revision;
  }

  /**
   * The `telemetry` section to follow (from `cms.settings()`). Rates are
   * capped by the destination's limits here too, whatever the caller passed.
   */
  apply(section: Telemetry): void {
    const { limits } = this.#destination;
    this.#settings = {
      enabled: typeof section.enabled === "boolean" ? section.enabled : TELEMETRY_DEFAULTS.enabled,
      metrics: typeof section.metrics === "boolean" ? section.metrics : TELEMETRY_DEFAULTS.metrics,
      errorSampleRate: Math.min(
        rate(section.errorSampleRate, TELEMETRY_DEFAULTS.errorSampleRate),
        limits.errorSampleRate,
      ),
      traceSampleRate: Math.min(
        rate(section.traceSampleRate, TELEMETRY_DEFAULTS.traceSampleRate),
        limits.traceSampleRate,
      ),
    };
  }

  histogram(name: string, attributes: Attributes, seconds: number): void {
    if (!this.#settings.enabled || !this.#settings.metrics) return;
    const key = `${name}\u0000${JSON.stringify(attributes)}`;
    let histogram = this.#histograms.get(key);
    if (histogram === undefined) {
      histogram = {
        name,
        attributes,
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        buckets: new Array(BOUNDS.length + 1).fill(0),
      };
      this.#histograms.set(key, histogram);
    }
    histogram.count++;
    histogram.sum += seconds;
    histogram.min = Math.min(histogram.min, seconds);
    histogram.max = Math.max(histogram.max, seconds);
    const bucket = BOUNDS.findIndex((bound) => seconds <= bound);
    histogram.buckets[bucket === -1 ? BOUNDS.length : bucket]++;
    this.#schedule();
  }

  /** An error log, kept at the error sample rate. */
  error(message: string, attributes: Attributes): void {
    if (!this.#settings.enabled || Math.random() >= this.#settings.errorSampleRate) return;
    if (this.#logs.length >= MAX_LOGS) return;
    this.#logs.push({ time: Date.now(), message, attributes });
    this.#schedule();
  }

  /** Whether to trace one request (or one upstream call), at the trace sample rate. */
  sampleTrace(): boolean {
    return this.#settings.enabled && Math.random() < this.#settings.traceSampleRate;
  }

  span(span: SpanInput): void {
    if (!this.#settings.enabled || this.#spans.length >= MAX_SPANS) return;
    this.#spans.push({ ...span, spanId: randomHex(8) });
    this.#schedule();
  }

  /**
   * The hooks one client reports through. The trace decision is made once per
   * client, on its first block, after its release is loaded, so the first
   * client of a release already uses that release's `telemetry` section.
   */
  forClient(): ClientTelemetry {
    let decided = false;
    let traceId: string | undefined;
    return {
      block: (type, start, end, error) => {
        if (!decided) {
          decided = true;
          traceId = this.sampleTrace() ? newTraceId() : undefined;
        }
        if (traceId !== undefined) {
          this.span({
            name: type,
            kind: "internal",
            traceId,
            start,
            end,
            attributes: { "deco.block.type": type },
            error: error !== undefined,
          });
        }
        // A ResolutionError was already reported where it started.
        if (error !== undefined && !isResolutionError(error)) {
          this.error(`block "${type}" failed: ${describe(error)}`, {
            "error.code": "BLOCK_FAILED",
            "deco.block.type": type,
          });
        }
      },
      error: (error) => {
        // Block failures arrive through block(); a missing name is ordinary.
        if (error.code === "NOT_FOUND" || error.code === "BLOCK_FAILED") return;
        // A loader's message can quote a draft pointer (and its token): never send it.
        const message = error.code === "LOADER_FAILED" ? "content loader failed" : error.message;
        this.error(message, { "error.code": error.code, "deco.path": error.path.join(".") });
      },
    };
  }

  /** Sends what's been collected since the last batch. Never throws. */
  async flush(): Promise<void> {
    const now = Date.now();
    const start = this.#windowStart;
    this.#windowStart = now;
    const histograms = [...this.#histograms.values()];
    const logs = this.#logs;
    const spans = this.#spans;
    this.#histograms = new Map();
    this.#logs = [];
    this.#spans = [];
    const scrub = (text: string) => this.#scrub(text);
    const encode = (attributes: Attributes) => encodeAttributes(attributes, scrub);
    const resource = { attributes: encode(this.#resource()) };
    const scope = { name: "@decocms/blocks" };
    const sends: Promise<void>[] = [];
    if (histograms.length > 0) {
      const byName = new Map<string, Histogram[]>();
      for (const h of histograms) byName.set(h.name, [...(byName.get(h.name) ?? []), h]);
      sends.push(
        this.#send("metrics", {
          resourceMetrics: [
            {
              resource,
              scopeMetrics: [
                {
                  scope,
                  metrics: [...byName].map(([name, points]) => ({
                    name,
                    unit: "s",
                    histogram: {
                      aggregationTemporality: 1, // DELTA
                      dataPoints: points.map((h) => ({
                        attributes: encode(h.attributes),
                        startTimeUnixNano: nanos(start),
                        timeUnixNano: nanos(now),
                        count: String(h.count),
                        sum: h.sum,
                        min: h.min,
                        max: h.max,
                        bucketCounts: h.buckets.map(String),
                        explicitBounds: BOUNDS,
                      })),
                    },
                  })),
                },
              ],
            },
          ],
        }),
      );
    }
    if (logs.length > 0) {
      sends.push(
        this.#send("logs", {
          resourceLogs: [
            {
              resource,
              scopeLogs: [
                {
                  scope,
                  logRecords: logs.map((log) => ({
                    timeUnixNano: nanos(log.time),
                    severityNumber: 17,
                    severityText: "ERROR",
                    body: { stringValue: scrub(log.message) },
                    attributes: encode(log.attributes),
                  })),
                },
              ],
            },
          ],
        }),
      );
    }
    if (spans.length > 0) {
      const kinds = { internal: 1, server: 2, client: 3 };
      sends.push(
        this.#send("traces", {
          resourceSpans: [
            {
              resource,
              scopeSpans: [
                {
                  scope,
                  spans: spans.map((span) => ({
                    traceId: span.traceId,
                    spanId: span.spanId,
                    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                    name: span.name,
                    kind: kinds[span.kind],
                    startTimeUnixNano: nanos(span.start),
                    endTimeUnixNano: nanos(span.end),
                    attributes: encode(span.attributes),
                    status: { code: span.error ? 2 : 0 },
                  })),
                },
              ],
            },
          ],
        }),
      );
    }
    await Promise.all(sends);
  }

  #scrub(text: string): string {
    let out = text;
    for (const secret of this.#secrets) out = out.split(secret).join("[redacted]");
    return scrubText(out);
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    if (!hasBackgroundHook()) {
      later(FLUSH_MS, () => {
        this.#scheduled = false;
        void this.flush();
      });
      return;
    }
    // With a host hook (Workers: after the response, in ctx.waitUntil),
    // a batch goes out once it's FLUSH_MS old; a younger one stays pending
    // and a later request's measurement schedules it again.
    runInBackground(() => {
      this.#scheduled = false;
      if (Date.now() - this.#windowStart < FLUSH_MS) return;
      return this.flush();
    });
  }

  #resource(): Attributes {
    const site = this.#destination.site;
    return {
      "service.name": readEnv("OTEL_SERVICE_NAME") || site || "decocms-site",
      "service.version": firstEnv(COMMIT_VARIABLES) ?? "unknown",
      "deployment.environment.name":
        readEnv("VERCEL_ENV") ||
        (readEnv("NODE_ENV") === "development" ? "development" : "production"),
      ...(site ? { "deco.site": site } : {}),
      ...(this.#release ? { "deco.release": this.#release } : {}),
      // The standard OTel override wins: service.version=<commit>,
      // deployment.environment.name=preview, service.name=…
      ...parseKeyValues(readEnv("OTEL_RESOURCE_ATTRIBUTES")),
    };
  }

  async #send(signal: Signal, payload: unknown): Promise<void> {
    const { endpoint, signals } = this.#destination;
    const url =
      signals?.[signal] ?? (endpoint ? `${endpoint.replace(/\/+$/, "")}/v1/${signal}` : "");
    if (!url) return; // this signal has no destination
    const { body, gzipped } = await gzip(JSON.stringify(payload));
    const headers: Record<string, string> = {
      ...this.#destination.headers,
      "content-type": "application/json",
    };
    if (gzipped) headers["content-encoding"] = "gzip";
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, { method: "POST", headers, body });
      } catch {
        return; // a collector that's down loses this batch
      }
      void response.body?.cancel().catch(() => {});
      if (response.ok || !RETRY_STATUSES.has(response.status) || attempt >= 1) return;
      await new Promise((resolve) => later(1_000, () => resolve(undefined)));
    }
  }
}

// ---------------------------------------------------------------------------
// The process's active pipeline, which the instrumented fetch reports to
// ---------------------------------------------------------------------------

/** The pipeline the instrumented fetch reports to: the latest CMS created with telemetry. */
export function currentTelemetry(): TelemetryPipeline | undefined {
  return (globalThis as Record<symbol, TelemetryPipeline | undefined>)[SINK];
}

export function setCurrentTelemetry(pipeline: TelemetryPipeline | undefined): void {
  (globalThis as Record<symbol, TelemetryPipeline | undefined>)[SINK] = pipeline;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Where hosts put the deployed commit, tried in order (`service.version`). */
const COMMIT_VARIABLES = [
  "DECO_COMMIT_SHA",
  "WORKERS_CI_COMMIT_SHA",
  "CF_PAGES_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "GITHUB_SHA",
  "RENDER_GIT_COMMIT",
  "SOURCE_VERSION",
  "COMMIT_SHA",
];

function firstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = readEnv(name);
    if (value) return value;
  }
  return undefined;
}

const QUERY = /(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/gi;
const CREDENTIAL = /\b(Bearer|Basic)\s+[\w~+/.=-]+/gi;
const SENSITIVE =
  /\b(authorization|cookie|set-cookie|x-api-key|api[-_]?key|app[-_]?key|app[-_]?token|token|secret|password)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;

/** Removes query strings, credentials and cookie/token values from text before it's sent. */
function scrubText(text: string): string {
  return text
    .replace(QUERY, "$1?[redacted]")
    .replace(CREDENTIAL, "$1 [redacted]")
    .replace(SENSITIVE, "$1$2[redacted]")
    .slice(0, 1_000);
}

export function newTraceId(): string {
  return randomHex(16);
}

export function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `k1=v1,k2=v2` with URL-encoded values, the format of the OTEL_* environment variables. */
function parseKeyValues(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw?.split(",") ?? []) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    try {
      out[decodeURIComponent(pair.slice(0, at).trim())] = decodeURIComponent(
        pair.slice(at + 1).trim(),
      );
    } catch {
      // A malformed pair is skipped.
    }
  }
  return out;
}

function encodeAttributes(attributes: Attributes, scrub: (text: string) => string) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({
      key,
      value:
        typeof value === "string"
          ? { stringValue: scrub(value) }
          : typeof value === "boolean"
            ? { boolValue: value }
            : Number.isInteger(value)
              ? { intValue: String(value) }
              : { doubleValue: value },
    }));
}

function nanos(ms: number): string {
  return `${Math.round(ms)}000000`;
}

async function gzip(text: string): Promise<{ body: BodyInit; gzipped: boolean }> {
  if (typeof CompressionStream !== "function") return { body: text, gzipped: false };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return { body: new Uint8Array(await new Response(stream).arrayBuffer()), gzipped: true };
}
