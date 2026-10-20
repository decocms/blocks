/**
 * `@decocms/blocks/metrics`: the site's own request metric, for the framework
 * bindings (`createDecoWorker` in `@decocms/tanstack`, `register` from
 * `@decocms/nextjs/instrumentation`). Sites don't import it: a binding records
 * every request it serves. See /next/telemetry.
 *
 * One function, `recordServerRequest`, records one served request as
 * `http.server.request.duration` (seconds, OpenTelemetry's recommended
 * buckets, the same as the upstream clients' `http.client.request.duration`)
 * in the CMS's telemetry in the same process, labelled `http.route`,
 * `http.request.method`, `status_class`, `cache` and, when the binding knows
 * it, `device`. Every label is normalized to a short list of values so the
 * metric stays low-cardinality whatever the binding passes.
 *
 * Off when telemetry is off: with no telemetry destination (no `token` and no
 * `endpoint`) or `metrics: false` in the content it records nothing and never
 * calls the binding's route function, so finding the route costs nothing.
 * It never throws and its promise never rejects: a binding hands it to
 * `waitUntil` (or lets it run) and a metric never breaks a request.
 */
import { currentTelemetry } from "./telemetry.ts";

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
   * the request's path, or a function that finds it: called (and awaited)
   * only while telemetry measures. Missing, empty, or a function that throws
   * or rejects: `"unmatched"`.
   */
  route: string | undefined | (() => string | undefined | Promise<string | undefined>);
  /** The request's method; one OpenTelemetry doesn't know is `_OTHER`. */
  method: string;
  /** The response's status; a request that threw is a 500. */
  status: number;
  /** The binding's own cache decision; anything else is `BYPASS`. */
  cache: "HIT" | "MISS" | "BYPASS" | "DRAFT";
  /** `mobile`, `tablet` or `desktop`; left out otherwise. */
  device?: "mobile" | "tablet" | "desktop";
  /** From the request to the response's headers. */
  seconds: number;
}

/**
 * Records one served request as `http.server.request.duration`. Resolves
 * without doing anything (not even calling `route`) when telemetry is off;
 * never rejects.
 */
export async function recordServerRequest(request: ServerRequest): Promise<void> {
  try {
    const telemetry = currentTelemetry();
    if (telemetry === undefined || !telemetry.measuring()) return;
    const seconds = Number(request.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) return;
    let route: unknown;
    try {
      route = typeof request.route === "function" ? await request.route() : request.route;
    } catch {
      route = undefined;
    }
    const method = String(request.method ?? "").toUpperCase();
    const status = Number(request.status);
    const device = typeof request.device === "string" ? request.device : "";
    telemetry.histogram(
      SERVER_REQUEST_DURATION,
      {
        "http.route":
          typeof route === "string" && route !== "" ? route.slice(0, MAX_ROUTE) : "unmatched",
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
