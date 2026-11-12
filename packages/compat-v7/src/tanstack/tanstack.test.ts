// @vitest-environment node
// biome-ignore-all lint/correctness/useHookAtTopLevel: v7 and this port call useDevice outside a render on purpose; the test checks that path
/**
 * `@decocms/compat-v7/tanstack` and `/tanstack/server` against v7's own code
 * (latest 7.x, `src/__fixtures__/v7`, run by `__tests__/v7Device.ts`):
 *
 * - `matcherContext`: one context per request and page URL, and the page's
 *   URL required on a server-function call;
 * - `requestDevice`: v7's `detectDevice` on the request's user agent;
 * - `DeviceProvider`/`useDevice`: v7's sdk/useDeviceContext.tsx with a value,
 *   in a browser without one, and on the server with no request in scope.
 *
 * TanStack Start's `getRequest()` is replaced by the request each case serves.
 */

import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { v7DetectDevice, v7Device, v7Runtime } from "../__tests__/v7Device";
import { DeviceProvider, useDevice } from "./index.ts";
import { matcherContext, requestDevice } from "./server.ts";

/** A provider element with its child (`createElement`'s third argument, which the provider's props type can't see). */
const provide = (provider: unknown, props: object, child: ReactNode) =>
  createElement(provider as FunctionComponent<object>, props, child);

const served = vi.hoisted(() => ({ request: undefined as Request | undefined }));

vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => served.request }));

function serve(request: Request): void {
  served.request = request;
}

afterEach(() => {
  vi.restoreAllMocks();
  served.request = undefined;
});

describe("matcherContext", () => {
  it("one context per request and page URL", () => {
    const request = new Request("https://loja.example/a");
    serve(request);
    const a = matcherContext();
    expect(a).toEqual({ request, url: "https://loja.example/a" });
    expect(matcherContext()).toBe(a);
    expect(matcherContext("https://loja.example/a")).toBe(a);
    const b = matcherContext("/b");
    expect(b).not.toBe(a);
    expect(b.url).toBe("https://loja.example/b");
    expect(b.request).toBe(request);
    serve(new Request("https://loja.example/a"));
    expect(matcherContext()).not.toBe(a);
  });

  it("a server-function call without the page URL throws, saying what to pass", () => {
    serve(new Request("https://loja.example/_serverFn/abc"));
    expect(() => matcherContext()).toThrow(/pass the page's URL/);
    expect(matcherContext("/p").url).toBe("https://loja.example/p");
  });
});

const UAS = [
  "",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-X700) Chrome/129.0.0.0 Safari/537.36",
];

describe("the device", () => {
  it("requestDevice is v7's detectDevice on the request's user agent", () => {
    for (const ua of UAS) {
      const request = new Request("https://loja.example/", { headers: { "user-agent": ua } });
      serve(request);
      expect([ua, requestDevice()]).toEqual([ua, v7DetectDevice.detectDevice(ua)]);
      expect(requestDevice(request)).toBe(v7DetectDevice.detectDevice(ua));
    }
  });

  const Show = ({ hook }: { hook: () => string }) => createElement("i", null, hook());

  it("DeviceProvider with a value renders what v7's did", () => {
    for (const value of ["mobile", "tablet", "desktop"] as const) {
      const ours = renderToStaticMarkup(
        provide(DeviceProvider, { value }, createElement(Show, { hook: useDevice })),
      );
      const theirs = renderToStaticMarkup(
        provide(
          v7Device.DeviceProvider,
          { value },
          createElement(Show, { hook: v7Device.useDevice }),
        ),
      );
      expect(ours).toBe(theirs);
      expect(ours).toBe(`<i>${value}</i>`);
    }
  });

  it("without a value, in a browser: the browser's user agent, as v7", () => {
    for (const ua of UAS) {
      vi.stubGlobal("document", {});
      vi.stubGlobal("navigator", { userAgent: ua });
      try {
        const ours = renderToStaticMarkup(
          provide(DeviceProvider, {}, createElement(Show, { hook: useDevice })),
        );
        const theirs = renderToStaticMarkup(
          provide(v7Device.DeviceProvider, {}, createElement(Show, { hook: v7Device.useDevice })),
        );
        expect([ua, ours]).toEqual([ua, theirs]);
        // Outside a render, both skip the context.
        expect(useDevice()).toBe(v7Device.useDevice());
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("without a value on the server: v7 with no request in scope (desktop)", () => {
    v7Runtime.current = null;
    for (const element of [
      provide(DeviceProvider, {}, createElement(Show, { hook: useDevice })),
      createElement(Show, { hook: useDevice }),
    ]) {
      expect(renderToStaticMarkup(element)).toBe("<i>desktop</i>");
    }
    expect(renderToStaticMarkup(createElement(Show, { hook: v7Device.useDevice }))).toBe(
      "<i>desktop</i>",
    );
    expect(useDevice()).toBe(v7Device.useDevice());
  });
});
