/**
 * Page cache profiles: how long a response may be served from the edge cache
 * and from the browser, picked per URL. The values and URL rules are v7's
 * (`@decocms/blocks/sdk/cacheHeaders`), which the TanStack storefronts copied
 * unchanged; a site that needs other values passes `cacheProfiles` to
 * `createDecoWorker`.
 */

export type CacheProfileName =
  | "static"
  | "product"
  | "listing"
  | "search"
  | "cart"
  | "private"
  | "none";

/** Seconds: `fresh` = served as is; `swr` = served stale while revalidating; `sie` = served stale when the origin fails. */
export interface CacheWindow {
  fresh: number;
  swr: number;
  sie: number;
}

export interface CacheProfile {
  edge: CacheWindow;
  browser: CacheWindow;
  isPublic: boolean;
}

/** A site's changes to the default profiles: only the values that differ. */
export type CacheProfileOverrides = Partial<
  Record<CacheProfileName, { edge?: Partial<CacheWindow>; browser?: Partial<CacheWindow> }>
>;

const NEVER: CacheWindow = { fresh: 0, swr: 0, sie: 0 };
const NO_CACHE: CacheProfile = { edge: NEVER, browser: NEVER, isPublic: false };

export const DEFAULT_CACHE_PROFILES: Readonly<Record<CacheProfileName, CacheProfile>> = {
  static: {
    edge: { fresh: 900, swr: 7200, sie: 21600 },
    browser: { fresh: 120, swr: 1800, sie: 7200 },
    isPublic: true,
  },
  product: {
    edge: { fresh: 300, swr: 1800, sie: 7200 },
    browser: { fresh: 60, swr: 600, sie: 3600 },
    isPublic: true,
  },
  listing: {
    edge: { fresh: 120, swr: 900, sie: 3600 },
    browser: { fresh: 30, swr: 300, sie: 1800 },
    isPublic: true,
  },
  search: {
    edge: { fresh: 60, swr: 300, sie: 1800 },
    browser: { fresh: 0, swr: 120, sie: 600 },
    isPublic: true,
  },
  cart: NO_CACHE,
  private: NO_CACHE,
  none: NO_CACHE,
};

/** The defaults with a site's overrides applied. The private profiles stay private. */
export function resolveProfiles(
  overrides: CacheProfileOverrides | undefined,
): Record<CacheProfileName, CacheProfile> {
  const out = { ...DEFAULT_CACHE_PROFILES };
  for (const [name, change] of Object.entries(overrides ?? {}) as [
    CacheProfileName,
    CacheProfileOverrides[CacheProfileName],
  ][]) {
    const base = DEFAULT_CACHE_PROFILES[name];
    if (!base || !change || !base.isPublic) continue;
    out[name] = {
      isPublic: true,
      edge: { ...base.edge, ...change.edge },
      browser: { ...base.browser, ...change.browser },
    };
  }
  return out;
}

export const PRIVATE_NO_CACHE = "private, no-cache, no-store, must-revalidate";

/** The browser's `Cache-Control` for a profile. */
export function cacheControl(profile: CacheProfile): string {
  if (!profile.isPublic || (profile.edge.fresh === 0 && profile.browser.fresh === 0)) {
    return PRIVATE_NO_CACHE;
  }
  const { browser, edge } = profile;
  const parts = ["public", browser.fresh > 0 ? `max-age=${browser.fresh}` : "max-age=0"];
  if (edge.fresh > 0) parts.push(`s-maxage=${edge.fresh}`);
  if (browser.swr > 0) parts.push(`stale-while-revalidate=${browser.swr}`);
  if (browser.sie > 0) parts.push(`stale-if-error=${browser.sie}`);
  return parts.join(", ");
}

const PRIVATE_PREFIX_RE = /^\/(cart|checkout|account|login|my-account)(\/|$)/;

/** The profile of a page URL. The first rule that matches wins. */
export function detectCacheProfile(url: URL): CacheProfileName {
  const p = url.pathname;
  if (PRIVATE_PREFIX_RE.test(p)) return "private";
  if (p.startsWith("/api/") || p.startsWith("/deco/") || p.startsWith("/_build")) return "none";
  if (p === "/sitemap.xml") return "static";
  if (p === "/s" || p.startsWith("/s/") || url.searchParams.has("q")) return "search";
  if (p.endsWith("/p")) return "product";
  if (p === "/" || p === "") return "static";
  return "listing";
}

export function isServerFnPath(pathname: string): boolean {
  return pathname.startsWith("/_serverFn/") || pathname.startsWith("/_server/");
}

/**
 * The page a GET server-function request loads, from its `payload`: the first
 * string in it that is a local path. `null` for any other server function.
 */
export function serverFnPagePath(url: URL): string | null {
  if (!isServerFnPath(url.pathname)) return null;
  const payload = url.searchParams.get("payload");
  if (!payload) return null;
  let found: string | null = null;
  const visit = (v: unknown): void => {
    if (found !== null) return;
    if (typeof v === "string") {
      if (v.startsWith("/") && !v.startsWith("//")) found = v;
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) visit(x);
    }
  };
  try {
    visit(JSON.parse(payload));
  } catch {
    return null;
  }
  return found;
}

/** Variant params a page loader ignores, left out of a server function's cache key. */
const SERVER_FN_IGNORED_PARAMS = ["skuId", "idsku"];

/** A server function's payload for its cache key: page paths without the variant params. */
export function canonicalizeServerFnPayload(payload: string): string {
  const stripQuery = (s: string): string => {
    if (!s.startsWith("/") || s.startsWith("//")) return s;
    const q = s.indexOf("?");
    if (q < 0) return s;
    const sp = new URLSearchParams(s.slice(q + 1));
    for (const p of SERVER_FN_IGNORED_PARAMS) sp.delete(p);
    const rest = sp.toString();
    return rest ? `${s.slice(0, q)}?${rest}` : s.slice(0, q);
  };
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") return stripQuery(v);
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
    return v;
  };
  try {
    return JSON.stringify(visit(JSON.parse(payload)));
  } catch {
    return payload;
  }
}

/** The profile of a request: a GET server function takes its page's, any other one is private. */
export function profileOf(url: URL): CacheProfileName {
  if (isServerFnPath(url.pathname)) {
    const page = serverFnPagePath(url);
    return page ? detectCacheProfile(new URL(page, url.origin)) : "private";
  }
  return detectCacheProfile(url);
}
