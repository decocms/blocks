/**
 * `@decocms/blocks/metrics`: the site's own request metric, for the framework
 * bindings (`createDecoWorker` in `@decocms/tanstack`). See /next/telemetry.
 *
 * `http.server.request.duration` (seconds, OpenTelemetry's recommended
 * buckets, the same as `http.client.request.duration`) goes to the CMS's
 * telemetry in the same process, labelled `http.route`,
 * `http.request.method`, `status_class`, `cache` and, when the binding knows
 * it, `device`. Every label is normalized to a short list of values so the
 * metric stays low-cardinality whatever the binding passes. With telemetry off
 * (no `token` and no `endpoint`, or `metrics: false` in the content) nothing
 * is recorded, and nothing here ever throws into a request.
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
