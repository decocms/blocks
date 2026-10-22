/**
 * `@decocms/nextjs/proxy`: draft previews, the visitor and what a request's
 * content gives it, decided once, in a Next.js proxy (`proxy.ts`, or
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
 * A site with a proxy of its own calls the pieces (`decideDraft`,
 * `decideVisitor` and `decideAssignments`, then `draftRequestHeaders`,
 * `visitorRequestHeaders` and `assignmentsRequestHeaders` on the request it
 * forwards, then `applyDraft` and `applyVisitor` on the response); a site
 * without one exports `draftProxy(...)`.
 *
 * The proxy decides: the version (`decideDraft`: a Studio link's draft or old
 * release, after the host allowlist, with the preview's moment and switched
 * tests and campaigns), the visitor (`decideVisitor`: `readVisitor` from
 * `@decocms/blocks/experiments`, the `deco_segment` cookie or a new visitor)
 * and, from both, each test and campaign on or off (`decideAssignments`:
 * `cms.client({ version, visitor, date, experiments, campaigns })` resolving
 * the saved `experiments` and `campaigns` blocks). It forwards them on
 * `x-deco-version`, `x-deco-visitor` and `x-deco-assignments` (copies from
 * outside are always removed), and the page builds
 * `cms.client({ version, experiments, campaigns })` from them
 * (`contentClient`), deciding nothing again. It sends the visitor's cookie on
 * a first visit only, never from a preview.
 *
 * Cached (ISR) pages can't read a request, so a drafted request to one is
 * rewritten onto a dynamic draft route (`/_draft/<path>`, mounted as
 * `app/%5Fdraft/...`: a literal `_draft` folder is private in Next and never
 * routes), and a published one onto the assignments route
 * (`/_assignments/<assignments>/<path>`, `rewriteToAssignmentsRoute`), where
 * `assignedClient` from `@decocms/nextjs/server` builds the client from the
 * path.
 *
 * The binding caches nothing. A site that caches in front of its pages (a
 * CDN keyed on a request header) keys on the request's assignments, never on
 * the visitor: `assignmentsKey(await decideAssignments(proxyCms, draft,
 * visitor))`, `""` when there are none.
 *
 * The proxy measures no requests: it runs before Next routes and renders the
 * page. `http.server.request.duration` comes from Next's own request span
 * (`register` from `@decocms/nextjs/instrumentation`).
 */
import type { CMS, RequestVersion } from "@decocms/blocks";
import { readVisitor, serializeVisitor, type Visitor } from "@decocms/blocks/experiments";
import { type NextRequest, NextResponse } from "next/server.js";
import {
  ASSIGNMENTS_HEADER,
  assignmentsRoutePath,
  assignmentsSegment,
  isAssignmentsRoutePath,
  type RequestAssignments,
  readAssignmentsAndScope,
} from "../assignments.ts";
import { DRAFT_ROUTE_PREFIX, draftResponseHeaders, VERSION_HEADER } from "../draft.ts";
import {
  allowedDraft,
  draftCookie,
  draftLinkValue,
  endsPreview,
  hasDraftSignal,
  requestLike,
} from "../drafts.ts";
import { VISITOR_HEADER } from "../visitor.ts";

export { requestLike } from "../drafts.ts";

/** What the draft decision needs from the CMS: its preview host check, and the release. */
export type CMSHandle = Pick<CMS, "readVersion" | "forRelease">;

/** What the proxy does with a request's draft state. */
export interface DraftDecision {
  /**
   * What this request's Studio link asks for, after the host check: the
   * version (a draft pointer, or a release's commit SHA) and the preview's
   * moment and switched tests and campaigns, in the shape of
   * `cms.client()`'s options; `null` for the current release.
   */
  version: RequestVersion | null;
  /** The `Set-Cookie` the response carries: storing a link's version, or ending a preview. */
  setCookie: string | null;
}

