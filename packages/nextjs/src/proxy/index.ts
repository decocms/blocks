/**
 * `@decocms/nextjs/proxy`: draft previews in a Next.js proxy (`proxy.ts`, or
 * `middleware.ts` before Next 16). No React and no block map: pass the proxy
 * a CMS handle made with an empty block map and the app's options, which
 * shares the app's instance (one per process) without pulling the site's
 * sections into the proxy bundle:
 *
 * ```ts
 * // src/cms.proxy.ts
 * export const proxyCms = createCMS({ blocks: {}, ...cmsConfig });
 * ```
 *
 * A site with a proxy of its own calls the pieces (`decideDraft`, then
 * `draftRequestHeaders` on the request it forwards, then `applyDraft` on the
 * response); a site without one exports `draftProxy(...)`.
 *
 * Statically rendered pages can't read a draft, so a drafted request to one
 * is rewritten onto a dynamic draft route (`/_draft/<path>`, mounted as
 * `app/%5Fdraft/...`: a literal `_draft` folder is private in Next and never
 * routes).
 */
import { type CMS, DRAFT_HEADER, draftResponseHeaders } from "@decocms/blocks";
import { type NextRequest, NextResponse } from "next/server.js";
import {
  allowedDraft,
  draftCookie,
  endsPreview,
  fromDraftLink,
  hasDraftSignal,
  type PreviewPolicy,
  requestLike,
} from "../drafts.ts";

export { isNextDev } from "../dev.ts";
export {
  inferredPreviewHosts,
  type PreviewPolicy,
  previewHostDecision,
  requestLike,
} from "../drafts.ts";

/** What the proxy needs from the CMS: the preview-host check of the `CMS` block. */
export type CMSHandle = Pick<CMS, "draftPointer">;

/** What the proxy does with a request's draft state. */
export interface DraftDecision {
  /** The draft this request renders, after the host check; `null` for the release. */
  pointer: string | null;
  /** The `Set-Cookie` the response carries: storing a draft link's pointer, or ending a preview. */
  setCookie: string | null;
}

/** The URL prefix a drafted request is rewritten onto (`app/%5Fdraft/[[...path]]`). */
export const DRAFT_ROUTE_PREFIX = "/_draft";

const INERT: DraftDecision = Object.freeze({ pointer: null, setCookie: null });

/**
 * The draft a request renders and the cookie its response sets, under
 * `policy` (the same options the pages pass to `bindDraft`). A request with
 * no `?__draft=` and no draft cookie never reaches the CMS.
 */
export async function decideDraft(
  cms: CMSHandle,
  request: NextRequest | Request,
  policy: PreviewPolicy = {},
): Promise<DraftDecision> {
  const url = new URL(request.url);
  const like = requestLike(request.headers, url.pathname + url.search, url.host);
  if (like === null || !hasDraftSignal(like)) return INERT;
  // Ending a preview is allowed on any host, so a cookie set earlier always goes.
  if (endsPreview(like)) return { pointer: null, setCookie: draftCookie("", ["Max-Age=0"]) };
  const pointer = await allowedDraft(cms, like, policy);
  if (pointer === null) return INERT;
  return {
    pointer,
    setCookie: fromDraftLink(like, pointer) ? draftCookie(encodeURIComponent(pointer)) : null,
  };
}

/**
 * The request headers to forward: the accepted pointer on `x-deco-draft`, so
 * the root layout can bind the draft on the same request (a layout gets no
 * `searchParams`, and on a draft link the cookie is only on the response).
 * A copy that arrives from outside is always removed.
 */
export function draftRequestHeaders(
  request: NextRequest | Request,
  decision: DraftDecision,
): Headers {
  const headers = new Headers(request.headers);
  if (decision.pointer) headers.set(DRAFT_HEADER, decision.pointer);
  else headers.delete(DRAFT_HEADER);
  return headers;
}

/** Whether `pathname` is on the draft route: a site answers a direct hit there with its 404. */
export function isDraftRoutePath(pathname: string): boolean {
  return pathname === DRAFT_ROUTE_PREFIX || pathname.startsWith(`${DRAFT_ROUTE_PREFIX}/`);
}

/**
 * The rewrite of a drafted request onto the draft route, keeping its path and
 * forwarding the pointer; `null` when the request isn't drafted or is already
 * on the draft route.
 */
export function rewriteToDraftRoute(
  request: NextRequest,
  decision: DraftDecision,
): NextResponse | null {
  if (!decision.pointer) return null;
  const url = request.nextUrl.clone();
  if (isDraftRoutePath(url.pathname)) return null;
  url.pathname = `${DRAFT_ROUTE_PREFIX}${url.pathname}`;
  return NextResponse.rewrite(url, {
    request: { headers: draftRequestHeaders(request, decision) },
  });
}

/**
 * The cookie and the response headers of a draft: `Set-Cookie`, and for a
 * drafted response `Cache-Control: no-store, private`, `Vary: Cookie` and
 * `X-Robots-Tag: noindex, nofollow` (`draftResponseHeaders`). With the
 * pointer in a cookie a draft shares its URL with the published page, so a
 * cache keyed on the URL alone would serve it to visitors.
 */
export function applyDraft<R extends Response>(response: R, decision: DraftDecision): R {
  if (decision.setCookie) response.headers.append("set-cookie", decision.setCookie);
  for (const [name, value] of Object.entries(draftResponseHeaders(decision.pointer))) {
    response.headers.set(name, value);
  }
  return response;
}

export interface DraftProxyOptions extends PreviewPolicy {
  /**
   * Which drafted requests go to the draft route (a statically rendered
   * page's). Default: every drafted request outside the draft route. Return
   * `false` for a route that is already dynamic and binds the draft itself.
   */
  rewrite?: (request: NextRequest) => boolean;
}

/**
 * The whole draft flow for a site with no proxy of its own:
 * `export const proxy = draftProxy(proxyCms, { site: "my-store" })`.
 */
export function draftProxy(
  cms: CMSHandle,
  options: DraftProxyOptions = {},
): (request: NextRequest) => Promise<NextResponse> {
  const { rewrite = () => true, ...policy } = options;
  return async (request) => {
    const decision = await decideDraft(cms, request, policy);
    const rewritten = rewrite(request) ? rewriteToDraftRoute(request, decision) : null;
    const response =
      rewritten ??
      NextResponse.next({ request: { headers: draftRequestHeaders(request, decision) } });
    return applyDraft(response, decision);
  };
}
