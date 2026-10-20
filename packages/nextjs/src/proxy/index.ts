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
 * A site with a proxy of its own calls the pieces (`decideDraft` and
 * `decideAssignments`, then `draftRequestHeaders` and
 * `assignmentRequestHeaders` on the request it forwards, then `applyDraft`
 * and `applyAssignments` on the response); a site without one exports
 * `draftProxy(...)`.
 *
 * A/B tests: the proxy decides the visitor's assignments for the release's
 * `Experiments` block (`assign` from `@decocms/blocks/experiments`), forwards
 * them on `x-deco-assignments` (a copy from outside is always removed) for
 * `bindDraft` and `contentClient`, and stores them in the `deco_segment`
 * cookie when they changed. A draft writes no cookie and forwards none: a
 * preview shows the control, plus the variants its pointer forces.
 *
 * Statically rendered pages can't read a draft, so a drafted request to one
 * is rewritten onto a dynamic draft route (`/_draft/<path>`, mounted as
 * `app/%5Fdraft/...`: a literal `_draft` folder is private in Next and never
 * routes).
 *
 * The proxy measures no requests: it runs before Next routes and renders the
 * page. `http.server.request.duration` comes from Next's own request span
 * (`register` from `@decocms/nextjs/instrumentation`).
 */
import type { CMS } from "@decocms/blocks";
import { type Assignments, assign, readSegment, segmentCookie } from "@decocms/blocks/experiments";
import { type NextRequest, NextResponse } from "next/server.js";
import { ASSIGNMENTS_HEADER, encodeAssignments } from "../assignments.ts";
import { DRAFT_HEADER, DRAFT_ROUTE_PREFIX, draftResponseHeaders } from "../draft.ts";
import {
  allowedDraft,
  draftCookie,
  endsPreview,
  fromDraftLink,
  hasDraftSignal,
  type PreviewPolicy,
  requestLike,
} from "../drafts.ts";

export {
  inferredPreviewHosts,
  type PreviewPolicy,
  previewHostDecision,
  requestLike,
} from "../drafts.ts";

/** What the draft decision needs from the CMS: the site's declared preview hosts and their check. */
export type CMSHandle = Pick<CMS, "draftPointer" | "settings" | "forRelease">;

/** What the proxy does with a request's draft state. */
export interface DraftDecision {
  /** The draft this request renders, after the host check; `null` for the release. */
  pointer: string | null;
  /** The `Set-Cookie` the response carries: storing a draft link's pointer, or ending a preview. */
  setCookie: string | null;
}

export { DRAFT_ROUTE_PREFIX } from "../draft.ts";

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
 * A copy that arrives from outside is always removed, and so is any
 * `x-deco-assignments` (`assignmentRequestHeaders` sets the proxy's own).
 */
export function draftRequestHeaders(
  request: NextRequest | Request,
  decision: DraftDecision,
): Headers {
  const headers = new Headers(request.headers);
  headers.delete(ASSIGNMENTS_HEADER);
  if (decision.pointer) headers.set(DRAFT_HEADER, decision.pointer);
  else headers.delete(DRAFT_HEADER);
  return headers;
}

/** The visitor's A/B assignments for one request. */
export interface AssignmentDecision {
  /**
   * The experiments of the release and whether the visitor is in each;
   * `null` for a draft or a release without experiments (nothing forwarded).
   */
  assignments: Assignments | null;
  /** The `deco_segment` `Set-Cookie`, when the visitor's assignments changed. */
  setCookie: string | null;
}

const UNASSIGNED: AssignmentDecision = Object.freeze({ assignments: null, setCookie: null });

/** Whether the visitor asked over https (`x-forwarded-proto` first, as a host in front reports it). */
function isHttps(request: NextRequest | Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwarded) return forwarded === "https";
  return new URL(request.url).protocol === "https:";
}

/**
 * The visitor's assignments for the release's `Experiments` block, read from
 * and written back to the `deco_segment` cookie. Nothing for a draft (a
 * preview never writes the visitor's cookie) or when the release has no
 * experiments.
 */
export async function decideAssignments(
  cms: Pick<CMS, "experiments">,
  request: NextRequest | Request,
  draft: DraftDecision,
): Promise<AssignmentDecision> {
  if (draft.pointer !== null) return UNASSIGNED;
  const experiments = await cms.experiments();
  if (Object.keys(experiments).length === 0) return UNASSIGNED;
  const { assignments, segment, changed } = assign(experiments, readSegment(request));
  return {
    assignments,
    setCookie: changed ? segmentCookie(segment, { secure: isHttps(request) }) : null,
  };
}

/**
 * The forwarded headers with the visitor's assignments on
 * `x-deco-assignments`, for `bindDraft` and `contentClient`. Pass it the
 * headers `draftRequestHeaders` gave, which already removed a copy from
 * outside.
 */
export function assignmentRequestHeaders(headers: Headers, decision: AssignmentDecision): Headers {
  const out = new Headers(headers);
  if (decision.assignments === null) out.delete(ASSIGNMENTS_HEADER);
  else out.set(ASSIGNMENTS_HEADER, encodeAssignments(decision.assignments));
  return out;
}

/** The `deco_segment` cookie on the response, when the visitor's assignments changed. */
export function applyAssignments<R extends Response>(response: R, decision: AssignmentDecision): R {
  if (decision.setCookie) response.headers.append("set-cookie", decision.setCookie);
  return response;
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
 * The whole draft flow, and the visitor's A/B assignments, for a site with no
 * proxy of its own: `export const proxy = draftProxy(proxyCms, { site: "my-store" })`.
 */
export function draftProxy(
  cms: CMSHandle & Pick<CMS, "experiments">,
  options: DraftProxyOptions = {},
): (request: NextRequest) => Promise<NextResponse> {
  const { rewrite = () => true, ...policy } = options;
  return async (request) => {
    const decision = await decideDraft(cms, request, policy);
    const assignments = await decideAssignments(cms, request, decision);
    const rewritten = rewrite(request) ? rewriteToDraftRoute(request, decision) : null;
    const response =
      rewritten ??
      NextResponse.next({
        request: {
          headers: assignmentRequestHeaders(draftRequestHeaders(request, decision), assignments),
        },
      });
    return applyAssignments(applyDraft(response, decision), assignments);
  };
}
