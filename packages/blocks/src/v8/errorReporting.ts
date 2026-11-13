/**
 * Application errors on the CMS's existing sampled OTLP pipeline. Framework
 * bindings call this at their own error boundaries; reporting never replaces
 * an exception, changes a response, or installs a process-wide handler.
 */
import { isResolutionError } from "./errors.ts";
import { currentTelemetry, type TelemetryPipeline } from "./telemetry.ts";

/** Same-origin browser intake mounted by the framework bindings. */
export const ERROR_REPORT_PATH = "/deco/_errors";

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
const MAX_BODY_BYTES = 8_192;
const FLUSH_TIMEOUT_MS = 2_000;
const READ_TIMEOUT_MS = 5_000;
const browserBudgets = new WeakMap<TelemetryPipeline, { start: number; count: number }>();

function browserBudget(telemetry: TelemetryPipeline, consume: boolean): boolean {
  const now = performance.now();
  let budget = browserBudgets.get(telemetry);
  if (budget === undefined || now - budget.start >= 10_000) {
    budget = { start: now, count: 0 };
    browserBudgets.set(telemetry, budget);
  }
  // The monotonic clock normally cannot go backwards; preserve the budget if
  // a host replaces it rather than extending the window indefinitely.
  if (now < budget.start) budget.start = now;
  if (budget.count >= 200) return false;
  if (consume) budget.count++;
  return true;
}

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
  browser: boolean,
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
    "error.code": browser ? "CLIENT_EXCEPTION" : "UNCAUGHT_EXCEPTION",
    "exception.type": name,
    "exception.stacktrace": field(error, "stack", 4_000),
    "error.source": source,
    "error.runtime": browser ? "browser" : "server",
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
 * Queue an application error using the CMS's current sampling and scrubbing.
 * Safe for a catch handler: no error or rejected promise reaches its caller.
 */
export async function reportError(error: unknown, context: ErrorReportContext = {}): Promise<void> {
  try {
    await recordError(error, context, false);
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
  await flushPipeline(currentTelemetry());
}

async function flushPipeline(telemetry: TelemetryPipeline | undefined): Promise<void> {
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

class InvalidBody extends Error {
  constructor(readonly status: number) {
    super("invalid error report");
  }
}

async function readReport(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new InvalidBody(413);
  if (request.body === null) throw new InvalidBody(400);
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new InvalidBody(408)), READ_TIMEOUT_MS);
  });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new InvalidBody(413);
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } finally {
    clearTimeout(timer);
    // Never await a peer-controlled stream's cancellation.
    void reader.cancel().catch(() => {});
  }
}

interface BrowserReport {
  name: string;
  message: string;
  stack?: string;
  source: "request" | "render";
  component?: string;
}

function browserReport(value: unknown): value is BrowserReport {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  const fields = new Set(["name", "message", "stack", "source", "component"]);
  return (
    Object.keys(report).every((key) => fields.has(key)) &&
    typeof report.name === "string" &&
    report.name.length > 0 &&
    report.name.length <= 80 &&
    typeof report.message === "string" &&
    report.message.length <= 1_000 &&
    (report.stack === undefined ||
      (typeof report.stack === "string" && report.stack.length <= 2_000)) &&
    (report.source === "request" || report.source === "render") &&
    (report.component === undefined || component(report.component) !== undefined)
  );
}

/**
 * The binding's browser intake. The browser supplies exception fields only;
 * destination, resource identity and credentials always stay on the server.
 * Origin prevents cross-site browser submissions, not forged nonbrowser
 * requests. A pipeline accepts at most 200 browser reports per ten seconds.
 */
export async function handleErrorReport(request: Request): Promise<Response> {
  const reply = (status: number) =>
    new Response(null, {
      status,
      headers: { "Cache-Control": "no-store", ...(status === 405 ? { Allow: "POST" } : {}) },
    });
  try {
    if (request.method !== "POST") return reply(405);
    if (request.headers.get("origin") !== new URL(request.url).origin) return reply(403);
    if (
      request.headers.get("sec-fetch-site") &&
      request.headers.get("sec-fetch-site") !== "same-origin"
    )
      return reply(403);
    if (
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
    )
      return reply(415);
    const telemetry = currentTelemetry();
    if (!telemetry?.logging()) return reply(204);
    if (!browserBudget(telemetry, false)) return reply(429);
    const report = await readReport(request);
    if (!browserReport(report)) return reply(400);
    if (!browserBudget(telemetry, true)) return reply(429);
    await recordError(
      report,
      { source: report.source, component: report.component },
      true,
      telemetry,
    );
    await flushPipeline(telemetry);
    return reply(204);
  } catch (error) {
    return reply(error instanceof InvalidBody ? error.status : 400);
  }
}
