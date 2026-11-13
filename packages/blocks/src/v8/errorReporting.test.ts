// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ERROR_REPORT_PATH,
  flushTelemetry,
  handleErrorReport,
  reportError,
} from "./errorReporting";
import { errors } from "./errors";
import { resolveDestination, setCurrentTelemetry, TelemetryPipeline } from "./telemetry";

interface Log {
  severityText: string;
  body: { stringValue: string };
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[];
}
interface Batch {
  resourceLogs?: { scopeLogs: { logRecords: Log[] }[] }[];
}
const BACKGROUND = Symbol.for("decocms.blocks.background");
let batches: Batch[];
let pipeline: TelemetryPipeline;

function newPipeline() {
  return new TelemetryPipeline(
    resolveDestination(
      {
        endpoint: "https://collector.example",
        defaults: { errorSampleRate: 1 },
      },
      "shop",
    )!,
  );
}
beforeEach(() => {
  batches = [];
  (globalThis as Record<symbol, unknown>)[BACKGROUND] = () => {};
  vi.stubGlobal("CompressionStream", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init: RequestInit) => {
      batches.push(JSON.parse(String(init.body)) as Batch);
      return new Response(null, { status: 204 });
    }),
  );
  pipeline = newPipeline();
  setCurrentTelemetry(pipeline);
});
afterEach(() => {
  setCurrentTelemetry(undefined);
  delete (globalThis as Record<symbol, unknown>)[BACKGROUND];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function logs() {
  return batches
    .flatMap((b) => b.resourceLogs ?? [])
    .flatMap((r) => r.scopeLogs)
    .flatMap((s) => s.logRecords);
}
function attrs(log: Log) {
  return Object.fromEntries(
    log.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue]),
  );
}
function request(
  body: unknown = {
    name: "TypeError",
    message: "render crashed",
    source: "render",
    component: "hero",
  },
  options: RequestInit = {},
) {
  return new Request(`https://shop.example${ERROR_REPORT_PATH}`, {
    method: "POST",
    headers: { Origin: "https://shop.example", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...options,
  });
}

describe("reportError", () => {
  it("records a sanitized render exception independently of metrics", async () => {
    pipeline.apply({ metrics: false });
    const error = new TypeError(
      "fetch https://shop.example/p?token=private Bearer abc password=hidden",
    );
    error.stack = "TypeError at https://shop.example/chunk.js?token=stack-secret:4:2";
    await reportError(error, {
      source: "render",
      framework: "tanstack",
      route: async () => "/:slug?secret=route",
      method: "get",
      component: "hero",
      status: 503,
    });
    await pipeline.flush();
    expect(logs()).toHaveLength(1);
    expect(logs()[0]?.severityText).toBe("ERROR");
    expect(attrs(logs()[0]!)).toMatchObject({
      "error.code": "UNCAUGHT_EXCEPTION",
      "error.runtime": "server",
      "error.source": "render",
      "deco.framework": "tanstack",
      "deco.component": "hero",
      "http.route": "/:slug",
      "http.request.method": "GET",
      "http.response.status_code": "503",
      "exception.type": "TypeError",
    });
    const encoded = JSON.stringify(batches);
    for (const secret of ["private", "hidden", "stack-secret", "secret=route", "Bearer abc"])
      expect(encoded).not.toContain(secret);
  });

  it.each([
    { enabled: false },
    { errorSampleRate: 0 },
  ])("does not resolve route metadata when reporting is disabled: %o", async (settings) => {
    pipeline.apply(settings);
    const route = vi.fn(() => "/");
    await reportError(new Error("off"), { route });
    expect(route).not.toHaveBeenCalled();
    await flushTelemetry();
    expect(logs()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not call metadata without a destination and never rejects", async () => {
    setCurrentTelemetry(undefined);
    const route = vi.fn(() => {
      throw new Error("metadata");
    });
    await expect(reportError(new Error("unconfigured"), { route })).resolves.toBeUndefined();
    await expect(flushTelemetry()).resolves.toBeUndefined();
    expect(route).not.toHaveBeenCalled();
  });

  it("skips CMS errors and wrappers whose failure was already reported", async () => {
    const cmsError = errors.blockFailed("hero", [], new Error("already logged"));
    await reportError(cmsError);
    await reportError(new Error("wrapper", { cause: cmsError }));
    await reportError(errors.notFound("ordinary-missing-name"));
    await pipeline.flush();
    expect(logs()).toEqual([]);
  });

  it("does not suppress the same error reused by separate requests", async () => {
    const error = new Error("shared instance");
    await reportError(error);
    await reportError(error);
    await pipeline.flush();
    expect(logs()).toHaveLength(2);
  });

  it("handles throwing getters, proxies, cause cycles, primitive throws and rejected metadata", async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter");
        },
        getPrototypeOf() {
          throw new Error("prototype");
        },
      },
    );
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    for (const value of [hostile, cycle, Symbol("hidden"), null, 42, "thrown string"]) {
      await expect(
        reportError(value, {
          route: async () => {
            throw new Error("bad route");
          },
        }),
      ).resolves.toBeUndefined();
    }
    await pipeline.flush();
    expect(logs()).toHaveLength(6);
    expect(JSON.stringify(batches)).not.toContain("bad route");
  });

  it("reports an explicit AbortError when it is not a request cancellation", async () => {
    await reportError(new DOMException("an application abort", "AbortError"));
    await pipeline.flush();
    expect(logs()).toHaveLength(1);
    expect(attrs(logs()[0]!)).toMatchObject({ "exception.type": "AbortError" });
  });

  it("omits unknown status and arbitrary component data and normalizes methods", async () => {
    await reportError(new Error("unknown status"), {
      method: "BAD",
      status: 0,
      component: "token=shopper-value",
    });
    await pipeline.flush();
    expect(logs()).toHaveLength(1);
    expect(attrs(logs()[0]!)).toMatchObject({ "http.request.method": "_OTHER" });
    expect(attrs(logs()[0]!)).not.toHaveProperty("http.response.status_code");
    expect(attrs(logs()[0]!)).not.toHaveProperty("deco.component");
  });
});

