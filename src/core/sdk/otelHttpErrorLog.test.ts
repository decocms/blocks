import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOtlpHttpErrorLogAdapter } from "./otelHttpErrorLog";

interface OtlpLogsPayload {
  resourceLogs: Array<{
    resource: {
      attributes: Array<{ key: string; value: { stringValue: string } }>;
    };
    scopeLogs: Array<{
      scope: { name: string; version: string };
      logRecords: Array<{
        timeUnixNano: string;
        severityNumber: number;
        severityText: string;
        body: { stringValue: string };
        attributes: Array<{ key: string; value: Record<string, unknown> }>;
      }>;
    }>;
  }>;
}

function captureFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function buildAdapter(
  overrides: {
    fetchImpl?: typeof fetch;
    minFlushIntervalMs?: number;
    maxBufferRecords?: number;
    rateLimitBurstCapacity?: number;
    rateLimitRefillPerMinute?: number;
    nowMs?: () => number;
    onError?: (kind: "flush" | "overflow" | "rate-limit", err: unknown) => void;
  } = {},
) {
  return createOtlpHttpErrorLogAdapter({
    endpoint: "https://ingest.test/v1/logs",
    resourceAttributes: {
      "service.name": "smoke-site",
      "service.version": "abc123",
    },
    scopeVersion: "5.0.0-test",
    fetchImpl: overrides.fetchImpl,
    minFlushIntervalMs: overrides.minFlushIntervalMs ?? 0,
    maxBufferRecords: overrides.maxBufferRecords,
    rateLimitBurstCapacity: overrides.rateLimitBurstCapacity ?? 100,
    rateLimitRefillPerMinute: overrides.rateLimitRefillPerMinute ?? 1000,
    nowMs: overrides.nowMs,
    onError: overrides.onError,
  });
}

describe("createOtlpHttpErrorLogAdapter — level filter + OTLP shape", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T16:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("buffers only level=error; debug/info/warn are dropped silently", async () => {
    const { impl, calls } = captureFetch();
    const sink = buildAdapter({ fetchImpl: impl });

    sink.adapter.log("info", "info msg", { foo: 1 });
    sink.adapter.log("warn", "warn msg", { foo: 2 });
    sink.adapter.log("debug", "debug msg", { foo: 3 });
    expect(sink.pendingRecordCount()).toBe(0);

    sink.adapter.log("error", "boom", { reason: "kaboom" });
    expect(sink.pendingRecordCount()).toBe(1);

    await sink.flush();
    expect(calls).toHaveLength(1);
    const p = JSON.parse(String(calls[0].init.body)) as OtlpLogsPayload;
    const r = p.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(r.severityText).toBe("error");
    expect(r.severityNumber).toBe(17);
    expect(r.body.stringValue).toBe("boom");
    expect(r.attributes).toContainEqual({
      key: "reason",
      value: { stringValue: "kaboom" },
    });
  });

  it("stamps resource attributes on every payload", async () => {
    const { impl, calls } = captureFetch();
    const sink = buildAdapter({ fetchImpl: impl });
    sink.adapter.log("error", "x");
    await sink.flush();

    const p = JSON.parse(String(calls[0].init.body)) as OtlpLogsPayload;
    expect(p.resourceLogs[0].resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "smoke-site" },
    });
    expect(p.resourceLogs[0].resource.attributes).toContainEqual({
      key: "service.version",
      value: { stringValue: "abc123" },
    });
  });

  it("serializes scalar attribute kinds correctly", async () => {
    const { impl, calls } = captureFetch();
    const sink = buildAdapter({ fetchImpl: impl });
    sink.adapter.log("error", "x", {
      s: "string",
      b: true,
      i: 42,
      d: 1.5,
      n: null,
      u: undefined,
      o: { nested: 1 },
    });
    await sink.flush();

    const p = JSON.parse(String(calls[0].init.body)) as OtlpLogsPayload;
    const attrs = p.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const byKey = (k: string) => attrs.find((a) => a.key === k)?.value;
    expect(byKey("s")).toEqual({ stringValue: "string" });
    expect(byKey("b")).toEqual({ boolValue: true });
    expect(byKey("i")).toEqual({ intValue: "42" });
    expect(byKey("d")).toEqual({ doubleValue: 1.5 });
    expect(byKey("n")).toBeUndefined();
    expect(byKey("u")).toBeUndefined();
    expect(byKey("o")).toEqual({ stringValue: '{"nested":1}' });
  });
});