export {
  ASSIGNMENTS_HEADER,
  ASSIGNMENTS_ROUTE_PREFIX,
  assignmentsKey,
  assignmentsRoutePath,
  assignmentsSegment,
  isAssignmentsRoutePath,
  type PathAssignments,
  parseAssignmentsSegment,
  type RequestAssignments,
  readAssignments,
} from "../assignments.ts";
export { DRAFT_ROUTE_PREFIX, VERSION_HEADER } from "../draft.ts";

const INERT: DraftDecision = Object.freeze({ version: null, setCookie: null });

/**
 * The version a request renders and the cookie its response sets, on a host
 * the CMS allows (as the pages' `bindDraft` checks again). A request with
 * no `?__draft=` and no draft cookie never reaches the CMS.
 */
export async function decideDraft(
  cms: CMSHandle,
  request: NextRequest | Request,
): Promise<DraftDecision> {
  const url = new URL(request.url);
  const like = requestLike(request.headers, url.pathname + url.search, url.host);
  if (like === null || !hasDraftSignal(like)) return INERT;
  // Ending a preview is allowed on any host, so a cookie set earlier always goes.
  if (endsPreview(like)) return { version: null, setCookie: draftCookie("", ["Max-Age=0"]) };
  const version = await allowedDraft(cms, like);
  if (version === null) return INERT;
  const link = draftLinkValue(like);
  return { version, setCookie: link ? draftCookie(encodeURIComponent(link)) : null };
}

/** The headers the proxy writes for the pages: never taken from outside. */
const OWN_HEADERS = [VERSION_HEADER, VISITOR_HEADER, ASSIGNMENTS_HEADER];

/**
 * The request headers to forward: the accepted version on `x-deco-version`,
 * so the root layout can bind the draft on the same request (a layout gets no
 * `searchParams`, and on a draft link the cookie is only on the response).
 * A copy that arrives from outside is always removed, and so are any
 * `x-deco-visitor` and `x-deco-assignments` (`visitorRequestHeaders` and
 * `assignmentsRequestHeaders` set the proxy's own).
 */
export function draftRequestHeaders(
  request: NextRequest | Request,
  decision: DraftDecision,
): Headers {
  const headers = new Headers(request.headers);
  for (const name of OWN_HEADERS) headers.delete(name);
  if (decision.version) headers.set(VERSION_HEADER, decision.version.version);
  return headers;
}

/** The visitor of one request. */
export interface VisitorDecision {
  /** Who is visiting: the `deco_segment` cookie's visitor, or a new one. */
  visitor: Visitor;
  /** The `deco_segment` `Set-Cookie`, on a first visit to the live site; `null` otherwise. */
  setCookie: string | null;
}

/** Whether the visitor asked over https (`x-forwarded-proto` first, as a host in front reports it). */
function isHttps(request: NextRequest | Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwarded) return forwarded === "https";
  return new URL(request.url).protocol === "https:";
}

/**
 * The visitor of a request (`readVisitor`: the `deco_segment` cookie, or a
 * new visitor when it had no id) and the cookie to send back, only on a first
 * visit and never from a preview (`draft` holds a version): Studio is not a
 * visitor. Reads no content.
 */
export function decideVisitor(
  request: NextRequest | Request,
  draft: DraftDecision,
): VisitorDecision {
  // `readVisitor` makes the cookie `Secure` unless the request came over plain http.
  const { visitor, cookie } = readVisitor({
    url: isHttps(request) ? "https://localhost/" : "http://localhost/",
    headers: request.headers,
  });
  return { visitor, setCookie: draft.version === null ? cookie : null };
}

/**
 * The forwarded headers with the visitor on `x-deco-visitor`. Pass it the
 * headers `draftRequestHeaders` gave, which already removed a copy from
 * outside.
 */
export function visitorRequestHeaders(headers: Headers, decision: VisitorDecision): Headers {
  const out = new Headers(headers);
  out.set(VISITOR_HEADER, serializeVisitor(decision.visitor));
  return out;
}

/** The `deco_segment` cookie on the response, on a first visit. */
export function applyVisitor<R extends Response>(response: R, decision: VisitorDecision): R {
  if (decision.setCookie) response.headers.append("set-cookie", decision.setCookie);
  return response;
}

