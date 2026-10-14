import { afterEach, describe, expect, it } from "vitest";
import { pageValues } from "./pageValues.ts";

afterEach(() => {
  const w = window as unknown as Record<string, unknown>;
  delete w.__DECO_CSEG;
  delete w.__DECO_DRAFT;
});

describe("page values in the browser", () => {
  it("are what the server published on window", () => {
    const w = window as unknown as Record<string, unknown>;
    w.__DECO_CSEG = "a1b2c3d4";
    w.__DECO_DRAFT = "studio.decocms.com/x@1";
    expect(pageValues()).toEqual({ cseg: "a1b2c3d4", draft: "studio.decocms.com/x@1" });
  });
});
