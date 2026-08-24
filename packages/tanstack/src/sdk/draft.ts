/**
 * Draft preview — the TanStack Start / Cloudflare Workers binding.
 *
 * `@decocms/blocks`'s `draftSource` owns the framework-agnostic half (token
 * parsing, origin validation, fetch, version cache, the host allowlist). This
 * file binds a resolved draft to the current request and drives the cookie +
 * cache/indexing headers.
 *
 * ## Why this is simpler than the Next.js binding
 *
 * The Next binding (`@decocms/nextjs`'s `draft.ts`/`draftMiddleware.ts`) fights
 * two App Router constraints that do NOT exist here:
 *
 *  1. **Request scope.** App Router never enters an AsyncLocalStorage request
 *     scope, so Next backs the per-request draft slot with React `cache()` and
 *     has to await `ensureDraft` from the *page* (a layout's await does not gate
 *     its children). TanStack already wraps every request in
 *     `RequestContext.run(request, …)` (see `workerEntry.ts`), so the draft just
 *     rides the request bag — `loadBlocks()` reads it back through the
 *     dependency-injected getter registered by {@link registerDraftOverride}.
 *
 *  2. **Static-vs-dynamic rewrite.** `dynamic`/`revalidate` are static route
 *     exports in App Router, so Next rewrites drafted requests onto an
 *     encoded `app/%5Fdraft/…` route to escape ISR. The worker decides
 *     cacheability per request, so a drafted request simply bypasses the edge
 *     cache (see `requestCarriesDraft`) — no rewrite dance.
 *
 * Like Next, the whole feature is inert unless the site opts in: an allowlist
 * (the site block's `previewHosts`, or the `DECO_ALLOWED_PREVIEW_HOSTS`
 * override) must name the request's host. Upgrading the package can never be
 * enough to start rendering unpublished content.
 */

import {
  DRAFT_COOKIE_NAME,
  DRAFT_QUERY_PARAM,
  isDraftHostAllowed,
  isDraftPreviewEnabled,
  resolveDraftForRequest,
  setDecoSiteHost,
  setDraftOverrideGetter,
  setDraftPreviewHosts,
} from "@decocms/blocks/cms";
import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { DRAFT_POINTER_BAG_KEY } from "./draftShared";

/** RequestContext bag key the resolved draft decofile is stashed under. */
const DRAFT_BAG_KEY = "deco:draftBlocks";

/**
 * Cookie lifetime. Short on purpose: a preview session is minutes, and a stale
 * pointer would keep pinning an old content version. Matches the Next binding.
 */
const DRAFT_COOKIE_MAX_AGE = 60 * 30;

// ---------------------------------------------------------------------------
// Runtime binding (dependency injection into @decocms/blocks)
// ---------------------------------------------------------------------------

let registered = false;

/**
 * Register the request-scoped draft getter with the runtime, once.
 *
 * `loadBlocks()` consults `getRequestDraftOverride()` as a fallback after its
 * own `withBlocksOverride` scope; this points that fallback at the
 * RequestContext bag {@link bindRequestDraft} fills. Idempotent and safe to
 * call at setup: outside a request scope `getBag` returns undefined, so
 * `loadBlocks()` behaves exactly as before.
 */
export function registerDraftOverride(): void {
  if (registered) return;
  registered = true;
  setDraftOverrideGetter(
    () => RequestContext.getBag<Record<string, unknown>>(DRAFT_BAG_KEY) ?? null,
  );
}

/**
 * Install the site block's `previewHosts` as the draft-preview allowlist.
 *
 * Reads the BASE blocks (the `setBlocks()` argument / `loadBlocks()` at setup
 * time), never the request-time merged blocks: an allowlist readable through
 * the draft override could be rewritten by the very draft it gates.
 * `DECO_ALLOWED_PREVIEW_HOSTS` remains an operational override that replaces
 * this list when set. Handles both decofile shapes (`site` / `Site`), same as
 * `withSiteGlobals`.
 */
