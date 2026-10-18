/**
 * Built-in matchers matching deco-cx/apps website/matchers/*.
 *
 * These augment the matchers already handled inline in resolve.ts
 * (always, never, device, random, utm) with the additional matchers
 * that deco supported: cookie, cron, date, host, pathname, queryString,
 * location, userAgent, environment, multi, negate.
 *
 * Register these at startup:
 *
 * @example
 * ```ts
 * import { registerBuiltinMatchers } from "@decocms/start/matchers/builtins";
 * registerBuiltinMatchers();
 * ```
 */

import type { MatcherContext } from "../cms/resolve";
import { evaluateMatcher, registerMatcher } from "../cms/resolve";
import { resolveCountryCode } from "./countryNames";

// -------------------------------------------------------------------------
// Cookie matcher
// -------------------------------------------------------------------------

function cookieMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  const name = rule.name as string | undefined;
  const value = rule.value as string | undefined;
  if (!name) return false;

  const cookies = ctx.cookies ?? {};
  const cookieValue = cookies[name];

  if (cookieValue === undefined) return false;
  if (value === undefined) return true;
  return cookieValue === value;
}

// -------------------------------------------------------------------------
// Cron matcher
// -------------------------------------------------------------------------

function cronMatcher(rule: Record<string, unknown>, _ctx: MatcherContext): boolean {
  const start = rule.start as string | undefined;
  const end = rule.end as string | undefined;

  if (!start && !end) return true;

  const now = Date.now();

  if (start) {
    const startTime = new Date(start).getTime();
    if (isNaN(startTime) || now < startTime) return false;
  }

  if (end) {
    const endTime = new Date(end).getTime();
    if (isNaN(endTime) || now > endTime) return false;
  }

  return true;
}

// -------------------------------------------------------------------------
// Date matcher — parity with deco-cx/apps website/matchers/date.ts
//
// Unlike cronMatcher's inclusive [start, end] window (>=, <=), date.ts uses
// strict inequalities: it matches only strictly *between* start and end, so
// a request landing on the exact boundary instant does not match. Invalid
// date strings produce NaN comparisons, which are always false — same
// "reject silently" behavior as the original (no explicit isNaN check
// needed to match upstream semantics).
// -------------------------------------------------------------------------

function dateMatcher(rule: Record<string, unknown>, _ctx: MatcherContext): boolean {
  const start = rule.start as string | undefined;
  const end = rule.end as string | undefined;

  const now = new Date();
  const afterStart = start ? now > new Date(start) : true;
  const beforeEnd = end ? now < new Date(end) : true;

  return afterStart && beforeEnd;
}

// -------------------------------------------------------------------------
// Host matcher
// -------------------------------------------------------------------------

function hostMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  // deco-cx/apps format: `includes` (substring) and/or `match` (regex), both
  // optional and AND'ed, against the request host.
  const includes = rule.includes as string | undefined;
  const match = rule.match as string | undefined;
  if (includes || match) {
    let host = ctx.request?.headers.get("host") ?? ctx.headers?.host ?? "";
    if (!host && ctx.url) {
      try {
        host = new URL(ctx.url).host;
      } catch {
        host = "";
      }
    }
    if (match) {
      if (!isSafePattern(match)) return false;
      try {
        if (!new RegExp(match).test(host)) return false;
      } catch {
        return false;
      }
    }
    return includes ? host.includes(includes) : true;
  }

  const hostToMatch = rule.host as string | undefined;
  if (!hostToMatch) return false;

  const currentUrl = ctx.url;
  if (!currentUrl) return false;

  try {
    const url = new URL(currentUrl);
    return url.hostname === hostToMatch || url.host === hostToMatch;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------
// Pathname matcher
// -------------------------------------------------------------------------

const MAX_PATTERN_LENGTH = 500;
const REDOS_HEURISTIC = /(\+|\*|\{[^}]*,\})\s*(\+|\*|\{[^}]*,\})/;

function isSafePattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  if (REDOS_HEURISTIC.test(pattern)) return false;
  return true;
}

function pathnameMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  const path = ctx.path ?? "";

  // CMS "case" format (deco-cx/apps): { type: "Equals" | "Includes" | "Template", pathname, negate? }
  // plus "Not Includes" / "Starts With". `negate` inverts any of them.
  const caseObj = rule.case as { type?: string; pathname?: string; negate?: boolean } | undefined;
  if (caseObj) {
    if (!caseObj.pathname) return false;
    const result = pathnameCase(caseObj.type, path, caseObj.pathname);
    return caseObj.negate ? !result : result;
  }

  // Standard format: pattern (regex), includes (exact/glob), excludes (exact/glob)
  const pattern = rule.pattern as string | undefined;
  const includes = rule.includes as string[] | undefined;
  const excludes = rule.excludes as string[] | undefined;

  if (pattern) {
    if (!isSafePattern(pattern)) {
      console.warn(
        `[pathnameMatcher] Rejected potentially unsafe pattern: ${pattern.slice(0, 80)}`,
      );
      return false;
    }
    try {
      const regex = new RegExp(pattern);
      if (!regex.test(path)) return false;
    } catch {
      return false;
    }
  }

  if (includes && includes.length > 0) {
    const matches = includes.some((inc) => {
      if (inc.includes("*")) {
        const prefix = inc.replace(/\*+$/, "");
        return path.startsWith(prefix);
      }
      return path === inc;
    });
    if (!matches) return false;
  }

  if (excludes && excludes.length > 0) {
    const excluded = excludes.some((exc) => {
      if (exc.includes("*")) {
        const prefix = exc.replace(/\*+$/, "");
        return path.startsWith(prefix);
      }
      return path === exc;
    });
    if (excluded) return false;
  }

  // No constraints specified — vacuously true
  if (!pattern && !includes?.length && !excludes?.length) return false;

  return true;
}

