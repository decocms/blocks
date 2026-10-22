/**
 * `createDecoWorker`: the Cloudflare Worker in front of TanStack Start, the way
 * Deco runs every TanStack storefront. One entry, a few options, one escape
 * hatch (`routes`). What every site gets, with no option:
 *
 * - `/deco/_liveness` answers `OK`; v7's admin paths (`/deco/*`, `/live/*`,
 *   `/.decofile`) answer 404.
 * - Versions: the host allowlist (`./drafts.ts`) for a Studio link's version
 *   (a draft, or a published release by its commit SHA), the draft cookie,
 *   the `x-deco-draft` request header the page reads, and on the response
 *   `no-store`, `Vary: Cookie` and `noindex`. Only a real preview skips the
 *   cache.
 * - The CMS redirects, before any route.
 * - An edge cache (the Cloudflare Cache API) keyed by URL, device, the site's
 *   segment parts, `<build>.<content revision>` and the request's assignments
 *   (`./assignments.ts`: the tests of the saved `experiments`
 *   block the visitor is in and the campaigns of `campaigns` running now,
 *   never the visitor id), with stale-while-revalidate and stale-if-error;
 *   logged-in, private and degraded responses never stored.
 * - CDN caching of client-side navigation data whose `__cseg` token checks out;
 *   every other response tells the CDN `no-store`, at one exit.
 * - Security headers and `frame-ancestors` for Studio; immutable fingerprinted
 *   assets; one `Set-Cookie` per cookie; `x-page-status`.
 * - The visitor: on a page or server-function request, `readVisitor` from
 *   `@decocms/blocks/experiments` (the `deco_segment` cookie, or a new
 *   visitor), handed to the app on `x-deco-visitor` (`contentClient` reads
 *   it); the cookie is sent on a first visit only, never from a preview.
 * - `http.server.request.duration` for every request, to the CMS's telemetry
 *   (`recordServerRequest` from `@decocms/blocks/metrics`), labelled with the route's template, the
 *   method, the status class, the cache decision and the device; nothing
 *   when the CMS has no telemetry.
 */
import { type CMS, matchRoute, type Redirect, type Route } from "@decocms/blocks";
import { readVisitor, serializeVisitor, type Visitor } from "@decocms/blocks/experiments";
import { recordServerRequest } from "@decocms/blocks/metrics";
import { runInScope } from "@decocms/tanstack/scope";
import { DRAFT_HEADER, draftResponseHeaders } from "../draft.ts";
import { CSEG_PARAM, DEGRADED_HEADER, PAGE_STATUS_HEADER } from "../shared.ts";
import { VISITOR_HEADER } from "../visitor.ts";
import { assignmentsKey, liveAssignmentKeys, readAssignments } from "./assignments.ts";
import {
  type CacheProfileName,
  type CacheProfileOverrides,
  cacheControl,
  canonicalizeServerFnPayload,
  isServerFnPath,
  PRIVATE_NO_CACHE,
  profileOf,
  resolveProfiles,
} from "./cacheProfiles.ts";
import { dedupeSetCookies, hasOnlySafeCookies, withoutSafeCookies } from "./cookies.ts";
import { decideDraft, type PreviewPolicy } from "./drafts.ts";
import { type CspOptions, htmlSecurityHeaders } from "./security.ts";
import { type Device, detectDevice, type Segment, segmentKey, segmentToken } from "./segment.ts";

export type {
  CacheProfile,
  CacheProfileName,
  CacheProfileOverrides,
  CacheWindow,
} from "./cacheProfiles.ts";
export { DEFAULT_CACHE_PROFILES } from "./cacheProfiles.ts";
export type { CspOptions } from "./security.ts";
export type { Device, Segment } from "./segment.ts";

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

/** What the edge cache did with a request (`X-Cache`). */
export type CacheDecision = "HIT" | "STALE-HIT" | "STALE-ERROR" | "MISS" | "BYPASS";

