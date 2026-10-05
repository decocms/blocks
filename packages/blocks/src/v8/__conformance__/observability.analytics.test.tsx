// @vitest-environment jsdom
/**
 * Conformance: analytics.mdx, the analytics rows of hosted-telemetry.mdx and
 * upstream-clients.mdx, and telemetry-internals.mdx › Analytics events.
 * Each `it` names the claim it checks (ana-*, htel-04, tin-10, up-04).
 */

import * as analyticsModule from "@decocms/blocks/analytics";
import { AnalyticsScript, track } from "@decocms/blocks/analytics";
import type { ReactElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTED_ANALYTICS_COLLECTOR } from "../builtins/data";
import { builtIns } from "../builtins/index";
import { createCMS, resetForTests } from "../cms";
import type { Analytics } from "../types";

const COLLECTOR = "https://stats.example.com/events";

let images: string[] = [];
let beacons: { url: string; body: string }[] = [];
let posts: { url: string; body: unknown }[] = [];
const originalPushState = history.pushState;

beforeEach(() => {
  resetForTests();
  images = [];
  beacons = [];
  posts = [];
  vi.stubGlobal(
    "Image",
    class {
      onerror: (() => void) | null = null;
      set src(value: string) {
        images.push(value);
      }
    },
  );
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string, body: string) => {
      beacons.push({ url, body });
      return true;
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      posts.push({ url: String(url), body: init?.body });
      return new Response(null, { status: 202 });
    }),
  );
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(document, "referrer", { configurable: true, value: "" });
  history.replaceState(null, "", "/");
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__decoAnalytics;
  history.pushState = originalPushState;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetForTests();
});

/** Runs the script AnalyticsScript renders, as the browser would. */
function runTracker(props: Analytics) {
  const element = AnalyticsScript(props) as ReactElement<{
    "data-url": string;
    dangerouslySetInnerHTML: { __html: string };
  }>;
  const script = document.createElement("script");
  script.setAttribute("data-url", element.props["data-url"]);
  Object.defineProperty(document, "currentScript", { configurable: true, get: () => script });
  new Function(element.props.dangerouslySetInnerHTML.__html)();
}