function pathnameCase(type: string | undefined, path: string, pathname: string): boolean {
  switch (type) {
    case "Equals":
      return path === pathname;
    case "Not Includes":
      return !path.includes(pathname);
    case "Starts With":
      return path.startsWith(pathname);
    case "Template": {
      // "/:slug/p" → each `:segment` matches one path segment, whole path.
      const escaped = pathname
        .split(/(:[^/]+)/)
        .map((part) => (part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("");
      return new RegExp(`^${escaped}$`).test(path);
    }
    default: // "Includes"
      return path.includes(pathname);
  }
}

// -------------------------------------------------------------------------
// Query string matcher
// -------------------------------------------------------------------------

type QueryCase = { type?: string; value?: string };
const QUERY_OPERATIONS: Record<string, (param: string, value: string) => boolean> = {
  Equals: (a, b) => a === b,
  Greater: (a, b) => a > b,
  GreaterOrEquals: (a, b) => a >= b,
  Lesser: (a, b) => a < b,
  LesserOrEquals: (a, b) => a <= b,
  Includes: (a, b) => a.includes(b),
};

/**
 * deco-cx/apps format: every condition must hold. A condition fails when its
 * param is absent; `Exists` holds when it is present; the other operations
 * hold when at least one of the param's values compares true (string compare,
 * as upstream).
 */
function queryStringConditions(
  conditions: Array<{ param?: string; case?: QueryCase }>,
  url: URL,
): boolean {
  return conditions.every((condition) => {
    const values = condition.param ? url.searchParams.getAll(condition.param) : [];
    if (values.length === 0) return false;
    const type = condition.case?.type;
    if (type === "Exists") return true;
    const compare = type ? QUERY_OPERATIONS[type] : undefined;
    const expected = condition.case?.value;
    if (!compare || expected === undefined) return false;
    return values.some((value) => compare(value, expected));
  });
}

function queryStringMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  if (Array.isArray(rule.conditions)) {
    if (!ctx.url) return false;
    try {
      return queryStringConditions(rule.conditions, new URL(ctx.url));
    } catch {
      return false;
    }
  }

  const key = (rule.key ?? rule.param) as string | undefined;
  const value = rule.value as string | undefined;

  if (!key) return false;

  const currentUrl = ctx.url;
  if (!currentUrl) return false;

  try {
    const url = new URL(currentUrl);
    const paramValue = url.searchParams.get(key);

    if (paramValue === null) return false;
    if (value === undefined) return true;
    return paramValue === value;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------
// Location matcher — parity with deco-cx/apps/website/matchers/location.ts
//
// Each entry in includeLocations/excludeLocations is a union of:
//   Location: { city?, regionCode?, country? }
//   Map:      { coordinates?: "lat,lng,radius_in_meters" }
// Fields may coexist on the same entry; the matcher AND's every constraint
// that is populated. An entry with zero constraints returns defaultNotMatched
// (true for includes, false for excludes), matching upstream semantics.
// -------------------------------------------------------------------------

interface LocationOrMap {
  country?: string;
  regionCode?: string;
  city?: string;
  /** "latitude,longitude,radius_in_meters" — e.g. "-23.5505,-46.6333,5000" */
  coordinates?: string;
}

interface GeoSource {
  country: string;
  regionCode: string;
  city: string;
  /** "latitude,longitude" when available */
  coordinates?: string;
}

function decodeCookie(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Extract geo data from the request context.
 *
 * Read order mirrors the original deco-cx/apps matcher (header-first), with
 * additional fallbacks for environments that don't preserve the cf-* request
 * headers (e.g. when TanStack Start re-wraps the request and drops them):
 *   1. cf-* request headers (cf-region-code, cf-ipcity, ...)
 *   2. request.cf (Cloudflare Workers native)
 *   3. __cf_geo_* cookies (injected by createDecoWorkerEntry)
 */
function getGeoData(ctx: MatcherContext): GeoSource {
  const headers = ctx.headers ?? {};
  const reqHeaders = ctx.request?.headers;
  const h = (name: string): string =>
    headers[name] ?? reqHeaders?.get(name) ?? "";

  let regionCode = h("cf-region-code");
  let country = h("cf-ipcountry") || h("x-vercel-ip-country");
  let city = h("cf-ipcity");
  let latitude = h("cf-iplatitude");
  let longitude = h("cf-iplongitude");

  if (!country || !regionCode || !city || !latitude || !longitude) {
    const req = ctx.request;
    const cf = req ? ((req as any).cf as Record<string, unknown> | undefined) : undefined;
    if (cf) {
      country = country || ((cf.country as string) ?? "");
      regionCode = regionCode || ((cf.regionCode as string) ?? "");
      city = city || ((cf.city as string) ?? "");
      latitude = latitude || (cf.latitude != null ? String(cf.latitude) : "");
      longitude = longitude || (cf.longitude != null ? String(cf.longitude) : "");
    }
  }

  if (!country || !regionCode || !city || !latitude || !longitude) {
    const cookies = ctx.cookies ?? {};
    country = country || decodeCookie(cookies.__cf_geo_country);
    regionCode = regionCode || decodeCookie(cookies.__cf_geo_region_code);
    city = city || decodeCookie(cookies.__cf_geo_city);
    latitude = latitude || decodeCookie(cookies.__cf_geo_lat);
    longitude = longitude || decodeCookie(cookies.__cf_geo_lng);
  }

  const coordinates = latitude && longitude ? `${latitude},${longitude}` : undefined;
  return { country, regionCode, city, coordinates };
}

/**
 * Haversine "within radius" check.
 *
 * @param source "latitude,longitude" from the request's geo.
 * @param target "latitude,longitude,radius_in_meters" from the rule entry.
 */
function haversineWithinRadius(source: string, target: string): boolean {
  const [slat, slng] = source.split(",").map(Number);
  const parts = target.split(",").map(Number);
  const [tlat, tlng, radiusMeters] = parts;
  if (
    !Number.isFinite(slat) ||
    !Number.isFinite(slng) ||
    !Number.isFinite(tlat) ||
    !Number.isFinite(tlng) ||
    !Number.isFinite(radiusMeters)
  ) {
    return false;
  }
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(tlat - slat);
  const dLng = toRad(tlng - slng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(slat)) * Math.cos(toRad(tlat)) * Math.sin(dLng / 2) ** 2;
  const distance = 2 * R * Math.asin(Math.sqrt(a));
  return distance <= radiusMeters;
}

function matchLocation(defaultNotMatched: boolean, source: GeoSource) {
  return (target: LocationOrMap): boolean => {
    const hasRegion = !!target.regionCode;
    const hasCity = !!target.city;
    const hasCountry = !!target.country;
    const hasCoords = !!target.coordinates;

    if (!hasRegion && !hasCity && !hasCountry && !hasCoords) {
      return defaultNotMatched;
    }

    let result =
      !hasRegion ||
      (target.regionCode!.toLowerCase() === source.regionCode.toLowerCase());

    // Map-mode entries require the visitor to have coordinates — otherwise
    // we can't tell whether they're inside the target radius, so the
    // conservative default is "no match". This is a deliberate divergence
    // from deco-cx/apps, which let coord-only rules vacuously pass when the
    // visitor had no lat/lng — that behavior matches every visitor without
    // geo data, which is a footgun in production.
    result = result &&
      (!hasCoords ||
        (!!source.coordinates &&
          haversineWithinRadius(source.coordinates, target.coordinates!)));

    result = result &&
      (!hasCity || target.city!.toLowerCase() === source.city.toLowerCase());

    result = result &&
      (!hasCountry ||
        resolveCountryCode(target.country!).toUpperCase() ===
          source.country.toUpperCase());

    return result;
  };
}

function locationMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  const source = getGeoData(ctx);
  const includeLocations = rule.includeLocations as LocationOrMap[] | undefined;
  const excludeLocations = rule.excludeLocations as LocationOrMap[] | undefined;

  if (excludeLocations?.some(matchLocation(false, source))) {
    return false;
  }
  if (!includeLocations || includeLocations.length === 0) {
    return true;
  }
  return includeLocations.some(matchLocation(true, source));
}

// -------------------------------------------------------------------------
// User Agent matcher
// -------------------------------------------------------------------------

function userAgentMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  const ua = ctx.userAgent ?? "";
  const includes = rule.includes as string | undefined;
  const match = rule.match as string | undefined;

  if (includes && !ua.includes(includes)) return false;
  if (match) {
    if (!isSafePattern(match)) return false;
    try {
      if (!new RegExp(match, "i").test(ua)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// -------------------------------------------------------------------------
// Environment matcher
// -------------------------------------------------------------------------

function environmentMatcher(rule: Record<string, unknown>, _ctx: MatcherContext): boolean {
  const environment = rule.environment as string | undefined;
  if (!environment) return true;

  const isProd =
    typeof process !== "undefined" && process.env?.NODE_ENV === "production";

  if (environment === "production") return isProd;
  if (environment === "development") return !isProd;
  return false;
}

// -------------------------------------------------------------------------
// Multi matcher (AND/OR combinator)
// -------------------------------------------------------------------------

function multiMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  const op = (rule.op as string) ?? "and";
  const matchers = rule.matchers as Array<Record<string, unknown>> | undefined;

  if (!matchers?.length) return true;

  const results = matchers.map((m) => evaluateMatcher(m, ctx));
  return op === "or" ? results.some(Boolean) : results.every(Boolean);
}

// -------------------------------------------------------------------------
// Negate matcher
// -------------------------------------------------------------------------

function negateMatcher(rule: Record<string, unknown>, ctx: MatcherContext): boolean {
  const matcher = rule.matcher as Record<string, unknown> | undefined;
  if (!matcher) return false;
  return !evaluateMatcher(matcher, ctx);
}

// -------------------------------------------------------------------------
// Registration
// -------------------------------------------------------------------------

/**
 * Register all built-in matchers with the CMS resolver.
 *
 * Call once during app setup (in setup.ts or similar).
 * These cover the matchers from deco-cx/apps that weren't
 * handled inline in resolve.ts.
 */
export function registerBuiltinMatchers(): void {
  registerMatcher("website/matchers/cookie.ts", cookieMatcher);
  registerMatcher("website/matchers/cron.ts", cronMatcher);
  registerMatcher("website/matchers/date.ts", dateMatcher);
  registerMatcher("website/matchers/host.ts", hostMatcher);
  registerMatcher("website/matchers/pathname.ts", pathnameMatcher);
  registerMatcher("website/matchers/queryString.ts", queryStringMatcher);
  registerMatcher("website/matchers/location.ts", locationMatcher);
  registerMatcher("website/matchers/userAgent.ts", userAgentMatcher);
  registerMatcher("website/matchers/environment.ts", environmentMatcher);
  registerMatcher("website/matchers/multi.ts", multiMatcher);
  registerMatcher("website/matchers/negate.ts", negateMatcher);
}