/**
 * Each test and campaign on or off for this request, decided once:
 * `cms.client({ visitor, ...version })` (the visitor, and the Studio link's
 * version, moment and switched tests and campaigns) resolving the saved
 * `experiments` and `campaigns` blocks. Missing blocks, or content that
 * doesn't load, give none, never an error.
 */
export function decideAssignments(
  cms: Pick<CMS, "client">,
  draft: DraftDecision,
  visitor: VisitorDecision,
): Promise<RequestAssignments> {
  return readAssignmentsAndScope(cms, { visitor: visitor.visitor, ...draft.version }).then(
    (read) => read.assignments,
  );
}

/**
 * The forwarded headers with the decided tests and campaigns on
 * `x-deco-assignments` (`assignmentsSegment`), for `bindDraft` and
 * `contentClient`. Pass it the headers `draftRequestHeaders` gave.
 */
export function assignmentsRequestHeaders(
  headers: Headers,
  assignments: RequestAssignments,
): Headers {
  const out = new Headers(headers);
  out.set(ASSIGNMENTS_HEADER, assignmentsSegment(assignments));
  return out;
}

/** The request headers to forward: the version's and, when given, the visitor's and the assignments. */
function forwardedHeaders(
  request: NextRequest | Request,
  draft: DraftDecision,
  visitor: VisitorDecision | undefined,
  assignments: RequestAssignments | undefined,
): Headers {
  let headers = draftRequestHeaders(request, draft);
  if (visitor !== undefined) headers = visitorRequestHeaders(headers, visitor);
  if (assignments !== undefined) headers = assignmentsRequestHeaders(headers, assignments);
  return headers;
}

/** Whether `pathname` is on the draft route: a site answers a direct hit there with its 404. */
export function isDraftRoutePath(pathname: string): boolean {
  return pathname === DRAFT_ROUTE_PREFIX || pathname.startsWith(`${DRAFT_ROUTE_PREFIX}/`);
}

/**
 * The rewrite of a drafted request onto the draft route, keeping its path and
 * forwarding the version and, when given, the visitor (`decideVisitor`) and
 * the assignments (`decideAssignments`); `null` when the request isn't
 * drafted or is already on the draft route.
 */
export function rewriteToDraftRoute(
  request: NextRequest,
  decision: DraftDecision,
  visitor?: VisitorDecision,
  assignments?: RequestAssignments,
): NextResponse | null {
  if (!decision.version) return null;
  const url = request.nextUrl.clone();
  if (isDraftRoutePath(url.pathname)) return null;
  url.pathname = `${DRAFT_ROUTE_PREFIX}${url.pathname}`;
  return NextResponse.rewrite(url, {
    request: { headers: forwardedHeaders(request, decision, visitor, assignments) },
  });
}

/** An assignments-route response's `Cache-Control` when its content has tests or campaigns. */
const ASSIGNED_CACHE_CONTROL = "private, no-cache";

/**
 * The rewrite of a published request onto the assignments route,
 * `/_assignments/<assignments>/<path>`: each test on or off for the visitor
 * and each campaign running or not now (`readAssignments` on the current
 * release), as one path segment, so Next's own path-keyed cache (ISR, the
 * full route cache) keeps one entry per set of assignments. Visitors on the
 * same side of every test share a path; the visitor id is never in it, and
 * the page reads neither the visitor nor the version (the proxy's headers are
 * removed from the request it forwards), so Next can cache it. The page
 * builds its client with `assignedClient` from `@decocms/nextjs/server`,
 * `cms.client({ experiments, campaigns })` from the path: the proxy decides,
 * the page renders that. A cached page (ISR, `revalidate = 600`) is about 10
 * minutes stale (the first request after that still gets it while Next
 * renders it again), a banner switching on late, which is accepted.
 *
 * `null` for a drafted request (it renders on the draft route, never cached)
 * and for a path already on the draft or assignments route. When the content
 * saves tests or campaigns, the response is marked `Cache-Control: private,
 * no-cache`: Next keeps one cached page per set of assignments, but the URL
 * the visitor asked for answers by their cookie and the moment, so a CDN in
 * front must not share it. Call it only for the paths the assignments route
 * renders (the CMS's pages), and answer a direct hit on the route with a 404
 * (`isAssignmentsRoutePath`).
 */
