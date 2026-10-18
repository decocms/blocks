/**
 * Names the worker, the router and the browser code share. No imports, no
 * state: safe in every bundle.
 */

/**
 * The query parameter `decoServerFnFetch` adds to a server-function URL: the
 * page's CDN segment token, which the worker checks before it lets the CDN
 * cache the response. `__d` is avoided: v7 used it as a debug flag.
 */
export const CSEG_PARAM = "__cseg";

/** The `window` property the page publishes the token on. */
export const CSEG_GLOBAL = "__DECO_CSEG";

/**
 * The response header a route sets to give the document another status (a CMS
 * page that renders the site's 404 page): the worker turns it into the
 * response's status and removes it. A route's `headers` reach the document
 * response, a status set while rendering does not.
 */
export const PAGE_STATUS_HEADER = "x-page-status";

/**
 * The response header a page sets when a loader it depends on failed: the
 * worker never stores that response, and serves a stale copy instead when it
 * has one.
 */
export const DEGRADED_HEADER = "x-deco-degraded";
