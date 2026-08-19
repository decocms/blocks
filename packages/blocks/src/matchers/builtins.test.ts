import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatcherContext } from "../cms/resolve";
import { evaluateMatcher, registerMatcher, unregisterMatcher } from "../cms/resolve";
import { createSiteSetup } from "../setup";
import { __resetPathnamePatternCache, registerBuiltinMatchers } from "./builtins";

const LOCATION_KEY = "website/matchers/location.ts";
const DATE_KEY = "website/matchers/date.ts";

beforeEach(() => {
  registerBuiltinMatchers();
});

function ctxFromCookies(cookies: Record<string, string>): MatcherContext {
  return { cookies };
}

function ctxFromCf(cf: Record<string, unknown>): MatcherContext {
  const request = new Request("https://example.com/");
  Object.defineProperty(request, "cf", { value: cf, configurable: true });
  return { request };
}

function ctxFromHeaders(headers: Record<string, string>): MatcherContext {
  return {
    request: new Request("https://example.com/", { headers }),
  };
}

function match(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  return evaluateMatcher({ ...rule, __resolveType: LOCATION_KEY }, ctx);
}

describe("locationMatcher — typed mode (Location)", () => {
  it("matches when regionCode equals Cloudflare's cf-region-code (SP)", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP", "cf-ipcountry": "BR" });
    expect(match({ includeLocations: [{ regionCode: "SP" }] }, ctx)).toBe(true);
  });

  it("matches a raw numeric regionCode (e.g. '47') for parity with deco-cx/apps", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "47", "cf-ipcountry": "BR" });
    expect(match({ includeLocations: [{ regionCode: "47" }] }, ctx)).toBe(true);
  });

  it("is case-insensitive on regionCode", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(match({ includeLocations: [{ regionCode: "sp" }] }, ctx)).toBe(true);
  });

  it("does NOT match a region NAME against cf-region-code (parity with original)", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(
      match({ includeLocations: [{ regionCode: "São Paulo" }] }, ctx),
    ).toBe(false);
  });

  it("does not match when the region differs", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(match({ includeLocations: [{ regionCode: "RJ" }] }, ctx)).toBe(false);
  });

  it("AND's multiple fields on the same entry (regionCode + country)", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP", "cf-ipcountry": "BR" });
    expect(
      match(
        { includeLocations: [{ regionCode: "SP", country: "BR" }] },
        ctx,
      ),
    ).toBe(true);
    expect(
      match(
        { includeLocations: [{ regionCode: "SP", country: "AR" }] },
        ctx,
      ),
    ).toBe(false);
  });

  it("resolves country aliases (Brasil → BR)", () => {
    const ctx = ctxFromHeaders({ "cf-ipcountry": "BR", "cf-region-code": "SP" });
    expect(
      match({ includeLocations: [{ country: "Brasil" }] }, ctx),
    ).toBe(true);
  });

  it("OR's across multiple include entries", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "RJ" });
    expect(
      match(
        {
          includeLocations: [{ regionCode: "SP" }, { regionCode: "RJ" }],
        },
        ctx,
      ),
    ).toBe(true);
  });
});

describe("locationMatcher — empty / shape edge cases", () => {
  it("empty includeLocations array → match (no constraint)", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(match({ includeLocations: [] }, ctx)).toBe(true);
  });

  it("missing includeLocations → match", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(match({}, ctx)).toBe(true);
  });

  it("entry {} inside includeLocations matches everyone (parity with original)", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP", "cf-ipcountry": "BR" });
    expect(match({ includeLocations: [{}] }, ctx)).toBe(true);
  });

  it("entry {} inside excludeLocations does NOT exclude anyone (parity)", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP", "cf-ipcountry": "BR" });
    expect(match({ excludeLocations: [{}] }, ctx)).toBe(true);
  });

  it("excludeLocations short-circuits over includeLocations", () => {
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(
      match(
        {
          includeLocations: [{ regionCode: "SP" }],
          excludeLocations: [{ regionCode: "SP" }],
        },
        ctx,
      ),
    ).toBe(false);
  });

  it("includeLocations with [{regionCode}] fails when geo is empty", () => {
    expect(
      match({ includeLocations: [{ regionCode: "SP" }] }, {}),
    ).toBe(false);
  });
});

