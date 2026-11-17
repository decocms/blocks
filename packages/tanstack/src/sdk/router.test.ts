import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decoParseSearch, decoStringifySearch, keepBfcacheScroll } from "./router";

describe("decoStringifySearch ∘ decoParseSearch is a fixed point", () => {
  // TanStack Router redirects (307) on the server when
  // stringifySearch(parseSearch(search)) differs from the request's search —
  // every query string that round-trips unchanged is a request that never
  // redirects.
  it.each([
    "?q=camisa&sort=",
    "?utm_source=",
    "?a=&b=",
    "?q=camisa",
    "?filter.brand=Nike&filter.brand=Adidas",
    // (`%20` is re-encoded as `+` by URLSearchParams — a pre-existing
    // normalization, out of this fix's scope.)
    "?q=a+b&page=2",
  ])("round-trips %s unchanged", (search) => {
    expect(decoStringifySearch(decoParseSearch(search))).toBe(search);
  });

  it("parses a value-less param to an empty string", () => {
    expect(decoParseSearch("?q=camisa&sort=")).toEqual({ q: "camisa", sort: "" });
  });

  it("still drops undefined and null (how navigate() removes a param)", () => {
    expect(decoStringifySearch({ q: "camisa", sort: undefined, page: null })).toBe("?q=camisa");
    expect(decoStringifySearch({ q: undefined })).toBe("");
  });

  it("keeps an explicit empty string as key= and arrays as repeated keys", () => {
    expect(decoStringifySearch({ sort: "", f: ["a", "b"] })).toBe("?sort=&f=a&f=b");
  });
});

describe("keepBfcacheScroll (iOS bfcache resume)", () => {
  // Stands in for router-core's own listener, registered first: on a
  // persisted pageshow it sets "manual", which makes iOS skip its restoration.
  const routerCoreListener = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) window.history.scrollRestoration = "manual";
  };
  const pageshow = (persisted: boolean) => {
    const event = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(event, "persisted", { value: persisted });
    window.dispatchEvent(event);
  };

  let navigate: () => void;
  let subscribed = 0;
  let dispose: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    subscribed = 0;
    navigate = () => {};
    window.history.scrollRestoration = "manual";
    window.addEventListener("pageshow", routerCoreListener);
    dispose = keepBfcacheScroll(window, (handBack) => {
      subscribed++;
      navigate = handBack;
      return () => {
        subscribed--;
        navigate = () => {};
      };
    });
  });
  afterEach(() => {
    dispose();
    window.removeEventListener("pageshow", routerCoreListener);
    vi.useRealTimers();
  });

  it("leaves 'auto' for the browser after router-core's listener on a persisted pageshow", () => {
    pageshow(true);
    expect(window.history.scrollRestoration).toBe("auto");
  });

  it("does nothing on a normal (not persisted) pageshow", () => {
    pageshow(false);
    expect(window.history.scrollRestoration).toBe("manual");
    expect(subscribed).toBe(0);
  });

  it("keeps 'auto' through scroll events and time (the restoration is not cut short)", () => {
    pageshow(true);
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(5000);
    expect(window.history.scrollRestoration).toBe("auto");
  });

  it("hands scroll back to the router on its next navigation, once", () => {
    pageshow(true);
    navigate();
    expect(window.history.scrollRestoration).toBe("manual");
    expect(subscribed).toBe(0);
  });

  it("does not stack subscriptions across repeated resumes", () => {
    pageshow(true);
    pageshow(true);
    expect(subscribed).toBe(1);
  });
});
