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
 * The response headers of a page rendered from a draft: never stored by a
 * browser or a CDN (`Cache-Control: no-store, private`, `Vary: Cookie`) and
 * never indexed (`X-Robots-Tag: noindex, nofollow`). `{}` when `version` is
 * `null`, so the result of the draft decision applies as is.
 */
export function draftResponseHeaders(version: string | null | undefined): Record<string, string> {
  if (!version) return {};
  return {
    "Cache-Control": "no-store, private",
    Vary: "Cookie",
    "X-Robots-Tag": "noindex, nofollow",
  };
}
