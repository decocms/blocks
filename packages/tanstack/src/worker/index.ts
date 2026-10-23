/**
 * `createDecoWorker`: the Cloudflare Worker in front of TanStack Start, the way
 * Deco runs every TanStack storefront. One entry, a few options, one escape
 * hatch (`routes`). What every site gets, with no option:
 *
 * - `/deco/_liveness` answers `OK`; v7's admin paths (`/deco/*`, `/live/*`,
 *   `/.decofile`) answer 404.
 * - Versions: the host allowlist (`./drafts.ts`) for a Studio link's version
 *   (a draft, or a published release by its commit SHA, with the preview's
 *   moment and switched tests and campaigns), the draft cookie, the
 *   `x-deco-version` request header the page reads. A preview (any request
 *   with `?__draft=`, `off` included, or the draft cookie) never goes through
 *   `pageCache` and answers `Cache-Control: max-age=0, no-cache,
 *   must-revalidate`, `Vary: Cookie` and `noindex`. A link's cookie is set
 *   only with a response below 500; a link to a draft that can't be read
 *   anymore renders the release, expires the cookie and tells the page
 *   (`draftUnavailable`), never a 500.
 * - The CMS redirects, before any route.
 * - No page cache: caching is the site's (`pageCache`, the README's
 *   worker-entry recipe), with the helpers it needs exported here
 *   (`assignmentsKey`, `cacheVersion`, `isCacheable`, …).
 *   The worker calls `pageCache` only for a request `isCacheable` accepts,
 *   never for a preview (any draft signal), and adds the visitor's cookie after it, so a stored
 *   copy never carries one. A page request with `Authorization` is never
 *   handed to it and answers `private, no-cache, no-store`. A response with no
 *   `CDN-Cache-Control` tells the CDN `no-store`, at one exit.
 * - Security headers and `frame-ancestors` for Studio; immutable fingerprinted
 *   assets; one `Set-Cookie` per cookie; `x-page-status`.
 * - The visitor: on a page or server-function request, `readVisitor` from
 *   `@decocms/blocks/experiments` (the `deco_segment` cookie, or a new
 *   visitor), handed to the app on `x-deco-visitor`; the cookie is sent on a
 *   first visit only, never from a preview.
 * - What the request's content gives it, decided once per request: each test
 *   and campaign on or off (`readAssignments`: `cms.client({ visitor,
 *   version, date, experiments, campaigns })` with the visitor and the Studio
 *   link's version, moment and switched tests and campaigns), handed to the
 *   site's `pageCache` (`page.assignments`, for its key) and to the app on
 *   `x-deco-assignments` (`contentClient` builds
 *   `cms.client({ version, experiments, campaigns })` from it, deciding
 *   nothing again).
 * - `http.server.request.duration` for every request, to the CMS's telemetry
 *   (`recordServerRequest` from `@decocms/blocks/metrics`), labelled with the route's template, the
 *   method, the status class, the cache decision (the `X-Cache` the site's
 *   `pageCache` answered with) and the device; nothing when the CMS has no
 *   telemetry.
 */
import { type CMS, matchRoute, type Redirect, type Route } from "@decocms/blocks";
import { readVisitor, serializeVisitor, type Visitor } from "@decocms/blocks/experiments";
import { recordServerRequest } from "@decocms/blocks/metrics";
import { runInScope } from "@decocms/tanstack/scope";
import { ASSIGNMENTS_HEADER, serializeAssignments } from "../assignments.ts";
import { draftResponseHeaders, VERSION_HEADER } from "../draft.ts";
import { PAGE_STATUS_HEADER } from "../shared.ts";
import { VISITOR_HEADER } from "../visitor.ts";
import { type RequestAssignments, readAssignments } from "./assignments.ts";
import { isCacheable } from "./cache.ts";
import { dedupeSetCookies } from "./cookies.ts";
import { type DraftDecision, decideDraft, hasDraftSignal } from "./drafts.ts";
import { type CspOptions, htmlSecurityHeaders } from "./security.ts";
import { type Device, detectDevice } from "./segment.ts";
import { isServerFnPath } from "./serverFn.ts";

