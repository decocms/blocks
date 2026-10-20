/**
 * `@decocms/blocks/fetch`: blocks' HTTP request metrics, client and server,
 * on the CMS's telemetry in the same process (OpenTelemetry's recommended
 * buckets, in seconds). See /next/upstream-clients, /next/telemetry and
 * /next/api-reference#createinstrumentedfetch-options.
 *
 * - `createInstrumentedFetch`: the instrumented fetch every upstream client
 *   uses. Each request is timed until its response headers arrive and
 *   measured once (`http.client.request.duration`), with `provider`,
 *   `operation`, `status_class`, `cached` and `retries` labels, however many
 *   retries it took. Nothing about a request's body, headers or query string
 *   is recorded.
 * - `recordServerRequest` and `measuringServerRequests`: the site's own
 *   request metric, `http.server.request.duration`, which the framework
 *   bindings record (`createDecoWorker` in `@decocms/tanstack`, `register`
 *   from `@decocms/nextjs/instrumentation`), labelled `http.route`,
 *   `http.request.method`, `status_class`, `cache` and, when the binding
 *   knows it, `device`. Every label is normalized to a short list of values
 *   so the metric stays low-cardinality whatever the binding passes.
 *
 * With no telemetry destination (no `token` and no `endpoint`, or
 * `metrics: false` in the content) nothing is recorded, and nothing here ever
 * throws into a request because of a metric.
 */
import { currentTelemetry, describe, newTraceId } from "./telemetry.ts";

interface InstrumentedFetchOptions {
  /** The provider label, e.g. "vtex", "acme-search". */
  provider: string;
  /**
   * The fetch underneath; defaults to `globalThis.fetch`. An upstream cache
   * goes here (see /next/caching#upstream-data); a response it serves from
   * the cache carries `x-cache: HIT` and is measured with `cached=true`.
   */
  fetch?: typeof fetch;
  /** Off unless set. `attempts` is how many times a failed request is retried; a retried request is measured once. */
  retry?: { attempts: number; backoffMs?: number };
  /** Off unless set: after `failures` consecutive failures, fail fast for `cooldownMs`. */
  circuitBreaker?: { failures: number; cooldownMs: number };
}

type InstrumentedFetch = (
  input: string | URL | Request,
  init?: RequestInit & { operation?: string },
) => Promise<Response>;

/** Statuses worth retrying: rate limits and gateway errors. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
/** Only requests that are safe to repeat are retried. */
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

