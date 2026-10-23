/**
 * The draft names and headers of a Deco Next.js site: the `?__draft=` link,
 * the cookie that keeps a preview going, the request header the proxy hands
 * the pages the version on, and the response headers of a page rendered from a draft. The
 * proxy reads and writes them (`./drafts.ts`, `./proxy`); the pages read the
 * header (`./server`); `./config/index.cjs` repeats them (`config.test.ts`
 * holds them equal). This package's own copy: it never imports
 * `@decocms/tanstack`. No imports, no state: safe in every bundle.
 */

/**
 * The query parameter a draft link carries (`?__draft=<pointer>`, or `off` to
 * end a preview). The proxy reads it after its host check; reading it
 * directly would skip that check.
 */
export const DRAFT_PARAM = "__draft";

/**
 * The cookie that keeps a preview going after the first draft link. Like
 * {@link DRAFT_PARAM}, the proxy reads it after its host check.
 */
export const DRAFT_COOKIE = "__deco_draft";

/**
 * The request header the proxy sets on the request it hands the pages once it
 * accepted a Studio link: the version (a draft pointer or a release's commit
 * SHA), already checked, without the preview's moment and switched tests
 * (those are decided in the proxy: `ASSIGNMENTS_HEADER`). The proxy removes
 * any copy that arrives from outside, and `bindDraft` repeats the host check,
 * so a client can't send one itself.
 */
export const VERSION_HEADER = "x-deco-version";

/**
 * The request header the proxy sets on a draft request it hands the pages:
 * the id of the release check it made for it (`cms.checkRelease()`), so
 * `bindDraft`'s host check and the page's draft reads wait for that check
 * instead of making their own (one `latest.json` read per preview request).
 * The proxy removes any copy that arrives from outside; an id the CMS didn't
 * make (a proxy in another process) is a check of its own anyway.
 */
export const RELEASE_CHECK_HEADER = "x-deco-release-check";

/** The URL prefix a drafted request is rewritten onto (`app/%5Fdraft/[[...path]]`). */
export const DRAFT_ROUTE_PREFIX = "/_draft";

/**
 * The request header the proxy sets when the link named a draft that can't be
 * read anymore (deleted, say): the pages render the release and
 * `DraftPreviewIndicator` says so calmly. The proxy removes any copy that
 * arrives from outside.
 */
export const DRAFT_UNAVAILABLE_HEADER = "x-deco-draft-unavailable";

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