export function installPreviewHostsFromBlocks(blocks: Record<string, unknown> | undefined): void {
  const site = (blocks?.site ?? blocks?.Site) as { previewHosts?: unknown } | undefined;
  if (Array.isArray(site?.previewHosts)) setDraftPreviewHosts(site.previewHosts);
}

/**
 * Register the deco-operated preview domains inferred from the site name —
 * `<site>.deco.site` (exact host) and `envs-<site>--<hash>.decocdn.com` (the
 * per-deploy preview URL, matched as a pattern) — so a signed `?__draft=`
 * grant previews on deco-hosted infra with zero per-site config.
 *
 * Fed from the Workers env binding `DECO_SITE_NAME`: deploy-time configuration
 * set by deco's hosting, trusted the same way `DECO_ALLOWED_PREVIEW_HOSTS` is —
 * never derived from the request. Merged ON TOP of the site block/env list
 * (see `setDecoSiteHost` in `@decocms/blocks`); an unset binding registers
 * nothing, and `DECO_ALLOWED_PREVIEW_HOSTS=none` kills the inferred hosts too.
 *
 * This inference is deliberately tanstack-only (like Fast Deploy): the
 * deco-operated domains only ever serve Workers deployments, and in the Next
 * binding flipping `isDraftPreviewEnabled()` on costs every page its
 * static/ISR rendering — Next sites keep the explicit opt-in.
 */
export function installDecoSiteHostFromEnv(env: Record<string, unknown>): void {
  const site = env.DECO_SITE_NAME;
  setDecoSiteHost(typeof site === "string" ? site : undefined);
}

// ---------------------------------------------------------------------------
// Per-request resolution + response decoration
// ---------------------------------------------------------------------------

/**
 * Read one cookie value out of a raw `Cookie:` header.
 *
 * Decodes the value — the cookie is written with `encodeURIComponent` (see
 * `draftCookie`), and `@decocms/blocks`'s own cookie reader decodes too, so a
 * cookie-carried pointer must round-trip identically or the badge's share link
 * would double-encode it. Decode defensively: a malformed `%` sequence
 * (a crafted cookie) falls back to the raw value rather than throwing and
 * 500-ing the request.
 */
function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/**
 * Whether a request is in draft mode — carries a live `?__draft=` param or the
 * navigation cookie — on a host allowed to preview.
 *
 * A pure, synchronous, network-free check (no fetch, no resolve): the worker
 * uses it to keep drafted requests out of the shared edge cache *before* doing
 * any work. Gated on `isDraftPreviewEnabled()` first, so a build without the
 * allowlist configured is completely unaffected — a stray `?__draft=` on a
 * production domain neither renders a draft nor even bypasses the cache.
 */
export function requestCarriesDraft(request: Request, url: URL): boolean {
  if (!isDraftPreviewEnabled()) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!isDraftHostAllowed(host)) return false;
  const param = url.searchParams.get(DRAFT_QUERY_PARAM);
  if (param === "off") return false;
  if (param) return true;
  return readCookie(request.headers.get("cookie"), DRAFT_COOKIE_NAME) !== null;
}

/** The cookie/header actions a drafted request implies for its response. */
export interface DraftDecision {
  /**
   * The request is previewing (a pointer is present on an allowed host), so its
   * response must never be cached under the shared (cookie-only) URL — even if
   * the draft failed to resolve and the page fell back to published content.
   */
  previewing: boolean;
  /** Persist this pointer in the navigation cookie (set only on `?__draft=` entry). */
  setCookie: string | null;
  /** Clear the navigation cookie (`?__draft=off`). */
  clearCookie: boolean;
}

const INERT: DraftDecision = { previewing: false, setCookie: null, clearCookie: false };