/** One page or server-function request, for `onCache`. */
export interface CacheEvent {
  /** The page type (cache profile) the URL maps to. */
  profile: CacheProfileName;
  decision: CacheDecision;
  /** Milliseconds from the request to the response's headers. */
  ms: number;
  status: number;
}

export interface DecoWorkerOptions<Env = unknown> {
  serverEntry: ServerEntry;
  /** The site's CMS: drafts, the content revision in the cache key, CMS redirects. */
  cms: CMS;
  /** The site's name: `<site>.deco.site` and `<site>.deco-cx.workers.dev` may preview drafts. */
  site: string;
  /** The build's id, in every cache key: the commit sha (`decoTanstack()` defines `__BUILD_HASH__`). */
  buildHash: string;
  /** Local development (`import.meta.env.DEV`): no edge cache, `no-cache` pages, loopback may frame the site. */
  dev?: boolean;
  /** The site's Content-Security-Policy. Studio's `frame-ancestors` is always added. */
  csp?: CspOptions;
  /**
   * More cache-key parts for a request (a region, a sales channel, an A/B
   * cohort), merged over `{ device }` (`mobile`, `tablet` or `desktop`; return
   * your own `device` to merge classes). Return `"private"` for a request that
   * must never share a cached response (a signed-in shopper).
   */
  segment?: (request: Request) => Record<string, string | undefined> | "private";
  /** Changes to the default cache profiles (`DEFAULT_CACHE_PROFILES`). */
  cacheProfiles?: CacheProfileOverrides;
  /** Cookies a cached response may set (stripped from the stored copy). Default: `_deco_bucket`. */
  safeCookies?: readonly string[];
  /**
   * Turns on `POST /_cache/purge` with `Authorization: Bearer <token>` (v7's
   * request): for each exact path, the worker deletes every key it could have
   * stored it under (each device and segment part, navigation and fetch, the
   * page's navigation data, every combination of the tests and campaigns).
   */
  purgeToken?: (env: Env) => string | undefined;
  /**
   * `Link: rel=preload` hints on every HTML response the app renders. A
   * `routes` response carries none: it is another origin's page (a proxied
   * checkout, an A/B test's other site), and these are this app's assets.
   */
  preload?: { styles?: readonly string[]; fonts?: readonly string[] };
  /**
   * v7's `DECO_ALLOWED_PREVIEW_HOSTS`: replaces the site's declared preview
   * hosts (the `CMS` block's), exact hosts with their port
   * (`["localhost:5173"]` for local development); the site's Deco hosts stay
   * allowed. `"none"` turns draft previews off on every host. Without it and
   * without hosts in the `CMS` block, drafts preview only on the Deco hosts.
   */
  previewHosts?: readonly string[] | "none";
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
  /** Called once per page or server-function request (D3: no exporter is built in). */
  onCache?: (event: CacheEvent) => void;
}

export interface DecoWorker<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response>;
}

