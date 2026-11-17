/**
 * Edge cache telemetry — what `createDecoWorkerEntry` records about every
 * cacheable document / server-function request, so a low HIT rate can be
 * explained from traces instead of guessed at (decocms/blocks#824).
 *
 * Everything here is OBSERVATION ONLY: these helpers read the key, the segment
 * and the origin response the worker already computed. They never feed back
 * into the cache key, the TTLs or the store decision.
 *
 * The attributes are stamped on the active span — the `deco.http.request` root
 * span — so they ride the existing OTLP trace export at the existing head
 * sampling rate (`DECO_OTEL_TRACES_SAMPLING_RATE`, or `?__d=` for one request).
 * No new span, metric point or log line is produced per request.
 *
 * Privacy: no attribute carries a value a visitor brings. The segment travels
 * as a hash plus its "shape" (field names; device, login and sales channel are
 * kept because they are a handful of values and what the key is for); cookies
 * travel as names only.
 */

/** Span attribute keys. `deco.cache.status` / `deco.cache.profile` are shared with `recordCacheMetric`. */
export const EdgeCacheAttr = {
  /** `HIT` | `STALE-HIT` | `STALE-ERROR` | `MISS` (set by `recordCacheMetric`) or `BYPASS` (set here). */
  STATUS: "deco.cache.status",
  /** Why the lookup was skipped. Only on `BYPASS`. */
  BYPASS_REASON: "deco.cache.bypass_reason",
  /** `html` (document or GET server fn keyed as a page) | `serverFn` (POST server fn, body-hash key). */
  KIND: "deco.cache.kind",
  PROFILE: "deco.cache.profile",
  /** First 8 chars of the cache-key version (`__v`, the build hash). */
  VERSION: "deco.cache.version",
  /** Cloudflare data center (`request.cf.colo`) — the Cache API is per colo. Same key as the request metric label. */
  COLO: "deco.http.region",
  /** fnv1a of the serialized segment (the `X-Cache-Segment` value), hex. */
  SEGMENT_HASH: "deco.cache.segment.hash",
  /** The serialized segment with values reduced to field names, e.g. `mobile|sc=1|r|gps`. */
  SEGMENT_SHAPE: "deco.cache.segment.shape",
  /** fnv1a of the full synthetic cache-key URL, hex: distinct keys per page. */
  KEY_HASH: "deco.cache.key.hash",
  /** Extra key dimensions present, comma-separated (`abf,bot,fetch,cf_geo,cf_device`); `""` for none. */
  KEY_PARTS: "deco.cache.key.parts",
  /** What happened to the origin response after a lookup that did not serve from cache. */
  STORE: "deco.cache.store",
  /** Names of the `Set-Cookie`s that kept a response out of the cache. */
  STORE_UNSAFE_COOKIES: "deco.cache.store.unsafe_cookies",
  /**
   * On the `deco.cache.store` span, once `cache.put` settles: `stored` |
   * `skipped:uncacheable` | `skipped:too-large` | `error` (`ResponseCachePutResult`).
   */
  STORE_OUTCOME: "deco.cache.store.outcome",
} as const;

export type EdgeCacheKind = "html" | "serverFn";

/**
 * Why a request never looked the cache up. `method:<VERB>` covers everything
 * that is not a GET (POST server functions have their own key and do look up).
 */
export type EdgeCacheBypassReason =
  | "logged-in"
  | "draft-preview"
  | "preview"
  | "path-template"
  | "matchers-override"
  | "bypass-path"
  | `method:${string}`;

/**
 * Outcome of a lookup that did not serve from cache.
 *
 * - `put` — `cache.put` was issued (in `waitUntil`); whether it landed is on the
 *   child `deco.cache.store` span as `deco.cache.store.outcome`.
 * - `skipped:*` — not stored, and why. `unsafe-cookie` (HTML) means a
 *   `Set-Cookie` outside `safeCookies`; `set-cookie` (POST server fn) means any
 *   `Set-Cookie`, which that path refuses outright.
 */
export type EdgeCacheStoreDecision =
  | "put"
  | "skipped:unsafe-cookie"
  | "skipped:set-cookie"
  | "skipped:non-200"
  | "skipped:degraded"
  | "skipped:tracking"
  | "skipped:profile"
  | "skipped:not-cacheable"
  | "skipped:no-cache";

/**
 * 32-bit FNV-1a, hex. Same function (including the `Math.abs`) sites already
 * use to hash `X-Cache-Segment` in their own analytics rows, so a trace and a
 * site-side row of the same request carry the same segment hash.
 */
export function fnv1aHex(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash).toString(16);
}

const KEPT_SEGMENT_PART = /^(auth|sc=[^|]{0,16})$/;
const MAX_SHAPE_LENGTH = 128;

/**
 * The serialized segment (`hashSegment` output: `device|auth|sc=1|r=…|k=v…`)
 * with every value a visitor brings dropped: the device (first part), `auth`
 * and `sc=<channel>` stay; any other part keeps only its name.
 *
 * `mobile|sc=1|r=v2.ABC|gps=-23.5,-46.6` → `mobile|sc=1|r|gps`.
 */
export function segmentShape(serialized: string): string {
  if (!serialized) return "";
  const parts = serialized.split("|");
  const shaped = parts.map((part, i) => {
    if (i === 0) return part.slice(0, 16);
    if (KEPT_SEGMENT_PART.test(part)) return part;
    return part.split("=")[0];
  });
  return shaped.join("|").slice(0, MAX_SHAPE_LENGTH);
}

const KEY_PART_PARAMS: ReadonlyArray<readonly [string, string]> = [
  ["__abf", "abf"],
  ["__bot", "bot"],
  ["__fetch", "fetch"],
  ["__cf_geo", "cf_geo"],
  ["__cf_device", "cf_device"],
];

/** Which optional dimensions the synthetic cache key carries — names only, never values. */
export function cacheKeyParts(keyUrl: string): string {
  const params = new URL(keyUrl).searchParams;
  return KEY_PART_PARAMS.filter(([param]) => params.has(param))
    .map(([, name]) => name)
    .join(",");
}

/**
 * Names of the cookies a response sets that are not in `safe`, deduplicated,
 * in order. Names only — the values are per-visitor tokens.
 */
export function unsafeCookieNames(response: Response, safe: ReadonlySet<string>): string {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const names: string[] = [];
  for (const sc of setCookies) {
    const eq = sc.indexOf("=");
    const name = eq > 0 ? sc.slice(0, eq).trim() : "";
    if (!name || safe.has(name) || names.includes(name)) continue;
    names.push(name);
  }
  // A Set-Cookie the parser could not split is what made the response unsafe.
  if (names.length === 0 && response.headers.has("set-cookie")) return "(unparsed)";
  return names.join(",").slice(0, 256);
}
