/**
 * v7's website matchers with v7's results, taking the request explicitly:
 * `device` from `@decocms/blocks@7` cms/resolve.ts, the others from its
 * matchers/builtins.ts. Each is `(props, request)`: in the block map,
 * `"website/matchers/device.ts": (props: DeviceProps) => device(props, request)`.
 * Like v7's resolver, a matcher that throws counts as not matched.
 *
 * `always`, `never` and `date` are v8 built-ins (v7's names for the first two
 * are aliases), so they are not here.
 */

import { type MatcherInput, type V7MatcherContext, v7Context } from "./context.ts";
import { resolveCountryCode } from "./countryNames.ts";

/** v7's resolver: a matcher that throws doesn't match. */
function guarded<P>(
  fn: (props: P, ctx: V7MatcherContext) => boolean,
): (props: P, input: MatcherInput) => boolean {
  return (props, input) => {
    const ctx = v7Context(input);
    try {
      return fn((props ?? {}) as P, ctx);
    } catch {
      return false;
    }
  };
}

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

export interface DeviceProps {
  /** @title Mobile */
  mobile?: boolean;
  /** @title Tablet */
  tablet?: boolean;
  /** @title Desktop */
  desktop?: boolean;
}

/**
 * @title Device
 * @description Matches the visitor's device. With no device ticked it matches every visitor.
 */
export const device: (props: DeviceProps, request: MatcherInput) => boolean = guarded(
  (rule, ctx) => {
    const ua = (ctx.userAgent || "").toLowerCase();
    const isTablet = /ipad|android(?!.*mobile)|tablet/i.test(ua);
    const isMobile =
      !isTablet && /mobile|android|iphone|ipod|webos|blackberry|opera mini|iemobile/i.test(ua);
    const isDesktop = !isMobile && !isTablet;
    if (!rule.mobile && !rule.tablet && !rule.desktop) return true;
    return (
      !!(rule.mobile && isMobile) || !!(rule.tablet && isTablet) || !!(rule.desktop && isDesktop)
    );
  },
);

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

export interface CookieProps {
  /** @title Cookie name */
  name?: string;
  /**
   * @title Value
   * @description Leave empty to match any value.
   */
  value?: string;
}

/**
 * @title Cookie
 * @description Matches visitors who have a cookie, or a cookie with a given value.
 */
export const cookie: (props: CookieProps, request: MatcherInput) => boolean = guarded(
  (rule, ctx) => {
    const name = rule.name as string | undefined;
    const value = rule.value as string | undefined;
    if (!name) return false;
    const cookieValue = ctx.cookies[name];
    if (cookieValue === undefined) return false;
    if (value === undefined) return true;
    return cookieValue === value;
  },
);

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export interface HostProps {
  /**
   * @title Contains
   * @description Part of the host name.
   */
  includes?: string;
  /**
   * @title Pattern
   * @description A regular expression the host must match.
   */
  match?: string;
  /**
   * @title Host
   * @description The exact host (older form, used when neither of the above is set).
   */
  host?: string;
}

const MAX_PATTERN_LENGTH = 500;
const REDOS_HEURISTIC = /(\+|\*|\{[^}]*,\})\s*(\+|\*|\{[^}]*,\})/;

function isSafePattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  if (REDOS_HEURISTIC.test(pattern)) return false;
  return true;
}

/**
 * @title Host
 * @description Matches the host the page is served on.
 */
export const host: (props: HostProps, request: MatcherInput) => boolean = guarded((rule, ctx) => {
  const includes = rule.includes as string | undefined;
  const match = rule.match as string | undefined;
  if (includes || match) {
    let current = ctx.request?.headers.get("host") ?? "";
    if (!current && ctx.url) {
      try {
        current = new URL(ctx.url).host;
      } catch {
        current = "";
      }
    }
    if (match) {
      if (!isSafePattern(match)) return false;
      try {
        if (!new RegExp(match).test(current)) return false;
      } catch {
        return false;
      }
    }
    return includes ? current.includes(includes) : true;
  }

  const hostToMatch = rule.host as string | undefined;
  if (!hostToMatch) return false;
  if (!ctx.url) return false;
  try {
    const url = new URL(ctx.url);
    return url.hostname === hostToMatch || url.host === hostToMatch;
  } catch {
    return false;
  }
});

