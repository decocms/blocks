// @vitest-environment node
/**
 * `@decocms/compat-v7/nextjs`, `/nextjs/server` and `/nextjs/proxy`, the
 * device against v7's own code (latest 7.x, run by `__tests__/v7Device.ts`).
 *
 * `next/headers`' `headers()` is replaced by each case's request headers, and
 * React's `cache` by one memo per case (in Next it is one per request).
 */
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { v7DetectDevice } from "../__tests__/v7Device";
import * as client from "./index.ts";
import { PAGE_URL_HEADER, pageUrlRequestHeaders } from "./proxy.ts";
import { matcherContext, requestDevice } from "./server.ts";

/** A provider element with its child (`createElement`'s third argument, which the provider's props type can't see). */
const provide = (provider: unknown, props: object, child: ReactNode) =>
  createElement(provider as FunctionComponent<object>, props, child);

const request = vi.hoisted(() => ({
  headers: new Headers(),
  memo: new Map<unknown, unknown>(),
}));

vi.mock("next/headers.js", () => ({ headers: async () => request.headers }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  cache:
    <T>(fn: () => T) =>
    (): T => {
      if (!request.memo.has(fn)) request.memo.set(fn, fn());
      return request.memo.get(fn) as T;
    },
}));

/** A new request: its headers, and a fresh per-request cache. */
function render(headers: HeadersInit = {}): void {
  request.headers = new Headers(headers);
  request.memo = new Map();
}

describe("matcherContext reads the page URL the proxy forwarded", () => {
  it("one request per render; the same context per page URL", async () => {
    render({ [PAGE_URL_HEADER]: "https://loja.example/a" });
    const a = await matcherContext();
    expect(await matcherContext()).toBe(a);
    expect(await matcherContext("https://loja.example/a")).toBe(a);
    const b = await matcherContext("https://loja.example/b");
    expect(b).not.toBe(a);
    expect(b.request).toBe(a.request);
    render({ [PAGE_URL_HEADER]: "https://loja.example/a" });
    expect(await matcherContext()).not.toBe(a);
  });

  it("the request the matchers read carries the request's headers at the page URL", async () => {
    render({ cookie: "a=1", "user-agent": "UA", [PAGE_URL_HEADER]: "https://loja.example/x?y=1" });
    const { request: req, url } = await matcherContext();
    expect(url).toBe("https://loja.example/x?y=1");
    expect(req.url).toBe(url);
    expect([req.headers.get("cookie"), req.headers.get("user-agent")]).toEqual(["a=1", "UA"]);
  });

  it("without the proxy's header or a URL, it says how to forward one", async () => {
    render({});
    await expect(matcherContext()).rejects.toThrow(/pageUrlRequestHeaders/);
    expect((await matcherContext("https://loja.example/p")).url).toBe("https://loja.example/p");
  });
});

describe("the proxy forwards the visitor's URL", () => {
  it("sets x-deco-page-url to the request's URL, replacing a forged copy", () => {
    const req = new Request("https://loja.example/c/shoes?page=2", {
      headers: { [PAGE_URL_HEADER]: "https://evil.example/", cookie: "a=1" },
    });
    const headers = pageUrlRequestHeaders(req);
    expect(headers.get(PAGE_URL_HEADER)).toBe("https://loja.example/c/shoes?page=2");
    expect(headers.get("cookie")).toBe("a=1");
    // It composes with headers the proxy already prepared (the draft's).
    const prepared = new Headers({ "x-deco-draft": "abc" });
    expect(pageUrlRequestHeaders(req, prepared)).toBe(prepared);
    expect(prepared.get(PAGE_URL_HEADER)).toBe("https://loja.example/c/shoes?page=2");
  });
});

describe("the device", () => {
  it("requestDevice is v7's detectDevice on the request's user agent", async () => {
    for (const ua of [
      "",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) Mobile/15E148",
      "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X)",
      "Mozilla/5.0 (Linux; Android 13; SM-X700) Chrome/129.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0.0.0",
    ]) {
      render({ "user-agent": ua });
      expect([ua, await requestDevice()]).toEqual([ua, v7DetectDevice.detectDevice(ua)]);
    }
  });

  it("DeviceProvider and useDevice are the TanStack subpath's, one context", async () => {
    const tanstack = await import("../tanstack/index.ts");
    expect(client.DeviceProvider).toBe(tanstack.DeviceProvider);
    expect(client.useDevice).toBe(tanstack.useDevice);
    expect(client.DeviceContext).toBe(tanstack.DeviceContext);
    const Show = () => createElement("i", null, client.useDevice());
    expect(
      renderToStaticMarkup(
        provide(client.DeviceProvider, { value: "tablet" }, createElement(Show)),
      ),
    ).toBe("<i>tablet</i>");
  });
});
