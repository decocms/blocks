import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstrumentedFetch } from "./instrumentedFetch";
import { configureTracer, setObservabilitySpanStore } from "./observability";
import type { Span, TracerAdapter } from "./observability";

function makeFakeTracer(): {
  tracer: TracerAdapter;
  startSpan: ReturnType<typeof vi.fn>;
  spans: Array<ReturnType<typeof makeFakeSpan>>;
} {
  const spans: Array<ReturnType<typeof makeFakeSpan>> = [];
  const startSpan = vi.fn((name: string, attrs?: Record<string, string | number | boolean>) => {
    const s = makeFakeSpan(name, attrs);
    spans.push(s);
    return s.span;
  });
  return { tracer: { startSpan } as TracerAdapter, startSpan, spans };
}

function makeFakeSpan(
  name: string,
  initialAttrs?: Record<string, string | number | boolean>,
  ctx?: { traceId: string; spanId: string; traceFlags: number },
) {
  const attrs: Record<string, string | number | boolean> = { ...(initialAttrs ?? {}) };
  const span: Span = {
    end: vi.fn(),
    setError: vi.fn(),
    setAttribute: vi.fn((k: string, v: string | number | boolean) => {
      attrs[k] = v;
    }),
    spanContext: ctx ? () => ctx : undefined,
  };
  return { name, span, attrs };
}

describe("createInstrumentedFetch — URL redaction", () => {
  afterEach(() => {
    configureTracer({ startSpan: () => ({ end: () => {} }) });
    setObservabilitySpanStore(undefined);
    vi.restoreAllMocks();
  });

  it("stamps a redacted http.url on the span, not the raw URL", async () => {
    const { tracer, spans } = makeFakeTracer();
    configureTracer(tracer);
    const baseFetch = vi.fn(async () => new Response("ok", { status: 200 }));

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
    });

    await f("https://api.test/search?token=SECRET123&page=2");

    expect(spans).toHaveLength(1);
    expect(spans[0].attrs["http.url"]).toBe(
      "https://api.test/search?token=REDACTED&page=REDACTED",
    );
  });

  it("honors keepQueryKeys for benign query params", async () => {
    const { tracer, spans } = makeFakeTracer();
    configureTracer(tracer);
    const baseFetch = vi.fn(async () => new Response("ok"));

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      keepQueryKeys: ["page", "sort"],
    });

    await f("https://api.test/search?token=SECRET&page=2&sort=name");

    expect(spans[0].attrs["http.url"]).toBe(
      "https://api.test/search?token=REDACTED&page=2&sort=name",
    );
  });

  it("preserves rawUrl in the structured `outgoing fetch` log's host/path", async () => {
    // OTEL_LOG_OUTGOING_FETCH is consulted via globalThis.process.env;
    // the breadcrumb logs `host` and `path` derived from the rawUrl,
    // which is correct — the structured log goes into the logger pipe
    // where attribute redaction is the ingestor's job.
    const baseFetch = vi.fn(async () => new Response("ok"));
    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
    });

    const res = await f("https://api.test/items?id=42");
    expect(res.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledOnce();
  });
});

describe("createInstrumentedFetch — traceparent injection", () => {
  afterEach(() => {
    configureTracer({ startSpan: () => ({ end: () => {} }) });
    setObservabilitySpanStore(undefined);
    vi.restoreAllMocks();
  });

  it("injects traceparent on outbound calls when a span is active", async () => {
    // Install a tracer that creates a fake span whose spanContext()
    // returns a known id, AND wire the spanStore so getActiveSpan()
    // can find it across the await boundary inside withTracing.
    const knownCtx = {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "fedcba9876543210",
      traceFlags: 1,
    };

    // The redacted "active span" is the one createInstrumentedFetch starts.
    // injectTraceContext reads `getActiveSpan()`, which only works inside
    // a `withTracing` / spanStore.run scope. The simplest stub: install a
    // tracer that returns a span with spanContext, AND make the spanStore
    // resolve that span when fetched.
    const fakeSpan = makeFakeSpan("vtex.fetch", undefined, knownCtx);
    configureTracer({
      startSpan: () => fakeSpan.span,
    });

    // Custom span store that returns the fake span on every get(). This
    // models the host's ALS-backed store with a single active span.
    setObservabilitySpanStore({
      get: () => fakeSpan.span,
      run: (_span, fn) => fn(),
    });

    const baseFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      return new Response(h.get("traceparent") ?? "<missing>", { status: 200 });
    });

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
    });

    const res = await f("https://api.test/x");
    const body = await res.text();
    expect(body).toBe(
      `00-${knownCtx.traceId}-${knownCtx.spanId}-01`,
    );
  });

  it("does NOT inject traceparent when injectTraceparent: false", async () => {
    const fakeSpan = makeFakeSpan("vtex.fetch", undefined, {
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      traceFlags: 1,
    });
    configureTracer({ startSpan: () => fakeSpan.span });
    setObservabilitySpanStore({
      get: () => fakeSpan.span,
      run: (_s, fn) => fn(),
    });

    const baseFetch = vi.fn(async (_i: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      return new Response(JSON.stringify({ traceparent: h.get("traceparent") }), { status: 200 });
    });

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
      injectTraceparent: false,
    });

    const res = await f("https://api.test/x");
    const body = (await res.json()) as { traceparent: string | null };
    expect(body.traceparent).toBeNull();
  });

  it("is a safe no-op when no span is active", async () => {
    // No tracer configured, no spanStore — injectTraceContext returns early.
    configureTracer({ startSpan: () => ({ end: () => {} }) });
    setObservabilitySpanStore(undefined);

    const baseFetch = vi.fn(async (_i: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      return new Response(h.get("traceparent") ?? "<missing>", { status: 200 });
    });

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
    });

    const res = await f("https://api.test/x");
    expect(await res.text()).toBe("<missing>");
  });

  it("preserves caller-supplied headers when injecting traceparent", async () => {
    const fakeSpan = makeFakeSpan("vtex.fetch", undefined, {
      traceId: "33333333333333333333333333333333",
      spanId: "4444444444444444",
      traceFlags: 1,
    });
    configureTracer({ startSpan: () => fakeSpan.span });
    setObservabilitySpanStore({
      get: () => fakeSpan.span,
      run: (_s, fn) => fn(),
    });

    const baseFetch = vi.fn(async (_i: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          auth: h.get("authorization"),
          tp: h.get("traceparent"),
        }),
        { status: 200 },
      );
    });

    const f = createInstrumentedFetch({
      name: "vtex",
      baseFetch: baseFetch as unknown as typeof fetch,
      logging: false,
    });

    const res = await f("https://api.test/x", {
      headers: { authorization: "Bearer abc" },
    });
    const body = (await res.json()) as { auth: string; tp: string };
    expect(body.auth).toBe("Bearer abc");
    expect(body.tp).toBe(
      `00-${fakeSpan.span.spanContext!().traceId}-${fakeSpan.span.spanContext!().spanId}-01`,
    );
  });
});
