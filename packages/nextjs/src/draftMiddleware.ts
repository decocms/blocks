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
export function prepareDraft(request: NextRequest): DraftMiddlewareDecision {
  return decideDraft(new URL(request.url), request.cookies.get(DRAFT_COOKIE)?.value ?? null);
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
