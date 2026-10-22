// @vitest-environment node
/**
 * `register()` against Next's own tracer (`next/dist/server/lib/trace/tracer.js`),
 * driven the way `BaseServer.handleRequest` drives it: one root span per
 * request, child spans inside, `next.route` set on the root's attributes deep
 * in the render, status and route copied onto the span before it ends.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as api from "@opentelemetry/api";
import { BaseServerSpan } from "next/dist/server/lib/trace/constants.js";
import { BubbledError, getTracer, SpanKind } from "next/dist/server/lib/trace/tracer.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register, serverRequestSpanProcessor } from "./index.ts";

const SINK = Symbol.for("decocms.blocks.telemetry");
const REGISTERED = Symbol.for("decocms.nextjs.instrumentation");

interface Point {
  name: string;
  labels: Record<string, unknown>;
  seconds: number;
}
let points: Point[];

// Next's server puts AsyncLocalStorage on globalThis (node-environment-baseline.js), as the Edge runtime does.
(globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;

beforeEach(() => {
  points = [];
  (globalThis as Record<symbol, unknown>)[SINK] = {
    measuring: () => true,
    histogram: (name: string, labels: Record<string, unknown>, seconds: number) =>
      points.push({ name, labels, seconds }),
  };
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SINK];
});
afterAll(() => {
  unregister();
});

function unregister(): void {
  api.trace.disable();
  api.context.disable();
  api.propagation.disable();
  delete (globalThis as Record<symbol, unknown>)[REGISTERED];
}

interface Served {
  method?: string;
  route?: string;
  status?: number;
  headers?: Record<string, string>;
  throws?: boolean;
  rsc?: boolean;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** One request through Next's tracer, as `BaseServer.handleRequest` serves it. */
function serve({ method = "GET", route, status = 200, headers = {}, throws, rsc = false }: Served) {
  const tracer = getTracer();
  return tracer.withPropagatedContext(headers, () =>
    tracer.trace(
      BaseServerSpan.handleRequest,
      {
        spanName: method,
        kind: SpanKind.SERVER,
        attributes: { "http.method": method, "http.target": "/somewhere?q=1" },
      },
      async (span) =>
        (async () => {
          await tick();
          // Routing and rendering open child spans; once the page is found, base-server sets
          // the route template on the root's attributes (from the request's own context).
          await tracer.trace("NextNodeServer.findPageComponents", async () => tick());
          if (route) tracer.setRootSpanAttribute("next.route", route);
          await tracer.trace("AppRender.getBodyResult", async () => tick());
          if (throws) throw new Error("render failed");
        })().finally(() => {
          if (!span) return;
          span.setAttributes({ "http.status_code": status, "next.rsc": rsc });
          if (status >= 500) span.setStatus({ code: api.SpanStatusCode.ERROR });
          const root = tracer.getRootSpanAttributes();
          const name = root?.get("next.route");
          if (name) span.setAttributes({ "next.route": name, "http.route": name });
        }),
    ),
  );
}

describe("before register()", () => {
  it("Next opens no span and nothing is recorded", async () => {
    await serve({ route: "/[slug]/p" });
    expect(points).toEqual([]);
  });
});

