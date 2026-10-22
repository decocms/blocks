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
