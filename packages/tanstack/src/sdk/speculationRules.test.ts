import { describe, expect, it } from "vitest";
import {
  buildSpeculationRules,
  DEFAULT_EXCLUDED_HREF_MATCHES,
  getSpeculationRules,
  setSpeculationRules,
} from "./speculationRules";

describe("buildSpeculationRules", () => {
  it("defaults to prerender + moderate + document-wide, with safe exclusions", () => {
    const rule = JSON.parse(buildSpeculationRules());
    expect(rule.prerender).toHaveLength(1);
    const entry = rule.prerender[0];
    expect(entry.eagerness).toBe("moderate");
    // first condition targets all internal links; rest are exclusions
    expect(entry.where.and[0]).toEqual({ href_matches: "/*" });
    const excluded = entry.where.and
      .filter((c: { not?: { href_matches: string } }) => c.not)
      .map((c: { not: { href_matches: string } }) => c.not.href_matches);
    expect(excluded).toEqual([...DEFAULT_EXCLUDED_HREF_MATCHES]);
  });

  it("scopes to a link selector when given (excludes client-routed links)", () => {
    const rule = JSON.parse(
      buildSpeculationRules({ linkSelector: "[data-prerender] a[href]" }),
    );
    expect(rule.prerender[0].where.and[0]).toEqual({
      selector_matches: "[data-prerender] a[href]",
    });
  });

  it("merges extra exclusions and honors action/eagerness", () => {
    const rule = JSON.parse(
      buildSpeculationRules({
        action: "prefetch",
        eagerness: "conservative",
        excludeHrefMatches: ["/*/p"],
      }),
    );
    expect(rule.prefetch).toBeDefined();
    expect(rule.prerender).toBeUndefined();
    expect(rule.prefetch[0].eagerness).toBe("conservative");
    const excluded = rule.prefetch[0].where.and
      .filter((c: { not?: unknown }) => c.not)
      .map((c: { not: { href_matches: string } }) => c.not.href_matches);
    expect(excluded).toContain("/*/p");
    expect(excluded).toContain("/checkout*");
  });

  it("can replace the default exclusions entirely", () => {
    const rule = JSON.parse(
      buildSpeculationRules({
        excludeHrefMatches: ["/only-this*"],
        overrideDefaultExclusions: true,
      }),
    );
    const excluded = rule.prerender[0].where.and
      .filter((c: { not?: unknown }) => c.not)
      .map((c: { not: { href_matches: string } }) => c.not.href_matches);
    expect(excluded).toEqual(["/only-this*"]);
  });

  it("emits valid JSON for selectors containing '>'", () => {
    expect(() =>
      JSON.parse(buildSpeculationRules({ linkSelector: "nav > a" })),
    ).not.toThrow();
  });
});

describe("speculation rules activation singleton", () => {
  it("is disabled by default and toggles via set/get", () => {
    setSpeculationRules(undefined);
    expect(getSpeculationRules()).toBeUndefined();

    const cfg = { linkSelector: "[data-prerender] a[href]" };
    setSpeculationRules(cfg);
    expect(getSpeculationRules()).toBe(cfg);

    setSpeculationRules(undefined);
    expect(getSpeculationRules()).toBeUndefined();
  });
});
