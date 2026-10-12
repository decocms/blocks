/**
 * Section Loader Registry
 *
 * Section loaders enrich resolved CMS props with server-side data
 * (e.g., price simulations, device detection) that can't be done
 * at the CMS resolution level.
 *
 * This runs AFTER resolveDecoPage and BEFORE React rendering,
 * inside the TanStack Start server function.
 */

import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { getCacheProfile } from "../sdk/cacheHeaders";
import { cacheBackground, createCacheStore, getCacheStorageContext } from "../sdk/cacheStorage";
import { detectDevice } from "../sdk/detectDevice";
import { withInflightTimeout } from "../sdk/inflightTimeout";
import { withTracing } from "../sdk/observability";
import type { ResolvedSection } from "./resolve";
import { buildSectionLoaderContext, type SectionLoaderContext } from "./sectionLoaderContext";

export type SectionLoaderFn = (
  props: Record<string, unknown>,
  req: Request,
  /**
   * Compat context (issue #305). Optional so 2-arg loaders/mixins remain
   * valid — they simply ignore the extra argument. Framework-supplied at the
   * call site via {@link buildSectionLoaderContext}.
   */
  ctx?: SectionLoaderContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

// globalThis-backed: server function split modules need access
const G = globalThis as any;
if (!G.__deco) G.__deco = {};
if (!G.__deco.sectionLoaderRegistry) G.__deco.sectionLoaderRegistry = new Map();
if (!G.__deco.layoutSections) G.__deco.layoutSections = new Set();
if (!G.__deco.cacheableSections) G.__deco.cacheableSections = new Map();
if (!G.__deco.nonCriticalSections) G.__deco.nonCriticalSections = new Set();

const loaderRegistry: Map<string, SectionLoaderFn> = G.__deco.sectionLoaderRegistry;

// ---------------------------------------------------------------------------
// Degradation tracking (anti-cache-poisoning)
//
// When a section loader throws, the section renders with raw (un-enriched)
// props — e.g. a product shelf with no products during a VTEX outage. Today
// that degraded page is emitted as a healthy 200 and the edge caches it for the
// full retention window, so stale-if-error never fires and users see an empty
// page for hours. We record each CRITICAL section degradation on a
// request-scoped collector; the CMS route reads it and emits `X-Deco-Degraded`
// so the worker refuses to cache the broken page and serves stale instead.
//
// Every section is critical by default (a registered loader failing means
// intended data is missing). Decorative sections whose empty state is harmless
// can opt out via `registerNonCriticalSections`.
// ---------------------------------------------------------------------------

const DEGRADED_BAG_KEY = "deco:degraded-sections";
const nonCriticalSections: Set<string> = G.__deco.nonCriticalSections;

/** Mark section keys whose loader failure should NOT make the page uncacheable. */
export function registerNonCriticalSections(keys: string[]): void {
  for (const k of keys) nonCriticalSections.add(k);
}

/** A section is critical (its failure degrades the page) unless opted out. */
export function isCriticalSection(key: string): boolean {
  return !nonCriticalSections.has(key);
}

/**
 * Record that a critical section rendered with raw props because its loader
 * threw. No-op outside a request scope or for non-critical sections.
 */
export function markSectionDegraded(component: string): void {
  if (!isCriticalSection(component)) return;
  const set = RequestContext.getBag<Set<string>>(DEGRADED_BAG_KEY) ?? new Set<string>();
  set.add(component);
  RequestContext.setBag(DEGRADED_BAG_KEY, set);
}

/** Component keys of critical sections that degraded during this request. */
export function getDegradedSections(): string[] {
  const set = RequestContext.getBag<Set<string>>(DEGRADED_BAG_KEY);
  return set ? [...set] : [];
}

// ---------------------------------------------------------------------------
// Cacheable section loaders — SWR cache for section loader results
// ---------------------------------------------------------------------------

interface CacheableSectionConfig {
  maxAge: number;
  /** Bounded stale window in milliseconds. Default: 5 minutes. */
  staleWhileRevalidate?: number;
}

export type CacheableSectionInput =
  | CacheableSectionConfig
  | import("../sdk/cacheHeaders").CacheProfileName;

function resolveSectionCacheConfig(input: CacheableSectionInput): CacheableSectionConfig {
  if (typeof input === "string") {
    const profile = getCacheProfile(input);
    return { maxAge: profile.loader.fresh };
  }
  return input;
}

const cacheableSections: Map<string, CacheableSectionConfig> = G.__deco.cacheableSections;

interface SectionCacheEntry {
  section: ResolvedSection;
  createdAt: number;
  refreshing: boolean;
}

const sectionLoaderCache = createCacheStore<SectionCacheEntry>("sections");
const sectionLoaderInflight = new Map<string, Promise<ResolvedSection>>();
function sectionCacheKey(component: string, props: Record<string, unknown>): string {
  return `${component}::${JSON.stringify(props)}`;
}

/**
 * Register section components whose loader results should be cached.
 * Uses SWR (stale-while-revalidate) semantics: stale results are returned
 * immediately while a background refresh runs.
 *
 * Works for both eager sections (speeds up SSR) and deferred sections
 * (speeds up individual fetch on scroll).
 */
export function registerCacheableSections(configs: Record<string, CacheableSectionInput>): void {
  for (const [key, config] of Object.entries(configs)) {
    cacheableSections.set(key, resolveSectionCacheConfig(config));
  }
}

async function runCacheableSectionLoader(
  section: ResolvedSection,
  loader: SectionLoaderFn,
  request: Request,
  config: CacheableSectionConfig,
): Promise<ResolvedSection> {
  const key = sectionLoaderCache.key(
    sectionCacheKey(section.component, section.props as Record<string, unknown>),
  );

  const existing = sectionLoaderInflight.get(key);
  if (existing) return existing;

  const entry = getCacheStorageContext()?.storage
    ? await sectionLoaderCache.read(key)
    : sectionLoaderCache.get(key);
  const pending = sectionLoaderInflight.get(key);
  if (pending) return pending;
  const now = Date.now();
  const isStale = entry ? now - entry.createdAt > config.maxAge : true;

  if (entry && !isStale) {
    return Promise.resolve(entry.section);
  }

  if (entry && isStale && !entry.refreshing) {
    entry.refreshing = true;
    cacheBackground(
      Promise.resolve()
        .then(() => loader(section.props as Record<string, unknown>, request))
        .then((enrichedProps) => {
          const enriched = { ...section, props: enrichedProps };
          sectionLoaderCache.set(
            key,
            {
              section: enriched,
              createdAt: Date.now(),
              refreshing: false,
            },
            Date.now() + config.maxAge + (config.staleWhileRevalidate ?? 300_000),
          );
        })
        .catch(() => {
          entry.refreshing = false;
        }),
    );
    return Promise.resolve(entry.section);
  }

  if (entry) return Promise.resolve(entry.section);

  const promise = withInflightTimeout(
    (async () => {
      const enrichedProps = await loader(section.props as Record<string, unknown>, request);
      const enriched = { ...section, props: enrichedProps };
      sectionLoaderCache.set(
        key,
        {
          section: enriched,
          createdAt: Date.now(),
          refreshing: false,
        },
        Date.now() + config.maxAge + (config.staleWhileRevalidate ?? 300_000),
      );
      return enriched;
    })(),
    `sectionLoader ${key}`,
  ).finally(() => sectionLoaderInflight.delete(key));

  sectionLoaderInflight.set(key, promise);
  return promise;
}

/**
 * Register a server-side loader for a specific section.
 * The loader receives the CMS-resolved props and a Request,
 * and returns enriched props.
 */
export function registerSectionLoader(sectionKey: string, loader: SectionLoaderFn): void {
  loaderRegistry.set(sectionKey, loader);
}

/**
 * Register multiple section loaders at once.
 *
 * Dev-only diagnostic: when a request-dependent loader (one built from
 * `withDevice`/`withMobile`/`withSearchParam`, possibly through `compose`)
 * is registered for a section that's also in `layoutSections`, the layout cache
 * may serve the first visitor's variant to every viewer for
 * `LAYOUT_CACHE_TTL` (5 min). See #206.
 *
 * DEVICE is now segmented in the key ({@link layoutLoaderCacheKey}), so
 * `withDevice`/`withMobile` are safe. The warning stays because
 * `__requestDependent` is a single boolean and does not say WHICH signal the
 * loader reads — a `withSearchParam` layout loader still contaminates, and we
 * would rather warn on a safe case than stay silent on an unsafe one.
 */
export function registerSectionLoaders(loaders: Record<string, SectionLoaderFn>): void {
  for (const [key, loader] of Object.entries(loaders)) {
    loaderRegistry.set(key, loader);
  }
  if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
    for (const [key, loader] of Object.entries(loaders)) {
      const requestDependent =
        (loader as SectionLoaderFn & { __requestDependent?: boolean }).__requestDependent === true;
      if (requestDependent && layoutSections.has(key)) {
        console.warn(
          `[SectionLoaders] "${key}" is registered as a layout section ` +
            `(cached for 5min by component path + device) but its loader is ` +
            `request-dependent (withDevice/withMobile/withSearchParam). ` +
            `withDevice/withMobile are safe — device is in the key. If it ` +
            `reads a search param, cookie or geo, the first visitor's variant ` +
            `will be served to all users for 5min. Fix: ` +
            `(1) remove "export const layout = true" from the section, ` +
            `(2) call unregisterLayoutSections(["${key}"]) in setup.ts ` +
            `after applySectionConventions, or (3) move the request-` +
            `dependent logic out of the layout loader.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Layout section cache — sections whose output doesn't change per-page
// (Header, Footer, Theme, etc.) are cached server-side so they aren't
// re-resolved and re-enriched on every navigation.
//
// Uses in-flight deduplication: if two requests try to resolve the same
// layout section concurrently, the second shares the first's Promise.
// ---------------------------------------------------------------------------

const layoutSections: Set<string> = G.__deco.layoutSections;

const LAYOUT_CACHE_TTL = 5 * 60_000; // 5 minutes

interface CachedSection {
  section: ResolvedSection;
  expiresAt: number;
}

const layoutCache = createCacheStore<CachedSection>("layout-loaders");
const layoutInflight = new Map<string, Promise<ResolvedSection>>();

/**
 * Register section keys that should be cached as layout sections.
 * Layout sections (Header, Footer, etc.) are cached server-side
 * for LAYOUT_CACHE_TTL to avoid redundant enrichment on every navigation.
 *
 * The cache key is the component path plus the DEVICE (see
 * {@link layoutLoaderCacheKey}) — it does NOT include cookies, geo or search
 * params. A section whose loader depends on THOSE must not be layout-cached:
 * see {@link unregisterLayoutSections} to opt a section out of the
 * auto-discovery done by `applySectionConventions`.
 */
export function registerLayoutSections(keys: string[]): void {
  for (const key of keys) {
    layoutSections.add(key);
  }
}

/**
 * Remove section keys from the layout cache set. Use this to opt a section
 * out of caching when `applySectionConventions` auto-registered it via
 * `export const layout = true` but the section's loader is in fact request-
 * dependent (Header with `withDevice()`, geo-aware promo, etc.).
 *
 * Call after `applySectionConventions` and before the first request.
 *
 * See #206 for the contamination bug this prevents.
 */
export function unregisterLayoutSections(keys: string[]): void {
  for (const key of keys) {
    layoutSections.delete(key);
  }
}

/** Check if a section key is registered as a layout section. */
export function isLayoutSection(key: string): boolean {
  return layoutSections.has(key);
}

/**
 * Cache key for a layout section's LOADER OUTPUT, segmented by device.
 *
 * This is the cache that actually carried the device leak, and it is a
 * different one from `resolvedLayoutCache` in `cms/resolve.ts` — that one holds
 * the CMS prop resolution, which never sees `isMobile`. `isMobile` is produced
 * HERE, by the section's own loader (`ctx.device`, or a loader composed with
 * `withDevice`/`withMobile`), and this cache stored it under the component path
 * alone. Measured on a real store's PDP with Header/Footer layout-cached: the
 * first request decided the variant for everyone — desktop first and a mobile
 * visitor got `h-[90px]`; mobile first and a desktop visitor got
 * `id="header-mobile-menu"`.
 *
 * Device is the right default axis because it is the one signal the framework
 * itself injects into every section loader, so a layout section can depend on it
 * without the site opting into anything. A layout whose output does not vary by
 * device just gets up to 3 identical entries.
 *
 * Still NOT covered, and still the reason the `registerSectionLoaders` warning
 * below exists: a layout loader that varies on a search param, a cookie or geo.
 * Those are site-specific; such a section belongs outside `layoutSections`.
 *
 * Exported for unit testing.
 */
export function layoutLoaderCacheKey(component: string, request?: Request): string {
  return `${component}::${detectDevice(request?.headers?.get?.("user-agent") ?? "")}`;
}

async function getCachedLayout(cacheKey: string): Promise<ResolvedSection | null> {
  const entry = await layoutCache.read(cacheKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    layoutCache.delete(cacheKey);
    return null;
  }
  return entry.section;
}

function setCachedLayout(cacheKey: string, section: ResolvedSection): void {
  layoutCache.set(
    cacheKey,
    {
      section,
      expiresAt: Date.now() + LAYOUT_CACHE_TTL,
    },
    Date.now() + LAYOUT_CACHE_TTL,
  );
}

/**
 * Run a layout section's loader with in-flight dedup + TTL cache.
 */
async function resolveLayoutSection(
  section: ResolvedSection,
  loader: SectionLoaderFn,
  request: Request,
): Promise<ResolvedSection> {
  const key = layoutCache.key(layoutLoaderCacheKey(section.component, request));
  const { index } = section;

  // Re-apply the caller's page-specific index onto a fresh object so the
  // shared cache entry never carries an index from a previous request.
  const withIndex = (s: ResolvedSection): ResolvedSection =>
    index !== undefined ? { ...s, index } : s;

  const cached = await getCachedLayout(key);
  if (cached) return Promise.resolve(withIndex(cached));

  const existing = layoutInflight.get(key);
  if (existing) return existing.then(withIndex);

  const promise = withInflightTimeout(
    (async () => {
      const enrichedProps = await loader(section.props as Record<string, unknown>, request);
      const { index: _idx, ...sectionWithoutIndex } = section;
      const enriched = { ...sectionWithoutIndex, props: enrichedProps };
      setCachedLayout(key, enriched);
      return withIndex(enriched);
    })(),
    `layoutSection ${key}`,
  ).finally(() => layoutInflight.delete(key));

  layoutInflight.set(key, promise);

  return promise;
}

/**
 * Run registered section loaders against resolved sections.
 * Sections without a registered loader pass through unchanged.
 *
 * Layout sections use in-flight dedup + TTL cache to avoid
 * redundant enrichment across concurrent and sequential requests.
 *
 * Runs all loaders in parallel for performance.
 */
export async function runSectionLoaders(
  sections: ResolvedSection[],
  request: Request,
): Promise<ResolvedSection[]> {
  // Dev warning: detect likely layout sections not registered via registerLayoutSections.
  // Without registration, Header/Footer won't be cached across navigations.
  if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
    for (const s of sections) {
      const key = s.component.toLowerCase();
      if ((key.includes("header") || key.includes("footer")) && !layoutSections.has(s.component)) {
        console.warn(
          `[SectionLoaders] "${s.component}" looks like a layout section but is not in registerLayoutSections(). ` +
            `Add it to registerLayoutSections() in setup.ts for consistent caching across navigations.`,
        );
      }
    }
  }
  return withTracing(
    "deco.section.loaders.batch",
    () => Promise.all(sections.map((section) => runSingleSectionLoader(section, request))),
    { "section.count": sections.length },
  );
}

/**
 * Inject the active request's URL and path into section props so site
 * loaders can read `props.__pageUrl` / `props.__pagePath` without having
 * to derive them from `req.url` themselves.
 *
 * The framework already injects these for commerce loaders (resolve.ts),
 * but section loaders (e.g. category SearchBanner, breadcrumb-aware FAQs)
 * also need to know the active page. Without this, callers had to wrap
 * `loader(...)` themselves in a custom `delegateAfter`-style helper —
 * forgetting it produced silent rendering bugs (empty banners, default
 * fallbacks).
 *
 * Existing values in `props` win — sites that already pre-populated
 * `__pageUrl` (e.g. via a custom mixin) keep their value untouched.
 *
 * Note: this runs only at the point we hand props to the user's loader.
 * The cacheable-section cache key hashes the *original* props (URL-agnostic),
 * so sections registered via `registerCacheableSections` keep sharing a
 * single cache entry across pages.
 */
function injectPageContext(
  props: Record<string, unknown>,
  request: Request,
): Record<string, unknown> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return props;
  }
  const enriched = { ...props } as Record<string, unknown>;
  if (enriched.__pageUrl === undefined) enriched.__pageUrl = request.url;
  if (enriched.__pagePath === undefined) enriched.__pagePath = url.pathname;
  return enriched;
}

/**
 * Wrap a loader so it receives __pageUrl/__pagePath in its props AND the
 * 3rd-arg compat `ctx` (issue #305). This is the single choke point that all
 * four invocation paths (regular, layout, cacheable, SWR refresh) route
 * through, so building `ctx` here covers every path.
 */
function withPageContext(loader: SectionLoaderFn): SectionLoaderFn {
  return (props, req) => loader(injectPageContext(props, req), req, buildSectionLoaderContext(req));
}

/**
 * Run a single section's registered loader.
 * Used by both `runSectionLoaders` (batch) and `loadDeferredSection` (individual).
 *
 * Respects three cache tiers:
 * 1. Layout sections (Header/Footer) — 5min TTL + in-flight dedup
 * 2. Cacheable sections (ProductShelf, FAQ) — SWR with configurable maxAge
 * 3. Regular sections — no cache, always fresh
 *
 * After the section's own loader runs, recursively runs loaders for any
 * nested sections found in its resolved props (e.g. wrapper sections with
 * a `sections: Section[]` prop). This eliminates the need for sites to
 * manually walk + invoke `runSingleSectionLoader` on children.
 */
export async function runSingleSectionLoader(
  section: ResolvedSection,
  request: Request,
): Promise<ResolvedSection> {
  return withTracing("deco.section.loader", () => runSingleSectionLoaderImpl(section, request), {
    "deco.section": section.component,
  });
}

async function runSingleSectionLoaderImpl(
  section: ResolvedSection,
  request: Request,
): Promise<ResolvedSection> {
  const loader = loaderRegistry.get(section.component);

  let result: ResolvedSection;

  if (!loader) {
    // No own-loader, but the section may still contain nested sections in
    // its props (CMS-resolved children) that need their loaders run.
    result = section;
  } else {
    // Wrap the loader so __pageUrl/__pagePath are injected at the call site.
    // Cache keys (component name for layout, component+propsHash for cacheable)
    // are computed from the *original* section.props — keeping cache entries
    // URL-agnostic and shared across pages.
    const wrapped = withPageContext(loader);

    if (layoutSections.has(section.component)) {
      try {
        result = await resolveLayoutSection(section, wrapped, request);
      } catch (error) {
        console.error(`[SectionLoader] Error in layout "${section.component}":`, error);
        // Deliberately NOT marked degraded: layout sections (Header/Footer/Theme)
        // render on every page, so a flaky layout loader would flip the whole
        // site to X-Deco-Degraded and defeat edge caching everywhere. A failed
        // layout renders raw chrome, which is acceptable — page-body data
        // integrity (product shelves/PLP/PDP) is what the degraded signal guards.
        result = section;
      }
    } else {
      const cacheConfig = cacheableSections.get(section.component);
      if (cacheConfig) {
        try {
          result = await runCacheableSectionLoader(section, wrapped, request, cacheConfig);
        } catch (error) {
          console.error(`[SectionLoader] Error in cacheable "${section.component}":`, error);
          markSectionDegraded(section.component);
          result = section;
        }
      } else {
        try {
          const enrichedProps = await wrapped(section.props as Record<string, unknown>, request);
          result = { ...section, props: enrichedProps };
        } catch (error) {
          console.error(`[SectionLoader] Error in "${section.component}":`, error);
          markSectionDegraded(section.component);
          result = section;
        }
      }
    }
  }

  // Recurse into nested sections AFTER the parent's loader/cache lookup so
  // child sections keep their own cache TTL independent from the parent's.
  // For layout/cacheable parents, this means a 5-min layout cache hit still
  // re-evaluates child sections (whose own caches are usually shorter, e.g.
  // ProductShelf 60s). For leaf sections, `enrichNestedSections` returns
  // the same reference (no allocation, no extra work).
  const props = result.props as Record<string, unknown> | undefined;
  if (props && typeof props === "object") {
    try {
      const enrichedProps = await enrichNestedSections(props, request);
      if (enrichedProps !== props) {
        return { ...result, props: enrichedProps };
      }
    } catch (error) {
      // The walk runs on arbitrary loader output; a failure here must not
      // reject the whole runSectionLoaders batch — keep the section's props.
      console.error(
        `[SectionLoader] Error enriching nested sections of "${section.component}":`,
        error,
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Nested section loader support
// ---------------------------------------------------------------------------

/**
 * Type guard: matches the shape produced by `normalizeNestedSections` in
 * resolve.ts — `{ Component: string, props: object }`. This is how the CMS
 * resolver represents nested sections (children of wrapper sections).
 *
 * Note: the `Component` key uses capital C to match the runtime renderer's
 * convention (mirrors deco-cx/deco's Fresh API). Not to be confused with
 * the lowercase `component` on `ResolvedSection`.
 */
function isNestedSection(
  value: unknown,
): value is { Component: string; props: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.Component === "string" &&
    obj.props != null &&
    typeof obj.props === "object" &&
    !Array.isArray(obj.props)
  );
}

/**
 * Walk a props object and run section loaders for any nested sections.
 * Handles direct child sections, arrays of sections (`sections: Section[]`,
 * `slides: Slide[]`) AND sections nested inside plain objects/arrays at any
 * depth (`variants: [{ name, section: Section }]`, `layout: { aside: Section }`)
 * — the resolver resolves a section reference wherever the CMS placed it, so
 * the loader walk has to find it there too; a section reachable only through
 * a plain object used to be skipped and rendered with its raw CMS props.
 *
 * Two passes: a synchronous scan marks every object/array whose subtree
 * holds a nested section, and the walk descends only into marked nodes.
 * Props without any nested section (the vast majority — including multi-MB
 * PLP payloads) cost one sync traversal and return the same reference, with
 * no Promise allocated. Cyclic loader output terminates instead of
 * overflowing the stack (see `markSectionSubtrees` and `walkNested`).
 *
 * Concurrency: all nested loader calls run in parallel via Promise.all.
 */
async function enrichNestedSections(
  props: Record<string, unknown>,
  request: Request,
): Promise<Record<string, unknown>> {
  const scan: SectionScan = { marked: new WeakSet(), deep: new WeakMap() };
  if (!markSectionSubtrees(props, scan, 0)) return props;
  return (await walkNested(props, request, scan.marked, new WeakMap())) as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Real props are a few dozen levels deep at most. Above this depth the scan
 * keeps no per-node bookkeeping (a visited map costs 2-3x the bare traversal
 * on a PLP payload); a cycle necessarily recurses past it, and from there on
 * every node is memoized, so the scan terminates.
 */
const CYCLE_GUARD_DEPTH = 32;

interface SectionScan {
  /** Arrays/plain objects whose subtree holds a nested section. */
  marked: WeakSet<object>;
  /** Scan results for nodes reached below CYCLE_GUARD_DEPTH. */
  deep: WeakMap<object, boolean>;
}

/**
 * Sync scan: whether `value` is or contains a nested section, adding every
 * array/plain object on the path to one to `scan.marked`. Does not look
 * inside a nested section's props — its own runSingleSectionLoader call
 * walks those after its loader runs. Below CYCLE_GUARD_DEPTH a node is
 * recorded as `false` on entry, so a cycle back to it reports false; the
 * first visit already covers that subtree.
 */
function markSectionSubtrees(value: unknown, scan: SectionScan, depth: number): boolean {
  if (isNestedSection(value)) return true;
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return false;
  const node = value as object;
  const guarded = depth >= CYCLE_GUARD_DEPTH;
  if (guarded) {
    const known = scan.deep.get(node);
    if (known !== undefined) return known;
    scan.deep.set(node, false);
  }
  let found = false;
  if (isArray) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) {
      if (markSectionSubtrees(arr[i], scan, depth + 1)) found = true;
    }
  } else {
    const obj = value as Record<string, unknown>;
    for (const key in obj) {
      if (markSectionSubtrees(obj[key], scan, depth + 1)) found = true;
    }
  }
  if (found) {
    scan.marked.add(node);
    if (guarded) scan.deep.set(node, true);
  }
  return found;
}

/**
 * Returns the enriched value — a Promise only for nodes on a path to a
 * nested section. The descent itself is synchronous (depth-first), so a
 * `null` memo entry means "an ancestor still being walked": a cycle, which
 * keeps its original reference. A subtree shared by several props is
 * enriched once and the result reused at every position.
 */
function walkNested(
  value: unknown,
  request: Request,
  marked: WeakSet<object>,
  memo: WeakMap<object, Promise<unknown> | null>,
): unknown {
  if (isNestedSection(value)) {
    return runSingleSectionLoader(
      { component: value.Component, props: value.props, key: value.Component } as ResolvedSection,
      request,
    ).then((enriched) => ({ Component: enriched.component, props: enriched.props }));
  }
  if (!value || typeof value !== "object" || !marked.has(value)) return value;
  const known = memo.get(value);
  if (known !== undefined) return known ?? value;
  memo.set(value, null);
  let pending: Promise<unknown>;
  if (Array.isArray(value)) {
    pending = Promise.all(value.map((item) => walkNested(item, request, marked, memo))).then(
      (next) => (next.some((item, i) => item !== value[i]) ? next : value),
    );
  } else {
    const entries = Object.entries(value);
    pending = Promise.all(entries.map(([, v]) => walkNested(v, request, marked, memo))).then(
      (next) => {
        let out: Record<string, unknown> | null = null;
        for (let i = 0; i < entries.length; i++) {
          if (next[i] !== entries[i][1]) {
            out ??= { ...value };
            out[entries[i][0]] = next[i];
          }
        }
        return out ?? value;
      },
    );
  }
  memo.set(value, pending);
  return pending;
}