const LIVENESS_PATH = "/deco/_liveness";
/** v7's admin protocol paths: v8 sites serve none of them. */
const REMOVED_ADMIN_PATHS = ["/deco/", "/live/", "/.decofile"];
const PURGE_PATH = "/_cache/purge";
const BYPASS_PATHS = ["/_build"];
const STATIC_PATHS = ["/fonts/"];
const FINGERPRINTED_ASSET_RE = /(?:\/_build)?\/assets\/.*-[a-zA-Z0-9_-]{8,}\.\w+$/;
/** Query parameters that never change a page, left out of its cache key (v7's list). */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utmi_campaign",
  "utmi_page",
  "utmi_part",
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "ttclid",
  "srsltid",
]);
const DEFAULT_SAFE_COOKIES = ["_deco_bucket"];
const STORED_AT = "X-Deco-Stored-At";
const DEVICES: readonly Device[] = ["mobile", "tablet", "desktop"];
const DECISIONS = new Set<string>(["HIT", "STALE-HIT", "STALE-ERROR", "MISS", "BYPASS"]);
/** Paths the worker (or TanStack Start) serves under a fixed template, for `http.route`. */
const FIXED_ROUTES = [LIVENESS_PATH, PURGE_PATH];
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
 * The cache label of `http.server.request.duration`: the worker's own
 * decision. A response that never went through the edge cache (no cache
 * profile: a redirect, the site's `routes`, an asset) is `BYPASS` whatever
 * `X-Cache` an upstream put on it.
 */
function cacheLabel(
  response: Response,
  draft: boolean,
  served: { profile?: unknown } | undefined,
): "HIT" | "MISS" | "BYPASS" | "DRAFT" {
  if (draft) return "DRAFT";
  if (!served?.profile) return "BYPASS";
  const xCache = response.headers.get("X-Cache");
  if (xCache === "HIT" || xCache === "STALE-HIT" || xCache === "STALE-ERROR") return "HIT";
  return xCache === "MISS" ? "MISS" : "BYPASS";
}

const isHtml = (r: Response) => (r.headers.get("content-type") ?? "").includes("text/html");

function edgeCache(): Cache | null {
  return typeof caches !== "undefined"
    ? ((caches as unknown as { default?: Cache }).default ?? null)
    : null;
}

/** The origin's response with the page's own status (`x-page-status`) applied. */
function withPageStatus(response: Response): Response {
  const status = Number(response.headers.get(PAGE_STATUS_HEADER));
  if (!status || status < 200 || status > 599) return response;
  const headers = new Headers(response.headers);
  headers.delete(PAGE_STATUS_HEADER);
  return new Response(response.body, { status, headers });
}

function isPrivateResponse(response: Response): boolean {
  return /\b(private|no-store)\b/i.test(response.headers.get("cache-control") ?? "");
}

function isDegraded(response: Response): boolean {
  return response.headers.get(DEGRADED_HEADER) === "true";
}

/** Adds `value` to the response's `Vary`, keeping what the origin listed. */
function appendVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (!current) headers.set("vary", value);
  else if (!current.split(",").some((v) => v.trim().toLowerCase() === value.toLowerCase())) {
    headers.set("vary", `${current}, ${value}`);
  }
}

/** A constant-time string compare, as v7's, for the purge token (its length isn't secret). */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function mutable(response: Response): Response {
  return new Response(response.body, response);
}

function bypass(response: Response, reason: string, cacheControlValue?: string): Response {
  const out = mutable(response);
  if (cacheControlValue) {
    out.headers.set("Cache-Control", cacheControlValue);
    out.headers.delete("CDN-Cache-Control");
  }
  out.headers.set("X-Cache", "BYPASS");
  out.headers.set("X-Cache-Reason", reason);
  return out;
}

