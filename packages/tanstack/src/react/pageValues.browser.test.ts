import { afterEach, describe, expect, it } from "vitest";
import { pageValues, publishScript } from "./pageValues.ts";

afterEach(() => {
  const w = window as unknown as Record<string, unknown>;
  delete w.__DECO_CSEG;
  delete w.__DECO_DRAFT;
  delete w.__DECO_EXPERIMENTS;
});

describe("page values in the browser", () => {
  it("are what the server published on window", () => {
    const w = window as unknown as Record<string, unknown>;
    w.__DECO_CSEG = "a1b2c3d4";
    w.__DECO_DRAFT = "studio.decocms.com/x@1";
    expect(pageValues()).toEqual({ cseg: "a1b2c3d4", draft: "studio.decocms.com/x@1" });
  });

  it("read the tests the server published back as they were, a test named __proto__ included", () => {
    // JSON.parse: in an object literal, `__proto__` would set the prototype, not a key.
    const experiments = JSON.parse('{"__proto__":true,"hero-copy":false}');
    const script = publishScript({ experiments });
    expect(script).toContain("__proto__");
    // Runs the published script as the page's inline <script> would.
    new Function(script as string)();
    const read = pageValues().experiments ?? {};
    expect(Object.keys(read)).toEqual(["__proto__", "hero-copy"]);
    expect(Object.getOwnPropertyDescriptor(read, "__proto__")?.value).toBe(true);
    // The browser's copy publishes the same markup as the server's: no hydration mismatch.
    expect(publishScript(pageValues())).toBe(script);
  });
});