export { CSEG_PARAM, DEGRADED_HEADER } from "../shared.ts";
export {
  assignmentsKey,
  liveAssignmentKeys,
  type RequestAssignments,
  readAssignments,
} from "./assignments.ts";
export { cacheVersion, isCacheable, requestVersion } from "./cache.ts";
export type { CspOptions } from "./security.ts";
export { type Device, detectDevice, type Segment, segmentKey, segmentToken } from "./segment.ts";
export { isServerFnPath, serverFnPagePath } from "./serverFn.ts";

/** The part of Cloudflare's `ExecutionContext` the worker uses. */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

/**
 * TanStack Start's server entry (`createServerEntry({ fetch: handler.fetch })`). The worker
 * passes it the request, the Worker's env and the execution context.
 */
export interface ServerEntry {
  fetch(request: Request, env?: any, ctx?: any): Response | Promise<Response>;
}

/**
 * A page or server-function request the site's `pageCache` may answer from
 * its own cache: always one `isCacheable` accepts (a GET of the current
 * release, never a preview).
 */
export interface PageRequest<Env = unknown> {
  /** The request as the app gets it: the visitor and the assignments on their headers. */
  request: Request;
  url: URL;
  /** The visitor the worker read (`readVisitor`). */
  visitor: Visitor;
  /**
   * Each test and campaign on or off for this request, as the worker decided
   * them and the page renders them: key the cache on `assignmentsKey(page.assignments)`.
   */
  assignments: RequestAssignments;
  /** The request's device class, from its user agent. */
  device: Device;
  env: Env;
  ctx: ExecutionContextLike;
  /**
   * Renders the page: the app's response, with `x-page-status` applied and
   * without the visitor's cookie (the worker adds it to whatever `pageCache`
   * answers). `csegToken` is the `__cseg` token `DecoDocument` publishes and
   * `decoServerFnFetch` sends back on the page's navigation data.
   */
  render(scope?: { csegToken?: string }): Promise<Response>;
}

/**
 * The site's page cache: answers a page from its own cache, or calls
 * `page.render()`. Set `X-Cache` (`HIT`, `STALE-HIT`, `STALE-ERROR`, `MISS`)
 * on the answer and the request's metric counts it.
 */
export type PageCache<Env = unknown> = (page: PageRequest<Env>) => Promise<Response>;

export interface DecoWorkerOptions<Env = unknown> {
  serverEntry: ServerEntry;
  /** The site's CMS: drafts, the CMS redirects, the page templates of the request metric. */
  cms: CMS;
  /** Local development (`import.meta.env.DEV`): `pageCache` is never called, loopback may frame the site. */
  dev?: boolean;
  /** The site's Content-Security-Policy. Studio's `frame-ancestors` is always added. */
  csp?: CspOptions;
  /**
   * The site's own page cache (the example worker entry the README links), called for
   * every page and server-function request `isCacheable` accepts. Without
   * it nothing is cached: every request renders.
   */
  pageCache?: PageCache<Env>;
  /**
   * `Link: rel=preload` hints on every HTML response the app renders. A
   * `routes` response carries none: it is another origin's page (a proxied
   * checkout, an A/B test's other site), and these are this app's assets.
   */
  preload?: { styles?: readonly string[]; fonts?: readonly string[] };
  /**
   * The escape hatch, after the CMS redirects and before anything else: answer
   * a request yourself (a commerce proxy, a sitemap, an A/B route) or return
   * `null` to let the worker serve it. The request carries the checked draft.
   * Its response leaves like any other (security headers, `CDN-Cache-Control`)
   * but without the `preload` hints.
   */
  routes?: (
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
  ) => Response | null | undefined | Promise<Response | null | undefined>;
}

export interface DecoWorker<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response>;
}

