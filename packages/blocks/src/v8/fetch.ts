/**
 * `@decocms/blocks/fetch`: the instrumented fetch every upstream client uses.
 * See /next/upstream-clients and /next/api-reference#createinstrumentedfetch-options.
 *
 * Each request is timed until its response headers arrive and measured once
 * (`http.client.request.duration`), with `provider`, `operation`,
 * `status_class`, `cached` and `retries` labels, however many retries it
 * took. Measurements go to the CMS in the same process, and nowhere when it
 * has no telemetry destination. Nothing about a request's body, headers or
 * query string is recorded.
 */
import { currentTelemetry, describe, newTraceId } from "./telemetry";

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
