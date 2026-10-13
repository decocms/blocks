import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatcherContext } from "../cms/resolve";
import { evaluateMatcher } from "../cms/resolve";
import { registerBuiltinMatchers } from "./builtins";

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
// deco-cx/apps parity: pathname `case` (Template, negate), queryString
// `conditions`, host `includes`/`match`. Migrated content stores these shapes;
// the pre-parity readers ignored them, so e.g. a "brand segment" rule
// (`/:slug/p` AND `?brand=x`) never matched.
// ---------------------------------------------------------------------------

function urlCtx(url: string, headers: Record<string, string> = {}): MatcherContext {
  const u = new URL(url);
  return { url, path: u.pathname, request: new Request(url, { headers }) };
}

const PATHNAME_KEY = "website/matchers/pathname.ts";
const QUERY_KEY = "website/matchers/queryString.ts";
const HOST_KEY = "website/matchers/host.ts";

describe("pathnameMatcher — deco-cx/apps `case`", () => {
  const pathname = (c: Record<string, unknown>, url: string) =>
    evaluateMatcher({ __resolveType: PATHNAME_KEY, case: c }, urlCtx(url));

  it("Template matches one path segment per `:param`, whole path", () => {
    const c = { type: "Template", pathname: "/:slug/p" };
    expect(pathname(c, "https://x.com/vestido-123-456/p")).toBe(true);
    expect(pathname(c, "https://x.com/a/b/p")).toBe(false);
    expect(pathname(c, "https://x.com/vestido-123-456/p/extra")).toBe(false);
    expect(pathname(c, "https://x.com/farm-etc")).toBe(false);
  });

  it("negate inverts the result", () => {
    const c = { type: "Includes", pathname: "/farm-etc", negate: true };
    expect(pathname(c, "https://x.com/farm-etc/novidades")).toBe(false);
    expect(pathname(c, "https://x.com/novidades")).toBe(true);
  });

  it("keeps Equals / Includes", () => {
    expect(pathname({ type: "Equals", pathname: "/tapume" }, "https://x.com/tapume")).toBe(true);
    expect(pathname({ type: "Equals", pathname: "/tapume" }, "https://x.com/tapume/a")).toBe(false);
    expect(pathname({ type: "Includes", pathname: "/farm-etc" }, "https://x.com/farm-etc/a")).toBe(
      true,
    );
  });

  it("does not match a case without a pathname (as upstream)", () => {
    expect(pathname({ type: "Includes" }, "https://x.com/anything")).toBe(false);
  });
});

describe("queryStringMatcher — deco-cx/apps `conditions`", () => {
  const query = (conditions: unknown[], url: string) =>
    evaluateMatcher({ __resolveType: QUERY_KEY, conditions }, urlCtx(url));

  it("Equals on a param", () => {
    const conditions = [{ param: "brand", case: { type: "Equals", value: "farmetc" } }];
    expect(query(conditions, "https://x.com/v-1-2/p?brand=farmetc")).toBe(true);
    expect(query(conditions, "https://x.com/v-1-2/p?brand=farm")).toBe(false);
    expect(query(conditions, "https://x.com/v-1-2/p")).toBe(false);
  });

  it("every condition must hold; Exists only needs the param", () => {
    const conditions = [
      { param: "a", case: { type: "Exists" } },
      { param: "b", case: { type: "Includes", value: "x" } },
    ];
    expect(query(conditions, "https://x.com/?a=&b=1x2")).toBe(true);
    expect(query(conditions, "https://x.com/?b=1x2")).toBe(false);
    expect(query(conditions, "https://x.com/?a=1&b=2")).toBe(false);
  });

  it("matches when any of a repeated param's values does", () => {
    const conditions = [{ param: "c", case: { type: "Equals", value: "2" } }];
    expect(query(conditions, "https://x.com/?c=1&c=2")).toBe(true);
  });

  it("keeps the key/value format", () => {
    expect(
      evaluateMatcher(
        { __resolveType: QUERY_KEY, key: "utm_source", value: "x" },
        urlCtx("https://x.com/?utm_source=x"),
      ),
    ).toBe(true);
  });
});

describe("a saved brand-segment rule (multi of pathname + queryString)", () => {
  const segment = {
    __resolveType: "website/matchers/multi.ts",
    op: "or",
    matchers: [
      { __resolveType: PATHNAME_KEY, case: { type: "Includes", pathname: "/farm-etc" } },
      {
        __resolveType: "website/matchers/multi.ts",
        op: "and",
        matchers: [
          { __resolveType: PATHNAME_KEY, case: { type: "Template", pathname: "/:slug/p" } },
          {
            __resolveType: QUERY_KEY,
            conditions: [{ param: "brand", case: { type: "Equals", value: "farmetc" } }],
          },
        ],
      },
    ],
  };

  it("matches a brand listing and a brand PDP, not the other brand's PDP", () => {
    expect(evaluateMatcher(segment, urlCtx("https://x.com/farm-etc/novidades"))).toBe(true);
    expect(evaluateMatcher(segment, urlCtx("https://x.com/caneca-1-2/p?brand=farmetc"))).toBe(true);
    expect(evaluateMatcher(segment, urlCtx("https://x.com/vestido-1-2/p?brand=farm"))).toBe(false);
  });
});

describe("hostMatcher — deco-cx/apps `includes` / `match`", () => {
  const host = (rule: Record<string, unknown>, url: string) =>
    evaluateMatcher({ __resolveType: HOST_KEY, ...rule }, urlCtx(url));

  it("includes is a substring of the host", () => {
    expect(host({ includes: "www.example.com" }, "https://www.example.com/a")).toBe(true);
    expect(host({ includes: "www.example.com" }, "https://preview.example.com/a")).toBe(false);
  });

  it("match is a regex; both must hold when both are set", () => {
    expect(host({ match: "^www\\." }, "https://www.example.com/")).toBe(true);
    expect(host({ match: "^www\\.", includes: "other" }, "https://www.example.com/")).toBe(false);
  });

  it("keeps the host format", () => {
    expect(host({ host: "www.example.com" }, "https://www.example.com/")).toBe(true);
  });
});
