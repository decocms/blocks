/**
 * The draft names and headers of a Deco TanStack site: the `?__draft=` link,
 * the cookie that keeps a preview going, the request header the worker hands
 * the app the version on, and the response headers of a page rendered from a draft. The
 * worker reads and writes them (`./worker/drafts.ts`); the app reads the
 * header (`@decocms/tanstack/server`). No imports, no state: safe in every
 * bundle.
 */

/**
 * The query parameter a draft link carries (`?__draft=<pointer>`, or `off` to
 * end a preview). The worker reads it after its host check; reading it
 * directly would skip that check.
 */
export const DRAFT_PARAM = "__draft";

/**
 * The cookie that keeps a preview going after the first draft link. Like
 * {@link DRAFT_PARAM}, the worker reads it after its host check.
 */
export const DRAFT_COOKIE = "__deco_draft";

/**
 * The request header the worker sets on the request it hands the app once it
 * accepted a Studio link: the version (a draft pointer or a release's commit
 * SHA), already checked, without the preview's moment and switched tests
 * (those are decided in the worker: `ASSIGNMENTS_HEADER`). The worker
 * removes any copy that arrives from outside, so a client can't send one
 * itself.
 */
export const VERSION_HEADER = "x-deco-version";

/**
 * The request header the worker sets on a draft request: the id of the
 * release check it made for it (`cms.checkRelease()`), so the page's draft
 * reads wait for that check instead of making their own (one `latest.json`
 * read per preview request). The worker removes any copy that arrives from
 * outside; an id the CMS didn't make is a check of its own anyway.
 */
export const RELEASE_CHECK_HEADER = "x-deco-release-check";

/**
 * The `Cache-Control` of every response to a preview request (a request with
 * `?__draft=`, whatever its value, or the draft cookie): always revalidated,
 * never answered from a cache (PO 2026-10-23).
 */
export const DRAFT_CACHE_CONTROL = "max-age=0, no-cache, must-revalidate";

/**
 * The response headers of a preview: never answered from a browser's or a
 * CDN's cache (`Cache-Control: max-age=0, no-cache, must-revalidate`, `Vary:
 * Cookie`) and never indexed (`X-Robots-Tag: noindex, nofollow`). `{}` when
 * `preview` is `null`, `false` or empty, so the result of the draft decision
 * applies as is: pass the version, or whether the request carries a draft
 * signal at all (`?__draft=off` and a refused or unavailable draft too).
 */
export function draftResponseHeaders(
  preview: string | boolean | null | undefined,
): Record<string, string> {
  if (!preview) return {};
  return {
    "Cache-Control": DRAFT_CACHE_CONTROL,
    Vary: "Cookie",
    "X-Robots-Tag": "noindex, nofollow",
  };
}
