/**
 * Site Globals Wrapper
 *
 * Opt-in helper that merges sections declared in the CMS `Site` block
 * (`site.theme + site.global + site.pageSections`) into every page's
 * `resolvedSections` array.
 *
 * Without this wrapper, only `site.seo` is consumed by `cmsRouteConfig` —
 * the rest of the Site block is dormant CMS data. Sites that declare
 * theme/analytics/wishlist/help-button blocks at the site level (rather
 * than per-page) can opt in here to have them rendered automatically.
 *
 * @example Site's `src/routes/$.tsx`:
 * ```ts
 * import { createFileRoute, notFound } from "@tanstack/react-router";
 * import { cmsRouteConfig, withSiteGlobals } from "@decocms/start/routes";
 *
 * export const Route = createFileRoute("/$")({
 *   ...withSiteGlobals(cmsRouteConfig({
 *     siteName: "Bagaggio",
 *     defaultTitle: "Bagaggio",
 *   })),
 *   component: ...,
 * });
 * ```
 */

import type { MatcherContext, ResolvedSection } from "@decocms/blocks/cms";
import { loadBlocks, onChange, resolvePageSections } from "@decocms/blocks/cms";
import { SEGMENT_COOKIE } from "@decocms/blocks/sdk/flags";
import { isTrackingParam } from "@decocms/blocks/sdk/urlUtils";
import { detectDevice } from "@decocms/blocks/sdk/useDevice";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A raw site-block ref — the JSON object pulled from a `.deco/blocks/*.json`
 * file before block resolution. Always an object with at least
 * `__resolveType`; concrete props vary by block.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SiteGlobalRef = Record<string, any>;

/** Loader output additions when site globals are merged into the page. */
export interface SiteGlobalsLoaderData {
  /**
   * Raw refs (before resolution) declared in `site.theme`, `site.global`, and
   * `site.pageSections`. Includes refs for sections that don't resolve into
   * the section tree (`SKIP_RESOLVE_TYPES`) — useful for sites that need to
   * read site-level data (analytics IDs, manifest config, etc.) outside the
   * normal section render path.
   *
   * Ordering: `theme`, then `global`, then `pageSections`.
   */
  rawRefs: SiteGlobalRef[];
}

interface SiteBlock {
  theme?: SiteGlobalRef;
  global?: SiteGlobalRef[];
  pageSections?: SiteGlobalRef[];
}

