/**
 * The draft names and headers of a Deco Next.js site: the `?__draft=` link,
 * the cookie that keeps a preview going, the request header the proxy hands
 * the pages, and the response headers of a page rendered from a draft. The
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
 * accepted the draft: the pointer, already checked. The proxy removes any
 * copy that arrives from outside, and `bindDraft` repeats the host check, so a
 * client can't send one itself.
 */
export const DRAFT_HEADER = "x-deco-draft";

/**
 * The response headers of a page rendered from a draft: never stored by a
 * browser or a CDN (`Cache-Control: no-store, private`, `Vary: Cookie`) and
 * never indexed (`X-Robots-Tag: noindex, nofollow`). `{}` when `pointer` is
 * `null`, so the result of the draft decision applies as is.
 */
export function draftResponseHeaders(pointer: string | null | undefined): Record<string, string> {
  if (!pointer) return {};
  return {
    "Cache-Control": "no-store, private",
    Vary: "Cookie",
    "X-Robots-Tag": "noindex, nofollow",
  };
}