describe("locationMatcher — Map mode (haversine)", () => {
  it("matches when source coords are within target radius", () => {
    // Target: São Paulo center, 5km. Source: ~500m away.
    const ctx = ctxFromHeaders({
      "cf-iplatitude": "-23.5510",
      "cf-iplongitude": "-46.6340",
    });
    expect(
      match(
        { includeLocations: [{ coordinates: "-23.5505,-46.6333,5000" }] },
        ctx,
      ),
    ).toBe(true);
  });

  it("does NOT match when source coords are outside the radius", () => {
    // Target: São Paulo, 5km. Source: Rio (~360km away).
    const ctx = ctxFromHeaders({
      "cf-iplatitude": "-22.9068",
      "cf-iplongitude": "-43.1729",
    });
    expect(
      match(
        { includeLocations: [{ coordinates: "-23.5505,-46.6333,5000" }] },
        ctx,
      ),
    ).toBe(false);
  });

  it("Map-only rule does NOT match when source has no coordinates", () => {
    // Deliberate divergence from deco-cx/apps: upstream lets coord-only rules
    // vacuously pass when the visitor has no lat/lng, which matches every
    // such visitor — a footgun in production. We require both sides to have
    // coordinates before the haversine check passes.
    const ctx = ctxFromHeaders({ "cf-region-code": "SP" });
    expect(
      match(
        { includeLocations: [{ coordinates: "-23.5505,-46.6333,5000" }] },
        ctx,
      ),
    ).toBe(false);
  });

  it("AND's coordinates with regionCode on the same entry", () => {
    // Source: SP coords, region=SP.
    const ctx = ctxFromHeaders({
      "cf-region-code": "SP",
      "cf-iplatitude": "-23.5510",
      "cf-iplongitude": "-46.6340",
    });
    // Entry asks for region=SP AND within 5km of SP center — matches.
    expect(
      match(
        {
          includeLocations: [
            { regionCode: "SP", coordinates: "-23.5505,-46.6333,5000" },
          ],
        },
        ctx,
      ),
    ).toBe(true);
    // Entry asks for region=SP AND within 5km of Rio — fails on coords.
    expect(
      match(
        {
          includeLocations: [
            { regionCode: "SP", coordinates: "-22.9068,-43.1729,5000" },
          ],
        },
        ctx,
      ),
    ).toBe(false);
  });
});

describe("locationMatcher — data source fallbacks", () => {
  it("reads from request.cf when headers are absent", () => {
    const ctx = ctxFromCf({ country: "BR", regionCode: "SP" });
    expect(match({ includeLocations: [{ regionCode: "SP" }] }, ctx)).toBe(true);
  });

  it("reads from __cf_geo_* cookies as fallback", () => {
    const ctx = ctxFromCookies({
      __cf_geo_country: "BR",
      __cf_geo_region_code: "SP",
    });
    expect(match({ includeLocations: [{ regionCode: "SP" }] }, ctx)).toBe(true);
  });

  it("decodes URL-encoded cookie values (e.g. city with accent)", () => {
    const ctx = ctxFromCookies({
      __cf_geo_country: "BR",
      __cf_geo_city: encodeURIComponent("São Paulo"),
    });
    expect(
      match({ includeLocations: [{ city: "São Paulo" }] }, ctx),
    ).toBe(true);
  });

  it("headers take precedence over request.cf and cookies", () => {
    const request = new Request("https://example.com/", {
      headers: { "cf-region-code": "SP" },
    });
    Object.defineProperty(request, "cf", {
      value: { regionCode: "RJ", country: "BR" },
      configurable: true,
    });
    const ctx: MatcherContext = {
      request,
      cookies: { __cf_geo_region_code: "MG" },
    };
    expect(match({ includeLocations: [{ regionCode: "SP" }] }, ctx)).toBe(true);
    expect(match({ includeLocations: [{ regionCode: "RJ" }] }, ctx)).toBe(false);
  });
});

