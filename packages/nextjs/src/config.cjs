/**
 * next.config wrapper for Deco sites. CommonJS on purpose: next.config.js
 * is CJS in most sites and this package is "type": "module", so a .js
 * file here would be ESM and unrequireable on Node < 22.
 *
 * Adds:
 * 1. Rewrites for the Studio-protocol URLs Next cannot express as route
 *    segments — `/.decofile` (segments can't start with a dot) and
 *    `/live/_meta` (`_`-prefixed segments are Next "private folders",
 *    silently excluded from routing) — plus `/live/previews/*`, all
 *    funneled to `/deco/*` where a single catch-all route
 *    (`app/deco/[[...deco]]/route.ts` + createDecoRouteHandlers) serves
 *    the whole protocol.
 * 2. transpilePackages for the raw-TS @decocms packages.
 * 3. Response headers that keep a draft-preview render out of every cache.
 */
const DECO_REWRITES = [
  { source: "/.decofile", destination: "/deco/decofile" },
  { source: "/live/_meta", destination: "/deco/meta" },
  { source: "/live/previews/:path*", destination: "/deco/previews/:path*" },
];

const DECO_TRANSPILE = ["@decocms/blocks", "@decocms/blocks-admin", "@decocms/nextjs"];

/**
 * A draft render must never be cached or indexed: with the pointer in a cookie
 * it shares a URL with the published page, so a shared cache keyed on URL alone
 * would serve unpublished content to a real visitor.
 *
 * Two rules, not one: `has` entries within a rule are ANDed, and the two
 * signals never coincide. On ENTRY the pointer is in the query and the cookie
 * has not been set yet (middleware sets it in the response); on every
 * navigation after that it is the cookie and the query is gone.
 *
 * MEASURED LIMIT — do not assume `no-store` is in force. On a *dynamic* App
 * Router response Next reserves `Cache-Control` and `Vary` and overwrites
 * whatever we set, from here AND from middleware: the wire shows
 * `Cache-Control: no-cache, must-revalidate` and
 * `Vary: rsc, next-router-state-tree, …`. Verified that these rules do match
 * (a marker header on the same rules came through on both signals and was
 * correctly absent otherwise) — it is those two header names specifically that
 * Next owns. `X-Robots-Tag` does get through.
 *
 * Why that is still safe: `no-cache` is not "don't cache", it is "never reuse
 * without revalidating with the origin", so a compliant shared cache cannot
 * serve a stored draft to a different visitor — it has to ask us first, and we
 * answer per-request. That also covers the loss of `Vary: Cookie`. The residual
 * risk is a cache that ignores `no-cache`; closing that needs a CDN-level rule,
 * which is a deployment concern rather than something this package can set.
 * `Cache-Control`/`Vary` are kept here so the intent is explicit and so they
 * apply anywhere Next is not overriding them.
 */
const DRAFT_NO_STORE_HEADERS = [
  { key: "Cache-Control", value: "no-store, private" },
  { key: "Vary", value: "Cookie" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const DECO_DRAFT_HEADERS = [
  {
    source: "/:path*",
    has: [{ type: "query", key: "__draft" }],
    headers: DRAFT_NO_STORE_HEADERS,
  },
  {
    source: "/:path*",
    has: [{ type: "cookie", key: "__deco_draft" }],
    headers: DRAFT_NO_STORE_HEADERS,
  },
];

function withDeco(nextConfig = {}) {
  const userRewrites = nextConfig.rewrites;
  const userHeaders = nextConfig.headers;
  return {
    ...nextConfig,
    transpilePackages: [...new Set([...(nextConfig.transpilePackages ?? []), ...DECO_TRANSPILE])],
    async rewrites() {
      const user = typeof userRewrites === "function" ? await userRewrites() : (userRewrites ?? []);
      if (Array.isArray(user)) return [...DECO_REWRITES, ...user];
      return { ...user, beforeFiles: [...DECO_REWRITES, ...(user.beforeFiles ?? [])] };
    },
    async headers() {
      const user = typeof userHeaders === "function" ? await userHeaders() : (userHeaders ?? []);
      // Draft rules first: a site's own catch-all Cache-Control must not win
      // over the one thing standing between a draft and a shared cache.
      return [...DECO_DRAFT_HEADERS, ...user];
    },
  };
}

module.exports = { withDeco, DECO_REWRITES, DECO_DRAFT_HEADERS };