describe("flushTelemetry", () => {
  it("waits for an error already detached by a background export", async () => {
    let respond!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    await reportError(new Error("background owns this error"));
    const background = pipeline.flush();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
    let finished = false;
    const drained = flushTelemetry().then(() => {
      finished = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    respond(new Response(null, { status: 204 }));
    await background;
    await drained;
    expect(finished).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("bounds waiting for a previous batch without aborting its owner's signal", async () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    let respond!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    await reportError(new Error("another request's batch"));
    const background = pipeline.flush({ signal: owner.signal });
    await vi.advanceTimersByTimeAsync(0);
    const drained = flushTelemetry();
    await vi.advanceTimersByTimeAsync(2_000);
    await drained;
    expect(owner.signal.aborted).toBe(false);
    respond(new Response(null, { status: 204 }));
    await background;
  });

  it("aborts a stalled collector and resolves within the two-second budget", async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      init?.signal?.addEventListener("abort", aborted);
      return await new Promise<Response>(() => {}); // also test a fetch mock ignoring abort
    });
    await reportError(new Error("one failure"));
    const flushed = flushTelemetry();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(aborted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(flushed).resolves.toBeUndefined();
    expect(aborted).toHaveBeenCalledOnce();
  });

  it("allows the existing retry inside the budget", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
    await reportError(new Error("retry"));
    const flushed = flushTelemetry();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushed;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry after the flush signal was aborted", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
    const controller = new AbortController();
    await reportError(new Error("retry cancelled"));
    const flushed = pipeline.flush({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushed;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never rejects on collector failure", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("collector offline"));
    await reportError(new Error("original failure"));
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });
});

describe("browser intake", () => {
  it("exports one browser render error using server-owned identity", async () => {
    const response = await handleErrorReport(request());
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(logs()).toHaveLength(1);
    expect(attrs(logs()[0]!)).toMatchObject({
      "error.code": "CLIENT_EXCEPTION",
      "error.runtime": "browser",
      "error.source": "render",
      "deco.component": "hero",
    });
    expect(attrs(logs()[0]!)).not.toHaveProperty("http.route");
  });

  it.each([
    [405, { method: "GET", body: undefined }],
    [403, { headers: { Origin: "https://other.example", "Content-Type": "application/json" } }],
    [403, { headers: { "Content-Type": "application/json" } }],
    [
      403,
      {
        headers: {
          Origin: "https://shop.example",
          "Sec-Fetch-Site": "cross-site",
          "Content-Type": "application/json",
        },
      },
    ],
    [415, { headers: { Origin: "https://shop.example", "Content-Type": "text/plain" } }],
  ] as const)("rejects an invalid envelope with status %i and no collector call", async (status, options) => {
    expect((await handleErrorReport(request(undefined, options))).status).toBe(status);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { name: "Error", message: "bad", source: "render", site: "other-tenant" },
    { name: "Error", message: "bad", source: "render", headers: { authorization: "secret" } },
    { name: "Error", message: "bad", source: "render", endpoint: "https://attacker.example" },
    { name: "Error", message: "bad", source: "proxy" },
    { name: "Error", message: "x".repeat(1_001), source: "render" },
    { name: "Error", message: "bad", source: "render", component: "email=private" },
    [],
    null,
  ])("rejects fields outside the bounded exception schema", async (body) => {
    expect((await handleErrorReport(request(body))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces the byte ceiling with and without Content-Length", async () => {
    const big = "x".repeat(8_193);
    for (const options of [
      { body: big },
      {
        body: big,
        headers: {
          Origin: "https://shop.example",
          "Content-Type": "application/json",
          "Content-Length": String(big.length),
        },
      },
    ]) {
      expect((await handleErrorReport(request(undefined, options))).status).toBe(413);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an incomplete slow body without waiting for cancellation", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => {}) });
    const incoming = request(undefined, { body, duplex: "half" } as RequestInit);
    const pending = handleErrorReport(incoming);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).status).toBe(408);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds reports per pipeline, resets after ten seconds and preserves the cap across a backward clock", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    // Intentionally isolate intake limits from export/network work here.
    vi.spyOn(pipeline, "flush").mockResolvedValue();
    for (let i = 0; i < 200; i++) expect((await handleErrorReport(request())).status).toBe(204);
    expect((await handleErrorReport(request())).status).toBe(429);
    now.mockReturnValue(9_000);
    expect((await handleErrorReport(request())).status).toBe(429);
    now.mockReturnValue(18_999);
    expect((await handleErrorReport(request())).status).toBe(429);
    now.mockReturnValue(19_000);
    expect((await handleErrorReport(request())).status).toBe(204);
    setCurrentTelemetry(newPipeline());
    expect((await handleErrorReport(request())).status).toBe(204);
  });

  it("does not read or flush a body when telemetry is disabled", async () => {
    pipeline.apply({ enabled: false });
    const incoming = request();
    const read = vi.spyOn(incoming, "body", "get");
    expect((await handleErrorReport(incoming)).status).toBe(204);
    expect(read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