function matchDate(rule: Record<string, unknown>): boolean {
  return evaluateMatcher({ ...rule, __resolveType: DATE_KEY }, {});
}

describe("dateMatcher — parity with deco-cx/apps website/matchers/date.ts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches when neither start nor end is given (vacuously true)", () => {
    expect(matchDate({})).toBe(true);
  });

  it("matches when now is after start and no end is given", () => {
    expect(matchDate({ start: "2026-07-01T00:00:00Z" })).toBe(true);
  });

  it("does not match when now is before start", () => {
    expect(matchDate({ start: "2026-08-01T00:00:00Z" })).toBe(false);
  });

  it("matches when now is before end and no start is given", () => {
    expect(matchDate({ end: "2026-08-01T00:00:00Z" })).toBe(true);
  });

  it("does not match when now is after end", () => {
    expect(matchDate({ end: "2026-06-01T00:00:00Z" })).toBe(false);
  });

  it("matches when now is strictly between start and end", () => {
    expect(
      matchDate({ start: "2026-07-01T00:00:00Z", end: "2026-07-31T00:00:00Z" }),
    ).toBe(true);
  });

  it("does not match outside a [start, end] window in either direction", () => {
    expect(
      matchDate({ start: "2026-08-01T00:00:00Z", end: "2026-09-01T00:00:00Z" }),
    ).toBe(false);
    expect(
      matchDate({ start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" }),
    ).toBe(false);
  });

  it("does not match at the exact start boundary instant (strict >, not >=)", () => {
    expect(matchDate({ start: "2026-07-07T12:00:00Z" })).toBe(false);
  });

  it("does not match at the exact end boundary instant (strict <, not <=)", () => {
    expect(matchDate({ end: "2026-07-07T12:00:00Z" })).toBe(false);
  });

  it("treats an invalid start date as non-matching (NaN comparison is always false)", () => {
    expect(matchDate({ start: "not-a-date" })).toBe(false);
  });

  it("treats an invalid end date as non-matching", () => {
    expect(matchDate({ end: "not-a-date" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pathnameMatcher — CMS `case` shape
//
// These use the exact shape the CMS emits (`{ case: { type, pathname } }`),
// not a normalized one: the production bug was precisely the divergence
// between what the CMS writes and what the matcher read.
// ---------------------------------------------------------------------------

const PATHNAME_KEY = "website/matchers/pathname.ts";
const QUERYSTRING_KEY = "website/matchers/queryString.ts";

function matchPathname(rule: Record<string, unknown>, path: string): boolean {
  return evaluateMatcher({ ...rule, __resolveType: PATHNAME_KEY }, { path });
}

describe("pathnameMatcher — CMS case shape", () => {
  beforeEach(() => {
    __resetPathnamePatternCache();
  });

  it("matches a route template against a PDP path", () => {
    expect(matchPathname({ case: { type: "Template", pathname: "/:slug/p" } }, "/vestido-x/p")).toBe(
      true,
    );
  });

  it("does not match a template when the segment count differs", () => {
    const rule = { case: { type: "Template", pathname: "/:slug/p" } };
    expect(matchPathname(rule, "/farm-etc")).toBe(false);
    expect(matchPathname(rule, "/a/b/p")).toBe(false);
  });

  it("does not treat the template as a literal substring (the shipped bug)", () => {
    // Pre-fix, `Template` fell into the `Includes` default and tested
    // path.includes("/:slug/p") — false for every real URL.
    expect(matchPathname({ case: { type: "Template", pathname: "/:slug/p" } }, "/:slug/p")).toBe(
      true,
    );
    expect(matchPathname({ case: { type: "Template", pathname: "/:slug/p" } }, "/x/p")).toBe(true);
  });

  it("supports a wildcard template", () => {
    const rule = { case: { type: "Template", pathname: "/*/p" } };
    expect(matchPathname(rule, "/vestido/p")).toBe(true);
    expect(matchPathname(rule, "/vestido")).toBe(false);
  });

  it("matches templates identically with no global URLPattern (older Node / the nextjs target)", () => {
    const original = (globalThis as Record<string, unknown>).URLPattern;
    // biome-ignore lint/performance/noDelete: restoring the global needs a true absence
    delete (globalThis as Record<string, unknown>).URLPattern;
    try {
      __resetPathnamePatternCache();
      expect(matchPathname({ case: { type: "Template", pathname: "/:slug/p" } }, "/x/p")).toBe(true);
      expect(matchPathname({ case: { type: "Template", pathname: "/:slug/p" } }, "/x")).toBe(false);
      expect(matchPathname({ case: { type: "Template", pathname: "/:slug/p" } }, "/a/b/p")).toBe(
        false,
      );
      expect(matchPathname({ case: { type: "Template", pathname: "/*/p" } }, "/x/p")).toBe(true);
      // Literal dots stay literal, not regex wildcards.
      expect(matchPathname({ case: { type: "Template", pathname: "/a.b" } }, "/axb")).toBe(false);
    } finally {
      (globalThis as Record<string, unknown>).URLPattern = original;
      __resetPathnamePatternCache();
    }
  });

  it("returns false for an unsafe/uncompilable template instead of throwing", () => {
    expect(matchPathname({ case: { type: "Template", pathname: "/(((" } }, "/x/p")).toBe(false);
  });

  it("reuses the compiled pattern across calls (cache is transparent)", () => {
    const rule = { case: { type: "Template", pathname: "/:slug/p" } };
    expect(matchPathname(rule, "/a/p")).toBe(true);
    expect(matchPathname(rule, "/b/p")).toBe(true);
    expect(matchPathname(rule, "/b")).toBe(false);
  });

  // --- regressions: the pre-existing case types must be untouched ---

  it("still handles Includes", () => {
    expect(matchPathname({ case: { type: "Includes", pathname: "/farm-etc" } }, "/farm-etc")).toBe(
      true,
    );
    expect(matchPathname({ case: { type: "Includes", pathname: "/farm-etc" } }, "/farm")).toBe(
      false,
    );
  });

  it("still handles Equals, Not Includes and Starts With", () => {
    expect(matchPathname({ case: { type: "Equals", pathname: "/a" } }, "/a")).toBe(true);
    expect(matchPathname({ case: { type: "Equals", pathname: "/a" } }, "/a/b")).toBe(false);
    expect(matchPathname({ case: { type: "Not Includes", pathname: "/a" } }, "/b")).toBe(true);
    expect(matchPathname({ case: { type: "Starts With", pathname: "/a" } }, "/a/b")).toBe(true);
  });

  it("still falls back to substring matching for an unknown case type", () => {
    expect(matchPathname({ case: { type: "Whatever", pathname: "/farm" } }, "/x/farm/y")).toBe(true);
  });

  it("still handles the standard pattern/includes/excludes shape", () => {
    expect(matchPathname({ pattern: "^/p/" }, "/p/x")).toBe(true);
    expect(matchPathname({ includes: ["/a/*"] }, "/a/b")).toBe(true);
    expect(matchPathname({ includes: ["/a/*"], excludes: ["/a/b"] }, "/a/b")).toBe(false);
    expect(matchPathname({}, "/a")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// queryStringMatcher — CMS `conditions[]` shape
// ---------------------------------------------------------------------------

function matchQuery(rule: Record<string, unknown>, url: string): boolean {
  return evaluateMatcher({ ...rule, __resolveType: QUERYSTRING_KEY }, { url });
}

describe("queryStringMatcher — CMS conditions shape", () => {
  it("matches the exact rule the CMS emits for brand=farmetc", () => {
    const rule = {
      conditions: [{ case: { type: "Equals", value: "farmetc" }, param: "brand" }],
    };
    expect(matchQuery(rule, "https://www.farmrio.com.br/vestido/p?brand=farmetc")).toBe(true);
    expect(matchQuery(rule, "https://www.farmrio.com.br/vestido/p?brand=farm")).toBe(false);
    expect(matchQuery(rule, "https://www.farmrio.com.br/vestido/p")).toBe(false);
  });

  it("ANDs every condition in the array", () => {
    const rule = {
      conditions: [
        { case: { type: "Equals", value: "farmetc" }, param: "brand" },
        { case: { type: "Equals", value: "1" }, param: "preview" },
      ],
    };
    expect(matchQuery(rule, "https://x.com/p?brand=farmetc&preview=1")).toBe(true);
    expect(matchQuery(rule, "https://x.com/p?brand=farmetc")).toBe(false);
  });

  it("handles Not Equals, including an absent param", () => {
    const rule = { conditions: [{ case: { type: "Not Equals", value: "farm" }, param: "brand" }] };
    expect(matchQuery(rule, "https://x.com/p?brand=farmetc")).toBe(true);
    expect(matchQuery(rule, "https://x.com/p")).toBe(true);
    expect(matchQuery(rule, "https://x.com/p?brand=farm")).toBe(false);
  });

  it("handles Includes and Not Includes", () => {
    const includes = { conditions: [{ case: { type: "Includes", value: "etc" }, param: "brand" }] };
    expect(matchQuery(includes, "https://x.com/p?brand=farmetc")).toBe(true);
    expect(matchQuery(includes, "https://x.com/p?brand=farm")).toBe(false);
    expect(matchQuery(includes, "https://x.com/p")).toBe(false);

    const notIncludes = {
      conditions: [{ case: { type: "Not Includes", value: "etc" }, param: "brand" }],
    };
    expect(notIncludes && matchQuery(notIncludes, "https://x.com/p?brand=farm")).toBe(true);
    expect(matchQuery(notIncludes, "https://x.com/p?brand=farmetc")).toBe(false);
  });

  it("matches when any value of a repeated param satisfies a positive condition", () => {
    const rule = { conditions: [{ case: { type: "Equals", value: "b" }, param: "x" }] };
    expect(matchQuery(rule, "https://x.com/p?x=a&x=b")).toBe(true);
    const negated = { conditions: [{ case: { type: "Not Equals", value: "b" }, param: "x" }] };
    expect(matchQuery(negated, "https://x.com/p?x=a&x=b")).toBe(false);
  });

  it("accepts a top-level case + param (single-condition CMS shape)", () => {
    expect(
      matchQuery({ param: "brand", case: { type: "Equals", value: "farmetc" } }, "https://x.com/p?brand=farmetc"),
    ).toBe(true);
  });

  it("returns false for an empty or param-less conditions array", () => {
    expect(matchQuery({ conditions: [] }, "https://x.com/p?brand=farmetc")).toBe(false);
    expect(
      matchQuery({ conditions: [{ case: { type: "Equals", value: "farmetc" } }] }, "https://x.com/p?brand=farmetc"),
    ).toBe(false);
  });

  // --- regressions: the flat { key, value } shape must be untouched ---

  it("still handles the flat key/value shape", () => {
    expect(matchQuery({ key: "brand", value: "farm" }, "https://x.com/p?brand=farm")).toBe(true);
    expect(matchQuery({ key: "brand", value: "farm" }, "https://x.com/p?brand=etc")).toBe(false);
    expect(matchQuery({ param: "brand", value: "farm" }, "https://x.com/p?brand=farm")).toBe(true);
  });

  it("still treats a missing value as a presence check", () => {
    expect(matchQuery({ key: "brand" }, "https://x.com/p?brand=anything")).toBe(true);
    expect(matchQuery({ key: "brand" }, "https://x.com/p?other=1")).toBe(false);
  });

  it("still returns false with no key and with no url", () => {
    expect(matchQuery({ value: "farm" }, "https://x.com/p?brand=farm")).toBe(false);
    expect(evaluateMatcher({ __resolveType: QUERYSTRING_KEY, key: "brand" }, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The ETC Segment block, end to end: Includes OR (Template AND queryString)
// ---------------------------------------------------------------------------

describe("ETC Segment — multi matcher over the real rule shapes", () => {
  const etcSegment = {
    __resolveType: "website/matchers/multi.ts",
    op: "or",
    matchers: [
      {
        __resolveType: PATHNAME_KEY,
        case: { type: "Includes", pathname: "/farm-etc" },
      },
      {
        __resolveType: "website/matchers/multi.ts",
        op: "and",
        matchers: [
          { __resolveType: PATHNAME_KEY, case: { type: "Template", pathname: "/:slug/p" } },
          {
            __resolveType: QUERYSTRING_KEY,
            conditions: [{ case: { type: "Equals", value: "farmetc" }, param: "brand" }],
          },
        ],
      },
    ],
  };

  function atUrl(url: string): boolean {
    return evaluateMatcher(etcSegment, { url, path: new URL(url).pathname });
  }

  it("matches the category page (first branch — worked before the fix)", () => {
    expect(atUrl("https://www.farmrio.com.br/farm-etc")).toBe(true);
  });

  it("matches an ETC PDP (second branch — the branch that never fired)", () => {
    expect(atUrl("https://www.farmrio.com.br/vestido-longo/p?brand=farmetc")).toBe(true);
  });

  it("does not match a FARM PDP", () => {
    expect(atUrl("https://www.farmrio.com.br/vestido-longo/p?brand=farm")).toBe(false);
    expect(atUrl("https://www.farmrio.com.br/vestido-longo/p")).toBe(false);
  });

  it("does not match an unrelated page", () => {
    expect(atUrl("https://www.farmrio.com.br/vestidos")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Matcher-override contract (#4)
// ---------------------------------------------------------------------------

describe("matcher override contract", () => {
  const OVERRIDE_KEY = "website/matchers/host.ts";

  afterEach(() => {
    // Drop the site override so the framework can reclaim the key.
    unregisterMatcher(OVERRIDE_KEY);
    registerBuiltinMatchers();
  });

  it("keeps a site override registered BEFORE registerBuiltinMatchers()", () => {
    registerMatcher(OVERRIDE_KEY, () => true);
    registerBuiltinMatchers();
    // The builtin host matcher returns false without a `host` prop.
    expect(evaluateMatcher({ __resolveType: OVERRIDE_KEY }, {})).toBe(true);
  });

  it("keeps a site override registered AFTER registerBuiltinMatchers()", () => {
    registerBuiltinMatchers();
    registerMatcher(OVERRIDE_KEY, () => true);
    expect(evaluateMatcher({ __resolveType: OVERRIDE_KEY }, {})).toBe(true);
  });

  it("survives createSiteSetup() regardless of registration order", () => {
    registerMatcher(OVERRIDE_KEY, () => true);
    createSiteSetup({ sections: {}, blocks: {} });
    expect(evaluateMatcher({ __resolveType: OVERRIDE_KEY }, {})).toBe(true);

    // ...and a later override still wins over the builtins createSiteSetup registered.
    registerMatcher(OVERRIDE_KEY, () => false);
    expect(evaluateMatcher({ __resolveType: OVERRIDE_KEY }, {})).toBe(false);
  });

  it("still lets registerBuiltinMatchers() replace resolve.ts's inline builtin", () => {
    // resolve.ts registers an inclusive [start, end] date matcher at module
    // load; builtins.ts registers the strict-inequality one. Framework-owned
    // keys stay overwritable — only *site* registrations are protected.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00Z"));
    try {
      registerBuiltinMatchers();
      expect(evaluateMatcher({ __resolveType: DATE_KEY, start: "2026-07-07T12:00:00Z" }, {})).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