export function createDecoWorker<Env = unknown>(options: DecoWorkerOptions<Env>): DecoWorker<Env> {
  const { cms, serverEntry } = options;
  const dev = options.dev === true;
  const profiles = resolveProfiles(options.cacheProfiles);
  const safeCookies = new Set(options.safeCookies ?? DEFAULT_SAFE_COOKIES);
  const securityHeaders = htmlSecurityHeaders(options.csp, dev);
  const policy: PreviewPolicy = { site: options.site, previewHosts: options.previewHosts };
  const preloadLinks = [
    ...(options.preload?.styles ?? []).map((href) => `<${href}>; rel=preload; as=style`),
    ...(options.preload?.fonts ?? []).map((href) => `<${href}>; rel=preload; as=font; crossorigin`),
  ];

  /** `<build>.<revision>`: a published release gets new entries at once; the build alone when the revision can't be read. */
  async function cacheVersion(): Promise<string> {
    let revision = "";
    try {
      revision = await cms.forRelease().revision();
    } catch {
      // The content didn't load: key on the build only.
    }
    return [options.buildHash, revision].filter(Boolean).join(".");
  }

  function segmentOf(request: Request): Segment | "private" {
    const base = { device: detectDevice(request.headers.get("user-agent") ?? "") };
    const extra = options.segment?.(request);
    if (extra === "private") return "private";
    const out: Record<string, string> = { ...base };
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (v === undefined || v === "") delete out[k];
      else out[k] = v;
    }
    return out;
  }

  function cacheKey(
    url: URL,
    request: Request,
    version: string,
    segment: Segment,
    assigned: string,
  ): Request {
    const key = new URL(url);
    for (const name of [...key.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(name.toLowerCase())) key.searchParams.delete(name);
    }
    key.searchParams.delete(CSEG_PARAM);
    const serverFn = isServerFnPath(key.pathname);
    if (serverFn) {
      const payload = key.searchParams.get("payload");
      if (payload) key.searchParams.set("payload", canonicalizeServerFnPayload(payload));
    }
    if (version) key.searchParams.set("__v", version);
    // Programmatic fetches (no navigation) get their own entries, as in v7.
    if (!serverFn && request.headers.get("sec-fetch-dest") === "empty") {
      key.searchParams.set("__fetch", "1");
    }
    key.searchParams.set("__seg", segmentKey(segment));
    if (assigned) key.searchParams.set("__a", assigned);
    return new Request(key.toString(), { method: "GET" });
  }

  /** The segments a purge drops: the body's own `segments`, or each device. */
  function purgeSegments(body: Record<string, unknown>): Segment[] {
    if (!Array.isArray(body.segments)) return DEVICES.map((device) => ({ device }));
    const out = new Map<string, Segment>();
    for (const s of body.segments) {
      if (!s || typeof s !== "object") continue;
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(s)) if (typeof v === "string" && v) clean[k] = v;
      out.set(segmentKey(clean), clean);
    }
    return [...out.values()];
  }

  async function purge(request: Request, env: Env): Promise<Response> {
    const token = options.purgeToken?.(env);
    if (!token || !sameString(request.headers.get("Authorization") ?? "", `Bearer ${token}`)) {
      return new Response("Unauthorized", { status: 401 });
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }
    const paths = Array.isArray(body.paths)
      ? [
          ...new Set(
            body.paths.filter((p): p is string => typeof p === "string" && p.startsWith("/")),
          ),
        ]
      : [];
    if (paths.length === 0) {
      return new Response('Body must include "paths": ["/", "/page"]', { status: 400 });
    }
    const cache = edgeCache();
    if (!cache) return Response.json({ purged: [], total: 0, note: "Cache storage unavailable" });
    const origin = new URL(request.url).origin;
    // Exact keys, as v7: each path as given (`/shoes` never drops
    // `/shoes?page=2`), under the current version, for every segment, every
    // assignments key a request can carry now (each subset of the saved tests,
    // with the running campaigns and with none), as a navigation and a
    // programmatic fetch. Navigation data (server-function page loads) isn't
    // purged: it expires with its cache lifetime, as in v7.
    const version = await cacheVersion();
    const segments = purgeSegments(body);
    const assignments = await liveAssignmentKeys(cms);
    const purged: string[] = [];
    // A failed call (the Cache API down, or the request's Cache API calls
    // spent: 50 on Workers Free, 1,000 on Paid) stops the purge: the answer
    // names the paths not fully purged, to send again.
    const stopped = (i: number) =>
      Response.json(
        {
          purged,
          notPurged: paths.slice(i),
          total: purged.length,
          note: "The Cache API stopped answering: send the notPurged paths again",
        },
        { status: 503 },
      );
    for (const [i, path] of paths.entries()) {
      const page = new URL(path, origin);
      const variants: [Request, string | null][] = [
        [new Request(page), null],
        [new Request(page, { headers: { "sec-fetch-dest": "empty" } }), "fetch"],
      ];
      for (const segment of segments) {
        for (const assigned of assignments) {
          for (const [req, tag] of variants) {
            const key = cacheKey(page, req, version, segment, assigned);
            let gone: boolean;
            try {
              gone = await cache.delete(key);
            } catch {
              return stopped(i);
            }
            if (gone) {
              const tags = [segmentKey(segment), assigned || null, tag].filter(Boolean).join(", ");
              purged.push(`${path} (${tags})`);
            }
          }
        }
      }
    }
    return Response.json({ purged, total: purged.length });
  }

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
    profile?: CacheProfileName;
    /** Answered by the site's `routes`: not this app's page, so no `preload` hints. */
    routed?: true;
    /** A CMS redirect. */
    redirect?: true;
    /** The visitor's `deco_segment` cookie, on a first visit to the live site. */
    visitorCookie?: string;
  }

  /**
   * The visitor of a page or server-function request (`readVisitor`: the
   * `deco_segment` cookie, or a new visitor), on `x-deco-visitor` for the
   * app, and the cookie to send when the visitor had no id. A preview (a
   * draft, or an old release) sends no cookie: Studio is not a visitor.
   */
  function withVisitor(
    request: Request,
    version: string | null,
  ): { request: Request; visitor: Visitor | null; visitorCookie?: string } {
    // TanStack Start's own build files render no content.
    if (BYPASS_PATHS.some((p) => new URL(request.url).pathname.startsWith(p))) {
      return { request, visitor: null };
    }
    const { visitor, cookie } = readVisitor(request);
    const headers = new Headers(request.headers);
    headers.set(VISITOR_HEADER, serializeVisitor(visitor));
    const forwarded = new Request(request, { headers });
    if (cookie === null || version !== null) return { request: forwarded, visitor };
    return { request: forwarded, visitor, visitorCookie: cookie };
  }

  async function handle(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
    draft: string | null,
  ): Promise<Served> {
    const url = new URL(request.url);
    const method = request.method;
    const readOnly = method === "GET" || method === "HEAD";

    if (url.pathname === LIVENESS_PATH) {
      return {
        response: new Response("OK", {
          headers: {
            "Content-Type": "text/plain",
            "Cache-Control": PRIVATE_NO_CACHE,
            "X-Cache": "BYPASS",
          },
        }),
      };
    }
    if (REMOVED_ADMIN_PATHS.some((p) => url.pathname.startsWith(p))) {
      return {
        response: new Response("Not Found", {
          status: 404,
          headers: { "Cache-Control": PRIVATE_NO_CACHE, "X-Cache": "BYPASS" },
        }),
      };
    }
    if (url.pathname === PURGE_PATH && method === "POST")
      return { response: await purge(request, env) };

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
      if (origin.status !== 200) return { response: origin };
      if (isHtml(origin)) return { response: new Response("Not Found", { status: 404 }) };
      const resp = mutable(origin);
      resp.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      resp.headers.set("Vary", "Accept-Encoding");
      return { response: resp };
    }

    const visited = withVisitor(request, draft);
    const served = await page(visited.request, env, ctx, draft, url, visited.visitor);
    return visited.visitorCookie === undefined
      ? served
      : { ...served, visitorCookie: visited.visitorCookie };
  }

  /** A page or server-function request: the edge cache, then the app. */
  async function page(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
    draft: string | null,
    url: URL,
    visitor: Visitor | null,
  ): Promise<Served> {
    const method = request.method;
    const profileName = profileOf(url);
    const profile = profiles[profileName];
    const segment = segmentOf(request);
    const cacheable =
      method === "GET" &&
      !dev &&
      draft === null &&
      segment !== "private" &&
      !request.headers.has("authorization") &&
      !BYPASS_PATHS.some((p) => url.pathname.startsWith(p));
    const cache = edgeCache();
    const version = cacheable ? await cacheVersion() : "";
    // The request's assignments, before the lookup: two visitors on the
    // same side of every test share an entry.
    const assigned = cacheable
      ? assignmentsKey(await readAssignments(cms, { visitor, version: draft }))
      : "";
    const token = cacheable
      ? segmentToken(segment as Segment, assigned ? `${version}|${assigned}` : version)
      : null;
    const origin = async (): Promise<Response> =>
      withPageStatus(
        await runInScope({ csegToken: token ?? undefined, draft: draft ?? undefined }, () =>
          serverEntry.fetch(request, env, ctx),
        ),
      );

    if (!cacheable) {
      const resp = await origin();
      if (draft !== null) {
        const out = bypass(resp, "draft");
        for (const [k, v] of Object.entries(draftResponseHeaders(draft))) {
          if (k.toLowerCase() !== "vary") out.headers.set(k, v);
          else appendVary(out.headers, v);
        }
        return { response: out, profile: profileName };
      }
      if (method !== "GET") return { response: bypass(resp, "method"), profile: profileName };
      if (
        segment === "private" ||
        request.headers.has("authorization") ||
        !profile.isPublic ||
        isPrivateResponse(resp) ||
        !hasOnlySafeCookies(resp, safeCookies)
      ) {
        return { response: bypass(resp, "private", PRIVATE_NO_CACHE), profile: profileName };
      }
      // `vite dev` (and the `/_build` paths): the browser revalidates every time.
      return {
        response: bypass(resp, dev ? "dev" : "path", dev ? "no-cache" : undefined),
        profile: profileName,
      };
    }

    const seg = segment as Segment;
    const key = cacheKey(url, request, version, seg, assigned);
    const edge = profile.edge;
    const cdnPublic =
      token !== null &&
      profile.isPublic &&
      edge.fresh > 0 &&
      isServerFnPath(url.pathname) &&
      url.searchParams.get(CSEG_PARAM) === token;

    const dress = (
      resp: Response,
      decision: CacheDecision,
      extra?: Record<string, string>,
    ): Response => {
      const out = mutable(resp);
      // Cloudflare's Cache API adds its own status to a matched response.
      out.headers.delete("cf-cache-status");
      out.headers.delete(STORED_AT);
      out.headers.set("Cache-Control", cacheControl(profile));
      out.headers.set("Vary", "Accept-Encoding");
      // The CDN may keep only navigation data whose URL carries this segment's token.
      out.headers.set(
        "CDN-Cache-Control",
        cdnPublic ? `public, max-age=${edge.fresh}` : "no-store",
      );
      out.headers.set("X-Cache", decision);
      out.headers.set("X-Cache-Profile", profileName);
      out.headers.set("X-Cache-Segment", segmentKey(seg));
      if (version) out.headers.set("X-Cache-Version", version);
      for (const [k, v] of Object.entries(extra ?? {})) out.headers.set(k, v);
      return out;
    };

    const storable = (resp: Response) =>
      resp.status === 200 &&
      !isDegraded(resp) &&
      !isPrivateResponse(resp) &&
      hasOnlySafeCookies(resp, safeCookies);

    const store = (resp: Response) => {
      if (!cache) return;
      const ttl = edge.fresh + Math.max(edge.swr, edge.sie);
      const copy = resp.headers.has("set-cookie")
        ? withoutSafeCookies(resp, safeCookies)
        : resp.clone();
      copy.headers.set("Cache-Control", `public, max-age=${ttl}`);
      copy.headers.set(STORED_AT, String(Date.now()));
      copy.headers.delete("CDN-Cache-Control");
      ctx.waitUntil(cache.put(key, copy).catch(() => {}));
    };

    const ageOf = (resp: Response) => {
      const storedAt = Number(resp.headers.get(STORED_AT) || "0");
      return storedAt > 0 ? (Date.now() - storedAt) / 1000 : Number.POSITIVE_INFINITY;
    };

    let cached: Response | undefined;
    if (cache && profile.isPublic && edge.fresh > 0) {
      try {
        cached = (await cache.match(key)) ?? undefined;
      } catch {
        // Cache API unavailable: a miss.
      }
    }

    if (cached) {
      const age = ageOf(cached);
      if (age < edge.fresh) return { response: dress(cached, "HIT"), profile: profileName };
      if (age < edge.fresh + edge.swr) {
        ctx.waitUntil(
          origin()
            .then((fresh) => {
              if (storable(fresh)) store(fresh);
            })
            .catch(() => {}),
        );
        return {
          response: dress(cached, "STALE-HIT", { "X-Cache-Age": String(Math.round(age)) }),
          profile: profileName,
        };
      }
    }

    const staleOnError = (reason: string, status?: number): Response | null => {
      if (!cached || edge.sie <= 0) return null;
      const age = ageOf(cached);
      if (age >= edge.fresh + edge.sie) return null;
      return dress(cached, "STALE-ERROR", {
        "X-Cache-Age": String(Math.round(age)),
        "X-Cache-Reason": reason,
        ...(status ? { "X-Cache-Origin-Status": String(status) } : {}),
      });
    };

    let resp: Response;
    try {
      resp = await origin();
    } catch (error) {
      const stale = staleOnError("origin-error");
      if (stale) return { response: stale, profile: profileName };
      throw error;
    }

    if (resp.status !== 200) {
      if (resp.status >= 500 || resp.status === 429) {
        const stale = staleOnError("origin-status", resp.status);
        if (stale) return { response: stale, profile: profileName };
      }
      return { response: bypass(resp, `status:${resp.status}`), profile: profileName };
    }
    if (isDegraded(resp)) {
      const stale = staleOnError("degraded");
      if (stale) return { response: stale, profile: profileName };
      return { response: bypass(resp, "degraded", PRIVATE_NO_CACHE), profile: profileName };
    }
    if (isPrivateResponse(resp) || !hasOnlySafeCookies(resp, safeCookies)) {
      return { response: bypass(resp, "private-response", PRIVATE_NO_CACHE), profile: profileName };
    }
    if (!profile.isPublic || edge.fresh === 0) {
      return {
        response: bypass(resp, `profile:${profileName}`, PRIVATE_NO_CACHE),
        profile: profileName,
      };
    }
    store(resp);
    return { response: dress(resp, "MISS"), profile: profileName };
  }

  async function serve(
    incoming: Request,
    env: Env,
    ctx: ExecutionContextLike,
    started: number,
  ): Promise<{ response: Response; served: Served; draft: boolean }> {
    let decision: { pointer: string | null; setCookie: string | null } = {
      pointer: null,
      setCookie: null,
    };
    try {
      decision = await decideDraft(cms, incoming, policy);
    } catch {
      // The settings didn't load: the request gets the release.
    }
    // The page reads the version and the visitor from these headers; a copy
    // from outside never counts.
    let request = incoming;
    if (
      incoming.headers.has(DRAFT_HEADER) ||
      incoming.headers.has(VISITOR_HEADER) ||
      decision.pointer !== null
    ) {
      const headers = new Headers(incoming.headers);
      headers.delete(DRAFT_HEADER);
      headers.delete(VISITOR_HEADER);
      if (decision.pointer !== null) headers.set(DRAFT_HEADER, decision.pointer);
      request = new Request(incoming, { headers });
    }

    const served = await handle(request, env, ctx, decision.pointer);
    const draft = decision.pointer !== null;
    let response = served.response;
    // A WebSocket upgrade passes through untouched.
    if (response.status === 101) return { response, served, draft };
    response = mutable(response);

    // CDN-Cache-Control is decided here, at the single exit: a response the
    // worker didn't cache, or that no branch gave one, tells the CDN no-store.
    if (
      response.headers.get("X-Cache") === "BYPASS" ||
      !response.headers.has("CDN-Cache-Control")
    ) {
      response.headers.set("CDN-Cache-Control", "no-store");
    }
    if (decision.setCookie) response.headers.append("Set-Cookie", decision.setCookie);
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

    if (served.profile && options.onCache) {
      const xCache = response.headers.get("X-Cache") ?? "BYPASS";
      try {
        options.onCache({
          profile: served.profile,
          decision: (DECISIONS.has(xCache) ? xCache : "BYPASS") as CacheDecision,
          ms: Date.now() - started,
          status: response.status,
        });
      } catch {
        // A metrics hook never breaks a response.
      }
    }
    return { response, served, draft };
  }

  return {
    async fetch(incoming, env, ctx) {
      const started = Date.now();
      const clock = performance.now();
      let result: Awaited<ReturnType<typeof serve>>;
      try {
        result = await serve(incoming, env, ctx, started);
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
