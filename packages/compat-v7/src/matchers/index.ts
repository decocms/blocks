/**
 * @decocms/compat-v7/matchers: v7's website matchers with v7's results.
 * Each takes the request as its second argument, since a v8 block function
 * gets only its inputs; register them in the site's block map under v7's
 * names:
 *
 * ```ts
 * "website/matchers/device.ts": (props: DeviceProps) => device(props, matcherContext()),
 * ```
 *
 * where `matcherContext()` is the site's way to reach the request being
 * served, with one `flags` array per request (the framework subpaths provide
 * it). `random` is sticky (latest 7.x): see `./random.ts` for the cohort
 * contract and the cookie.
 */
export {
  type CookieProps,
  cookie,
  type DeviceProps,
  device,
  environment,
  type HostProps,
  host,
  type LocationOrMap,
  type LocationProps,
  location,
  type MultiProps,
  multi,
  type PathnameProps,
  pathname,
  type QueryStringProps,
  queryString,
} from "./builtins.ts";
export { type MatcherContext, type MatcherInput, parseCookies } from "./context.ts";
export { COUNTRY_NAME_TO_CODE, resolveCountryCode } from "./countryNames.ts";
export {
  decideRandom,
  INLINE_COHORT,
  type RandomDecision,
  type RandomProps,
  random,
} from "./random.ts";
export {
  parseSegmentCookie,
  SEGMENT_COOKIE,
  SEGMENT_COOKIE_MAX_AGE,
  type StoredFlag,
  segmentCacheToken,
  segmentSetCookie,
  serializeSegmentCookie,
  trafficToPct,
} from "./segment.ts";