export function createInstrumentedFetch(options: InstrumentedFetchOptions): InstrumentedFetch {
  const { provider, retry, circuitBreaker } = options;
  let failures = 0;
  let openUntil = 0;

  return async (input, init = {}) => {
    const { operation = "unknown", ...requestInit } = init;
    const method = (
      requestInit.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const doFetch = options.fetch ?? globalThis.fetch;
    const maxRetries =
      retry && IDEMPOTENT.has(method) ? Math.max(0, Math.floor(retry.attempts)) : 0;
    const startedAt = Date.now();
    const started = performance.now();
    let retries = 0;
    let response: Response | undefined;
    let failure: unknown;

    if (circuitBreaker && failures >= circuitBreaker.failures && Date.now() < openUntil) {
      failure = new Error(`${provider} ${operation}: circuit open after ${failures} failures`);
    } else {
      for (;;) {
        try {
          response = await doFetch(
            maxRetries > 0 && input instanceof Request ? input.clone() : input,
            requestInit,
          );
          failure = undefined;
        } catch (error) {
          response = undefined;
          failure = error;
        }
        const retryable =
          response !== undefined ? RETRY_STATUSES.has(response.status) : !isAbort(failure);
        if (!retryable || retries >= maxRetries) break;
        void response?.body?.cancel().catch(() => {});
        await new Promise((resolve) =>
          setTimeout(resolve, (retry?.backoffMs ?? 100) * 2 ** retries),
        );
        retries++;
      }
      if (circuitBreaker) {
        const failed = response === undefined || response.status >= 500;
        failures = failed ? failures + 1 : 0;
        if (failed && failures >= circuitBreaker.failures) {
          openUntil = Date.now() + circuitBreaker.cooldownMs;
        }
      }
    }

    const telemetry = currentTelemetry();
    if (telemetry !== undefined) {
      const labels = {
        provider,
        operation,
        status_class: response ? `${Math.floor(response.status / 100)}xx` : "error",
        // An upstream cache is the site's own `fetch` option; it marks a hit `x-cache: HIT`.
        cached: response?.headers.get("x-cache") === "HIT",
        retries,
      };
      telemetry.histogram(
        "http.client.request.duration",
        labels,
        (performance.now() - started) / 1000,
      );
      if (response === undefined) {
        telemetry.error(`${provider} ${operation} failed: ${describe(failure)}`, {
          "error.code": "FETCH_FAILED",
          provider,
          operation,
        });
      }
      if (telemetry.sampleTrace()) {
        telemetry.span({
          name: `${provider} ${operation}`,
          kind: "client",
          traceId: newTraceId(),
          start: startedAt,
          end: Date.now(),
          attributes: { ...labels, "http.response.status_code": response?.status },
          error: response === undefined || response.status >= 500,
        });
      }
    }

    if (response === undefined) throw failure;
    return response;
  };
}

function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

// ---------------------------------------------------------------------------
// http.server.request.duration
// ---------------------------------------------------------------------------

/** The metric's name. */
const SERVER_REQUEST_DURATION = "http.server.request.duration";

/** OpenTelemetry's well-known methods; anything else is `_OTHER`. */
const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "CONNECT",
  "OPTIONS",
  "TRACE",
  "PATCH",
]);
const CACHE = new Set(["HIT", "MISS", "BYPASS", "DRAFT"]);
const DEVICES = new Set(["mobile", "tablet", "desktop"]);
const MAX_ROUTE = 200;

/** One request a binding served. */
interface ServerRequest {
  /**
   * The matched route's template (`/`, `/:slug/p`, `/_serverFn/*`), never
   * the request's path. Missing or empty: `"unmatched"`.
   */
  route?: string;
  /** The request's method; one OpenTelemetry doesn't know is `_OTHER`. */
  method: string;
  /** The response's status; a request that threw is a 500. */
  status: number;
  /** The binding's own cache decision; anything else is `BYPASS`. */
  cache: "HIT" | "MISS" | "BYPASS" | "DRAFT";
  /** `mobile`, `tablet` or `desktop`; left out otherwise. */
  device?: string;
  /** From the request to the response's headers. */
  seconds: number;
}

/**
 * Whether a request recorded now would be kept: a binding asks before work
 * it does only for the metric (finding the route), so that work costs
 * nothing with telemetry off.
 */
export function measuringServerRequests(): boolean {
  try {
    return currentTelemetry()?.measuring() === true;
  } catch {
    return false;
  }
}

/** Records one served request as `http.server.request.duration`. Never throws. */
export function recordServerRequest(request: ServerRequest): void {
  try {
    const telemetry = currentTelemetry();
    if (telemetry === undefined || !telemetry.measuring()) return;
    const seconds = Number(request.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const method = String(request.method ?? "").toUpperCase();
    const status = Number(request.status);
    const route =
      typeof request.route === "string" && request.route !== ""
        ? request.route.slice(0, MAX_ROUTE)
        : "unmatched";
    const device = typeof request.device === "string" ? request.device : "";
    telemetry.histogram(
      SERVER_REQUEST_DURATION,
      {
        "http.route": route,
        "http.request.method": METHODS.has(method) ? method : "_OTHER",
        status_class:
          Number.isInteger(status) && status >= 100 && status <= 599
            ? `${Math.floor(status / 100)}xx`
            : "5xx",
        cache: CACHE.has(request.cache) ? request.cache : "BYPASS",
        ...(DEVICES.has(device) ? { device } : {}),
      },
      seconds,
    );
  } catch {
    // A metric never breaks a request.
  }
}
