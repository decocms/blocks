// @vitest-environment node
// biome-ignore-all lint/correctness/useHookAtTopLevel: v7 and this port call useDevice outside a render on purpose; the test checks that path
/**
 * `@decocms/compat-v7/tanstack` and `/tanstack/server` against v7's own code
 * (latest 7.x, `src/__fixtures__/v7`, run by `__tests__/v7Page.ts`):
 *
 * - a page's sticky random decisions and the `deco_segment` cookie on its
 *   response: v7's `evaluateVariantRule` for each rule, then its TanStack page
 *   route's `persistFlags` through h3's `setCookie`;
 * - `cohortSegment`: the A/B part of v7's worker cache key;
 * - `DeviceProvider`/`useDevice`: v7's sdk/useDeviceContext.tsx with a value,
 *   in a browser without one, and on the server with no request in scope.
 *
 * TanStack Start's `getRequest()`, `getResponseHeaders()` and `setResponseHeader()` are replaced by the request
 * and response each case serves.
 */

import { createCMS } from "@decocms/blocks";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rng } from "../__tests__/v7";
import {
  cookieHeader,
  OTHER_COOKIES,
  ourDecisions,
  randomPage,
  seededMath,
  segmentValue,
  v7CacheToken,
  v7DetectDevice,
  v7Device,
  v7Multivariate,
  v7Page,
  v7Runtime,
} from "../__tests__/v7Page";
import { type RandomProps, random, SEGMENT_COOKIE } from "../matchers/index.ts";
import { DeviceProvider, useDevice } from "./index.ts";
import { cohortSegment, commitSegmentCookie, matcherContext, requestDevice } from "./server.ts";

/** A provider element with its child (`createElement`'s third argument, which the provider's props type can't see). */
const provide = (provider: unknown, props: object, child: ReactNode) =>
  createElement(provider as FunctionComponent<object>, props, child);

const served = vi.hoisted(() => ({
  request: undefined as Request | undefined,
  response: { headers: new Headers() },
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => served.request,
  // TanStack Start's semantics: a list replaces every value of the header.
  getResponseHeaders: () => new Headers(served.response.headers),
  setResponseHeader: (name: string, value: string | string[]) => {
    served.response.headers.delete(name);
    for (const v of Array.isArray(value) ? value : [value]) served.response.headers.append(name, v);
  },
}));

function serve(request: Request, setCookies: string[] = []): void {
  served.request = request;
  served.response = { headers: new Headers() };
  for (const c of setCookies) served.response.headers.append("set-cookie", c);
}

/** The fuzz runs take seconds; a busy machine (the whole suite in parallel) needs room. */
const FUZZ = { timeout: 120_000 };

afterEach(() => {
  vi.restoreAllMocks();
  served.request = undefined;
});