export async function rewriteToAssignmentsRoute(
  cms: Pick<CMS, "client">,
  request: NextRequest,
  draft: DraftDecision,
  visitor: VisitorDecision,
): Promise<NextResponse | null> {
  if (draft.version) return null;
  const url = request.nextUrl.clone();
  if (isDraftRoutePath(url.pathname) || isAssignmentsRoutePath(url.pathname)) return null;
  const { assignments, varies } = await readAssignmentsAndScope(cms, { visitor: visitor.visitor });
  url.pathname = assignmentsRoutePath(url.pathname, assignments);
  const response = NextResponse.rewrite(url, {
    request: { headers: draftRequestHeaders(request, INERT) },
  });
  // The URL the visitor asked for answers differently by their cookie and the moment: a
  // shared cache in front (a CDN) must not keep Next's ISR `s-maxage` under it.
  if (varies) response.headers.set("Cache-Control", ASSIGNED_CACHE_CONTROL);
  return response;
}

/**
 * The cookie and the response headers of a draft: `Set-Cookie`, and for a
 * drafted response `Cache-Control: no-store, private`, `Vary: Cookie` and
 * `X-Robots-Tag: noindex, nofollow` (`draftResponseHeaders`). With the
 * version in a cookie a draft shares its URL with the published page, so a
 * cache keyed on the URL alone would serve it to visitors.
 */
export function applyDraft<R extends Response>(response: R, decision: DraftDecision): R {
  if (decision.setCookie) response.headers.append("set-cookie", decision.setCookie);
  for (const [name, value] of Object.entries(draftResponseHeaders(decision.version?.version))) {
    response.headers.set(name, value);
  }
  return response;
}

export interface DraftProxyOptions {
  /**
   * Which drafted requests go to the draft route (a statically rendered
   * page's). Default: every drafted request outside the draft route. Return
   * `false` for a route that is already dynamic and binds the draft itself.
   */
  rewrite?: (request: NextRequest) => boolean;
  /**
   * Which published requests render on the assignments route
   * (`rewriteToAssignmentsRoute`): the CMS's pages, when the site mounts
   * `app/%5Fassignments/[assignments]/[[...path]]`. Default: none. A direct
   * hit on the route gets a 404 once this is set.
   */
  assignments?: (request: NextRequest) => boolean;
}

/**
 * The whole flow for a site with no proxy of its own:
 * `export const proxy = draftProxy(proxyCms)`. Every
 * request it forwards carries the version, the visitor and the assignments
 * it decided.
 */
export function draftProxy(
  cms: CMSHandle & Pick<CMS, "client">,
  options: DraftProxyOptions = {},
): (request: NextRequest) => Promise<NextResponse> {
  const { rewrite = () => true, assignments } = options;
  return async (request) => {
    if (assignments && isAssignmentsRoutePath(request.nextUrl.pathname)) {
      return new NextResponse(null, { status: 404 });
    }
    const decision = await decideDraft(cms, request);
    const visitor = decideVisitor(request, decision);
    const onAssignmentsRoute = decision.version === null && assignments?.(request) === true;
    const rewritten = onAssignmentsRoute
      ? await rewriteToAssignmentsRoute(cms, request, decision, visitor)
      : null;
    let response = rewritten;
    if (response === null) {
      const decided = await decideAssignments(cms, decision, visitor);
      response =
        (rewrite(request) ? rewriteToDraftRoute(request, decision, visitor, decided) : null) ??
        NextResponse.next({
          request: { headers: forwardedHeaders(request, decision, visitor, decided) },
        });
    }
    return applyVisitor(applyDraft(response, decision), visitor);
  };
}