/**
 * Resolve this request's draft, if any, and bind it to the RequestContext so
 * every `loadBlocks()` in the render sees the merged decofile.
 *
 * Call inside `RequestContext.run`, before the page render. Returns the
 * cookie/header decision for the worker to apply to the final response. A
 * missing allowlist, disallowed host, or `?__draft=off` all short-circuit
 * without touching the network; a resolve failure degrades to published but
 * still reports `previewing: true` so the response stays uncacheable.
 */
export async function bindRequestDraft(
  request: Request,
  fetchImpl?: typeof fetch,
): Promise<DraftDecision> {
  if (!isDraftPreviewEnabled()) return INERT;

  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  // Authoritative host gate — unlike Next, there is no separate middleware
  // module graph, so this single check bounds the whole feature.
  if (!isDraftHostAllowed(host)) return INERT;

  const param = url.searchParams.get(DRAFT_QUERY_PARAM);
  if (param === "off") return { previewing: false, setCookie: null, clearCookie: true };

  const cookie = readCookie(request.headers.get("cookie"), DRAFT_COOKIE_NAME);
  const pointer = param ?? cookie ?? null;
  if (!pointer) return INERT;

  const blocks = await resolveDraftForRequest(request, { fetchImpl });
  if (blocks) {
    RequestContext.setBag(DRAFT_BAG_KEY, blocks);
    // Expose the pointer to the SSR React tree so the preview badge can render
    // and build its share/exit links. Only when the draft actually bound —
    // the badge means "you're looking at draft content", matching Next.
    RequestContext.setBag(DRAFT_POINTER_BAG_KEY, pointer);
  }

  // Persist only on entry (`?__draft=`); in-preview navigation rides the cookie
  // already present.
  return { previewing: true, setCookie: param ?? null, clearCookie: false };
}

/** Build the `Set-Cookie` value for the draft navigation cookie. */
function draftCookie(value: string, maxAge: number): string {
  // SameSite=None; Secure is mandatory for the cross-site preview iframe, and
  // Partitioned (CHIPS) keeps it working as browsers wind down unpartitioned
  // third-party cookies. HttpOnly: the pointer is read server-side only.
  return `${DRAFT_COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None; Partitioned`;
}

/** Set a header defensively — some replayed responses seal their headers. */
function trySet(response: Response, key: string, value: string): void {
  try {
    response.headers.set(key, value);
  } catch {
    /* sealed headers (cached replay) — best-effort */
  }
}

/**
 * Apply the cookie lifecycle and the cache/indexing headers a draft response
 * requires.
 *
 * The caching headers are the difference between a preview and a leak: with the
 * pointer in a cookie, a drafted response and a published one share an
 * identical URL, so `no-store` is what stops a CDN keyed on URL alone from
 * serving unpublished content to a real visitor. `Vary: Cookie` keeps any
 * intermediary that does respect it from mixing the two; `X-Robots-Tag` keeps a
 * leaked draft out of search results.
 */
export function applyDraftCookieAndHeaders(response: Response, decision: DraftDecision): void {
  if (decision.clearCookie) {
    response.headers.append("set-cookie", draftCookie("", 0));
  } else if (decision.setCookie) {
    response.headers.append(
      "set-cookie",
      draftCookie(encodeURIComponent(decision.setCookie), DRAFT_COOKIE_MAX_AGE),
    );
  }

  if (decision.previewing) {
    trySet(response, "cache-control", "no-store, private");
    // Add Cookie to Vary without dropping tokens already there (e.g.
    // Accept-Encoding). Moot under no-store, but correct for any intermediary
    // that honours Vary anyway.
    const existingVary = response.headers.get("vary");
    if (!existingVary) {
      trySet(response, "vary", "Cookie");
    } else if (!/\bcookie\b/i.test(existingVary)) {
      trySet(response, "vary", `${existingVary}, Cookie`);
    }
    trySet(response, "x-robots-tag", "noindex, nofollow");
  }
}
