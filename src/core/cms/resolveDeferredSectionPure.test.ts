import { describe, expect, it } from "vitest";
import { resolveDeferredSectionPure } from "./resolveDeferredSectionPure";
import type { MatcherContext } from "./resolve";

describe("resolveDeferredSectionPure", () => {
  it("is a function (path, sectionKey, ctx, opts?)", () => {
    expect(typeof resolveDeferredSectionPure).toBe("function");
  });

  it("returns null for an unknown section", async () => {
    const ctx: MatcherContext = {
      userAgent: "",
      url: "http://t/",
      path: "/",
      cookies: {},
    };
    const r = await resolveDeferredSectionPure(
      "/",
      "site/sections/DoesNotExist.tsx",
      ctx,
    );
    expect(r).toBeNull();
  });
});
