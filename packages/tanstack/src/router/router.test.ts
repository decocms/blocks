// @vitest-environment node
import * as clientErrors from "@decocms/blocks/telemetry/client";
import { createRootRoute } from "@tanstack/react-router";
import { JSDOM } from "jsdom";
import type { ErrorInfo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecoRouter, decoParseSearch, decoStringifySearch } from "./index.ts";

describe("search params (v7's createDecoRouter, with #646)", () => {
  it.each([
    "?q=",
    "?sort=",
    "?q=&page=2",
    "?utm_source=",
    "?filter.size=M&filter.size=L",
    "?filter.brand=Nike&filter.brand=Adidas&q=shoe",
    "?q=caf%C3%A9",
    "",
  ])("%s round-trips unchanged (no 307 to a normalized URL)", (search) => {
    expect(decoStringifySearch(decoParseSearch(search))).toBe(search);
  });

  it("repeated keys become arrays; a single value stays a string", () => {
    expect(decoParseSearch("?a=1&a=2&b=3&c=")).toEqual({ a: ["1", "2"], b: "3", c: "" });
  });

  it("undefined and null remove a param; an empty string keeps it", () => {
    expect(decoStringifySearch({ q: undefined, page: null, sort: "", n: 2 })).toBe("?sort=&n=2");
  });
});

describe("caught router rendering errors", () => {
  let page: JSDOM | undefined;
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
  });
  afterEach(() => {
    page?.window.close();
    page = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const browser = () => {
    page = new JSDOM("<!doctype html>", { url: "https://store.example/" });
    vi.stubGlobal("window", page.window);
  };
  const info: ErrorInfo = { componentStack: "private component props must not be serialized" };

  it("reports the router's caught error automatically without serializing React metadata", () => {
    browser();
    const root = createRootRoute();
    const router = createDecoRouter({ routeTree: root });
    const error = new Error("caught during render");
    router.options.defaultOnCatch!(error, info);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/deco/_errors",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      name: "Error",
      message: "caught during render",
      source: "render",
    });
    expect(body).not.toHaveProperty("componentStack");
    expect(JSON.stringify(body)).not.toContain(info.componentStack);
  });

  it("reports before invoking the application's typed callback with the same objects", () => {
    browser();
    const error = new Error("caught during render");
    const onCatch = vi.fn((received: unknown, receivedInfo: ErrorInfo) => {
      expect(fetch).toHaveBeenCalledOnce();
      expect(received).toBe(error);
      expect(receivedInfo).toBe(info);
    });
    const router = createDecoRouter({ routeTree: createRootRoute(), defaultOnCatch: onCatch });
    router.options.defaultOnCatch!(error, info);
    expect(onCatch).toHaveBeenCalledExactlyOnceWith(error, info);
  });

  it("preserves an application's callback exception after reporting", () => {
    browser();
    const original = new Error("render failure");
    const callbackFailure = new Error("application callback failure");
    const router = createDecoRouter({
      routeTree: createRootRoute(),
      defaultOnCatch: () => {
        throw callbackFailure;
      },
    });
    expect(() => router.options.defaultOnCatch!(original, info)).toThrow(callbackFailure);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("still invokes the application's callback if its reporter unexpectedly throws", () => {
    vi.spyOn(clientErrors, "captureException").mockImplementationOnce(() => {
      throw new Error("instrumentation failed");
    });
    const onCatch = vi.fn();
    const error = new Error("render failure");
    const router = createDecoRouter({ routeTree: createRootRoute(), defaultOnCatch: onCatch });
    expect(() => router.options.defaultOnCatch!(error, info)).not.toThrow();
    expect(onCatch).toHaveBeenCalledExactlyOnceWith(error, info);
  });

  it("uses the existing client reporter's server-side no-op without transport", () => {
    const onCatch = vi.fn();
    const error = new Error("server callback");
    const router = createDecoRouter({ routeTree: createRootRoute(), defaultOnCatch: onCatch });
    router.options.defaultOnCatch!(error, info);
    expect(onCatch).toHaveBeenCalledExactlyOnceWith(error, info);
    expect(fetch).not.toHaveBeenCalled();
  });
});