interface CacheEntry {
  resolvedSections: ResolvedSection[];
  rawRefs: SiteGlobalRef[];
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Globals resolution (cached, with onChange invalidation)
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const cacheTtlMs = DEFAULT_CACHE_TTL_MS;

/**
 * Cap on distinct cache keys held per isolate. Globals now vary by URL, so an
 * unbounded map would grow with the site's URL space (and with any attacker's
 * junk query strings). LRU-evict the oldest key past this.
 */
const CACHE_MAX_ENTRIES = 64;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

/** `undefined` = not looked up yet, `null` = this site declares no globals. */
let refsMemo: SiteGlobalRef[] | null | undefined;

onChange(() => {
  cache.clear();
  inflight.clear();
  refsMemo = undefined;
});

function urlKeyPart(matcherCtx: MatcherContext): string {
  const path = matcherCtx.path ?? "";
  if (!matcherCtx.url) return path;
  try {
    const params = [...new URL(matcherCtx.url, "http://localhost").searchParams]
      .filter(([key]) => !isTrackingParam(key))
      .sort(([aKey, aVal], [bKey, bVal]) => aKey.localeCompare(bKey) || aVal.localeCompare(bVal));
    if (params.length === 0) return path;
    return `${path}?${params.map(([key, value]) => `${key}=${value}`).join("&")}`;
  } catch {
    return path;
  }
}

/**
 * Cache key for one request's site globals.
 *
 * **The query string must be part of it.** Site globals can hold
 * URL-dependent variants (the multivariate Alerta/topbar section lives in
 * `site.global`), and a path-only key made `/x/p?brand=farm` and
 * `/x/p?brand=farmetc` collide: whichever request warmed a cold path decided
 * the variant for both. Params are sorted so the key is stable, and tracking
 * params are dropped so `utm_*` traffic doesn't fragment the cache into one
 * entry per campaign.
 *
 * Device class and the sticky-flag segment cookie are in the key for the same
 * reason — device and A/B matchers are common in `site.global`, and both are
 * already how the edge splits its own cache.
 *
 * **Known limit:** matchers reading *other* cookies, geo, or wall-clock time
 * are not represented here, so two requests that differ only on one of those
 * share an entry for up to the TTL. Cookie/geo-varying globals need a wider
 * key (or no cache) — this covers the axes the CMS actually exposes on the
 * multivariate section today.
 */
export function siteGlobalsCacheKey(matcherCtx?: MatcherContext): string {
  if (!matcherCtx) return "";
  const device = detectDevice(matcherCtx.userAgent ?? "");
  const segment = matcherCtx.cookies?.[SEGMENT_COOKIE] ?? "";
  return `${urlKeyPart(matcherCtx)}|${device}|${segment}`;
}

function readCache(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // Touch for LRU recency.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function writeCache(key: string, entry: CacheEntry): void {
  cache.delete(key);
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

function readSiteBlock(): SiteBlock | null {
  const blocks = loadBlocks();
  // Block keys vary by site convention — try both common cases.
  const site = (blocks.site ?? blocks.Site) as SiteBlock | undefined;
  return site ?? null;
}

function gatherSectionRefs(site: SiteBlock): SiteGlobalRef[] {
  const refs: SiteGlobalRef[] = [];
  if (site.theme) refs.push(site.theme);
  if (Array.isArray(site.global)) refs.push(...site.global);
  if (Array.isArray(site.pageSections)) refs.push(...site.pageSections);
  return refs;
}

/**
 * The raw refs are the same for every request — only their *resolution* varies
 * by matcher context. Memoizing them separately from the per-key resolution
 * cache keeps the "no Site block / no globals" fast path from consuming a
 * cache slot per URL. Cleared by the same `onChange` invalidation.
 */
function siteGlobalRefs(): SiteGlobalRef[] | null {
  if (refsMemo !== undefined) return refsMemo;
  const site = readSiteBlock();
  const refs = site ? gatherSectionRefs(site) : [];
  refsMemo = refs.length > 0 ? refs : null;
  return refsMemo;
}

const EMPTY_ENTRY: CacheEntry = {
  resolvedSections: [],
  rawRefs: [],
  expiresAt: Number.POSITIVE_INFINITY, // empty entries don't need refresh
};

/**
 * Resolve `site.theme + site.global + site.pageSections` into a list of
 * `ResolvedSection`s, with in-flight dedup and 5-minute SWR caching.
 *
 * Cache is invalidated by `onChange()` from the CMS loader, so admin edits
 * and decofile reloads are reflected on the next request.
 *
 * Pass the request's `matcherCtx` so global sections can carry URL-, date-
 * and cookie-dependent variants — without it every matcher in `site.global`
 * evaluates against an empty context, and multivariate globals (the Alerta /
 * topbar block) silently collapse to their fallback variant. Results are
 * cached per {@link siteGlobalsCacheKey}, i.e. per path **and** query string.
 *
 * Exposed as a util so sites can call it directly if they need globals
 * outside the route loader path (rare).
 */
export async function resolveSiteGlobals(matcherCtx?: MatcherContext): Promise<{
  resolvedSections: ResolvedSection[];
  rawRefs: SiteGlobalRef[];
}> {
  // No Site block, or no globals declared on it — context-independent, so it
  // short-circuits ahead of the per-key cache.
  const rawRefs = siteGlobalRefs();
  if (!rawRefs) return EMPTY_ENTRY;

  const key = siteGlobalsCacheKey(matcherCtx);

  const cached = readCache(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const resolvedSections = await resolvePageSections(rawRefs, matcherCtx);
      const entry: CacheEntry = {
        resolvedSections,
        rawRefs,
        expiresAt: Date.now() + cacheTtlMs,
      };
      writeCache(key, entry);
      return entry;
    } catch (err) {
      console.error("[site-globals] failed to resolve:", err);
      // Don't cache failures — let the next request retry.
      return { resolvedSections: [], rawRefs, expiresAt: 0 };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Dedupe — collapse global/pageSection components that also exist on the page
// ---------------------------------------------------------------------------

/**
 * Filter `globals` to remove sections whose `component` already appears in
 * `existing` (page-level sections). Page sections take precedence — globals
 * that conflict are dropped.
 *
 * This collapses the common case where a section like `Session` is declared
 * both in `site.global` and in a page's section list, which would otherwise
 * render twice.
 */
export function dedupeGlobals(globals: ResolvedSection[], existing: ResolvedSection[]): ResolvedSection[] {
  if (globals.length === 0) return [];
  const seenComponents = new Set<string>();
  for (const s of existing) {
    if (typeof s.component === "string") seenComponents.add(s.component);
  }
  const result: ResolvedSection[] = [];
  for (const s of globals) {
    if (typeof s.component === "string") {
      if (seenComponents.has(s.component)) continue;
      seenComponents.add(s.component); // also dedupe within globals (e.g. Session in both site.global AND site.pageSections)
    }
    result.push(s);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public wrapper API (deprecated — kept for backward compat)
// ---------------------------------------------------------------------------

type AnyLoader = (...args: any[]) => Promise<any>;

/**
 * @deprecated Site globals are now resolved automatically inside the
 * `loadCmsPage` / `loadCmsHomePage` server functions. Wrapping
 * `cmsRouteConfig` is a no-op — the call is kept for backward compat so
 * existing sites don't need to change their `routes/$.tsx` immediately.
 *
 * Previously, this wrapper called `resolveSiteGlobals()` from the route
 * loader, which runs **client-side** on SPA navigations. On SPA, the vite
 * plugin replaces `blocks.gen.ts` with `{}` in the client bundle, so
 * `loadBlocks()` returned a stub and globals silently dropped — see #233.
 *
 * Moving resolution into the server function makes SSR (F5) and SPA
 * navigations both go through the same server-side path.
 */
export function withSiteGlobals<T extends { loader: AnyLoader }>(routeConfig: T): T {
  return routeConfig;
}

// ---------------------------------------------------------------------------
// Test-only resets (not exported in public types — used by withSiteGlobals.test.ts)
// ---------------------------------------------------------------------------

/** @internal */
export function __resetSiteGlobalsCache() {
  cache.clear();
  inflight.clear();
  refsMemo = undefined;
}
