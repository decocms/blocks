/** Browser exception reporting. Importing this module installs nothing. */
import { scrubText } from "./telemetryText.ts";

const ERROR_REPORT_PATH = "/deco/_errors";
const STATE = Symbol.for("decocms.blocks.errorCapture");
const MAX_REPORTS = 20;

export interface ClientErrorContext {
  source?: "request" | "render";
  /** A static component identifier, never component props or shopper data. */
  component?: string;
}

interface CaptureState {
  installed: boolean;
  count: number;
  seen: WeakSet<object>;
}

function state(): CaptureState {
  const global = window as unknown as Record<symbol, CaptureState | undefined>;
  global[STATE] ??= { installed: false, count: 0, seen: new WeakSet() };
  return global[STATE];
}

function text(value: unknown, key: string, limit: number): string | undefined {
  try {
    const item = (value as Record<string, unknown> | null | undefined)?.[key];
    return typeof item === "string" ? item.slice(0, limit) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reports a caught React/application exception to this site's server adapter.
 * Sends no URL, cookies, component props or collector credential. Failures are
 * ignored and a page can report at most twenty exceptions.
 */
export function captureException(error: unknown, context: ClientErrorContext = {}): void {
  if (typeof window === "undefined") return;
  try {
    const capture = state();
    if (capture.count >= MAX_REPORTS) return;
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      if (capture.seen.has(error)) return;
      capture.seen.add(error);
    }
    capture.count++;
    const stack = text(error, "stack", 2_000);
    const payload = {
      name: scrubText(text(error, "name", 80) || "Error").slice(0, 80),
      message: scrubText(
        text(error, "message", 1_000) ??
          (typeof error === "string" ? error.slice(0, 1_000) : "unknown error"),
      ),
      stack: stack === undefined ? undefined : scrubText(stack),
      source: context.source === "render" ? "render" : "request",
      component:
        typeof context.component === "string" && /^[\w./:-]{1,200}$/.test(context.component)
          ? context.component
          : undefined,
    };
    let body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).byteLength > 8_192) {
      payload.stack = undefined;
      body = JSON.stringify(payload);
    }
    // JSON escaping can expand control characters; retaining the message alone
    // still fits the server's byte ceiling, even with multibyte text.
    if (new TextEncoder().encode(body).byteLength > 8_192) return;
    void fetch(ERROR_REPORT_PATH, {
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      mode: "same-origin",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    })
      .then((response) => response.body?.cancel())
      .catch(() => {});
  } catch {
    // Reporting cannot cause a second exception or rejected promise.
  }
}

/** Installs one listener pair per browser page, across duplicate module copies. */
export function startErrorCapture(): void {
  if (typeof window === "undefined") return;
  try {
    const capture = state();
    if (capture.installed) return;
    capture.installed = true;
    window.addEventListener("error", (event: ErrorEvent) => {
      // Resource failures and opaque cross-origin "Script error." events do
      // not carry an application exception to diagnose.
      if (event.error == null) return;
      captureException(event.error);
    });
    window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
      captureException(event.reason);
    });
  } catch {
    // Browser instrumentation is best effort.
  }
}
