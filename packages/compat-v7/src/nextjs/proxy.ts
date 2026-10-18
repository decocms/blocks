/**
 * `@decocms/compat-v7/nextjs/proxy`: the page URL the matchers read, from the
 * site's proxy (`proxy.ts`). A server component learns the request's headers
 * but not its URL, and a proxy may rewrite the path the page renders under;
 * v7 matched the URL the visitor asked for. The proxy forwards it on
 * `x-deco-page-url` (any copy from outside is replaced), and
 * `matcherContext()` from `@decocms/compat-v7/nextjs/server` reads it.
 *
 * ```ts
 * // proxy.ts, next to @decocms/nextjs/proxy's draft handling
 * const headers = pageUrlRequestHeaders(request, draftRequestHeaders(request, decision));
 * return applyDraft(NextResponse.next({ request: { headers } }), decision);
 * ```
 *
 * No React and no `next` import: safe in the proxy bundle.
 */
import { PAGE_URL_HEADER } from "./shared.ts";

export { PAGE_URL_HEADER };

/**
 * The request headers to forward with the visitor's URL on
 * `x-deco-page-url`: `headers` (default: a copy of the request's) with the
 * header set, replacing any copy that came from outside.
 */
export function pageUrlRequestHeaders(
  request: Request,
  headers: Headers = new Headers(request.headers),
): Headers {
  headers.set(PAGE_URL_HEADER, request.url);
  return headers;
}
