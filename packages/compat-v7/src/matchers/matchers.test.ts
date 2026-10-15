// @vitest-environment node
/**
 * Every matcher against v7's own code (latest 7.x, `src/__fixtures__/v7`):
 * cms/resolve.ts' `evaluateMatcher` (with matchers/builtins.ts registered, as
 * v7 sites did at setup) and `evaluateVariantRule` (the sticky random), and
 * the TanStack page route's `persistFlags` for the cookie. v7's context is
 * built the way that route built it: the user agent, the page URL, the path
 * TanStack's splat gave (decoded), and the cookies h3 parsed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { v7Loader, v7Source } from "../__tests__/loadV7";
import { pick, rng } from "../__tests__/v7";
import {
  COUNTRY_NAME_TO_CODE,
  cookie,
  decideRandom,
  device,
  environment,
  host,
  INLINE_COHORT,
  location,
  type MatcherContext,
  multi,
  parseCookies,
  parseSegmentCookie,
  pathname,
  queryString,
  random,
  resolveCountryCode,
  SEGMENT_COOKIE,
  type StoredFlag,
  segmentCacheToken,
  segmentSetCookie,
  serializeSegmentCookie,
  trafficToPct,
} from "./index.ts";

// ---------------------------------------------------------------------------
// v7, loaded from the reference files
// ---------------------------------------------------------------------------

let savedBlocks: Record<string, unknown> = {};
/** What v7's `persistFlags` set, through h3's `setCookie`: `serialize(name, value, { path: "/", ...options })`. */
const setCookies: string[] = [];
const v7 = v7Loader({
  stubs: {
    "cms/loader": { loadBlocks: () => savedBlocks },
    "tanstack/routes/__h3": {
      setCookie: (name: string, value: string, options: object) =>
        setCookies.push(h3.serialize(name, value, { path: "/", ...options })),
    },
  },
});
const resolve = v7("cms/resolve.ts", { expose: ["evaluateVariantRule"] });
const builtins = v7("matchers/builtins.ts");
builtins.registerBuiltinMatchers();
const flags = v7("sdk/flags.ts");
const countries = v7("matchers/countryNames.ts");
const h3 = v7("vendor/h3-cookie.js");

/** `persistFlags` from v7's TanStack page route, verbatim, with h3's `setCookie`. */
const persistFlags: (ctx: object) => StoredFlag[] = (() => {
  const text = v7Source("tanstack/routes/cmsRoute.ts");
  const start = text.indexOf("/** One year");
  const fn = text.indexOf("function persistFlags(");
  const end = text.indexOf("\n}\n", fn) + 3;
  expect([start > 0, fn > start, end > fn]).toEqual([true, true, true]);
  const source = [
    'import { parseSegmentCookie, SEGMENT_COOKIE, serializeSegmentCookie } from "../../sdk/flags";',
    'import { setCookie } from "./__h3";',
    text.slice(start, end),
  ].join("\n");
  return v7("tanstack/routes/__persistFlags.ts", { source, expose: ["persistFlags"] }).persistFlags;
})();

/** The context v7's TanStack page route made for a page request. */
function v7Ctx(request: Request, extra: { flags?: StoredFlag[] } = {}) {
  const url = new URL(request.url);
  let path: string;
  try {
    path = `/${decodeURIComponent(url.pathname.slice(1))}`;
  } catch {
    path = url.pathname;
  }
  return {
    userAgent: request.headers.get("user-agent") ?? "",
    url: request.url,
    path,
    cookies: h3.parse(request.headers.get("cookie") ?? ""),
    request,
    ...extra,
  };
}

const evaluate = (type: string, props: object, request: Request): boolean =>
  resolve.evaluateMatcher(
    { ...props, __resolveType: `website/matchers/${type}.ts` },
    v7Ctx(request),
  );

/** The fuzz runs take seconds; a busy machine (the whole suite in parallel) needs room. */
const FUZZ = { timeout: 120_000 };

