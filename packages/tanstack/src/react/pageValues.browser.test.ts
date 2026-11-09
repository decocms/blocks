import { afterEach, describe, expect, it } from "vitest";
import { pageValues, publishScript } from "./pageValues.ts";

afterEach(() => {
  const w = window as unknown as Record<string, unknown>;
  delete w.__DECO_CSEG;
  delete w.__DECO_DRAFT;
  delete w.__DECO_EXPERIMENTS;
  delete w.__dq;
});

/** Runs a published script as the browser would. */
const run = (script: string | null) => new Function(script ?? "")();

describe("page values in the browser", () => {
  it("are what the server published on window", () => {
    const w = window as unknown as Record<string, unknown>;
    w.__DECO_CSEG = "a1b2c3d4";
    w.__DECO_DRAFT = "studio.decocms.com/x@1";
    expect(pageValues()).toEqual({ cseg: "a1b2c3d4", draft: "studio.decocms.com/x@1" });
  });

  it("read back the tests the server published, so the browser renders the same script", () => {
    const published = publishScript({ experiments: { "hero-copy": false, "buy-button": true } });
    run(published);
    expect(pageValues().experiments).toEqual({ "buy-button": true, "hero-copy": false });
    expect(publishScript(pageValues())).toBe(published);
  });
});

describe("the tests, for the Deco Analytics tag", () => {
  const dq = () => (window as unknown as { __dq?: Record<string, unknown> }).__dq;

  it("go into its experiment map before the tag loads, which keeps it", () => {
    run(publishScript({ experiments: { "buy-button": true, "hero-copy": false } }));
    expect(dq()).toEqual({ x: { "buy-button": "on", "hero-copy": "off" } });
    // The tag's boot line, as decocms/analytics serves it: the page's values win over its defaults.
    run('window.__dq=Object.assign({s:"site"},window.__dq||{});');
    expect(dq()?.x).toEqual({ "buy-button": "on", "hero-copy": "off" });
  });

  it("merge into a map the tag (or another script) already holds, over the same names", () => {
    const booted = { s: "site", x: { "other-test": "b", "buy-button": "off" } };
    (window as unknown as Record<string, unknown>).__dq = booted;
    run(publishScript({ experiments: { "buy-button": true } }));
    expect(dq()).toBe(booted);
    expect(booted.x).toEqual({ "other-test": "b", "buy-button": "on" });
  });

  it("keep any name an own property", () => {
    run(publishScript({ experiments: { ["__proto__"]: true } }));
    const published = (window as unknown as Record<string, unknown>).__DECO_EXPERIMENTS as object;
    expect(Object.hasOwn(published, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(dq()?.x)).toBe(Object.prototype);
  });
});
