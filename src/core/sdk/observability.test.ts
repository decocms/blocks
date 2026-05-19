import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestStore } from "../runtime/requestStore";
import {
  configureMeter,
  configureTracer,
  getActiveSpan,
  injectTraceContext,
  recordCacheMetric,
  type Span,
  setObservabilitySpanStore,
  withTracing,
} from "./observability";

function fakeStore<T>(): RequestStore<T> {
  let current: T | undefined;
  return {
    get: () => current,
    run<R>(value: T, fn: () => R): R {
      const prev = current;
      current = value;
      try {
        const result = fn();
        if (result instanceof Promise) {
          return result.finally(() => {
            current = prev;
          }) as unknown as R;
        }
        current = prev;
        return result;
      } catch (err) {
        current = prev;
        throw err;
      }
    },
  };
}

function recordingTracer() {
  const spans: Array<{ name: string; attrs?: Record<string, unknown>; ended: boolean }> = [];
  return {
    spans,
    startSpan: (name: string, attrs?: Record<string, string | number | boolean>) => {
      const entry = { name, attrs, ended: false };
      spans.push(entry);
      const span: Span = {
        end: () => {
          entry.ended = true;
        },
        spanContext: () => ({
          traceId: "11112222333344445555666677778888",
          spanId: "aabbccddeeff0011",
          traceFlags: 1,
        }),
      };
      return span;
    },
  };
}

describe("injectTraceContext", () => {
  beforeEach(() => {
    setObservabilitySpanStore(fakeStore<Span | null>());
    configureTracer(recordingTracer());
  });

  afterEach(() => {
    setObservabilitySpanStore(undefined);
  });

  it("writes a well-formed traceparent inside an active span", async () => {
    await withTracing("t", async () => {
      const headers = new Headers();
      injectTraceContext(headers);
      expect(headers.get("traceparent")).toBe(
        "00-11112222333344445555666677778888-aabbccddeeff0011-01",
      );
    });
  });

  it("is a no-op outside any active span", () => {
    const headers = new Headers();
    injectTraceContext(headers);
    expect(headers.get("traceparent")).toBeNull();
  });

  it("pads single-bit traceFlags to two hex chars", async () => {
    // recordingTracer always emits traceFlags=1 → "01"
    await withTracing("t", async () => {
      const headers = new Headers();
      injectTraceContext(headers);
      expect(headers.get("traceparent")?.endsWith("-01")).toBe(true);
    });
  });
});

describe("withTracing — active span propagation", () => {
  beforeEach(() => {
    setObservabilitySpanStore(fakeStore<Span | null>());
    configureTracer(recordingTracer());
  });

  afterEach(() => {
    setObservabilitySpanStore(undefined);
  });

  it("getActiveSpan returns the current span inside the callback", async () => {
    await withTracing("outer", async () => {
      expect(getActiveSpan()).not.toBeNull();
    });
    expect(getActiveSpan()).toBeNull();
  });
});

describe("recordCacheMetric — stamps cache decision on active span", () => {
  beforeEach(() => {
    setObservabilitySpanStore(fakeStore<Span | null>());
  });

  afterEach(() => {
    setObservabilitySpanStore(undefined);
    configureMeter({ counterInc: () => {} });
  });

  function captureSpan() {
    const setAttribute = vi.fn();
    const span: Span = { end: vi.fn(), setAttribute };
    return { span, setAttribute };
  }

  it("stamps deco.cache.decision and deco.cache.profile on the active span", async () => {
    const { span, setAttribute } = captureSpan();
    configureTracer({ startSpan: () => span });
    configureMeter({ counterInc: vi.fn() });

    await withTracing("outer", async () => {
      recordCacheMetric(true, "product", "STALE-HIT");
    });

    expect(setAttribute).toHaveBeenCalledWith("deco.cache.decision", "STALE-HIT");
    expect(setAttribute).toHaveBeenCalledWith("deco.cache.profile", "product");
  });

  it("is a no-op for span stamping when no active span exists", () => {
    configureMeter({ counterInc: vi.fn() });
    expect(() => recordCacheMetric(false, "product", "MISS")).not.toThrow();
  });

  it("still records the counter even when no span is active", () => {
    const counterInc = vi.fn();
    configureMeter({ counterInc });
    recordCacheMetric(false, "product", "MISS");
    expect(counterInc).toHaveBeenCalledOnce();
    expect(counterInc).toHaveBeenCalledWith(
      "cache_miss_total",
      1,
      { profile: "product", decision: "MISS" },
    );
  });

  it("stamps cache.decision but no profile when profile is omitted", async () => {
    const { span, setAttribute } = captureSpan();
    configureTracer({ startSpan: () => span });
    configureMeter({ counterInc: vi.fn() });

    await withTracing("outer", async () => {
      recordCacheMetric(true, undefined, "HIT");
    });

    expect(setAttribute).toHaveBeenCalledWith("deco.cache.decision", "HIT");
    expect(setAttribute).not.toHaveBeenCalledWith(
      "deco.cache.profile",
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Regression — state survives cross-module-instance access
//
// The 5.3.0-rc.0 release hit a "phantom" no-op: tsup inlined this module
// into every entry file in dist/, so `configureMeter()` called inside
// `dist/core/sdk/otel.js` wrote to a `meter` variable that
// `recordRequestMetric()` inside `dist/tanstack/sdk/workerEntry.js` never
// saw (each entry held its own copy of the module's locals). Direct-POST
// metrics silently no-op'd in prod despite the boot breadcrumb showing
// `otlpMetrics: true`.
//
// Fix: park state on `globalThis` under a `Symbol.for(...)` slot so all
// copies of this module read/write the same object.
//
// This test simulates the cross-bundle scenario by re-importing the
// module via Vitest's cache reset — each fresh import re-runs the
// top-level `getState()` lazy init, which under the bug returned a fresh
// `meter: null` each time. Under the fix, all imports converge on the
// same `globalThis[Symbol.for(...)].meter`.
// ---------------------------------------------------------------------------

describe("module state singleton (cross-bundle)", () => {
  it("configureMeter writes survive a module re-import", async () => {
    vi.resetModules();
    const a = await import("./observability");
    const counter = vi.fn();
    a.configureMeter({ counterInc: counter });

    vi.resetModules();
    const b = await import("./observability");
    // Module B's source has its OWN `meter` local in the unfixed code.
    // Under the fix both modules look up via Symbol.for, so module B's
    // `recordCacheMetric` finds the meter that module A installed.
    b.recordCacheMetric(true, "product", "HIT");

    expect(counter).toHaveBeenCalledTimes(1);
    expect(counter).toHaveBeenCalledWith(
      "cache_hit_total",
      1,
      { profile: "product", decision: "HIT" },
    );
  });

  it("configureTracer + active-span propagation survive re-import", async () => {
    const setAttribute = vi.fn();
    const span: Span = { end: () => {}, setAttribute };

    vi.resetModules();
    const a = await import("./observability");
    a.configureTracer({ startSpan: () => span });
    a.setObservabilitySpanStore(fakeStore<Span | null>());

    vi.resetModules();
    const b = await import("./observability");
    await b.withTracing("outer", async () => {
      b.setSpanAttribute("k", "v");
    });

    expect(setAttribute).toHaveBeenCalledWith("k", "v");
  });
});
