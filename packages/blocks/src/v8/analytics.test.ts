// @vitest-environment jsdom
/**
 * @decocms/blocks/analytics (analytics.mdx, telemetry-internals#analytics-events):
 * the script tag, the One Dollar Stats wire format, and track().
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsScript, track } from "./analytics";
import { analyticsSection as analytics, HOSTED_ANALYTICS_COLLECTOR } from "./builtins/data";

const COLLECTOR = "https://stats.example.com/events";

let images: string[] = [];
let beacons: { url: string; body: string }[] = [];
let pixels: { onerror: (() => void) | null }[] = [];
const originalPushState = history.pushState;

beforeEach(() => {
  images = [];
  beacons = [];
  pixels = [];
  vi.stubGlobal(
    "Image",
    class {
      onerror: (() => void) | null = null;
      constructor() {
        pixels.push(this);
      }
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
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  history.replaceState(null, "", "/");
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__decoAnalytics;
  history.pushState = originalPushState;
  vi.unstubAllGlobals();
});

/** Runs the script AnalyticsScript renders, as the browser would. */
function runTracker(props = analytics({ collector: COLLECTOR })) {
  const element = AnalyticsScript(props) as ReactElement<{
    "data-url": string;
    dangerouslySetInnerHTML: { __html: string };
  }>;
  const script = document.createElement("script");
  script.setAttribute("data-url", element.props["data-url"]);
  Object.defineProperty(document, "currentScript", { configurable: true, get: () => script });
  new Function(element.props.dangerouslySetInnerHTML.__html)();
}

/** Decodes a GET `?data=` payload. */
function decode(src: string): any {
  const data = new URL(src).searchParams.get("data")?.replace(/ /g, "+") ?? "";
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe("AnalyticsScript", () => {
  it("sends a page view once: a collector answering the GET with a non-image doesn't resend it", () => {
    runTracker();
    expect(images).toHaveLength(1);
    for (const pixel of pixels) pixel.onerror?.();
    expect(beacons).toHaveLength(0);
  });

  it("renders one script tag with the collector, the hosted one by default", () => {
    expect(renderToStaticMarkup(AnalyticsScript({ collector: COLLECTOR }) as ReactElement)).toMatch(
      /^<script data-url="https:\/\/stats\.example\.com\/events">\(function\(\)\{.*<\/script>$/,
    );
    const element = AnalyticsScript({}) as ReactElement<{ "data-url": string }>;
    expect(element.props["data-url"]).toBe(HOSTED_ANALYTICS_COLLECTOR);
  });

  it("renders nothing when enabled is false", () => {
    expect(AnalyticsScript({ enabled: false })).toBeNull();
    expect(AnalyticsScript(analytics({ enabled: false }))).toBeNull();
  });
});

describe("the tracker", () => {
  it("sends a page view in the One Dollar Stats format: URL without query, as base64 JSON in ?data=", () => {
    history.replaceState(null, "", "/summer/?utm_source=mail#top");
    runTracker();
    expect(images).toHaveLength(1);
    expect(images[0]?.startsWith(`${COLLECTOR}?data=`)).toBe(true);
    expect(decode(images[0] ?? "")).toEqual({
      u: `${location.origin}/summer`,
      e: [{ t: "PageView", h: false }],
      debug: false,
    });
  });

  it("sends a page view on navigations that change the path, not on the same path", () => {
    runTracker();
    history.pushState(null, "", "/products/shirt?color=blue");
    history.pushState(null, "", "/products/shirt?color=red");
    expect(images.map((src) => decode(src).u)).toEqual([
      location.origin,
      `${location.origin}/products/shirt`,
    ]);
  });

  it("waits until a prerendered page is visible", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    runTracker();
    expect(images).toHaveLength(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(images).toHaveLength(1);
  });

  it("track() sends a custom event with its properties through the script", () => {
    runTracker();
    track("add_to_cart", { sku: "123", price: 9.9 });
    expect(decode(images[1] ?? "").e).toEqual([
      { t: "add_to_cart", h: false, p: { sku: "123", price: 9.9 } },
    ]);
  });

  it("sends payloads longer than 1500 base64 characters with sendBeacon", () => {
    runTracker();
    track("big", { blob: "x".repeat(2_000) });
    expect(beacons).toHaveLength(1);
    expect(beacons[0]?.url).toBe(COLLECTOR);
    expect(JSON.parse(beacons[0]?.body ?? "").e[0].t).toBe("big");
  });

  it("track() does nothing on a page without the script", () => {
    expect(() => track("add_to_cart", { sku: "1" })).not.toThrow();
    expect(images).toHaveLength(0);
  });
});
