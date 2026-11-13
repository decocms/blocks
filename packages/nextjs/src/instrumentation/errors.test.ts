// @vitest-environment node
import type { Instrumentation } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reporting = vi.hoisted(() => ({
  reportError: vi.fn(async (_error: unknown, _context: unknown) => {}),
  flushTelemetry: vi.fn(async () => {}),
}));
vi.mock("@decocms/blocks/telemetry", () => reporting);

const { onRequestError } = await import("./index.ts");
type Context = Parameters<Instrumentation.onRequestError>[2];
const request = {
  path: "/customer/private-order?token=secret",
  method: "POST",
  headers: { authorization: "Bearer private", cookie: "customer=private" },
};
const context = (routeType: Context["routeType"]): Context => ({
  routerKind: "App Router",
  routePath: "/customer/[order]",
  routeType,
  revalidateReason: undefined,
});

beforeEach(() => {
  reporting.reportError.mockReset().mockResolvedValue(undefined);
  reporting.flushTelemetry.mockReset().mockResolvedValue(undefined);
});

describe("onRequestError", () => {
  it.each([
    "render",
    "route",
    "action",
    "proxy",
  ] as const)("reports a %s failure with only the route template and method", async (source) => {
    const error = new Error("request failed");
    await onRequestError(error, request, context(source));
    expect(reporting.reportError).toHaveBeenCalledExactlyOnceWith(error, {
      framework: "nextjs",
      source,
      route: "/customer/[order]",
      method: "POST",
    });
    expect(reporting.flushTelemetry).toHaveBeenCalledTimes(1);
    // A streamed rendering failure can happen after 200 headers. The hook
    // supplies no status, so it must not invent a 500 label.
    expect(reporting.reportError.mock.calls[0]?.[1]).not.toHaveProperty("status");
  });

  it("awaits reporting and the bounded flush before the hook settles", async () => {
    let queued!: () => void;
    reporting.reportError.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          queued = resolve;
        }),
    );
    let flushed!: () => void;
    reporting.flushTelemetry.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          flushed = resolve;
        }),
    );
    let settled = false;
    const hook = Promise.resolve(
      onRequestError(new Error("failed"), request, context("render")),
    ).then(() => {
      settled = true;
    });
    expect(reporting.flushTelemetry).not.toHaveBeenCalled();
    queued();
    await Promise.resolve();
    expect(reporting.flushTelemetry).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    flushed();
    await hook;
    expect(settled).toBe(true);
  });

  it("reports independent requests even when application code reuses an Error", async () => {
    const error = Object.assign(new Error("same fault"), { digest: "stable-fingerprint" });
    await onRequestError(error, request, context("render"));
    await onRequestError(error, request, context("render"));
    expect(reporting.reportError).toHaveBeenCalledTimes(2);
    expect(reporting.flushTelemetry).toHaveBeenCalledTimes(2);
  });

  it.each([
    "reportError",
    "flushTelemetry",
  ] as const)("a failing %s cannot replace the application's failure", async (method) => {
    reporting[method].mockRejectedValueOnce(new Error("collector unavailable"));
    await expect(
      onRequestError(new Error("original"), request, context("render")),
    ).resolves.toBeUndefined();
  });
});