afterEach(() => {
  vi.restoreAllMocks();
  savedBlocks = {};
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const UAS = [
  "",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Opera/9.80 (J2ME/MIDP; Opera Mini/9.80 (S60; SymbOS; Opera Mobi/23.348; U; en) Presto/2.5.25",
  "Mozilla/5.0 (compatible; MSIE 10.0; Windows Phone 8.0; Trident/6.0; IEMobile/10.0; ARM; Touch)",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];
const UA_TOKENS = [
  "Mobile",
  "Android",
  "iPhone",
  "iPod",
  "iPad",
  "Tablet",
  "webOS",
  "BlackBerry",
  "Opera Mini",
  "IEMobile",
  "Windows",
  "Macintosh",
  "Linux",
  "mobile",
  "ANDROID",
  "KFTT",
  "Silk",
  "x",
];
const HOSTS = [
  "www.example.com",
  "example.com",
  "shop.example.com:8443",
  "localhost:3000",
  "loja.exemplo.com.br",
  "EXAMPLE.com",
  "a.b.c.d.example.org",
];
const SEGMENTS = [
  "",
  "p",
  "c",
  "shoes",
  "s",
  "caf%C3%A9",
  "a%20b",
  "50%25",
  "Home",
  "x.y",
  "%2F",
  "busca",
  "produto-123",
  ":slug",
  "*",
  "UPPER",
];
const PARAMS = ["q", "page", "sort", "utm_source", "filter.category-1", "a", "b", "PS", "x y"];
const VALUES = ["", "1", "2", "10", "abc", "ABC", "shoes", "a b", "%", "%E0%A4%A", "0", "-1", "z"];
const COOKIE_NAMES = [
  "a",
  "session",
  "deco_segment",
  "__cf_geo_country",
  "__cf_geo_region_code",
  "__cf_geo_city",
  "__cf_geo_lat",
  "__cf_geo_lng",
  "vtex_segment",
  "theme",
  "constructor",
];
const COOKIE_VALUES = [
  "1",
  "abc",
  '"quoted"',
  "a%20b",
  "%E0%A4%A",
  " spaced ",
  "",
  "BR",
  "SP",
  "S%C3%A3o%20Paulo",
  "-23.55",
  "-46.63",
  "x=y",
  "Brasil",
];
const COUNTRY = ["BR", "US", "br", "Brasil", "Brazil", "united states", "México", "PT", "", "XX"];
const REGION = ["SP", "sp", "RJ", "CA", "", "MG"];
const CITY = ["São Paulo", "sao paulo", "Rio de Janeiro", "Lisbon", "", "Campinas"];
const COORDS = ["-23.5505,-46.6333", "-22.9068,-43.1729", "38.72,-9.14", "", "x,y", "40.7,-74.0"];

function ua(r: () => number): string {
  if (r() < 0.5) return pick(r, UAS);
  return Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(r, UA_TOKENS)).join(
    pick(r, [" ", "; ", "/", "("]),
  );
}

function cookieHeader(r: () => number): string {
  const n = Math.floor(r() * 5);
  const pairs = Array.from({ length: n }, () => {
    const name = pick(r, COOKIE_NAMES);
    if (name === SEGMENT_COOKIE && r() < 0.7) return `${name}=${segmentValue(r)}`;
    return `${r() < 0.1 ? " " : ""}${name}=${pick(r, COOKIE_VALUES)}`;
  });
  if (r() < 0.1) pairs.push("novalue");
  return pairs.join(pick(r, ["; ", ";", " ; "]));
}

function randomFlags(r: () => number): StoredFlag[] {
  return Array.from({ length: Math.floor(r() * 4) }, () => ({
    name: pick(r, ["Hero test", "Banner AB", INLINE_COHORT, "plp-ranking", "Ç test"]),
    value: r() < 0.2 ? pick(r, ["a", "b"]) : r() < 0.5,
    pct: pick(r, [-1, 0, 10, 30, 50, 100, Math.round(r() * 100)]),
  }));
}

function segmentValue(r: () => number): string {
  const roll = r();
  if (roll < 0.1) return "garbage";
  if (roll < 0.2) return btoa(encodeURIComponent(JSON.stringify({ active: ["Hero test"] })));
  return flags.serializeSegmentCookie(randomFlags(r));
}

function makeRequest(r: () => number): Request {
  const path = Array.from({ length: Math.floor(r() * 4) }, () => pick(r, SEGMENTS)).join("/");
  const query = Array.from(
    { length: Math.floor(r() * 4) },
    () => `${encodeURIComponent(pick(r, PARAMS))}=${encodeURIComponent(pick(r, VALUES))}`,
  ).join("&");
  const urlHost = pick(r, HOSTS);
  const url = `https://${urlHost}/${path}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = {};
  if (r() < 0.9) headers["user-agent"] = ua(r);
  if (r() < 0.7) headers.host = r() < 0.7 ? urlHost : pick(r, HOSTS);
  const cookies = cookieHeader(r);
  if (cookies) headers.cookie = cookies;
  if (r() < 0.4) headers["cf-ipcountry"] = pick(r, COUNTRY);
  if (r() < 0.4) headers["cf-region-code"] = pick(r, REGION);
  if (r() < 0.4) headers["cf-ipcity"] = pick(r, CITY);
  if (r() < 0.3) {
    const [lat, lng] = pick(r, COORDS).split(",");
    if (lat) headers["cf-iplatitude"] = lat;
    if (lng) headers["cf-iplongitude"] = lng;
  }
  if (r() < 0.1) headers["x-vercel-ip-country"] = pick(r, COUNTRY);
  let request: Request;
  try {
    request = new Request(url, { headers });
  } catch {
    request = new Request("https://example.com/", { headers: {} });
  }
  if (r() < 0.2) {
    const [lat, lng] = pick(r, COORDS).split(",");
    Object.assign(request, {
      cf: {
        country: pick(r, COUNTRY),
        regionCode: r() < 0.5 ? pick(r, REGION) : undefined,
        city: pick(r, CITY),
        latitude: r() < 0.5 ? Number(lat) : lat,
        longitude: r() < 0.5 ? lng : undefined,
      },
    });
  }
  return request;
}

/** Sometimes a well-formed value, sometimes not: v7 got whatever was saved. */
const odd = (r: () => number) => pick(r, [undefined, null, 0, 1, true, "", "x", [], {}, ["a"]]);
const maybe = <T>(r: () => number, value: () => T) => (r() < 0.75 ? value() : odd(r));

function pathString(r: () => number): string {
  return `/${Array.from({ length: Math.floor(r() * 3) }, () =>
    pick(
      r,
      SEGMENTS.map((s) => (s.includes("%") ? decodeURIComponent(s) : s)),
    ),
  ).join("/")}${r() < 0.3 ? "*" : ""}`;
}

const PROPS: Record<string, (r: () => number) => object> = {
  device: (r) => ({
    mobile: maybe(r, () => r() < 0.5),
    tablet: maybe(r, () => r() < 0.5),
    desktop: maybe(r, () => r() < 0.5),
  }),
  cookie: (r) => ({
    name: maybe(r, () => pick(r, COOKIE_NAMES)),
    value:
      r() < 0.4
        ? undefined
        : maybe(r, () =>
            pick(
              r,
              COOKIE_VALUES.map((v) => v.trim()),
            ),
          ),
  }),
  host: (r) => ({
    includes:
      r() < 0.5 ? undefined : maybe(r, () => pick(r, [...HOSTS, "example", "shop", ":8443"])),
    match:
      r() < 0.6
        ? undefined
        : maybe(r, () =>
            pick(r, ["^www\\.", "example\\.com$", "(a+)+", "[", "shop|loja", ".*", "EXAMPLE"]),
          ),
    host: r() < 0.5 ? undefined : maybe(r, () => pick(r, HOSTS)),
  }),
  pathname: (r) => {
    if (r() < 0.5) {
      return {
        case: maybe(r, () => ({
          type: maybe(r, () =>
            pick(r, ["Equals", "Includes", "Not Includes", "Starts With", "Template", "Other"]),
          ),
          pathname: maybe(r, () => pick(r, [pathString(r), "/:slug/p", "/c/:a", "p", "café", "/"])),
          negate: r() < 0.3 ? true : undefined,
        })),
      };
    }
    return {
      pattern:
        r() < 0.5
          ? undefined
          : maybe(r, () =>
              pick(r, ["^/p", "shoes$", "(x+)+", "(", "^/$", "/c/.*", ".{501}", "café"]),
            ),
      includes:
        r() < 0.5
          ? undefined
          : maybe(r, () => Array.from({ length: Math.floor(r() * 3) }, () => pathString(r))),
      excludes:
        r() < 0.5
          ? undefined
          : maybe(r, () => Array.from({ length: Math.floor(r() * 3) }, () => pathString(r))),
    };
  },
  queryString: (r) => {
    if (r() < 0.6) {
      return {
        conditions: maybe(r, () =>
          Array.from({ length: Math.floor(r() * 3) }, () => ({
            param: maybe(r, () => pick(r, PARAMS)),
            case: maybe(r, () => ({
              type: maybe(r, () =>
                pick(r, [
                  "Exists",
                  "Equals",
                  "Greater",
                  "GreaterOrEquals",
                  "Lesser",
                  "LesserOrEquals",
                  "Includes",
                  "Bogus",
                ]),
              ),
              value: maybe(r, () => pick(r, VALUES)),
            })),
          })),
        ),
      };
    }
    return {
      [r() < 0.5 ? "key" : "param"]: maybe(r, () => pick(r, PARAMS)),
      value: r() < 0.4 ? undefined : maybe(r, () => pick(r, VALUES)),
    };
  },
  location: (r) => {
    const entry = () =>
      maybe(r, () => ({
        country: r() < 0.5 ? undefined : maybe(r, () => pick(r, COUNTRY)),
        regionCode: r() < 0.6 ? undefined : pick(r, REGION),
        city: r() < 0.6 ? undefined : pick(r, CITY),
        coordinates:
          r() < 0.7 ? undefined : `${pick(r, COORDS)},${pick(r, ["5000", "1", "x", "900000"])}`,
      }));
    return {
      includeLocations:
        r() < 0.3 ? undefined : maybe(r, () => Array.from({ length: Math.floor(r() * 3) }, entry)),
      excludeLocations:
        r() < 0.5 ? undefined : maybe(r, () => Array.from({ length: Math.floor(r() * 3) }, entry)),
    };
  },
};

const OURS: Record<string, (props: never, request: MatcherContext | Request) => boolean> = {
  device,
  cookie,
  host,
  pathname,
  queryString,
  location,
};

// ---------------------------------------------------------------------------
// Request-reading matchers
// ---------------------------------------------------------------------------

describe("the request-reading matchers give v7's result", () => {
  for (const [type, gen] of Object.entries(PROPS)) {
    it(`${type}: 20k seeded cases`, FUZZ, () => {
      const r = rng(0x5eed + type.length * 7919 + type.charCodeAt(0));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let matched = 0;
      for (let i = 0; i < 20_000; i++) {
        const request = makeRequest(r);
        const props = gen(r);
        const expected = evaluate(type, props, request);
        const actual = OURS[type]!(props as never, i % 2 ? request : { request });
        if (actual !== expected) {
          expect({ i, props, url: request.url, headers: [...request.headers], actual }).toEqual({
            i,
            props,
            url: request.url,
            headers: [...request.headers],
            actual: expected,
          });
        }
        if (expected) matched++;
      }
      // The generator reaches both outcomes often.
      expect(matched).toBeGreaterThan(1_000);
      expect(matched).toBeLessThan(19_000);
    });
  }

  it("match the page's URL when it isn't the request's (a client-side navigation)", () => {
    const request = new Request("https://example.com/_serverFn/abc?payload=1", {
      headers: { host: "example.com" },
    });
    const ctx = { request, url: "https://example.com/c/shoes?q=red" };
    expect(pathname({ case: { type: "Equals", pathname: "/c/shoes" } }, ctx)).toBe(true);
    expect(queryString({ key: "q", value: "red" }, ctx)).toBe(true);
    expect(queryString({ key: "payload" }, ctx)).toBe(false);
  });

  it("read the decoded path, as TanStack's splat gave v7", () => {
    const request = new Request("https://example.com/caf%C3%A9/a%20b");
    expect(pathname({ case: { type: "Equals", pathname: "/café/a b" } }, request)).toBe(true);
    expect(evaluate("pathname", { case: { type: "Equals", pathname: "/café/a b" } }, request)).toBe(
      true,
    );
  });

  it("need the request: a call without one says how to pass it", () => {
    expect(() => device({}, undefined as never)).toThrow(/second argument/);
    expect(() => device({}, {} as never)).toThrow(/pass the Request/);
  });
});

describe("cookies are read as v7 read them (h3's parse)", () => {
  it("20k seeded headers", FUZZ, () => {
    const r = rng(0xc00c1e);
    const chars = ["a", "b", "=", ";", " ", '"', "%", "2", "0", "E", "_", "x", "\t", "é"];
    for (let i = 0; i < 20_000; i++) {
      const header =
        r() < 0.5
          ? cookieHeader(r)
          : Array.from({ length: Math.floor(r() * 24) }, () => pick(r, chars)).join("");
      expect([header, parseCookies(header)]).toEqual([header, h3.parse(header)]);
    }
  });
});

describe("multi", () => {
  it("combines its rules' results with v7's and/or", FUZZ, () => {
    const r = rng(0x3417);
    resolve.registerMatcher("test/yes", () => true);
    resolve.registerMatcher("test/no", () => false);
    for (let i = 0; i < 5_000; i++) {
      const results = Array.from({ length: Math.floor(r() * 4) }, () => r() < 0.5);
      const op = pick(r, [undefined, "and", "or", "OR", "xor"]);
      const rule = {
        __resolveType: "website/matchers/multi.ts",
        op,
        matchers:
          r() < 0.1
            ? undefined
            : results.map((b) => ({ __resolveType: b ? "test/yes" : "test/no" })),
      };
      const expected = resolve.evaluateMatcher(rule, {});
      expect(multi({ op: op as "and", matchers: rule.matchers && results })).toBe(expected);
    }
  });
});

describe("environment", () => {
  it("throws, naming the fix: v8 packages read no environment", () => {
    expect(() => environment({ environment: "production" })).toThrow(
      /environment matcher.*Register your own matcher block under "website\/matchers\/environment.ts"/s,
    );
  });
});

describe("the location matcher's country table is v7's", () => {
  it("same entries, same lookups", () => {
    expect({ ...COUNTRY_NAME_TO_CODE }).toEqual(countries.COUNTRY_NAME_TO_CODE);
    for (const name of [
      ...Object.keys(COUNTRY_NAME_TO_CODE),
      ...COUNTRY,
      "BRASIL",
      "japón",
      "zz",
    ]) {
      expect(resolveCountryCode(name)).toBe(countries.resolveCountryCode(name));
    }
  });
});

// ---------------------------------------------------------------------------
// Random: sticky, latest 7.x
// ---------------------------------------------------------------------------

/** A seeded `Math.random`, restarted for each side so both draw the same numbers. */
function seededMath(seed: number) {
  const r = rng(seed);
  return vi.spyOn(Math, "random").mockImplementation(r);
}

describe("random is v7's sticky random (latest 7.x)", () => {
  it(
    "decisions, recorded flags and the Set-Cookie match v7 over 10k seeded page requests",
    FUZZ,
    () => {
      const r = rng(0xab7e57);
      const COHORTS = ["Hero test", "Banner AB", "Ç test"];
      let fresh = 0;
      let kept = 0;
      let cookies = 0;
      for (let i = 0; i < 10_000; i++) {
        const traffic = pick(r, [
          0,
          0.1,
          0.3,
          0.5,
          0.505,
          0.9,
          1,
          1.5,
          -1,
          Number.NaN,
          undefined,
          "0.3",
        ]);
        const blocks: Record<string, unknown> = {};
        for (const name of COHORTS) {
          blocks[name] = {
            __resolveType: "website/matchers/random.ts",
            ...(r() < 0.9 ? { traffic: r() < 0.5 ? traffic : pick(r, [0.2, 0.5, 0.8]) } : {}),
          };
        }
        // The rules one page evaluates, in order: saved blocks by name, or inline.
        const rules = Array.from({ length: 1 + Math.floor(r() * 4) }, () =>
          r() < 0.75
            ? { __resolveType: pick(r, COHORTS) }
            : { __resolveType: "website/matchers/random.ts", ...(r() < 0.8 ? { traffic } : {}) },
        );
        const cookieHeaderValue =
          r() < 0.7 ? `${SEGMENT_COOKIE}=${segmentValue(r)}` : cookieHeader(r);
        const request = new Request("https://example.com/", {
          headers: cookieHeaderValue ? { cookie: cookieHeaderValue } : {},
        });
        const recordFlags = r() < 0.9;
        const seed = Math.floor(r() * 2 ** 31);

        // v7
        savedBlocks = blocks;
        const v7Flags: StoredFlag[] | undefined = recordFlags ? [] : undefined;
        const ctx = v7Ctx(request, { flags: v7Flags });
        const spy = seededMath(seed);
        const expected = rules.map((rule) => resolve.evaluateVariantRule(rule, ctx));
        setCookies.length = 0;
        if (v7Flags) persistFlags(ctx);
        const expectedCookie = setCookies[0] ?? null;
        spy.mockRestore();

        // ours: the saved block's name travels as `cohort`
        const ourFlags: StoredFlag[] | undefined = recordFlags ? [] : undefined;
        const input = recordFlags ? { request, flags: ourFlags } : request;
        seededMath(seed);
        const decisions = rules.map((rule) => {
          const saved = blocks[rule.__resolveType] as { traffic?: number } | undefined;
          const props = saved
            ? { traffic: saved.traffic, cohort: rule.__resolveType }
            : { traffic: (rule as { traffic?: number }).traffic };
          return decideRandom(props, input);
        });
        vi.restoreAllMocks();

        expect([i, decisions.map((d) => d.value)]).toEqual([i, expected]);
        expect([i, ourFlags]).toEqual([i, v7Flags]);
        const ourCookie = decisions.at(-1)!.setCookie;
        expect([i, ourCookie]).toEqual([i, expectedCookie]);
        expect([i, ourFlags ? segmentSetCookie(request, ourFlags) : null]).toEqual([
          i,
          expectedCookie,
        ]);
        for (const d of decisions) d.isFresh ? fresh++ : kept++;
        if (expectedCookie) cookies++;
      }
      // Every path is exercised: fresh draws, kept decisions, cookies set and not.
      expect(fresh).toBeGreaterThan(2_000);
      expect(kept).toBeGreaterThan(2_000);
      expect(cookies).toBeGreaterThan(2_000);
      expect(cookies).toBeLessThan(9_000);
    },
  );

  it("the cohort is the saved block's name: a visitor v7 drew keeps their group", () => {
    savedBlocks = { "Hero test": { __resolveType: "website/matchers/random.ts", traffic: 0.3 } };
    const cookieValue = flags.serializeSegmentCookie([{ name: "Hero test", value: true, pct: 30 }]);
    const request = new Request("https://example.com/", {
      headers: { cookie: `${SEGMENT_COOKIE}=${cookieValue}` },
    });
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(resolve.evaluateVariantRule({ __resolveType: "Hero test" }, v7Ctx(request))).toBe(true);
    expect(random({ traffic: 0.3, cohort: "Hero test" }, request)).toBe(true);
    // Without the name it is another test: the visitor is drawn again.
    expect(random({ traffic: 0.3 }, request)).toBe(false);
    expect(random({ traffic: 0.3, cohort: "Renamed" }, request)).toBe(false);
  });

  it("draws with Math.random() < traffic: a 0 share never matches, a 1 share always does", () => {
    const request = new Request("https://example.com/");
    for (const [draw, traffic] of [
      [0, 0],
      [0.999_999, 1],
      [0.3, 0.3],
      [0.299_999, 0.3],
    ] as const) {
      savedBlocks = {};
      vi.spyOn(Math, "random").mockReturnValue(draw);
      const expected = resolve.evaluateVariantRule(
        { __resolveType: "website/matchers/random.ts", traffic },
        v7Ctx(request),
      );
      expect([draw, traffic, random({ traffic }, request)]).toEqual([draw, traffic, expected]);
    }
  });

  it("a new traffic share draws the visitor again, once", () => {
    const cookieValue = serializeSegmentCookie([{ name: "Hero test", value: true, pct: 30 }]);
    const request = new Request("https://example.com/", {
      headers: { cookie: `${SEGMENT_COOKIE}=${cookieValue}` },
    });
    const flagsOfRequest: StoredFlag[] = [];
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const first = decideRandom(
      { traffic: 0.5, cohort: "Hero test" },
      { request, flags: flagsOfRequest },
    );
    expect(first).toMatchObject({ value: false, isFresh: true });
    expect(first.setCookie).toBe(
      `deco_segment=${serializeSegmentCookie([{ name: "Hero test", value: false, pct: 50 }])}; Max-Age=31536000; Path=/; SameSite=Lax`,
    );
    // The same request asks again: the decision already made is reused.
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(
      decideRandom({ traffic: 0.5, cohort: "Hero test" }, { request, flags: flagsOfRequest }),
    ).toMatchObject({ value: false, isFresh: false });
  });
});

describe("the deco_segment helpers are v7's", () => {
  it(
    "parse, serialize, the cache token and the traffic fingerprint: 20k seeded cases",
    FUZZ,
    () => {
      const r = rng(0xf1a95);
      for (let i = 0; i < 20_000; i++) {
        const list = randomFlags(r);
        expect(serializeSegmentCookie(list)).toBe(flags.serializeSegmentCookie(list));
        expect(segmentCacheToken(list)).toBe(flags.segmentCacheToken(list));
        const raw =
          r() < 0.8 ? flags.serializeSegmentCookie(list) : pick(r, ["", "x", "e30=", "bnVsbA=="]);
        expect(parseSegmentCookie(raw)).toEqual(flags.parseSegmentCookie(raw));
        const traffic = pick(r, [r(), r() * 2 - 0.5, Number.NaN, Infinity, 0.005, 0.995]);
        expect(trafficToPct(traffic)).toBe(flags.trafficToPct(traffic));
      }
      expect(SEGMENT_COOKIE).toBe(flags.SEGMENT_COOKIE);
    },
  );
});
