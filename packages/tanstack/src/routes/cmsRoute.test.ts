import { describe, expect, it } from "vitest";
import { parseLoadCmsHomePageInput, parseLoadCmsPageInput } from "./cmsRoute";

describe("parseLoadCmsPageInput (#292)", () => {
  it("treats a bare string as the path with resolveGlobals defaulting to true (back-compat)", () => {
    expect(parseLoadCmsPageInput("/produto/tenis")).toEqual({
      path: "/produto/tenis",
      resolveGlobals: true,
    });
  });

  it("accepts { path, resolveGlobals } and preserves an explicit false", () => {
    expect(parseLoadCmsPageInput({ path: "/produto/tenis", resolveGlobals: false })).toEqual({
      path: "/produto/tenis",
      resolveGlobals: false,
    });
  });

  it("defaults resolveGlobals to true when omitted from the object form", () => {
    expect(parseLoadCmsPageInput({ path: "/produto/tenis" })).toEqual({
      path: "/produto/tenis",
      resolveGlobals: true,
    });
  });
});

describe("parseLoadCmsHomePageInput (#292)", () => {
  it("defaults resolveGlobals to true when called with no data (back-compat)", () => {
    expect(parseLoadCmsHomePageInput(undefined)).toEqual({ resolveGlobals: true });
  });

  it("preserves an explicit resolveGlobals: false", () => {
    expect(parseLoadCmsHomePageInput({ resolveGlobals: false })).toEqual({ resolveGlobals: false });
  });
});
