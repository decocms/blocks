// @vitest-environment node
/**
 * `@decocms/compat-v7/nextjs`, `/nextjs/server` and `/nextjs/proxy` against
 * v7's own code (latest 7.x, run by `__tests__/v7Page.ts`).
 *
 * v7's Next.js binding never wrote `deco_segment` (only its TanStack route
 * did), so the cookie is pinned to that route's: a page's sticky random
 * decisions, made through `matcherContext()`, and the cookie `SegmentCookie`'s
 * script writes in the browser, equal v7's decisions and the `Set-Cookie`
 * its `persistFlags` sent, attribute for attribute.
 *
 * `next/headers`' `headers()` is replaced by each case's request headers, and
 * React's `cache` by one memo per case (in Next it is one per request).
 */
import {
  createElement,
  type FunctionComponent,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rng } from "../__tests__/v7";
import {
  cookieHeader,
  ourDecisions,
  randomPage,
  segmentValue,
  v7DetectDevice,
  v7Page,
} from "../__tests__/v7Page";
import { type MatcherContext, SEGMENT_COOKIE } from "../matchers/index.ts";
import * as client from "./index.ts";
import { PAGE_URL_HEADER, pageUrlRequestHeaders } from "./proxy.ts";
import { matcherContext, requestDevice, SegmentCookie, segmentCookieScript } from "./server.ts";

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

/** The fuzz runs take seconds; a busy machine (the whole suite in parallel) needs room. */
const FUZZ = { timeout: 120_000 };

afterEach(() => {
  vi.restoreAllMocks();
});

/** What the browser's cookie jar receives when the script runs. */
function runScript(element: ReactElement | null): string | null {
  if (element === null) return null;
  expect(isValidElement(element)).toBe(true);
  const markup = renderToStaticMarkup(element);
  const html = /^<script[^>]*>([\s\S]*)<\/script>$/.exec(markup)?.[1];
  if (html === undefined) throw new Error(`not one script: ${markup}`);
  const jar: string[] = [];
  const document = {
    set cookie(value: string) {
      jar.push(value);
    },
  };
  new Function("document", html)(document);
  expect(jar).toHaveLength(1);
  return jar[0] as string;
}

describe("the sticky random's cookie (latest 7.x), written by the page", () => {
  it("decisions and the cookie match v7's over 5,000 seeded pages", FUZZ, async () => {
    const r = rng(0x9e47);
    const pageUrl = "https://loja.example/promo?x=1";
    let cookies = 0;
    let returning = 0;
    for (let i = 0; i < 5_000; i++) {
      const page = randomPage(r);

      const visit = async (cookie: string | undefined) => {
        const headers: Record<string, string> = cookie ? { cookie } : {};
        const seed = Math.floor(r() * 2 ** 31);
        const expected = v7Page(page, new Request(pageUrl, { headers }), pageUrl, [], seed);
        // The proxy forwarded the page URL; the block map awaits matcherContext().
        render({ ...headers, [PAGE_URL_HEADER]: pageUrl });
        const inputs: MatcherContext[] = [];
        for (const _ of page.rules) inputs.push(await matcherContext());
        let n = 0;
        const decisions = ourDecisions(page, () => inputs[n++]!, seed);
        const written = runScript(SegmentCookie());
        expect([i, decisions]).toEqual([i, expected.decisions]);
        expect([i, written]).toEqual([i, expected.setCookies[0] ?? null]);
        return written;
      };

      const cookie = r() < 0.7 ? `${SEGMENT_COOKIE}=${segmentValue(r)}` : cookieHeader(r);
      const written = await visit(cookie);
      if (written) cookies++;
      if (written && r() < 0.3) {
        expect([i, await visit(written.split(";")[0])]).toEqual([i, null]);
        returning++;
      }
    }
    expect(cookies).toBeGreaterThan(1_000);
    expect(returning).toBeGreaterThan(300);
  });

  it("one flags array per request; the same context per page URL", async () => {
    render({ [PAGE_URL_HEADER]: "https://loja.example/a" });
    const a = await matcherContext();
    expect(await matcherContext()).toBe(a);
    expect(await matcherContext("https://loja.example/a")).toBe(a);
    const b = await matcherContext("https://loja.example/b");
    expect(b).not.toBe(a);
    expect(b.flags).toBe(a.flags);
    expect(b.request).toBe(a.request);
    render({ [PAGE_URL_HEADER]: "https://loja.example/a" });
    expect((await matcherContext()).flags).not.toBe(a.flags);
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

  it("SegmentCookie renders nothing when no matcher ran, and an inert script otherwise", async () => {
    render({});
    expect(SegmentCookie()).toBeNull();
    const script = segmentCookieScript("deco_segment=</script><x>; Path=/");
    expect(script).not.toContain("</script>");
    const element = createElement("script", {
      nonce: "n1",
      dangerouslySetInnerHTML: { __html: script },
    });
    expect(runScript(element)).toBe("deco_segment=</script><x>; Path=/");
    expect(renderToStaticMarkup(element)).toContain('nonce="n1"');
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
