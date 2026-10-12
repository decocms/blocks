/**
 * Telemetry: OpenTelemetry over OTLP/HTTP (JSON, gzipped), with no SDK. See
 * /next/telemetry and /next/telemetry-internals.
 *
 * - **Where** comes from code only: `createCMS({ telemetry: { endpoint,
 *   headers } })`, else the hosted Deco CMS collector when `createCMS` has a
 *   `token` (sent as a Bearer token), else nowhere. `false` sends nothing.
 *   Nothing is read from the environment.
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
import type { CMSError, Snapshot, Telemetry, TelemetryConfig } from "./types.ts";

/** The hosted Deco CMS collector, for `createCMS({ token })`. */
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
  /** The base URL each signal's `/v1/<signal>` is appended to. */
  endpoint: string;
  headers: Record<string, string>;
  site?: string;
  /** `telemetry.resource`: merged over the default resource attributes. */
  resource: Record<string, string>;
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
 * Where telemetry goes, or `null` for nowhere: `false` is off; a non-empty
 * `endpoint` is that collector, with `headers`; otherwise a `token` is the
 * hosted Deco CMS collector, with the token as a Bearer credential.
 */
export function resolveDestination(
  config: false | TelemetryConfig | undefined,
  site?: string,
  token?: string,
): Destination | null {
  if (config === false) return null;
  // OPEN: no per-signal URLs (v7's OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT): every signal goes to `<endpoint>/v1/<signal>`.
  const limits = telemetryLimits(config);
  const resource = { ...config?.resource };
  if (typeof config?.endpoint === "string" && config.endpoint) {
    return { endpoint: config.endpoint, headers: { ...config.headers }, site, resource, limits };
  }
  if (!token) return null;
  return {
    endpoint: HOSTED_TELEMETRY_ENDPOINT,
    headers: { authorization: `Bearer ${token}` },
    site,
    resource,
    limits,
  };
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
      "service.name": site || "decocms-site",
      "service.version": "unknown",
      // OPEN: the environment name defaults to "production"; `telemetry.resource` overrides it.
      "deployment.environment.name": "production",
      ...(site ? { "deco.site": site } : {}),
      ...(this.#release ? { "deco.release": this.#release } : {}),
      // `telemetry.resource` wins: service.version=<commit>, deployment.environment.name=preview, …
      ...this.#destination.resource,
    };
  }

  async #send(signal: Signal, payload: unknown): Promise<void> {
    const url = `${this.#destination.endpoint.replace(/\/+$/, "")}/v1/${signal}`;
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