describe("createOtlpHttpErrorLogAdapter — rate limiting + overflow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T16:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("token bucket drops errors past the burst capacity until refill", () => {
    let mockNow = 1_000_000;
    const onError = vi.fn();
    const sink = buildAdapter({
      rateLimitBurstCapacity: 3,
      rateLimitRefillPerMinute: 60, // 1 per second
      nowMs: () => mockNow,
      onError,
    });

    sink.adapter.log("error", "a");
    sink.adapter.log("error", "b");
    sink.adapter.log("error", "c");
    expect(sink.pendingRecordCount()).toBe(3);

    sink.adapter.log("error", "d");
    expect(sink.pendingRecordCount()).toBe(3);
    expect(onError).toHaveBeenCalledWith("rate-limit", expect.any(Error));
    onError.mockClear();

    // 2 seconds later → 2 new tokens refilled.
    mockNow += 2000;
    sink.adapter.log("error", "e");
    sink.adapter.log("error", "f");
    expect(sink.pendingRecordCount()).toBe(5);
    sink.adapter.log("error", "g");
    expect(sink.pendingRecordCount()).toBe(5);
    expect(onError).toHaveBeenCalledWith("rate-limit", expect.any(Error));
  });

  it("buffer overflow drops new records past the cap with onError", () => {
    const onError = vi.fn();
    const sink = buildAdapter({
      maxBufferRecords: 2,
      rateLimitBurstCapacity: 100,
      onError,
    });

    sink.adapter.log("error", "1");
    sink.adapter.log("error", "2");
    expect(sink.pendingRecordCount()).toBe(2);

    sink.adapter.log("error", "3");
    expect(sink.pendingRecordCount()).toBe(2);
    expect(onError).toHaveBeenCalledWith("overflow", expect.any(Error));
  });
});

