import { describe, expect, it } from "vitest";
import Audience from "./audience";
import Everyone from "./everyone";
import Flag from "./flag";
import type { Matcher } from "./types";
import multivariate from "./utils/multivariate";
import ImageVariants from "./multivariate/image";
import MessageVariants from "./multivariate/message";
import PageVariants from "./multivariate/page";
import SectionVariants from "./multivariate/section";

// ---------------------------------------------------------------------------
// flag.ts
// ---------------------------------------------------------------------------

describe("Flag", () => {
  it("returns a FlagObj with the same values", () => {
    const matcher: Matcher = () => true;
    const result = Flag({
      matcher,
      true: "variant-a",
      false: "variant-b",
      name: "test-flag",
    });

    expect(result.matcher).toBe(matcher);
    expect(result.true).toBe("variant-a");
    expect(result.false).toBe("variant-b");
    expect(result.name).toBe("test-flag");
  });

  it("preserves complex true/false values", () => {
    const routes = [{ pathTemplate: "/*", handler: { value: {} } }];
    const result = Flag<typeof routes>({
      matcher: () => false,
      true: routes,
      false: [],
      name: "routes-flag",
    });

    expect(result.true).toBe(routes);
    expect(result.false).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// audience.ts
// ---------------------------------------------------------------------------

describe("Audience", () => {
  it("returns FlagObj with routes as true branch and empty as false", () => {
    const matcher: Matcher = () => true;
    const routes = [{ pathTemplate: "/products/*", handler: { value: {} } }];

    const result = Audience({ matcher, name: "vip-users", routes });

    expect(result.name).toBe("vip-users");
    expect(result.true).toEqual(routes);
    expect(result.false).toEqual([]);
  });

  it("defaults routes to empty array when not provided", () => {
    const result = Audience({ matcher: () => false, name: "empty" });

    expect(result.true).toEqual([]);
    expect(result.false).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// everyone.ts
// ---------------------------------------------------------------------------

describe("Everyone", () => {
  it("creates a flag named Everyone that always matches", () => {
    const routes = [{ pathTemplate: "/*", handler: { value: {} } }];
    const result = Everyone({ routes });

    expect(result.name).toBe("Everyone");
    expect(result.true).toEqual(routes);
    expect(result.false).toEqual([]);
    // The matcher should be MatchAlways which returns true
    expect(result.matcher({} as any)).toBe(true);
  });

  it("works with no routes", () => {
    const result = Everyone({});

    expect(result.name).toBe("Everyone");
    expect(result.true).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// multivariate
// ---------------------------------------------------------------------------

describe("multivariate", () => {
  it("returns the variants as-is", () => {
    const variants = [
      { value: "A", weight: 0.5 },
      { value: "B", weight: 0.5 },
    ];

    const result = multivariate({ variants });

    expect(result.variants).toBe(variants);
    expect(result.variants).toHaveLength(2);
  });

  it("supports variants with matchers", () => {
    const matcher: Matcher = () => true;
    const variants = [{ value: "control", matcher }, { value: "default" }];

    const result = multivariate({ variants });

    expect(result.variants[0].matcher).toBe(matcher);
    expect(result.variants[1].matcher).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// multivariate/* (Image/Message/Page/Section variants) + the multivariate.ts
// re-export (`./multivariate.ts` re-exports `./multivariate/page.ts`'s
// default, so `PageVariants` doubles as the coverage for that re-export).
// ---------------------------------------------------------------------------

describe("multivariate/*", () => {
  it("Image delegates to multivariate", () => {
    const variants = [{ value: "a.png" }, { value: "b.png" }];
    expect(ImageVariants({ variants })).toEqual({ variants });
  });

  it("Message delegates to multivariate", () => {
    const variants = [{ value: "hello" }, { value: "world" }];
    expect(MessageVariants({ variants })).toEqual({ variants });
  });

  it("Page delegates to multivariate", () => {
    const variants = [{ value: [] }, { value: [] }];
    expect(PageVariants({ variants })).toEqual({ variants });
  });

  it("Section delegates to multivariate", () => {
    const variants = [{ value: {} }, { value: {} }];
    expect(SectionVariants({ variants })).toEqual({ variants });
  });
});
