/**
 * `@decocms/nextjs/config`: `withDeco(nextConfig)` for `next.config`.
 * Plain CommonJS JavaScript, shipped as is, so a CommonJS `next.config.js`
 * can `require()` it; an ESM `next.config.mjs`/`.ts` imports it the same way.
 *
 * It adds two things and nothing about hosting (no rewrites, no image hosts,
 * no CDN rules):
 *
 * 1. `draftHeaders` (default on): v7's two header rules, first, so a draft
 *    is never stored or indexed. A rule's `has` entries are ANDed and the two
 *    signals never meet: a draft link carries the query (the proxy sets the
 *    cookie on that response), every navigation after it the cookie.
 *    On a dynamic App Router response Next sets `Cache-Control` and `Vary`
 *    itself, so only `X-Robots-Tag` is sure to arrive from here; the proxy's
 *    `applyDraft` sets all three on the responses it makes.
 * 2. `studioOrigins` (default on): Studio's origins in `allowedDevOrigins`,
 *    so `next dev` serves Studio's local mode its dev assets.
 *
 * The names repeat the package's (`DRAFT_PARAM`, `DRAFT_COOKIE`,
 * `draftResponseHeaders` in `src/draft.ts`, `STUDIO_ORIGINS` in
 * `src/studio.ts`): a CommonJS file can't load an ES module everywhere
 * `next.config` runs. `config.test.ts` holds them equal.
 */
"use strict";

/** `draftResponseHeaders(pointer)` (`src/draft.ts`), as `next.config` header entries. */
const DRAFT_NO_STORE_HEADERS = [
  { key: "Cache-Control", value: "max-age=0, no-cache, must-revalidate" },
  { key: "Vary", value: "Cookie" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

/** v7's draft rules: the `?__draft=` query, or the `__deco_draft` cookie. */
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

/**
 * `STUDIO_ORIGINS` as `allowedDevOrigins` hosts: `https://*.decocms.com`
 * matches any name under `decocms.com` (`isStudioOrigin`), which Next writes
 * as `**.decocms.com`.
 */
const STUDIO_DEV_ORIGINS = [
  "studio.decocms.com",
  "studio-stg.decocms.com",
  "decocms.com",
  "**.decocms.com",
];

function withDeco(nextConfig = {}, options = {}) {
  const { draftHeaders = true, studioOrigins = true } = options;
  const config = { ...nextConfig };
  if (studioOrigins) {
    config.allowedDevOrigins = [
      ...new Set([...(nextConfig.allowedDevOrigins ?? []), ...STUDIO_DEV_ORIGINS]),
    ];
  }
  if (draftHeaders) {
    const siteHeaders = nextConfig.headers;
    config.headers = async () => [
      // First: a site-wide Cache-Control rule must not win over a draft's.
      ...DECO_DRAFT_HEADERS,
      ...(siteHeaders ? await siteHeaders() : []),
    ];
  }
  return config;
}

module.exports = { withDeco, DECO_DRAFT_HEADERS, STUDIO_DEV_ORIGINS };