describe("register()", () => {
  beforeEach(async () => {
    unregister();
    await register();
  });

  it("records each request once: the route template, method, status class, seconds", async () => {
    await serve({ route: "/[slug]/p" });
    await serve({ route: "/[slug]/p", method: "HEAD", status: 404 });
    expect(points).toHaveLength(2);
    expect(points[0]!.name).toBe("http.server.request.duration");
    expect(points[0]!.labels).toEqual({
      "http.route": "/[slug]/p",
      "http.request.method": "GET",
      status_class: "2xx",
      cache: "BYPASS",
    });
    expect(points[0]!.seconds).toBeGreaterThan(0.005);
    expect(points[0]!.seconds).toBeLessThan(5);
    expect(points[1]!.labels).toMatchObject({ "http.request.method": "HEAD", status_class: "4xx" });
  });

  it("the proxy's own invocation (a handleRequest that bubbles its result to the router) is not a request", async () => {
    const tracer = getTracer();
    const bubble = (error: Error) =>
      tracer.trace(
        BaseServerSpan.handleRequest,
        { spanName: "GET", kind: SpanKind.SERVER, attributes: { "http.method": "GET" } },
        async (span) =>
          (async () => {
            await tick();
            throw error;
          })().finally(() => span.setAttributes({ "http.status_code": 200 })),
      );
    // next-server's BubbledError (span attribute next.bubble), and base-server's plain error marked bubble.
    await expect(
      bubble(
        new BubbledError(true, { response: new Response(null), waitUntil: Promise.resolve() }),
      ),
    ).rejects.toThrow();
    await expect(bubble(Object.assign(new Error(), { bubble: true }))).rejects.toThrow();
    await serve({ route: "/[slug]/p" });
    expect(points.map((p) => p.labels["http.route"])).toEqual(["/[slug]/p"]);
  });

  it("an RSC request counts under its page's route", async () => {
    await serve({ route: "/blog", rsc: true });
    expect(points.map((p) => p.labels["http.route"])).toEqual(["/blog"]);
  });

  it("a request Next didn't route is unmatched", async () => {
    await serve({ status: 404 });
    expect(points[0]!.labels).toMatchObject({ "http.route": "unmatched", status_class: "4xx" });
  });

  it("a 5xx, and a request that threw, are 5xx", async () => {
    await serve({ route: "/", status: 503 });
    await expect(serve({ route: "/", status: 200, throws: true })).rejects.toThrow("render failed");
    expect(points.map((p) => p.labels.status_class)).toEqual(["5xx", "5xx"]);
  });

  it("a draft render is DRAFT: the proxy's x-deco-version, or the /_draft route", async () => {
    await serve({ route: "/[slug]/p", headers: { "x-deco-version": "studio/pointer@1" } });
    await serve({ route: "/_draft/[[...path]]" });
    await serve({ route: "/%5Fdraft/[[...path]]" });
    await serve({ route: "/drafts" });
    expect(points.map((p) => p.labels.cache)).toEqual(["DRAFT", "DRAFT", "DRAFT", "BYPASS"]);
  });

  it("concurrent requests keep their own routes", async () => {
    await Promise.all([serve({ route: "/a" }), serve({ route: "/b" }), serve({ route: "/c" })]);
    expect(points.map((p) => p.labels["http.route"]).sort()).toEqual(["/a", "/b", "/c"]);
  });

  it("every other span is non-recording and shares one context", () => {
    const tracer = api.trace.getTracer("anything");
    const a = tracer.startSpan("x");
    const b = tracer.startSpan("y", { attributes: { "next.span_type": "AppRender.fetch" } });
    expect(a.isRecording()).toBe(false);
    expect(a).toBe(b);
    a.end();
    expect(points).toEqual([]);
  });

  it("records nothing with telemetry off", async () => {
    (globalThis as Record<symbol, unknown>)[SINK] = {
      measuring: () => false,
      histogram: () => points.push({ name: "x", labels: {}, seconds: 0 }),
    };
    await serve({ route: "/" });
    expect(points).toEqual([]);
  });

  it("a second register() changes nothing", async () => {
    const provider = api.trace.getTracerProvider();
    await register();
    expect(api.trace.getTracerProvider()).toBe(provider);
    await serve({ route: "/" });
    expect(points).toHaveLength(1);
  });
});

describe("register() leaves other setups alone", () => {
  beforeEach(() => unregister());

  it("another tracer provider: registers nothing and says what to use instead", async () => {
    const theirs: api.TracerProvider = { getTracer: () => api.trace.getTracer("noop") };
    api.trace.setGlobalTracerProvider(theirs);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await register();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("serverRequestSpanProcessor()"));
    warn.mockRestore();
    expect((api.trace.getTracerProvider() as api.ProxyTracerProvider).getDelegate()).toBe(theirs);
  });

  it("the Edge runtime: registers nothing", async () => {
    (globalThis as Record<string, unknown>).EdgeRuntime = "edge-runtime";
    try {
      await register();
      await serve({ route: "/" });
      expect(points).toEqual([]);
    } finally {
      delete (globalThis as Record<string, unknown>).EdgeRuntime;
    }
  });
});

describe("serverRequestSpanProcessor()", () => {
  const ended = (attributes: Record<string, unknown>, status?: number) => ({
    attributes,
    duration: [0, 250_000_000] as [number, number],
    ...(status === undefined ? {} : { status: { code: status } }),
  });

  it("records Next's request span from an SDK's ended span, and nothing else", () => {
    const processor = serverRequestSpanProcessor();
    processor.onEnd(
      ended({
        "next.span_type": "BaseServer.handleRequest",
        "http.method": "GET",
        "http.status_code": 200,
        "http.route": "/[slug]/p",
      }),
    );
    processor.onEnd(ended({ "next.span_type": "AppRender.fetch", "http.status_code": 200 }));
    processor.onEnd(ended({ "next.span_type": "BaseServer.handleRequest", "next.bubble": true }));
    processor.onEnd(
      ended(
        {
          "next.span_type": "BaseServer.handleRequest",
          "http.method": "POST",
          "http.status_code": 200,
        },
        2,
      ),
    );
    expect(points).toEqual([
      {
        name: "http.server.request.duration",
        labels: {
          "http.route": "/[slug]/p",
          "http.request.method": "GET",
          status_class: "2xx",
          cache: "BYPASS",
        },
        seconds: 0.25,
      },
      {
        name: "http.server.request.duration",
        labels: {
          "http.route": "unmatched",
          "http.request.method": "POST",
          status_class: "5xx",
          cache: "BYPASS",
        },
        seconds: 0.25,
      },
    ]);
  });

  it("never throws", () => {
    expect(() => serverRequestSpanProcessor().onEnd(null as never)).not.toThrow();
  });
});
