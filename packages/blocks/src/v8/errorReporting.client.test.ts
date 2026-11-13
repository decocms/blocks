// @vitest-environment node
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureException, startErrorCapture } from "./errorReporting.client";

let page: JSDOM;
let bodies: Record<string, unknown>[];
beforeEach(() => {
  page = new JSDOM("<!doctype html>", { url: "https://shop.example/product?secret=private" });
  bodies = [];
  vi.stubGlobal("window", page.window);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }),
  );
});
afterEach(() => {
  page.window.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser error reporting", () => {
  it("imports without installing listeners or requiring a DOM", async () => {
    const add = vi.spyOn(page.window, "addEventListener");
    vi.resetModules();
    await import("./errorReporting.client");
    expect(add).not.toHaveBeenCalled();
    vi.stubGlobal("window", undefined);
    expect(() => captureException(new Error("SSR"))).not.toThrow();
    expect(() => startErrorCapture()).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a caught render error without location, props, cookies or a credential", () => {
    captureException(new TypeError("render broke"), { source: "render", component: "site-header" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "/deco/_errors",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        mode: "same-origin",
        redirect: "error",
        keepalive: true,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(bodies[0]).toMatchObject({
      name: "TypeError",
      message: "render broke",
      source: "render",
      component: "site-header",
    });
    expect(Object.keys(bodies[0]!).sort()).toEqual([
      "component",
      "message",
      "name",
      "source",
      "stack",
    ]);
    expect(JSON.stringify(bodies)).not.toContain("secret=private");
  });

  it("installs each listener only once across duplicate module imports", async () => {
    const add = vi.spyOn(page.window, "addEventListener");
    startErrorCapture();
    startErrorCapture();
    vi.resetModules();
    const secondCopy = await import("./errorReporting.client");
    secondCopy.startErrorCapture();
    expect(add.mock.calls.filter(([name]) => name === "error")).toHaveLength(1);
    expect(add.mock.calls.filter(([name]) => name === "unhandledrejection")).toHaveLength(1);
    const error = new Error("once");
    page.window.dispatchEvent(new page.window.ErrorEvent("error", { error }));
    secondCopy.captureException(error);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("captures uncaught rejections and ignores resource/opaque errors", () => {
    startErrorCapture();
    page.window.dispatchEvent(new page.window.Event("error"));
    const rejection = new page.window.Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: "rejected string" });
    page.window.dispatchEvent(rejection);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ message: "rejected string", source: "request" });
  });

  it("caps a page at twenty reports, including across duplicate modules", async () => {
    for (let i = 0; i < 25; i++) captureException(new Error(`failure-${i}`));
    vi.resetModules();
    (await import("./errorReporting.client")).captureException(new Error("another copy"));
    expect(fetch).toHaveBeenCalledTimes(20);
  });

  it("bounds escaped control text by encoded bytes and tolerates hostile getters", () => {
    captureException({
      name: "Error",
      message: "\u0000".repeat(1_000),
      stack: "\u0000".repeat(2_000),
    });
    expect(
      new TextEncoder().encode(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)).byteLength,
    ).toBeLessThanOrEqual(8_192);
    expect(bodies[0]).not.toHaveProperty("stack");
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter");
        },
      },
    );
    expect(() => captureException(hostile)).not.toThrow();
    expect(bodies[1]).toMatchObject({ name: "Error", message: "unknown error" });
  });

  it("swallows synchronous and rejected transport failures", async () => {
    vi.mocked(fetch).mockImplementationOnce(() => {
      throw new Error("sync fetch failure");
    });
    expect(() => captureException(new Error("original sync"))).not.toThrow();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("async fetch failure"));
    expect(() => captureException(new Error("original async"))).not.toThrow();
    await Promise.resolve();
  });

  it.each([
    "body getter",
    "cancel method",
  ])("swallows a fetch wrapper's throwing %s without an unhandled rejection", async (stage) => {
    const fail = vi.fn(() => {
      throw new Error("wrapped response cleanup failed");
    });
    const response =
      stage === "body getter"
        ? Object.defineProperty({}, "body", { get: fail })
        : { body: { cancel: fail } };
    vi.mocked(fetch).mockResolvedValueOnce(response as Response);
    captureException(new Error("original application error"));
    // Allow the fulfillment callback and its terminal catch to settle. Vitest
    // fails on an unhandled rejection if cleanup escapes that catch.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetch).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledOnce();
  });

  it("scrubs relative/absolute URL details and credentials before the browser POST", () => {
    captureException({
      name: "Error",
      message:
        "failed /api/customer?email=relative-private&token=relative-token https://user-private:password-private@api.example/p#fragment-private",
      stack: "at /assets/chunk.js?value=stack-private:12:34 at ../chunk.js#hash-private:56:78",
    });
    const posted = JSON.stringify(bodies);
    for (const secret of [
      "relative-private",
      "relative-token",
      "user-private",
      "password-private",
      "fragment-private",
      "stack-private",
      "hash-private",
    ])
      expect(posted).not.toContain(secret);
    expect(bodies[0]?.stack).toContain("/assets/chunk.js?[redacted]:12:34");
    expect(bodies[0]?.stack).toContain("../chunk.js#[redacted]:56:78");
  });
});
