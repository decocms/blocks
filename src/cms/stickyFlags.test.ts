import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./sectionLoaders", () => ({
  isLayoutSection: () => false,
  runSingleSectionLoader: vi.fn(async (section: any) => section),
}));

vi.mock("../sdk/normalizeUrls", () => ({
  normalizeUrlsInObject: vi.fn(<T>(x: T) => x),
}));

// A page whose A/B "TestHero" matcher block resolves to a 50/50 random matcher.
vi.mock("./loader", () => ({
  findPageByPath: vi.fn(),
  loadBlocks: vi.fn(() => ({
    TestHero: { __resolveType: "website/matchers/random.ts", traffic: 0.5 },
  })),
}));

vi.mock("./registry", () => ({
  getSection: vi.fn(),
}));

import { type StoredFlag, serializeSegmentCookie } from "../sdk/flags";
import type { MatcherContext } from "./resolve";
import { resolveValue } from "./resolve";

const FLAG = {
  __resolveType: "website/flags/multivariate.ts",
  variants: [
    { rule: { __resolveType: "TestHero" }, value: "VARIANT_1" },
    { rule: { __resolveType: "website/matchers/always.ts" }, value: "VARIANT_2" },
  ],
};

function ctx(decision?: { value: boolean; pct: number }): MatcherContext & { flags: StoredFlag[] } {
  const cookie = decision
    ? serializeSegmentCookie([{ name: "TestHero", value: decision.value, pct: decision.pct }])
    : undefined;
  return {
    cookies: cookie ? { deco_segment: cookie } : {},
    flags: [],
  };
}

afterEach(() => vi.restoreAllMocks());

describe("sticky A/B multivariate resolution", () => {
  it("honors a matching cookie without rolling (test cohort)", async () => {
    const rand = vi.spyOn(Math, "random");
    const c = ctx({ value: true, pct: 50 });

    const result = await resolveValue(FLAG, undefined, c);

    expect(result).toBe("VARIANT_1");
    expect(rand).not.toHaveBeenCalled();
    expect(c.flags).toEqual([{ name: "TestHero", value: true, pct: 50 }]);
  });

  it("honors a matching cookie without rolling (control cohort)", async () => {
    const rand = vi.spyOn(Math, "random");
    const c = ctx({ value: false, pct: 50 });

    const result = await resolveValue(FLAG, undefined, c);

    expect(result).toBe("VARIANT_2");
    expect(rand).not.toHaveBeenCalled();
    expect(c.flags).toEqual([{ name: "TestHero", value: false, pct: 50 }]);
  });

  it("rolls and records when there is no cookie", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9); // >= 0.5 -> control
    const c = ctx();

    const result = await resolveValue(FLAG, undefined, c);

    expect(result).toBe("VARIANT_2");
    expect(c.flags).toEqual([{ name: "TestHero", value: false, pct: 50 }]);
  });

  it("re-rolls when the cookie's traffic fingerprint is stale", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1); // < 0.5 -> test
    // Cookie says the user was in control at 70% traffic; current traffic is 50%.
    const c = ctx({ value: false, pct: 70 });

    const result = await resolveValue(FLAG, undefined, c);

    expect(result).toBe("VARIANT_1");
    expect(c.flags).toEqual([{ name: "TestHero", value: true, pct: 50 }]);
  });

  it("does not record flags when recording is not opted into", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    // No `flags` array on the context -> nothing to record, but still resolves.
    const result = await resolveValue(FLAG, undefined, { cookies: {} });
    expect(result).toBe("VARIANT_1");
  });
});
