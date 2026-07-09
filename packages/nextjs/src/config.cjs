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
 */
const DECO_REWRITES = [
  { source: "/.decofile", destination: "/deco/decofile" },
  { source: "/live/_meta", destination: "/deco/meta" },
  { source: "/live/previews/:path*", destination: "/deco/previews/:path*" },
];

const DECO_TRANSPILE = ["@decocms/blocks", "@decocms/blocks-admin", "@decocms/nextjs"];

function withDeco(nextConfig = {}) {
  const userRewrites = nextConfig.rewrites;
  return {
    ...nextConfig,
    transpilePackages: [...new Set([...(nextConfig.transpilePackages ?? []), ...DECO_TRANSPILE])],
    async rewrites() {
      const user = typeof userRewrites === "function" ? await userRewrites() : (userRewrites ?? []);
      if (Array.isArray(user)) return [...DECO_REWRITES, ...user];
      return { ...user, beforeFiles: [...DECO_REWRITES, ...(user.beforeFiles ?? [])] };
    },
  };
}

module.exports = { withDeco, DECO_REWRITES };