const LIVENESS_PATH = "/deco/_liveness";
/** v7's admin protocol paths: v8 sites serve none of them. */
const REMOVED_ADMIN_PATHS = ["/deco/", "/live/", "/.decofile"];
const BYPASS_PATHS = ["/_build"];
const STATIC_PATHS = ["/fonts/"];
const FINGERPRINTED_ASSET_RE = /(?:\/_build)?\/assets\/.*-[a-zA-Z0-9_-]{8,}\.\w+$/;
const PRIVATE_NO_CACHE = "private, no-cache, no-store, must-revalidate";
/** Paths the worker (or TanStack Start) serves under a fixed template, for `http.route`. */
const FIXED_ROUTES = [LIVENESS_PATH];
const PREFIX_ROUTES = ["/_serverFn/", "/_server/", "/_build/", "/assets/", "/fonts/"];

/** The template of a path the worker knows without the content, or `null`. */
function fixedRoute(pathname: string): string | null {
  if (FIXED_ROUTES.includes(pathname)) return pathname;
  const prefix = PREFIX_ROUTES.find((p) => pathname.startsWith(p));
  return prefix ? `${prefix}*` : null;
}

/**
 * `http.route` of a CMS redirect. One value for all of them: a redirect's
 * source is usually one exact URL (a site may carry thousands), so labelling
 * each would make the metric's cardinality the size of the redirect list.
 */
const REDIRECT_ROUTE = "redirect";

/**
 * The cache label of `http.server.request.duration`: `DRAFT` for a preview
 * (any draft signal),
 * otherwise what the site's `pageCache` said in `X-Cache`. A response that
 * never went through it (a redirect, the site's `routes`, an asset, a page
 * without a `pageCache`) is `BYPASS` whatever `X-Cache` an upstream put on it.
 */
function cacheLabel(
  response: Response,
  draft: boolean,
  served: { cached?: true } | undefined,
): "HIT" | "MISS" | "BYPASS" | "DRAFT" {
  if (draft) return "DRAFT";
  if (!served?.cached) return "BYPASS";
  const xCache = response.headers.get("X-Cache");
  if (xCache === "HIT" || xCache === "STALE-HIT" || xCache === "STALE-ERROR") return "HIT";
  return xCache === "MISS" ? "MISS" : "BYPASS";
}

const isHtml = (r: Response) => (r.headers.get("content-type") ?? "").includes("text/html");

/** The origin's response with the page's own status (`x-page-status`) applied. */
function withPageStatus(response: Response): Response {
  const status = Number(response.headers.get(PAGE_STATUS_HEADER));
  if (!status || status < 200 || status > 599) return response;
  const headers = new Headers(response.headers);
  headers.delete(PAGE_STATUS_HEADER);
  return new Response(response.body, { status, headers });
}

/** Adds `value` to the response's `Vary`, keeping what the origin listed. */
function appendVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (!current) headers.set("vary", value);
  else if (!current.split(",").some((v) => v.trim().toLowerCase() === value.toLowerCase())) {
    headers.set("vary", `${current}, ${value}`);
  }
}

function mutable(response: Response): Response {
  return new Response(response.body, response);
}