function decode(src: string): any {
  const data = new URL(src).searchParams.get("data")?.replace(/ /g, "+") ?? "";
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

const resolveAnalytics = async (section: Record<string, unknown>) => {
  const cms = createCMS({
    blocks: {},
    content: {
      revision: "r",
      blocks: { CMS: { __resolveType: "cms-settings", analytics: section } },
    },
  });
  return (await cms.settings()).analytics;
};

describe("the analytics section of the CMS settings (analytics.mdx)", () => {
  it("ana-01/ana-02/htel-04: the analytics section resolves to settings with the hosted collector and enabled: true", async () => {
    expect(await resolveAnalytics({})).toEqual({
      collector: HOSTED_ANALYTICS_COLLECTOR,
      enabled: true,
    });
    expect(await resolveAnalytics({ collector: COLLECTOR })).toEqual({
      collector: COLLECTOR,
      enabled: true,
    });
  });

  it("ana-02: the analytics section's fields are collector and enabled only (no site ID)", async () => {
    // The resolved settings carry nothing else either.
    expect(Object.keys(await resolveAnalytics({})).sort()).toEqual(["collector", "enabled"]);
  });

  it("ana-03: @decocms/blocks/analytics exports AnalyticsScript and track", () => {
    expect(typeof analyticsModule.AnalyticsScript).toBe("function");
    expect(typeof analyticsModule.track).toBe("function");
  });

  it("ana-04: cms.settings().analytics spreads into <AnalyticsScript />, with no CMS block at all", async () => {
    const cms = createCMS({ blocks: {}, content: { revision: "r", blocks: {} } });
    const { analytics } = await cms.settings();
    const html = renderToString(<AnalyticsScript {...analytics} />);
    expect(html).toContain("<script");
    expect(html).toContain(HOSTED_ANALYTICS_COLLECTOR);
  });

  it("ana-05/ana-09: enabled: false renders nothing", async () => {
    expect(renderToStaticMarkup(<AnalyticsScript enabled={false} />)).toBe("");
    const settings = await resolveAnalytics({ enabled: false });
    expect(settings.enabled).toBe(false);
    expect(renderToStaticMarkup(<AnalyticsScript {...settings} />)).toBe("");
  });

  it("ana-10: the section can have variants, picked when cms.settings() is called", async () => {
    const cms = createCMS({
      blocks: {},
      content: {
        revision: "r",
        blocks: {
          CMS: {
            __resolveType: "cms-settings",
            analytics: {
              __resolveType: "multivariate",
              variants: [
                {
                  rule: { __resolveType: "never" },
                  value: { __resolveType: "lazy", value: { collector: "https://a.example" } },
                },
                {
                  rule: { __resolveType: "always" },
                  value: { __resolveType: "lazy", value: { enabled: false } },
                },
              ],
            },
          },
        },
      },
    });
    const { analytics } = await cms.settings();
    expect(analytics).toEqual({ collector: HOSTED_ANALYTICS_COLLECTOR, enabled: false });
  });

  it("up-04: the framework ships always, never, date, multivariate and cms-settings built-ins", () => {
    for (const name of ["always", "never", "date", "multivariate", "cms-settings"]) {
      expect(typeof builtIns[name]).toBe("function");
    }
  });
});

describe("the tracker in the browser (analytics.mdx)", () => {
  it("ana-06: sends a page view on load and on each navigation: path without query, referrer and hostname", () => {
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: "https://news.example/story?id=1",
    });
    history.replaceState(null, "", "/landing?utm_source=mail");
    runTracker({ collector: COLLECTOR, enabled: true });
    history.pushState(null, "", "/a?q=1");
    window.dispatchEvent(new PopStateEvent("popstate"));
    history.replaceState(null, "", "/b?q=2");
    window.dispatchEvent(new PopStateEvent("popstate"));
    const views = images.map(decode);
    expect(views.map((v) => new URL(v.u).pathname)).toEqual(["/landing", "/a", "/b"]);
    for (const view of views) {
      expect(new URL(view.u).hostname).toBe(location.hostname);
      expect(view.u).not.toContain("?");
    }
    expect(views[0].e[0].r).toBe("https://news.example/story");
  });

  it("ana-07: track(name, props) sends a custom event through the script", () => {
    runTracker({ collector: COLLECTOR, enabled: true });
    track("add_to_cart", { sku: "123" });
    expect(decode(images[1] ?? "").e[0]).toMatchObject({ t: "add_to_cart", p: { sku: "123" } });
  });

  it("ana-07: without the script, track does nothing and doesn't throw", () => {
    expect(() => track("add_to_cart", { sku: "123" })).not.toThrow();
    expect(images).toEqual([]);
    expect(beacons).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("ana-11: no cookies, no browser storage; query strings are dropped", () => {
    const cookieSet = vi.fn();
    const cookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => "",
      set: cookieSet,
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    try {
      history.replaceState(null, "", "/search?q=private+term");
      runTracker({ collector: COLLECTOR, enabled: true });
      track("search", { results: 3 });
      expect(cookieSet).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
      expect(getItem).not.toHaveBeenCalled();
      for (const src of images) expect(JSON.stringify(decode(src))).not.toContain("private");
    } finally {
      delete (document as unknown as Record<string, unknown>).cookie;
      if (cookieDescriptor) Object.defineProperty(Document.prototype, "cookie", cookieDescriptor);
    }
  });

  it("ana-13: analytics is independent of telemetry: it runs with telemetry: false and never posts OTLP", () => {
    createCMS({ blocks: {}, content: { revision: "r", blocks: {} }, telemetry: false });
    runTracker({ collector: COLLECTOR, enabled: true });
    track("big", { blob: "x".repeat(2_000) });
    expect(images.length).toBeGreaterThan(0);
    for (const url of [...images, ...beacons.map((b) => b.url), ...posts.map((p) => p.url)]) {
      expect(url.startsWith(COLLECTOR)).toBe(true);
      expect(url).not.toMatch(/\/v1\/(metrics|logs|traces)/);
    }
  });
});

describe("wire format (telemetry-internals.mdx › Analytics events)", () => {
  it("tin-10: a short payload is a GET with base64 JSON in ?data=: the page URL without query, and events with type, cross-site referrer and properties", () => {
    history.replaceState(null, "", "/summer/?utm=1#top");
    runTracker({ collector: COLLECTOR, enabled: true });
    expect(images).toHaveLength(1);
    expect(images[0]?.startsWith(`${COLLECTOR}?data=`)).toBe(true);
    // stonks.js (One Dollar Stats): { u: page URL, e: [{ t: type, h: hash routing, r: referrer, p: props }] }
    expect(decode(images[0] ?? "")).toEqual({
      u: `${location.origin}/summer`,
      e: [{ t: "PageView", h: false }],
      debug: false,
    });
  });

  it("tin-10: a long payload goes with navigator.sendBeacon", () => {
    runTracker({ collector: COLLECTOR, enabled: true });
    track("big", { blob: "x".repeat(2_000) });
    expect(beacons).toHaveLength(1);
    expect(beacons[0]?.url).toBe(COLLECTOR);
    expect(JSON.parse(beacons[0]?.body ?? "").e[0].t).toBe("big");
  });

  it("tin-10: without sendBeacon, a long payload is POSTed", async () => {
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: undefined });
    runTracker({ collector: COLLECTOR, enabled: true });
    track("big", { blob: "x".repeat(2_000) });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(COLLECTOR);
  });
});