// ---------------------------------------------------------------------------
// Pathname
// ---------------------------------------------------------------------------

export interface PathnameProps {
  /** @title Rule */
  case?: {
    type?: "Equals" | "Includes" | "Not Includes" | "Starts With" | "Template";
    pathname?: string;
    negate?: boolean;
  };
  /**
   * @title Pattern
   * @description A regular expression the path must match.
   */
  pattern?: string;
  /**
   * @title Paths
   * @description Exact paths; a trailing `*` matches a prefix.
   */
  includes?: string[];
  /**
   * @title Excluded paths
   * @description Exact paths; a trailing `*` matches a prefix.
   */
  excludes?: string[];
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
      const escaped = pathname
        .split(/(:[^/]+)/)
        .map((part) =>
          part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
      return new RegExp(`^${escaped}$`).test(path);
    }
    default:
      return path.includes(pathname);
  }
}

/**
 * @title Pathname
 * @description Matches the page's path.
 */
export const pathname: (props: PathnameProps, request: MatcherInput) => boolean = guarded(
  (rule, ctx) => {
    const path = ctx.path ?? "";
    const caseObj = rule.case as PathnameProps["case"];
    if (caseObj) {
      if (!caseObj.pathname) return false;
      const result = pathnameCase(caseObj.type, path, caseObj.pathname);
      return caseObj.negate ? !result : result;
    }

    const pattern = rule.pattern as string | undefined;
    const includes = rule.includes as string[] | undefined;
    const excludes = rule.excludes as string[] | undefined;

    if (pattern) {
      // v7 warned here; a rejected pattern still just doesn't match.
      if (!isSafePattern(pattern)) return false;
      try {
        if (!new RegExp(pattern).test(path)) return false;
      } catch {
        return false;
      }
    }

    const matchesEntry = (entry: string) =>
      entry.includes("*") ? path.startsWith(entry.replace(/\*+$/, "")) : path === entry;
    if (includes && includes.length > 0 && !includes.some(matchesEntry)) return false;
    if (excludes && excludes.length > 0 && excludes.some(matchesEntry)) return false;

    if (!pattern && !includes?.length && !excludes?.length) return false;
    return true;
  },
);

// ---------------------------------------------------------------------------
// Query string
// ---------------------------------------------------------------------------

export interface QueryStringProps {
  /**
   * @title Conditions
   * @description Every one must hold.
   */
  conditions?: Array<{
    /** @title Parameter */
    param?: string;
    case?: {
      type?:
        | "Exists"
        | "Equals"
        | "Greater"
        | "GreaterOrEquals"
        | "Lesser"
        | "LesserOrEquals"
        | "Includes";
      value?: string;
    };
  }>;
  /** @title Parameter (older form) */
  key?: string;
  /** @title Parameter (older form) */
  param?: string;
  /**
   * @title Value (older form)
   * @description Leave empty to match any value.
   */
  value?: string;
}

const QUERY_OPERATIONS: Record<string, (param: string, value: string) => boolean> = {
  Equals: (a, b) => a === b,
  Greater: (a, b) => a > b,
  GreaterOrEquals: (a, b) => a >= b,
  Lesser: (a, b) => a < b,
  LesserOrEquals: (a, b) => a <= b,
  Includes: (a, b) => a.includes(b),
};

