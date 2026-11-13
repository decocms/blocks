/**
 * Server errors on the CMS's existing sampled OTLP pipeline. Framework
 * bindings call this at their own error boundaries; reporting never replaces
 * an exception, changes a response, or installs a process-wide handler.
 */
import { isResolutionError } from "./errors.ts";
import { currentTelemetry } from "./telemetry.ts";

export interface ErrorReportContext {
  framework?: "tanstack" | "nextjs";
  source?: "request" | "render" | "action" | "route" | "proxy";
  /** A matched route template, never the request URL or path. */
  route?: string | (() => string | undefined | Promise<string | undefined>);
  method?: string;
  /** Omit when the response status is not known (for example a streamed render). */
  status?: number;
  /** A static component identifier, never its props or a component stack. */
  component?: string;
}

const SOURCES = new Set(["request", "render", "action", "route", "proxy"]);
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
const FLUSH_TIMEOUT_MS = 2_000;

/** Reads only a bounded string field, including from objects with hostile getters. */
function field(value: unknown, key: string, max: number): string | undefined {
  try {
    const item = (value as Record<string, unknown> | null | undefined)?.[key];
    return typeof item === "string" ? item.slice(0, max) : undefined;
  } catch {
    return undefined;
  }
}

function alreadyReported(value: unknown): boolean {
  // The CMS reports its ResolutionError at the point of failure. A framework
  // wrapping it does not make it a new failure. No process-long identity cache:
  // another request may legitimately throw the same Error object again.
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && value !== null && typeof value === "object"; depth++) {
    if (seen.has(value)) break;
    seen.add(value);
    try {
      if (isResolutionError(value)) return true;
      value = (value as { cause?: unknown }).cause;
    } catch {
      break;
    }
  }
  return false;
}

function errorText(value: unknown): string {
  const message = field(value, "message", 1_000);
  if (message !== undefined) return message;
  if (typeof value === "string") return value.slice(0, 1_000);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "unknown error";
}

function component(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w./:-]{1,200}$/.test(value) ? value : undefined;
}

async function recordError(
  error: unknown,
  context: ErrorReportContext,
  telemetry = currentTelemetry(),
): Promise<void> {
  if (!telemetry?.logging() || alreadyReported(error)) return;
  const name = field(error, "name", 80) || "Error";
  let route: unknown;
  try {
    route = typeof context.route === "function" ? await context.route() : context.route;
  } catch {
    // A failed route lookup must not hide the original failure.
  }
  const source = SOURCES.has(context.source ?? "") ? context.source! : "request";
  const method = typeof context.method === "string" ? context.method.toUpperCase() : undefined;
  const routeTemplate =
    typeof route === "string" && route.startsWith("/")
      ? route.split(/[?#]/, 1)[0]?.slice(0, 200)
      : undefined;
  const framework =
    context.framework === "tanstack" || context.framework === "nextjs"
      ? context.framework
      : undefined;
  telemetry.error(`${source} failed: ${name}: ${errorText(error)}`, {
    "error.code": "UNCAUGHT_EXCEPTION",
    "exception.type": name,
    "exception.stacktrace": field(error, "stack", 4_000),
    "error.source": source,
    "error.runtime": "server",
    "deco.framework": framework,
    "deco.component": component(context.component),
    "http.route": routeTemplate,
    "http.request.method":
      method === undefined ? undefined : METHODS.has(method) ? method : "_OTHER",
    "http.response.status_code":
      Number.isInteger(context.status) && context.status! >= 100 && context.status! <= 599
        ? context.status
        : undefined,
  });
}

/**
 * Queue a server error using the CMS's current sampling and scrubbing.
 * Safe for a catch handler: no error or rejected promise reaches its caller.
 */
export async function reportError(error: unknown, context: ErrorReportContext = {}): Promise<void> {
  try {
    await recordError(error, context);
  } catch {
    // Observability never becomes an application failure.
  }
}

/**
 * Bounded delivery for framework hooks that are awaited before a serverless
 * request ends. Drains the pipeline's metrics/traces too; never waits over 2s.
 * Ordinary background batching is unchanged.
 */
export async function flushTelemetry(): Promise<void> {
  const telemetry = currentTelemetry();
  if (telemetry === undefined) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      telemetry.flush({ signal: controller.signal, waitForPending: true }),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve();
        }, FLUSH_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // A collector failure must not escape a framework's error hook.
  } finally {
    clearTimeout(timer);
  }
}
