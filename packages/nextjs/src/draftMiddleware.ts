/**
 * Draft preview — middleware half.
 *
 * Two composable calls, because sites already own their middleware and this
 * must slot into it rather than replace it:
 *
 * ```ts
 * // middleware.ts (Next <16) / proxy.ts (Next 16+)
 * export function middleware(request: NextRequest) {
 *   const decision = prepareDraft(request);
 *   return applyDraft(NextResponse.next(), decision);
 * }
 * ```
 *
 * The middleware owns only the cookie and the cache/indexing headers — a
 * Server Component can read cookies but cannot set them, so that part has to
 * live here. The pointer itself is read by the page.
 *
 * Lives on its own subpath so middleware (edge runtime) never imports the root
 * barrel, which pulls in the client component graph.
 */

import { isDraftHostAllowed } from "@decocms/blocks/cms";
import { type NextRequest, NextResponse } from "next/server";
import {
  DRAFT_COOKIE,
  DRAFT_COOKIE_OPTIONS,
  type DraftMiddlewareDecision,
  decideDraft,
} from "./draft";

/**
 * Compute the draft decision for a request.
 *
 * Only the cookie and the response headers are the middleware's business now —
 * the page reads the pointer itself from `searchParams` + `cookies()`, so
 * nothing has to be forwarded through the request. That also means a draft
 * still works on routes this middleware never matches.
 */
const INERT: DraftMiddlewareDecision = { pointer: null, setCookie: null, clearCookie: false };

export function prepareDraft(request: NextRequest): DraftMiddlewareDecision {
  // The AUTHORITATIVE host gate lives page-side (`ensureDraft`): the site
  // block's `previewHosts` are installed in the server-components graph, and
  // middleware runs in a separate module graph/runtime that never sees them.
  // Middleware therefore hard-gates only on the env override — keeping
  // DECO_ALLOWED_PREVIEW_HOSTS a full kill switch — and otherwise passes the
  // decision through. Worst case on a non-preview host is a cookie the
  // page-side gate then ignores; drafts never render there.
  if (process.env.DECO_ALLOWED_PREVIEW_HOSTS) {
    const host =
      request.headers.get("x-forwarded-host") ??
      request.headers.get("host") ??
      request.nextUrl.host;
    if (!isDraftHostAllowed(host)) return INERT;
  }
  return decideDraft(new URL(request.url), request.cookies.get(DRAFT_COOKIE)?.value ?? null);
}

/**
 * URL prefix a drafted request is rewritten onto.
 *
 * The site must mount the matching route as `app/%5Fdraft/...` — URL-encoded.
 * A literal `_draft/` directory is a Next "private folder", excluded from
 * routing entirely, so the rewrite would fall through to whatever catch-all
 * follows and 404. The encoded directory serves the same `/_draft` URL while
 * staying routable.
 */
export const DRAFT_ROUTE_PREFIX = "/_draft";

/**
 * Rewrite a drafted request onto the dynamic draft route.
 *
 * This exists because `dynamic` / `revalidate` are STATIC route exports: a
 * statically rendered page cannot become dynamic for one request. Making the
 * real route dynamic to support drafts would cost every shopper their cached
 * page, and — worse — a statically rendered draft would be cached and served to
 * them. Rewriting sends only drafted requests to a route that is dynamic by
 * construction, leaving ordinary traffic's ISR completely untouched.
 *
 * The original path is preserved in the rewritten pathname, so the draft route
 * can resolve exactly the page the visitor asked for.
 *
 * Returns null when this request is not drafted, so callers fall through to
 * their normal response.
 */
export function rewriteToDraftRoute(
  request: NextRequest,
  decision: DraftMiddlewareDecision,
): NextResponse | null {
  if (!decision.pointer) return null;
  const url = request.nextUrl.clone();
  // Already rewritten (Next re-runs middleware on the rewritten URL in some
  // configurations) — never nest the prefix.
  if (url.pathname.startsWith(`${DRAFT_ROUTE_PREFIX}/`)) return null;
  url.pathname = `${DRAFT_ROUTE_PREFIX}${url.pathname}`;
  return NextResponse.rewrite(url);
}

/**
 * Apply the cookie and the cache/indexing headers a draft response requires.
 *
 * The caching headers are the difference between a preview and a **leak**.
 * With the pointer in a cookie, a draft response and a published one share an
 * identical URL, so a CDN keyed on URL alone would happily serve unpublished
 * content to a real visitor. `no-store` is what actually prevents that;
 * `Vary: Cookie` keeps any intermediary that *does* respect it from mixing the
 * two; `X-Robots-Tag` keeps a leaked draft out of search results.
 */
export function applyDraft(
  response: NextResponse,
  decision: DraftMiddlewareDecision,
): NextResponse {
  if (decision.clearCookie) {
    response.cookies.delete(DRAFT_COOKIE);
  } else if (decision.setCookie) {
    response.cookies.set(DRAFT_COOKIE, decision.setCookie, DRAFT_COOKIE_OPTIONS);
  }

  if (decision.pointer) {
    response.headers.set("cache-control", "no-store, private");
    response.headers.set("vary", "Cookie");
    response.headers.set("x-robots-tag", "noindex, nofollow");
  }

  return response;
}

/**
 * Convenience for sites with no middleware of their own: prepare, continue,
 * apply. Sites that already have middleware should call the two halves
 * directly so their own logic sits in between.
 */
export function draftMiddleware(request: NextRequest): NextResponse {
  return applyDraft(NextResponse.next(), prepareDraft(request));
}