function queryStringConditions(
  conditions: NonNullable<QueryStringProps["conditions"]>,
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

/**
 * @title Query string
 * @description Matches the page's query parameters.
 */
export const queryString: (props: QueryStringProps, request: MatcherInput) => boolean = guarded(
  (rule, ctx) => {
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
    if (!ctx.url) return false;
    try {
      const paramValue = new URL(ctx.url).searchParams.get(key);
      if (paramValue === null) return false;
      if (value === undefined) return true;
      return paramValue === value;
    } catch {
      return false;
    }
  },
);

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

export interface LocationOrMap {
  /**
   * @title Country
   * @description A name ("Brasil") or an ISO code ("BR").
   */
  country?: string;
  /** @title Region code */
  regionCode?: string;
  /** @title City */
  city?: string;
  /**
   * @title Area
   * @description "latitude,longitude,radius_in_meters", e.g. "-23.5505,-46.6333,5000".
   */
  coordinates?: string;
}

export interface LocationProps {
  /**
   * @title Locations
   * @description Matches visitors in any of these; empty matches everyone not excluded.
   */
  includeLocations?: LocationOrMap[];
  /** @title Excluded locations */
  excludeLocations?: LocationOrMap[];
}

interface GeoSource {
  country: string;
  regionCode: string;
  city: string;
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
 * The visitor's location as v7 read it: the `cf-*` request headers, then the
 * Workers `request.cf` object, then the `__cf_geo_*` cookies.
 */
function getGeoData(ctx: V7MatcherContext): GeoSource {
  const reqHeaders = ctx.request?.headers;
  const h = (name: string): string => reqHeaders?.get(name) ?? "";

  let regionCode = h("cf-region-code");
  let country = h("cf-ipcountry") || h("x-vercel-ip-country");
  let city = h("cf-ipcity");
  let latitude = h("cf-iplatitude");
  let longitude = h("cf-iplongitude");

  if (!country || !regionCode || !city || !latitude || !longitude) {
    const cf = (ctx.request as { cf?: Record<string, unknown> } | undefined)?.cf;
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

function haversineWithinRadius(source: string, target: string): boolean {
  const [slat, slng] = source.split(",").map(Number) as [number, number];
  const [tlat, tlng, radiusMeters] = target.split(",").map(Number) as [number, number, number];
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

    if (!hasRegion && !hasCity && !hasCountry && !hasCoords) return defaultNotMatched;

    let result = !hasRegion || target.regionCode!.toLowerCase() === source.regionCode.toLowerCase();
    // A map entry needs the visitor's coordinates; without them it doesn't match (as in v7).
    result =
      result &&
      (!hasCoords ||
        (!!source.coordinates && haversineWithinRadius(source.coordinates, target.coordinates!)));
    result = result && (!hasCity || target.city!.toLowerCase() === source.city.toLowerCase());
    result =
      result &&
      (!hasCountry ||
        resolveCountryCode(target.country!).toUpperCase() === source.country.toUpperCase());
    return result;
  };
}

/**
 * @title Location
 * @description Matches where the visitor is (country, region, city or an area on the map).
 */
export const location: (props: LocationProps, request: MatcherInput) => boolean = guarded(
  (rule, ctx) => {
    const source = getGeoData(ctx);
    const includeLocations = rule.includeLocations;
    const excludeLocations = rule.excludeLocations;
    if (excludeLocations?.some(matchLocation(false, source))) return false;
    if (!includeLocations || includeLocations.length === 0) return true;
    return includeLocations.some(matchLocation(true, source));
  },
);

// ---------------------------------------------------------------------------
// Multi
// ---------------------------------------------------------------------------

export interface MultiProps {
  /**
   * @title Combine with
   * @description "and": all must match; "or": any one.
   */
  op?: "and" | "or";
  /** @title Rules */
  matchers?: boolean[];
}

/**
 * @title Multi
 * @description Combines rules: all of them ("and") or any of them ("or"). No rules matches everyone.
 *
 * In v8 the inner rules are resolved before this runs, so it gets their
 * results; v7 ran them itself, with the same and/or. One difference: an inner
 * `random` here is sticky like any other, where v7 re-drew it on every request.
 */
export function multi(props: MultiProps): boolean {
  const op = props?.op ?? "and";
  const matchers = props?.matchers;
  if (!matchers?.length) return true;
  return op === "or" ? matchers.some(Boolean) : matchers.every(Boolean);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * v7's `website/matchers/environment.ts` read the process environment, which
 * no v8 package does. It always throws, naming the fix: a matcher in the site
 * that compares `environment` with how the site knows it's in production.
 */
export function environment(_props?: { environment?: string }): never {
  throw new Error(
    "@decocms/compat-v7/matchers: the environment matcher read the process environment, " +
      "which v8 packages never do. Register your own matcher block under " +
      '"website/matchers/environment.ts" that compares props.environment ("production" or ' +
      '"development") with how your site knows it runs in production (for example a value ' +
      "your build sets).",
  );
}