describe("the sticky random's cookie on the page response (latest 7.x)", () => {
  it(
    "decisions and the response's Set-Cookie match v7's page route over 5,000 seeded pages",
    FUZZ,
    () => {
      const r = rng(0x7a57);
      const pageUrl = "https://loja.example/promo?x=1";
      let cookies = 0;
      let returning = 0;
      for (let i = 0; i < 5_000; i++) {
        const page = randomPage(r);

        /** One request for the page, on v7 and on ours; ours' deco_segment Set-Cookie. */
        const visit = (cookie: string | undefined, before: string[], serverFn: boolean) => {
          const request = new Request(
            serverFn ? "https://loja.example/_serverFn/abc?payload=1" : pageUrl,
            { headers: cookie ? { cookie } : {} },
          );
          const seed = Math.floor(r() * 2 ** 31);
          const expected = v7Page(page, request, pageUrl, before, seed);
          serve(request, before);
          // The block map passes matcherContext(); the server function commits.
          const decisions = ourDecisions(
            page,
            () => matcherContext(serverFn ? pageUrl : undefined),
            seed,
          );
          const set = commitSegmentCookie();
          expect([i, decisions]).toEqual([i, expected.decisions]);
          expect([i, served.response.headers.getSetCookie()]).toEqual([i, expected.setCookies]);
          return set;
        };

        const before = OTHER_COOKIES.filter(() => r() < 0.4);
        if (r() < 0.2) before.push(`${SEGMENT_COOKIE}=stale; Path=/`);
        const cookie = r() < 0.7 ? `${SEGMENT_COOKIE}=${segmentValue(r)}` : cookieHeader(r);
        const set = visit(cookie, before, r() < 0.3);
        if (set) cookies++;
        // The visitor comes back with the cookie the page set: same groups, nothing to set.
        if (set && r() < 0.3) {
          expect([i, visit(set.split(";")[0], [], r() < 0.3)]).toEqual([i, null]);
          returning++;
        }
      }
      expect(cookies).toBeGreaterThan(1_000);
      expect(returning).toBeGreaterThan(300);
    },
  );

  it("one flags array per request; the same context per page URL", () => {
    const request = new Request("https://loja.example/a");
    serve(request);
    const a = matcherContext();
    expect(matcherContext()).toBe(a);
    expect(matcherContext("https://loja.example/a")).toBe(a);
    const b = matcherContext("/b");
    expect(b).not.toBe(a);
    expect(b.url).toBe("https://loja.example/b");
    expect(b.flags).toBe(a.flags);
    serve(new Request("https://loja.example/a"));
    expect(matcherContext().flags).not.toBe(a.flags);
  });

  it("a server-function call without the page URL throws, saying what to pass", () => {
    serve(new Request("https://loja.example/_serverFn/abc"));
    expect(() => matcherContext()).toThrow(/pass the page's URL/);
    expect(matcherContext("/p").url).toBe("https://loja.example/p");
  });

  it("commits nothing when no matcher decided", () => {
    serve(new Request("https://loja.example/"), ["a=1"]);
    expect(commitSegmentCookie()).toBeNull();
    expect(served.response.headers.getSetCookie()).toEqual(["a=1"]);
  });
});

describe("the sticky random inside a multivariate (first match, as v7)", () => {
  it(
    "@decocms/blocks' multivariate with the compat random: same winner and cookie as v7 over 2,000 seeded pages",
    FUZZ,
    async () => {
      const r = rng(0xf125);
      const pageUrl = "https://loja.example/promo";
      let later = 0;
      for (let i = 0; i < 2_000; i++) {
        const page = randomPage(r);
        const request = new Request(pageUrl, {
          headers: r() < 0.6 ? { cookie: `${SEGMENT_COOKIE}=${segmentValue(r)}` } : {},
        });
        const seed = Math.floor(r() * 2 ** 31);
        const expected = v7Multivariate(page, request, pageUrl, [], seed);

        // The site: the migrator's block map and content (saved randoms carry their name as `cohort`).
        serve(request);
        const blocks: Record<string, unknown> = {};
        for (const [name, saved] of Object.entries(page.blocks)) {
          blocks[name] = { ...saved, cohort: name };
        }
        const cms = createCMS({
          blocks: {
            "website/matchers/random.ts": (props: RandomProps) => random(props, matcherContext()),
          },
          content: { revision: `mv-${i}`, blocks },
        });
        const spy = seededMath(seed);
        let value: unknown;
        try {
          [value] = await cms.forRelease().resolve({
            __resolveType: "multivariate",
            variants: page.rules.map((rule, n) => ({
              rule,
              value: { __resolveType: "lazy", value: n },
            })),
          });
        } finally {
          spy.mockRestore();
        }
        commitSegmentCookie();
        expect([i, value ?? -1]).toEqual([i, expected.winner]);
        expect([i, served.response.headers.getSetCookie()]).toEqual([i, expected.setCookies]);
        if (expected.winner >= 0 && expected.winner < page.rules.length - 1) later++;
      }
      // Pages where rules after the winner were never drawn.
      expect(later).toBeGreaterThan(300);
    },
  );
});

describe("cohortSegment is v7's worker cache split", () => {
  it("equals v7's A/B token over 20,000 cookie headers", FUZZ, () => {
    const r = rng(0xcace);
    let split = 0;
    for (let i = 0; i < 20_000; i++) {
      const cookie = cookieHeader(r);
      const request = new Request("https://loja.example/", {
        headers: cookie ? { cookie } : {},
      });
      const token = v7CacheToken(request);
      expect([i, cookie, cohortSegment(request)]).toEqual([i, cookie, token ? { abf: token } : {}]);
      if (token) split++;
    }
    expect(split).toBeGreaterThan(5_000);
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
