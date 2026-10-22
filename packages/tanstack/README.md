# @decocms/tanstack

Deco CMS for [TanStack Start](https://tanstack.com/start) sites on Cloudflare Workers, deployed the way Deco deploys them. It is opinionated: one worker entry with a few options, one escape hatch for your own routes, and the behaviour every Deco TanStack site should have, always on.

Peers: `@decocms/blocks` (same version), `@tanstack/react-start`, `@tanstack/react-router`, `react`, and `vite` for `/vite`.

## The worker

```ts
// src/worker-entry.ts (wrangler.jsonc "main"), without a page cache
import { createDecoWorker } from "@decocms/tanstack/worker";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { cms } from "./cms";

export default createDecoWorker({
  serverEntry: createServerEntry({ fetch: handler.fetch }),
  cms,
  site: "my-store",
  dev: import.meta.env.DEV,
});
```

Always on: `/deco/_liveness`; 404 for v7's admin paths; Studio may frame the site (`frame-ancestors`, no `X-Frame-Options`) and the security headers; drafts (the host allowlist, the draft cookie, `no-store`, `noindex`); the CMS redirects; one `Set-Cookie` per cookie; `x-page-status`; `CDN-Cache-Control: no-store` on every response that names none; and `http.server.request.duration` for every request, in the CMS's telemetry through `recordServerRequest` from `@decocms/blocks/metrics` (nothing without a `token` or an `endpoint`, and then the page template is never looked up), labelled `http.route` (the content's page template, `redirect` for every CMS redirect, a fixed one such as `/_serverFn/*` or `/assets/*`, otherwise `unmatched`), `http.request.method`, `status_class`, `cache` (`DRAFT` for a preview; otherwise the `X-Cache` your `pageCache` answered with, `HIT` for `HIT`, `STALE-HIT` and `STALE-ERROR`, `MISS`, else `BYPASS`) and `device`.

Options, each for a value a site needs to change: `csp`, `pageCache`, `preload`, `previewHosts` and `routes`.

The worker caches no page: the page cache is the site's, as on Next.js. Without `pageCache` every request renders. [The page cache](#the-page-cache) below is a complete worker entry with one.

### Draft hosts

A draft link (`?__draft=`) previews where v7 allowed it: on the preview hosts the site declares (the `CMS` block's `preview.hosts`, or `createCMS`'s) and always on the hosts Deco runs the site on, `<site>.deco.site` and `<site>.deco-cx.workers.dev`. A site that declares no hosts previews only on those two, not on every host. `previewHosts: [...]` replaces the declared list with exact hosts (`["localhost:5173"]` for local development), as v7's `DECO_ALLOWED_PREVIEW_HOSTS` did; `previewHosts: "none"` turns previews off on every host. The same link can carry a published release's commit SHA instead of a draft (Studio's "Preview this version"), and either one can carry a preview time (`__at`) and tests and campaigns switched on or off (`__test`, `__campaign`), which `cms.readVersion` reads as the client's `date`, `experiments` and `campaigns`; all of it passes the same host check, so a visitor on the live site never picks a version. The worker passes the accepted version, alone, to the app in the `x-deco-version` request header (`requestVersion(request)` reads it in a `routes` handler).

### The visitor, the assignments and the client

The worker decides once per request, at the edge. On every page and server-function request it reads the visitor with `readVisitor` from `@decocms/blocks/experiments` (the `deco_segment` cookie, or a new visitor), then each test and campaign on or off for it: `readAssignments(cms, { visitor, ...version })`, which resolves the saved `experiments` and `campaigns` blocks through `cms.client({ visitor, version, date, experiments, campaigns })` with the Studio link's version, moment and switched tests and campaigns. It hands the visitor to the app on `x-deco-visitor` and the decisions on `x-deco-assignments`, removing any copy sent from outside, and the decisions to the site's `pageCache` as `page.assignments`, for its key. It sends the visitor's cookie on a first visit only (a visitor with no id yet), never from a preview.

`contentClient(cms)` from `@decocms/tanstack/server` builds `cms.client({ version, experiments, campaigns })` from the headers, every test and campaign as the worker decided it, so the page renders exactly what the cache keyed on and decides nothing again; `requestVersion()`, `requestVisitor()` and `requestAssignments()` return them for a site's own code. A request that didn't come through the worker has no decisions: its visitor decides, and without one every test is off.

### The page cache

`pageCache(page)` is the site's own cache around the app. The worker calls it for every page and server-function request `isCacheable` accepts (a `GET` of the current release, outside `vite dev`, without `Authorization`, not `/_build`: never a preview, a draft or an old release), with `page.request` (as the app gets it), `page.url`, `page.visitor` (the visitor the page renders for, a first visit's new one included), `page.assignments` (each test and campaign on or off, as the page renders them), `page.device`, `env`, `ctx` and `page.render(scope?)`, which renders the page. Answer from your cache, or call `render()`; set `X-Cache` on the answer for the request metric.

The visitor's first-visit cookie is never in what `render()` returns: the worker adds it to whatever `pageCache` answers, a cached copy included. So a stored copy never carries a visitor's cookie, and a new visitor served from the cache still gets theirs. Never store a response that sets any other cookie.

What the key needs, from `@decocms/tanstack/worker`, the same names as `@decocms/nextjs/proxy`'s where both have them:

- `assignmentsKey(page.assignments)`: the tests on and the campaigns running, as one string (`x=<tests>|c=<campaigns>`, `""` for none), never the visitor's id. Visitors on the same side of every test share one entry, the other side gets its own, and a campaign starting or ending moves every page to new entries. `liveAssignmentKeys(cms)` lists every key a live request can carry now (each subset of the saved tests, with the running campaigns and with none), for a purge.
- `cacheVersion(cms, buildHash)`: `<build>.<content revision>`, so a deploy or a published release gets new entries at once.
- `detectDevice(userAgent)` (v7's classes: `mobile`, `tablet`, `desktop`), `segmentKey(segment)` (a segment's parts as one stable string) and `segmentToken(segment, version)`: the `__cseg` token. Pass it as `render({ csegToken })` and `DecoDocument` publishes it; `decoServerFnFetch` sends it back on the page's navigation data (`CSEG_PARAM`), and your cache may let the CDN keep that response when the token matches the request's own.
- `isCacheable(request, { version, dev })`, `requestVersion(request)`, `isServerFnPath(pathname)`, `serverFnPagePath(url)` (the page a server-function page load asks for, from its payload) and `DEGRADED_HEADER` (a page whose loader failed: never store it).

The recipe below, copied as is, is v7's edge cache on the Cloudflare Cache API: the key is the path (tracking parameters and `__cseg` dropped), the device and your segment's own parts, the assignments and the version; v7's cache profiles per URL, with stale-while-revalidate and stale-if-error; signed-in shoppers (`loggedIn: true` from `buildSegment`), private and degraded responses never stored; and v7's purge request, `POST /_cache/purge` with `Authorization: Bearer <PURGE_TOKEN>` (compared in constant time) and `{ "paths": ["/", "/shoes"] }`. A purge drops each exact path (`/shoes` never drops `/shoes?page=2`) under the current version, for each segment (the devices, or the body's `"segments": [{ "device": "desktop", "salesChannel": "2" }]`, your own parts), each assignments key, as a navigation and a programmatic fetch; its answer is v7's, `{ "purged": ["/shoes (device=desktop)"], "total": 1 }`, a 401 for a wrong token, a 400 for a body without paths, and a 503 with `notPurged` when the Cache API stops answering (a Worker request may make 50 Cache API calls on Workers Free and 1,000 on Paid; send those paths again in smaller requests). The Cache API is per data center, so a purge reaches the copies of the data center that serves it. `examples/tanstack-worker-smoke` runs this file as its worker entry, with its tests. `__BUILD_HASH__` is the build id `decoTanstack()` defines (declare it once: `declare const __BUILD_HASH__: string;`), and `PURGE_TOKEN` a Worker secret.

```ts
/**
 * The Worker (wrangler.jsonc "main"): TanStack Start behind `createDecoWorker`
 * (drafts, Studio framing, CMS redirects, the visitor), with this site's own
 * page cache in front of the app: the Cloudflare Cache API, keyed by path,
 * device, the site's segment parts, the request's assignments and
 * `<build>.<content revision>`; v7's cache profiles; and v7's purge route,
 * `POST /_cache/purge`. The cache is this file's: change what it keys on,
 * how long it keeps a page, or drop it.
 */
import {
  assignmentsKey,
  CSEG_PARAM,
  cacheVersion,
  createDecoWorker,
  DEGRADED_HEADER,
  detectDevice,
  type ExecutionContextLike,
  isServerFnPath,
  liveAssignmentKeys,
  type PageRequest,
  type Segment,
  segmentKey,
  segmentToken,
  serverFnPagePath,
} from "@decocms/tanstack/worker";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { cms } from "./cms";

interface Env {
  /** The purge route's token (a Worker secret: `wrangler secret put PURGE_TOKEN`). */
  PURGE_TOKEN?: string;
}

// ---------------------------------------------------------------------------
// What splits the cache besides the path, the assignments and the version.
// ---------------------------------------------------------------------------

/**
 * The site's segment (v7's `buildSegment`): the device and the site's own
 * parts (a region, a sales channel), each in the key. `loggedIn: true` is a
 * signed-in shopper: never served from or stored in the cache.
 */
type SiteSegment = { device: string; loggedIn?: boolean } & Record<
  string,
  string | boolean | undefined
>;

const buildSegment: (request: Request) => SiteSegment = (request) => ({
  device: detectDevice(request.headers.get("user-agent") ?? ""),
});

/** The segment as key parts, or `"private"` for a request that never shares a cached page. */
function segmentOf(request: Request): Segment | "private" {
  const { loggedIn, ...parts } = buildSegment(request);
  if (loggedIn === true) return "private";
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parts)) {
    if (value !== undefined && value !== "" && value !== false) out[name] = String(value);
  }
  return out;
}

/** The segments a purge drops when its body names none: each device. */
const DEVICES: readonly Segment[] = [
  { device: "mobile" },
  { device: "tablet" },
  { device: "desktop" },
];

// ---------------------------------------------------------------------------
// Cache profiles: how long a page is kept, picked per URL (v7's values).
// ---------------------------------------------------------------------------

/** Seconds: `fresh` = served as is; `swr` = served stale while revalidating; `sie` = served stale when the app fails. */
interface CacheWindow {
  fresh: number;
  swr: number;
  sie: number;
}
interface CacheProfile {
  edge: CacheWindow;
  browser: CacheWindow;
  isPublic: boolean;
}
type ProfileName = "static" | "product" | "listing" | "search" | "private" | "none";

const NEVER: CacheWindow = { fresh: 0, swr: 0, sie: 0 };
const NO_CACHE: CacheProfile = { edge: NEVER, browser: NEVER, isPublic: false };
const PROFILES: Record<ProfileName, CacheProfile> = {
  static: {
    edge: { fresh: 900, swr: 7200, sie: 21600 },
    browser: { fresh: 120, swr: 1800, sie: 7200 },
    isPublic: true,
  },
  product: {
    edge: { fresh: 300, swr: 1800, sie: 7200 },
    browser: { fresh: 60, swr: 600, sie: 3600 },
    isPublic: true,
  },
  listing: {
    edge: { fresh: 120, swr: 900, sie: 3600 },
    browser: { fresh: 30, swr: 300, sie: 1800 },
    isPublic: true,
  },
  search: {
    edge: { fresh: 60, swr: 300, sie: 1800 },
    browser: { fresh: 0, swr: 120, sie: 600 },
    isPublic: true,
  },
  private: NO_CACHE,
  none: NO_CACHE,
};

const PRIVATE_NO_CACHE = "private, no-cache, no-store, must-revalidate";
const PRIVATE_PREFIX_RE = /^\/(cart|checkout|account|login|my-account)(\/|$)/;

/** A page URL's profile: the first rule that matches wins. */
function pageProfile(url: URL): ProfileName {
  const p = url.pathname;
  if (PRIVATE_PREFIX_RE.test(p)) return "private";
  if (p.startsWith("/api/") || p.startsWith("/deco/")) return "none";
  if (p === "/sitemap.xml" || p === "/") return "static";
  if (p === "/s" || p.startsWith("/s/") || url.searchParams.has("q")) return "search";
  if (p.endsWith("/p")) return "product";
  return "listing";
}

/** A request's profile: a GET server function takes its page's, any other one is private. */
function profileOf(url: URL): ProfileName {
  if (!isServerFnPath(url.pathname)) return pageProfile(url);
  const page = serverFnPagePath(url);
  return page ? pageProfile(new URL(page, url.origin)) : "private";
}

/** The browser's `Cache-Control` for a profile. */
function browserCacheControl(profile: CacheProfile): string {
  if (!profile.isPublic || (profile.edge.fresh === 0 && profile.browser.fresh === 0)) {
    return PRIVATE_NO_CACHE;
  }
  const { browser, edge } = profile;
  const parts = ["public", `max-age=${browser.fresh}`];
  if (edge.fresh > 0) parts.push(`s-maxage=${edge.fresh}`);
  if (browser.swr > 0) parts.push(`stale-while-revalidate=${browser.swr}`);
  if (browser.sie > 0) parts.push(`stale-if-error=${browser.sie}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// The key: the same function for the lookup and the purge, so they match byte for byte.
// ---------------------------------------------------------------------------

/** Query parameters that never change a page, left out of the key (v7's list). */
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

/** Variant params a page load ignores, left out of a server function's key. */
const SERVER_FN_IGNORED_PARAMS = ["skuId", "idsku"];

/** A server function's payload for the key: page paths without the variant params. */
function canonicalPayload(payload: string): string {
  const strip = (s: string): string => {
    const q = s.indexOf("?");
    if (!s.startsWith("/") || s.startsWith("//") || q < 0) return s;
    const params = new URLSearchParams(s.slice(q + 1));
    for (const name of SERVER_FN_IGNORED_PARAMS) params.delete(name);
    const rest = params.toString();
    return rest ? `${s.slice(0, q)}?${rest}` : s.slice(0, q);
  };
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") return strip(v);
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
    }
    return v;
  };
  try {
    return JSON.stringify(visit(JSON.parse(payload)));
  } catch {
    return payload;
  }
}

interface KeyParts {
  /** `<build>.<content revision>` (`cacheVersion`). */
  version: string;
  segment: Segment;
  /** `assignmentsKey`: the tests the visitor is in and the campaigns running, never the visitor. */
  assigned: string;
  /** A programmatic fetch (`Sec-Fetch-Dest: empty`) of a page: its own entry, as in v7. */
  fetch: boolean;
}

function cacheKey(url: URL, parts: KeyParts): Request {
  const key = new URL(url);
  key.hash = "";
  for (const name of [...key.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(name.toLowerCase())) key.searchParams.delete(name);
  }
  key.searchParams.delete(CSEG_PARAM);
  const serverFn = isServerFnPath(key.pathname);
  const payload = key.searchParams.get("payload");
  if (serverFn && payload) key.searchParams.set("payload", canonicalPayload(payload));
  if (parts.version) key.searchParams.set("__v", parts.version);
  if (!serverFn && parts.fetch) key.searchParams.set("__fetch", "1");
  key.searchParams.set("__seg", segmentKey(parts.segment));
  if (parts.assigned) key.searchParams.set("__a", parts.assigned);
  return new Request(key.toString(), { method: "GET" });
}

// ---------------------------------------------------------------------------
// The page cache: createDecoWorker calls it for every page and server-function
// GET of the current release (never a preview, never in `vite dev`), and adds
// the visitor's first-visit cookie to whatever it answers, so a stored copy
// never carries one.
// ---------------------------------------------------------------------------

/** Cookies a cached page may set: stripped from the stored copy, the visitor still gets them. */
const SAFE_COOKIES = new Set(["_deco_bucket"]);
const STORED_AT = "X-Deco-Stored-At";

const cookieName = (setCookie: string) =>
  setCookie.slice(0, Math.max(0, setCookie.indexOf("="))).trim();

function edgeCache(): Cache | null {
  return typeof caches !== "undefined"
    ? ((caches as unknown as { default?: Cache }).default ?? null)
    : null;
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}

async function pageCache(page: PageRequest<Env>): Promise<Response> {
  const { request, url, ctx } = page;
  const profileName = profileOf(url);
  const profile = PROFILES[profileName];
  const segment = segmentOf(request);
  if (segment === "private" || !profile.isPublic || profile.edge.fresh === 0) {
    return withHeaders(await page.render(), {
      "Cache-Control": PRIVATE_NO_CACHE,
      "X-Cache": "BYPASS",
      "X-Cache-Reason": segment === "private" ? "private" : `profile:${profileName}`,
    });
  }

  const version = await cacheVersion(cms, __BUILD_HASH__);
  // What the worker decided and the page renders: two visitors on the same side of every test share an entry.
  const assigned = assignmentsKey(page.assignments);
  const key = cacheKey(url, {
    version,
    segment,
    assigned,
    fetch: request.headers.get("sec-fetch-dest") === "empty",
  });
  // The token the document publishes: its navigation data may be kept by the CDN under it.
  const token = segmentToken(segment, assigned ? `${version}|${assigned}` : version);
  const render = () => page.render({ csegToken: token ?? undefined });
  const cdnPublic =
    token !== null && isServerFnPath(url.pathname) && url.searchParams.get(CSEG_PARAM) === token;
  const { edge } = profile;
  const cache = edgeCache();

  const dress = (response: Response, decision: string, extra: Record<string, string> = {}) => {
    const out = withHeaders(response, {
      "Cache-Control": browserCacheControl(profile),
      Vary: "Accept-Encoding",
      "CDN-Cache-Control": cdnPublic ? `public, max-age=${edge.fresh}` : "no-store",
      "X-Cache": decision,
      "X-Cache-Profile": profileName,
      "X-Cache-Segment": segmentKey(segment),
      ...(version ? { "X-Cache-Version": version } : {}),
      ...extra,
    });
    // The Cache API adds its own status to a matched copy.
    out.headers.delete("cf-cache-status");
    out.headers.delete(STORED_AT);
    return out;
  };
  const isPrivate = (r: Response) =>
    /\b(private|no-store)\b/i.test(r.headers.get("cache-control") ?? "") ||
    r.headers.getSetCookie().some((c) => !SAFE_COOKIES.has(cookieName(c)));
  const isDegraded = (r: Response) => r.headers.get(DEGRADED_HEADER) === "true";
  const store = (response: Response) => {
    if (!cache) return;
    const copy = new Response(response.clone().body, response);
    copy.headers.delete("set-cookie");
    for (const c of response.headers.getSetCookie()) {
      if (!SAFE_COOKIES.has(cookieName(c))) copy.headers.append("set-cookie", c);
    }
    copy.headers.set(
      "Cache-Control",
      `public, max-age=${edge.fresh + Math.max(edge.swr, edge.sie)}`,
    );
    copy.headers.set(STORED_AT, String(Date.now()));
    copy.headers.delete("CDN-Cache-Control");
    ctx.waitUntil(cache.put(key, copy).catch(() => {}));
  };
  const ageOf = (r: Response) => {
    const storedAt = Number(r.headers.get(STORED_AT) || "0");
    return storedAt > 0 ? (Date.now() - storedAt) / 1000 : Number.POSITIVE_INFINITY;
  };

  const cached = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (cached) {
    const age = ageOf(cached);
    if (age < edge.fresh) return dress(cached, "HIT");
    if (age < edge.fresh + edge.swr) {
      ctx.waitUntil(
        render()
          .then((fresh) => {
            if (fresh.status === 200 && !isDegraded(fresh) && !isPrivate(fresh)) store(fresh);
          })
          .catch(() => {}),
      );
      return dress(cached, "STALE-HIT", { "X-Cache-Age": String(Math.round(age)) });
    }
  }
  const staleOnError = (reason: string): Response | null => {
    if (!cached || ageOf(cached) >= edge.fresh + edge.sie) return null;
    return dress(cached, "STALE-ERROR", {
      "X-Cache-Age": String(Math.round(ageOf(cached))),
      "X-Cache-Reason": reason,
    });
  };

  let response: Response;
  try {
    response = await render();
  } catch (error) {
    const stale = staleOnError("origin-error");
    if (stale) return stale;
    throw error;
  }
  if (response.status !== 200) {
    const failed = response.status >= 500 || response.status === 429;
    const stale = failed ? staleOnError(`origin-status:${response.status}`) : null;
    return (
      stale ??
      withHeaders(response, { "X-Cache": "BYPASS", "X-Cache-Reason": `status:${response.status}` })
    );
  }
  if (isDegraded(response) || isPrivate(response)) {
    const stale = isDegraded(response) ? staleOnError("degraded") : null;
    return (
      stale ??
      withHeaders(response, {
        "Cache-Control": PRIVATE_NO_CACHE,
        "X-Cache": "BYPASS",
        "X-Cache-Reason": isDegraded(response) ? "degraded" : "private-response",
      })
    );
  }
  store(response);
  return dress(response, "MISS");
}

// ---------------------------------------------------------------------------
// Purge: v7's request, POST /_cache/purge with `Authorization: Bearer <PURGE_TOKEN>`
// and { "paths": ["/", "/shoes"], "segments"?: [{ "device": "desktop", ... }] }.
// ---------------------------------------------------------------------------

const PURGE_PATH = "/_cache/purge";

/** Constant-time compare (the token's length isn't secret). */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Drops each exact path (`/shoes` never drops `/shoes?page=2`) under the
 * current version, for every segment (the body's own, else each device),
 * every assignments key a visitor can carry now (each subset of the saved
 * tests, with the running campaigns and with none), as a navigation and a
 * programmatic fetch. Navigation data expires with its profile, as in v7.
 */
async function purge(request: Request, env: Env): Promise<Response> {
  const token = env.PURGE_TOKEN;
  if (!token || !sameString(request.headers.get("Authorization") ?? "", `Bearer ${token}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  let body: { paths?: unknown; segments?: unknown };
  try {
    const parsed: unknown = await request.json();
    body = parsed && typeof parsed === "object" ? parsed : {};
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
  const segments = new Map<string, Segment>();
  for (const s of Array.isArray(body.segments) ? body.segments : DEVICES) {
    if (!s || typeof s !== "object") continue;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(s)) if (typeof v === "string" && v) clean[k] = v;
    segments.set(segmentKey(clean), clean);
  }
  const cache = edgeCache();
  if (!cache) return Response.json({ purged: [], total: 0, note: "Cache storage unavailable" });
  const origin = new URL(request.url).origin;
  const version = await cacheVersion(cms, __BUILD_HASH__);
  const assignments = await liveAssignmentKeys(cms);
  const purged: string[] = [];
  for (const [i, path] of paths.entries()) {
    const url = new URL(path, origin);
    for (const segment of segments.values()) {
      for (const assigned of assignments) {
        for (const fetch of [false, true]) {
          let gone: boolean;
          try {
            gone = await cache.delete(cacheKey(url, { version, segment, assigned, fetch }));
          } catch {
            // The Cache API is down, or the request's calls are spent (50 on Workers Free, 1,000 on Paid).
            return Response.json(
              {
                purged,
                notPurged: paths.slice(i),
                total: purged.length,
                note: "The Cache API stopped answering: send the notPurged paths again",
              },
              { status: 503 },
            );
          }
          if (gone) {
            const tags = [segmentKey(segment), assigned, fetch ? "fetch" : ""].filter(Boolean);
            purged.push(`${path} (${tags.join(", ")})`);
          }
        }
      }
    }
  }
  return Response.json({ purged, total: purged.length });
}

// ---------------------------------------------------------------------------
// The Worker.
// ---------------------------------------------------------------------------

const worker = createDecoWorker<Env>({
  serverEntry: createServerEntry({ fetch: handler.fetch }),
  cms,
  site: "tanstack-worker-smoke",
  dev: import.meta.env.DEV,
  pageCache,
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    if (request.method === "POST" && new URL(request.url).pathname === PURGE_PATH) {
      return purge(request, env);
    }
    return worker.fetch(request, env, ctx);
  },
};
```

### Names and Studio's origins

The root export holds what the worker, `/server` and `DecoDocument` share, for a site's own code: the draft names (`DRAFT_PARAM` `__draft`, `DRAFT_COOKIE` `__deco_draft`), the headers the worker hands the app (`VERSION_HEADER` `x-deco-version`, `VISITOR_HEADER` `x-deco-visitor`, `ASSIGNMENTS_HEADER` `x-deco-assignments`), `draftResponseHeaders(version)` (`no-store, private`, `Vary: Cookie`, `noindex`), and Studio's origins: `STUDIO_ORIGINS`, `STUDIO_FRAME_ANCESTORS` (what the worker's `frame-ancestors` starts from) and `isStudioOrigin`. `DecoDocument` passes `STUDIO_ORIGINS` to the Studio bridge.

```ts
import { STUDIO_ORIGINS, VERSION_HEADER } from "@decocms/tanstack";
```

## The app

```ts
// vite.config.ts
plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), react(),
  decoTanstack({ buildHash: process.env.WORKERS_CI_COMMIT_SHA })]

// src/router.tsx
export const getRouter = () => createDecoRouter({ routeTree });

// src/start.ts
export const startInstance = createStart(() => ({ serverFns: { fetch: decoServerFnFetch } }));

// src/routes/__root.tsx
export const Route = createRootRoute({ component: () => <DecoDocument site="my-store" /> });
```

`DecoDocument` mounts Studio's bridge and the draft badge. A page route returns `pathTemplate` (the page block's `path`, as `matchRoute` matched it) in its loader data, so "." on the store page opens that page in Studio's editor. A site that keeps its own document (a skip link before `<main>`, say) renders `<DecoPreview site="my-store" />` in its `<body>` instead: the bridge, the badge and the draft they read.

## Images

```tsx
// src/imageUrl.ts: the site's image URLs (@decocms/blocks/image plus its platform's helpers)
import { createImageUrl, decoCdn } from "@decocms/blocks/image";
import { vtexCatalog } from "@decocms/apps-vtex/image"; // a VTEX store
import { shopifyCdn } from "@decocms/apps-shopify/image"; // a Shopify store
export const imageUrl = createImageUrl({
  providers: [vtexCatalog(), shopifyCdn(), decoCdn({ quality: "high", sources: "all" })],
});

// src/router.tsx: around every page
createDecoRouter({ routeTree, Wrap: ({ children }) => <ImageUrlProvider value={imageUrl}>{children}</ImageUrlProvider> });

// any component
<Image src={src} width={400} height={300} preload={isLcp} />
```

`Image`, `Picture` and `Source` from `/react` take v7's props and render v7's markup, so a migrated call site only changes its import. This package knows no commerce platform: v7's components resized VTEX catalog and Shopify images on those platforms' hosts, and a site keeps those URLs by listing the platform's helper before `decoCdn` as above (v7's URLs, byte for byte, with the `decoCdn` options of the 7.x release the site ran, e.g. `stripAssetHosts: "leading"` from 7.71.4: the v7 to v8 migration skill lists them). An `Image` or `Source` without a width writes v7's `width=NaN` candidates, as v7 did. Without an `ImageUrlProvider` every source goes through `assets.decocms.com` (`DECO_IMAGE_URL`).

`examples/tanstack-worker-smoke` in the repository is a complete app.