export function createDecoWorker<Env = unknown>(options: DecoWorkerOptions<Env>): DecoWorker<Env> {
  const { cms, serverEntry } = options;
  const dev = options.dev === true;
  const securityHeaders = htmlSecurityHeaders(options.csp, dev);
  const preloadLinks = [
    ...(options.preload?.styles ?? []).map((href) => `<${href}>; rel=preload; as=style`),
    ...(options.preload?.fonts ?? []).map((href) => `<${href}>; rel=preload; as=font; crossorigin`),
  ];

  // The release's redirects, read once per revision (a draft's are read each time).
  let releaseRedirects: { revision: string; list: Promise<Redirect[]> } | undefined;

  async function redirectsFor(pointer: string | null): Promise<Redirect[]> {
    const read = async (client: ReturnType<CMS["forRelease"]>) => {
      const [list] = await client.list<Redirect>("redirect");
      return list ?? [];
    };
    if (pointer) return read(cms.client({ version: pointer }));
    const client = cms.client();
    const revision = await client.revision();
    if (releaseRedirects?.revision !== revision) {
      releaseRedirects = { revision, list: read(client) };
    }
    return releaseRedirects.list;
  }

  // The release's page templates, for `http.route`: read once per revision,
  // and only while telemetry is measuring (`recordServerRequest` calls the
  // route function only then).
  let metricRoutes: { revision: string; pages: Promise<Route[]> } | undefined;

  async function routeTemplate(url: URL): Promise<string | undefined> {
    const client = cms.forRelease();
    const revision = await client.revision();
    let routes = metricRoutes;
    if (routes?.revision !== revision) {
      const pages = client
        .list<{ path?: unknown }>("page")
        .then(([list]) =>
          (list ?? []).flatMap((p) =>
            typeof p?.path === "string" ? [{ name: p.path, path: p.path }] : [],
          ),
        );
      const entry = { revision, pages };
      metricRoutes = entry;
      routes = entry;
      // A failed read is tried again on the next request, not kept for the revision.
      pages.catch(() => {
        if (metricRoutes === entry) metricRoutes = undefined;
      });
    }
    const match = matchRoute(url, { routes: await routes.pages });
    return match.kind === "match" ? match.entry.path : undefined;
  }

  /**
   * Records the request (`http.server.request.duration`). The route is a
   * function, found after the response and only while telemetry measures:
   * with telemetry off `recordServerRequest` resolves without calling it.
   */
  function measure(
    request: Request,
    ctx: ExecutionContextLike,
    seconds: number,
    status: number,
    cache: "HIT" | "MISS" | "BYPASS" | "DRAFT",
    served: Served | undefined,
  ): void {
    try {
      ctx.waitUntil(
        recordServerRequest({
          route: () => {
            if (served?.redirect) return REDIRECT_ROUTE;
            const url = new URL(request.url);
            const fixed = fixedRoute(url.pathname);
            if (fixed !== null) return fixed;
            // The site's own `routes` answer has no template the worker knows.
            return served?.routed ? undefined : routeTemplate(url);
          },
          method: request.method,
          status,
          cache,
          device: detectDevice(request.headers.get("user-agent") ?? ""),
          seconds,
        }),
      );
    } catch {
      // A metric never breaks a response.
    }
  }

  async function findRedirect(url: URL, pointer: string | null): Promise<Response | null> {
    try {
      const redirects = await redirectsFor(pointer);
      if (!redirects.length) return null;
      const match = matchRoute(url, { routes: [], redirects });
      if (match.kind !== "redirect") return null;
      return new Response(null, { status: match.status, headers: { Location: match.location } });
    } catch {
      return null; // a content error never blocks the page
    }
  }

  interface Served {
    response: Response;
    /** Answered by the site's `pageCache`: its `X-Cache` labels the metric. */
    cached?: true;
    /** A fingerprinted or static asset: its own `Cache-Control`, a preview's or not. */
    asset?: true;
    /** Answered by the site's `routes`: not this app's page, so no `preload` hints. */
    routed?: true;
    /** A CMS redirect. */
    redirect?: true;
    /** The visitor's `deco_segment` cookie, on a first visit to the live site. */
    visitorCookie?: string;
  }

  /**
   * What a page or server-function request reads, decided once: the visitor
   * (`readVisitor`: the `deco_segment` cookie, or a new visitor) on
   * `x-deco-visitor`, each test and campaign on or off for it and the
   * request's version (`readAssignments`) on `x-deco-assignments`, and the
   * cookie to send when the visitor had no id. A preview (a draft, or an old
   * release) sends no cookie: Studio is not a visitor.
   */
  async function withDecisions(
    request: Request,
    draft: DraftDecision,
  ): Promise<{
    request: Request;
    visitor: Visitor | null;
    assignments?: RequestAssignments;
    visitorCookie?: string;
  }> {
    // TanStack Start's own build files render no content.
    if (BYPASS_PATHS.some((p) => new URL(request.url).pathname.startsWith(p))) {
      return { request, visitor: null };
    }
    const { visitor, cookie } = readVisitor(request);
    const assignments = await readAssignments(cms, { visitor, ...draft.version });
    const headers = new Headers(request.headers);
    headers.set(VISITOR_HEADER, serializeVisitor(visitor));
    headers.set(ASSIGNMENTS_HEADER, serializeAssignments(assignments));
    const forwarded = new Request(request, { headers });
    if (cookie === null || draft.version !== null) {
      return { request: forwarded, visitor, assignments };
    }
    return { request: forwarded, visitor, assignments, visitorCookie: cookie };
  }

  async function handle(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
    decision: DraftDecision,
    preview: boolean,
  ): Promise<Served> {
    const draft = decision.version?.version ?? null;
    const url = new URL(request.url);
    const method = request.method;
    const readOnly = method === "GET" || method === "HEAD";

    if (url.pathname === LIVENESS_PATH) {
      return {
        response: new Response("OK", {
          headers: {
            "Content-Type": "text/plain",
            "Cache-Control": PRIVATE_NO_CACHE,
          },
        }),
      };
    }
    if (REMOVED_ADMIN_PATHS.some((p) => url.pathname.startsWith(p))) {
      return {
        response: new Response("Not Found", {
          status: 404,
          headers: { "Cache-Control": PRIVATE_NO_CACHE },
        }),
      };
    }
    const asset =
      FINGERPRINTED_ASSET_RE.test(url.pathname) ||
      STATIC_PATHS.some((p) => url.pathname.startsWith(p));

    if (
      readOnly &&
      !asset &&
      !isServerFnPath(url.pathname) &&
      !BYPASS_PATHS.some((p) => url.pathname.startsWith(p))
    ) {
      const redirect = await findRedirect(url, draft);
      if (redirect) return { response: redirect, redirect: true };
    }

    if (options.routes) {
      const routed = await options.routes(request, env, ctx);
      if (routed) return { response: routed, routed: true };
    }

    if (asset) {
      const origin = await serverEntry.fetch(request, env, ctx);
      if (origin.status !== 200) return { response: origin, asset: true };
      if (isHtml(origin)) {
        return { response: new Response("Not Found", { status: 404 }), asset: true };
      }
      const resp = mutable(origin);
      resp.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      resp.headers.set("Vary", "Accept-Encoding");
      return { response: resp, asset: true };
    }

    const visited = await withDecisions(request, decision);
    const served = await page(visited.request, env, ctx, {
      draft,
      preview,
      unavailable: decision.unavailable === true,
      url,
      visitor: visited.visitor,
      assignments: visited.assignments,
    });
    return visited.visitorCookie === undefined
      ? served
      : { ...served, visitorCookie: visited.visitorCookie };
  }

  /**
   * A page or server-function request: the site's `pageCache` when it may
   * cache it, else the app. A preview (any draft signal) always renders: its
   * headers are set at the exit (`serve`).
   */
  async function page(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
    inputs: {
      draft: string | null;
      preview: boolean;
      unavailable: boolean;
      url: URL;
      visitor: Visitor | null;
      assignments: RequestAssignments | undefined;
    },
  ): Promise<Served> {
    const { draft, preview, unavailable, url, visitor, assignments } = inputs;
    const render = async (scope?: { csegToken?: string }): Promise<Response> =>
      withPageStatus(
        await runInScope(
          {
            csegToken: scope?.csegToken,
            draft: draft ?? undefined,
            ...(unavailable ? { draftUnavailable: true } : {}),
          },
          () => serverEntry.fetch(request, env, ctx),
        ),
      );

    if (draft !== null || preview) return { response: await render() };
    // A signed request's page is that caller's: no shared cache may keep it,
    // whatever the app said (RFC 9111 lets one store a `public` answer to it).
    if (request.headers.has("authorization")) {
      const out = mutable(await render());
      out.headers.set("Cache-Control", PRIVATE_NO_CACHE);
      return { response: out };
    }
    if (
      !options.pageCache ||
      visitor === null ||
      assignments === undefined ||
      !isCacheable(request, { version: draft, dev })
    ) {
      return { response: await render() };
    }
    const response = await options.pageCache({
      request,
      url,
      visitor,
      assignments,
      device: detectDevice(request.headers.get("user-agent") ?? ""),
      env,
      ctx,
      render,
    });
    return { response, cached: true };
  }

  async function serve(
    incoming: Request,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<{ response: Response; served: Served; draft: boolean }> {
    // Any draft signal makes the request a preview, whatever the decision.
    const preview = hasDraftSignal(incoming);
    let decision: DraftDecision = { version: null, setCookie: null };
    try {
      decision = await decideDraft(cms, incoming);
    } catch {
      // The settings didn't load: the request gets the release.
    }
    // The page reads the version, the visitor and the assignments from these
    // headers; a copy from outside never counts.
    let request = incoming;
    const own = [VERSION_HEADER, VISITOR_HEADER, ASSIGNMENTS_HEADER];
    if (own.some((name) => incoming.headers.has(name)) || decision.version !== null) {
      const headers = new Headers(incoming.headers);
      for (const name of own) headers.delete(name);
      if (decision.version !== null) headers.set(VERSION_HEADER, decision.version.version);
      request = new Request(incoming, { headers });
    }

    const served = await handle(request, env, ctx, decision, preview);
    const draft = decision.version !== null || preview;
    let response = served.response;
    // A WebSocket upgrade passes through untouched.
    if (response.status === 101) return { response, served, draft };
    response = mutable(response);

    // CDN-Cache-Control is decided here, at the single exit: a response that
    // names none (the app's, the site's cache's or a route's) tells the CDN
    // no-store, so only what the site chose to share is kept in front of it.
    if (!response.headers.has("CDN-Cache-Control")) {
      response.headers.set("CDN-Cache-Control", "no-store");
    }
    // A preview's response is never answered from a cache: the exact header,
    // whatever the app or a route said. A fingerprinted asset stays immutable.
    if (preview && !served.asset) {
      for (const [k, v] of Object.entries(draftResponseHeaders(true))) {
        if (k.toLowerCase() !== "vary") response.headers.set(k, v);
        else appendVary(response.headers, v);
      }
      // Nor kept by the CDN, whatever a route said: with the draft in a cookie
      // a preview shares its URL with the published page.
      response.headers.set("CDN-Cache-Control", "no-store");
    }
    // A link's cookie only with a page that rendered: a failed render never
    // pins the preview to it. The cookie that ends a preview always goes.
    const ending = decision.version === null;
    if (decision.setCookie && (ending || response.status < 500)) {
      response.headers.append("Set-Cookie", decision.setCookie);
    }
    if (served.visitorCookie) response.headers.append("Set-Cookie", served.visitorCookie);
    dedupeSetCookies(response);
    if (isHtml(response)) {
      for (const [k, v] of Object.entries(securityHeaders)) {
        if (!response.headers.has(k)) response.headers.set(k, v);
      }
      if (!served.routed) {
        for (const link of preloadLinks) response.headers.append("Link", link);
      }
    }

    return { response, served, draft };
  }

  return {
    async fetch(incoming, env, ctx) {
      const clock = performance.now();
      let result: Awaited<ReturnType<typeof serve>>;
      try {
        result = await serve(incoming, env, ctx);
      } catch (error) {
        // The runtime answers a thrown request with a 500.
        measure(incoming, ctx, (performance.now() - clock) / 1000, 500, "BYPASS", undefined);
        throw error;
      }
      const { response, served, draft } = result;
      measure(
        incoming,
        ctx,
        (performance.now() - clock) / 1000,
        response.status,
        cacheLabel(response, draft, served),
        served,
      );
      return response;
    },
  };
}