describe("createOtlpHttpErrorLogAdapter — flush semantics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("flush drains the buffer and resets length to 0 on success", async () => {
    const { impl } = captureFetch();
    const sink = buildAdapter({ fetchImpl: impl, minFlushIntervalMs: 0 });
    sink.adapter.log("error", "a");
    sink.adapter.log("error", "b");
    expect(sink.pendingRecordCount()).toBe(2);
    await sink.flush();
    expect(sink.pendingRecordCount()).toBe(0);
  });

  it("non-200 response surfaces via onError but does not throw", async () => {
    const onError = vi.fn();
    const non200: typeof fetch = vi.fn(async () =>
      new Response("oops", { status: 502 }),
    ) as unknown as typeof fetch;
    const sink = buildAdapter({ fetchImpl: non200, onError, minFlushIntervalMs: 0 });
    sink.adapter.log("error", "boom");
    await sink.flush();
    expect(onError).toHaveBeenCalledWith("flush", expect.any(Error));
  });

  it("fetch rejection surfaces via onError but does not throw", async () => {
    const onError = vi.fn();
    const failing: typeof fetch = vi.fn(() =>
      Promise.reject(new Error("offline")),
    ) as unknown as typeof fetch;
    const sink = buildAdapter({ fetchImpl: failing, onError, minFlushIntervalMs: 0 });
    sink.adapter.log("error", "boom");
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("flush", expect.any(Error));
  });

  it("cooldown gates flushes; cooldown is bypassed once buffer reaches the cap", async () => {
    let mockNow = 1_000_000;
    const { impl, calls } = captureFetch();
    const sink = buildAdapter({
      fetchImpl: impl,
      minFlushIntervalMs: 5000,
      maxBufferRecords: 3,
      nowMs: () => mockNow,
    });

    sink.adapter.log("error", "1");
    await sink.flush();
    expect(calls).toHaveLength(1);

    mockNow += 2000;
    sink.adapter.log("error", "2");
    await sink.flush();
    expect(calls).toHaveLength(1);

    mockNow += 500;
    sink.adapter.log("error", "3");
    sink.adapter.log("error", "4");
    expect(sink.pendingRecordCount()).toBe(3);
    await sink.flush();
    expect(calls).toHaveLength(2);
  });

  it("non-200 response RESTORES records to the buffer (no permanent loss)", async () => {
    // The earlier behavior dropped records on the ground when the POST
    // failed — sites lost errors permanently. After the fix, a failing
    // POST returns the buffered records to the front of the queue so a
    // subsequent successful flush picks them up.
    const onError = vi.fn();
    let attempt = 0;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return new Response("oops", { status: 502 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const sink = buildAdapter({ fetchImpl, onError, minFlushIntervalMs: 0 });
    sink.adapter.log("error", "boom-1");
    sink.adapter.log("error", "boom-2");
    expect(sink.pendingRecordCount()).toBe(2);

    await sink.flush();
    expect(onError).toHaveBeenCalledWith("flush", expect.any(Error));
    // Records restored.
    expect(sink.pendingRecordCount()).toBe(2);

    await sink.flush();
    expect(sink.pendingRecordCount()).toBe(0);
    expect(attempt).toBe(2);
  });

  it("fetch rejection RESTORES records to the buffer (no permanent loss)", async () => {
    const onError = vi.fn();
    let attempt = 0;
    const fetchImpl: typeof fetch = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("offline"));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    const sink = buildAdapter({ fetchImpl, onError, minFlushIntervalMs: 0 });
    sink.adapter.log("error", "boom");
    await sink.flush();
    expect(sink.pendingRecordCount()).toBe(1);
    await sink.flush();
    expect(sink.pendingRecordCount()).toBe(0);
  });

  it("on restore, when buffer has grown past the cap, drops the oldest-tail records of the snapshot", async () => {
    const onError = vi.fn();
    let inFlightResolve: ((res: Response) => void) | undefined;
    const fetchImpl: typeof fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          inFlightResolve = resolve;
        }),
    ) as unknown as typeof fetch;
    // cap = 3; buffer two, flush, while POST is in flight enqueue two
    // more records, then fail the POST. The snapshot held 2; the buffer
    // grew by 2 during the POST. cap=3 means we can only re-prepend 1
    // of the snapshot's 2 records. The fix surfaces the drop via
    // `onError("overflow", ...)` rather than silently losing both.
    const sink = buildAdapter({
      fetchImpl,
      onError,
      minFlushIntervalMs: 0,
      maxBufferRecords: 3,
    });
    sink.adapter.log("error", "old-a");
    sink.adapter.log("error", "old-b");
    const flushPromise = sink.flush();
    // Buffer is empty mid-flush (snapshot moved out).
    expect(sink.pendingRecordCount()).toBe(0);
    sink.adapter.log("error", "new-c");
    sink.adapter.log("error", "new-d");
    expect(sink.pendingRecordCount()).toBe(2);
    inFlightResolve?.(new Response("oops", { status: 503 }));
    await flushPromise;
    // After restore: 2 new + 1 of the snapshot (oldest-first preserved
    // by `unshift` of a truncated snapshot) = 3, at cap.
    expect(sink.pendingRecordCount()).toBe(3);
    expect(onError).toHaveBeenCalledWith(
      "overflow",
      expect.objectContaining({ message: expect.stringContaining("dropped") }),
    );
  });

  it("serializes a record whose attribute value is `undefined` without crashing or emitting undefined", async () => {
    // `JSON.stringify(undefined)` returns the JS value `undefined`, not the
    // string "undefined". Without the guard, that surfaces in the OTLP
    // payload as `{ stringValue: undefined }` which the ingestor rejects.
    const { impl, calls } = captureFetch();
    const sink = buildAdapter({ fetchImpl: impl, minFlushIntervalMs: 0 });
    sink.adapter.log("error", "boom", {
      fnAttr: () => 1,
      undef: undefined,
      ok: "yes",
    });
    await sink.flush();
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init?.body)) as {
      resourceLogs: Array<{
        scopeLogs: Array<{
          logRecords: Array<{
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
          }>;
        }>;
      }>;
    };
    const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const fnAttr = attrs.find((a) => a.key === "fnAttr");
    // Function should fall back to a stringified form, never `undefined`.
    expect(fnAttr).toBeDefined();
    expect(typeof (fnAttr?.value as { stringValue?: unknown }).stringValue).toBe("string");
    // `undefined` attrs are dropped at the serializer top-level filter.
    expect(attrs.find((a) => a.key === "undef")).toBeUndefined();
  });

  it("concurrent flushes share a single in-flight POST", async () => {
    let release: ((res: Response) => void) | undefined;
    const slow: typeof fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ) as unknown as typeof fetch;
    const sink = buildAdapter({ fetchImpl: slow, minFlushIntervalMs: 0 });
    sink.adapter.log("error", "x");
    const a = sink.flush();
    const b = sink.flush();
    expect(slow).toHaveBeenCalledTimes(1);
    release?.(new Response("{}", { status: 200 }));
    await Promise.all([a, b]);
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
