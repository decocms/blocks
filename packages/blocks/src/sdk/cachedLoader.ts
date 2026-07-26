/**
 * Server-side loader caching with stale-while-revalidate + stale-if-error.
 *
 * Provides an in-memory cache layer for commerce loaders during SSR.
 * Supports:
 * - Single-flight dedup (identical concurrent requests share one fetch)
 * - SWR: serve stale immediately, refresh in background
 * - SIE: on origin error, fall back to stale entry within a configurable window
 *
 * Can be configured with explicit options or by passing a cache profile name
 * (e.g. "product") which derives timing from the unified profile system.
 */

import {
  recordCacheMetric,
  recordLoaderError,
  recordLoaderMetric,
  withTracing,
} from "../middleware/observability";
import { type CacheProfileName, loaderCacheOptions } from "./cacheHeaders";
import { withInflightTimeout } from "./inflightTimeout";
import { RequestContext } from "./requestContext";

// Build-time constant injected by `decoVitePlugin()` (see @decocms/tanstack's
// vite plugin) — the same commit-SHA/deploy token the edge Cache API uses as
// its `__v` cache-key version. Declared here with a `typeof` guard so it's
// inert where the define is not applied (Node tests, non-plugin builds). Same
// pattern already used in `../cms/blockSource.ts`.
declare const __DECO_BUILD_HASH__: string | undefined;

// Prefixes every in-memory loader cache key with the build hash, mirroring the
// edge cache's `__v`. This is defense-in-depth, NOT the primary invalidation
// lever: the cache Map is per-isolate, so a fresh isolate spun for a new deploy
// already starts empty, and a warm isolate keeps running its old bundle (hence
// its old BUILD) until it is recycled — the prefix cannot flush that. It only
// matters if this store ever becomes shared across builds. Gated on truthiness
// (empty string ⇒ unversioned) to match getBuildHash()/getDeploymentId() in
// workerEntry.ts / blockSource.ts.
const BUILD =
  typeof __DECO_BUILD_HASH__ !== "undefined" && __DECO_BUILD_HASH__ ? __DECO_BUILD_HASH__ : "";

/**
 * `maxAge` above this (10 min) is almost always a mistake for a commerce loader:
 * upstream (catalog/price/stock) changes then take that long to propagate and a
 * redeploy is the only fast lever. Warned once per loader name.
 */
const LONG_MAXAGE_WARN = 600_000;
const warnedLongMaxAge = new Set<string>();

export type CachePolicy = "no-store" | "no-cache" | "stale-while-revalidate";

export interface CachedLoaderOptions {
  policy: CachePolicy;
  /** Max age in milliseconds before an entry is considered stale. Default: 60_000 (1 min). */
  maxAge?: number;
  /** How long to serve stale on origin error, in ms. Default: 0 (no error fallback). */
  staleIfError?: number;
  /** Key function to generate a cache key from loader props. Default: JSON.stringify. */
  keyFn?: (props: unknown) => string;
}

/**
 * The `@decocms/apps` loader/action module shape: a `default` loader plus the
 * optional `cache` / `cacheKey` exports Fresh loaders ship with.
 *
 *   export const cache = "stale-while-revalidate";
 *   export const cacheKey = (props, req) => `${new URL(req.url).pathname}...`;
 *
 * `cache` is the OPT-IN: absent (or `"no-store"`) means the loader runs on every
 * invocation, matching `@decocms/apps`' default. Any other value opts the loader
 * into single-flight dedup (concurrent identical calls in one render collapse to
 * one upstream call — the #339 N+1 fix). `cacheKey` computes the dedup identity
 * from `(props, req)`; returning `null` means "do not dedup, run fresh".
 */
export interface LoaderModule<TProps = any, TResult = any> {
  default: (props: TProps, req?: Request) => Promise<TResult>;
  cache?: CachePolicy | { maxAge: number };
  cacheKey?: (props: TProps, req?: Request) => string | null;
}


interface CacheEntry<T = unknown> {
  value: T;
  createdAt: number;
  refreshing: boolean;
  /** Estimated payload size in bytes (UTF-16 length of JSON.stringify). */
  estimatedBytes: number;
}

const DEFAULT_MAX_AGE = 60_000;

/**
 * Byte-cap for the in-memory loader cache. Default 32 MB — comfortably below
 * the Cloudflare Workers 128 MB isolate limit even when other caches (router,
 * VTEX fetch cache, V8 heap) are also resident.
 *
 * Override via env: `DECO_LOADER_CACHE_MAX_BYTES=67108864` (64 MB).
 *
 * Switched from entry-count to byte-based eviction because PLP payloads
 * (~0.5–2 MB each) blew past 128 MB at well under the previous 500-entry cap.
 */
const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024;

function resolveMaxBytes(): number {
  const env = typeof globalThis.process !== "undefined"
    ? globalThis.process.env
    : undefined;
  const raw = env?.DECO_LOADER_CACHE_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_CACHE_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CACHE_BYTES;
}

const MAX_CACHE_BYTES = resolveMaxBytes();

const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

// Bumped by clearLoaderCache(). A loader invocation captures this at entry and
// only writes its result back if the generation is unchanged when it settles —
// so a purge (e.g. POST /_cache/purge-loaders) that lands while a loader is
// in flight can't be silently undone by that in-flight loader repopulating a
// just-cleared entry with pre-purge data.
let cacheGeneration = 0;

// Floor each entry at 512 bytes so we never accumulate unbounded zero-cost
// entries when a loader legitimately returns `undefined` or an empty object
// — `JSON.stringify(undefined) === undefined` and the eviction loop would
// otherwise never reclaim them. JSON-length also under-counts V8's actual
// retention (structured objects retain 2–5× the JSON byte size); the 32 MB
// cap is conservative enough that this approximation is fine for an OOM
// safety net, but real RSS at the cap can land around 64–160 MB on
// object-heavy payloads.
const MIN_ENTRY_BYTES = 512;

function estimateBytes(value: unknown): number {
  try {
    // UTF-16 string length is an order-of-magnitude estimate of the bytes the
    // object retains in V8 (V8 keeps a structured representation, not JSON).
    // The absolute value is less important than the relative pressure signal.
    const len = JSON.stringify(value)?.length ?? 0;
    return Math.max(len, MIN_ENTRY_BYTES);
  } catch {
    // Circular refs / non-serializable values: fall back to a fixed budget so
    // the entry still counts against the cap.
    return 1024;
  }
}

function setCacheEntry<T>(key: string, entry: CacheEntry<T>) {
  const prev = cache.get(key);
  if (prev) cacheBytes -= prev.estimatedBytes;
  cacheBytes += entry.estimatedBytes;
  cache.set(key, entry);
}

function deleteCacheEntry(key: string) {
  const prev = cache.get(key);
  if (!prev) return;
  cacheBytes -= prev.estimatedBytes;
  cache.delete(key);
}

function evictIfNeeded() {
  if (cacheBytes <= MAX_CACHE_BYTES) return;
  const oldest = [...cache.entries()].sort(
    (a, b) => a[1].createdAt - b[1].createdAt,
  );
  for (const [key] of oldest) {
    deleteCacheEntry(key);
    if (cacheBytes <= MAX_CACHE_BYTES) break;
  }
}

const inflightRequests = new Map<string, Promise<unknown>>();

function resolveOptions(
  optionsOrProfile: CachedLoaderOptions | CacheProfileName,
): CachedLoaderOptions {
  if (typeof optionsOrProfile === "string") {
    return loaderCacheOptions(optionsOrProfile);
  }
  return optionsOrProfile;
}

/**
 * Wraps a loader function with server-side caching, single-flight dedup,
 * and stale-if-error resilience.
 *
 * Accepts either explicit options or a cache profile name:
 *
 * @example
 * ```ts
 * // Profile-driven (recommended):
 * const cachedPDP = createCachedLoader("vtex/productDetailsPage", pdpLoader, "product");
 *
 * // Explicit options (when loader needs different timing than its profile):
 * const cachedSuggestions = createCachedLoader("vtex/suggestions", suggestionsLoader, {
 *   policy: "stale-while-revalidate",
 *   maxAge: 120_000,
 *   staleIfError: 300_000,
 * });
 * ```
 */
export function createCachedLoader<TProps, TResult>(
  name: string,
  loaderFn: (props: TProps) => Promise<TResult>,
  optionsOrProfile: CachedLoaderOptions | CacheProfileName,
): (props: TProps) => Promise<TResult> {
  const resolved = resolveOptions(optionsOrProfile);
  const { policy, maxAge = DEFAULT_MAX_AGE, staleIfError = 0, keyFn = JSON.stringify } = resolved;

  const env = typeof globalThis.process !== "undefined" ? globalThis.process.env : undefined;
  const isDev = env?.DECO_CACHE_DISABLE === "true" || env?.NODE_ENV === "development";

  if (policy !== "no-store" && maxAge > LONG_MAXAGE_WARN && !warnedLongMaxAge.has(name)) {
    warnedLongMaxAge.add(name);
    console.warn(
      `[cachedLoader] ${name}: maxAge=${Math.round(maxAge / 1000)}s is very long — ` +
        `upstream changes take that long to propagate. Prefer a short window and use ` +
        `POST /_cache/purge-loaders (or a redeploy) for immediate invalidation.`,
    );
  }

  if (policy === "no-store") return loaderFn;

  return async (props: TProps): Promise<TResult> => {
    const cacheKey = `${BUILD}::${name}::${keyFn(props)}`;
    // Snapshot the cache generation; a purge during this invocation bumps it,
    // and the deferred writes below skip repopulating a just-cleared entry.
    const gen = cacheGeneration;

    const inflight = inflightRequests.get(cacheKey);
    if (inflight) {
      // Treat in-flight dedup as a cache hit — avoided the origin call.
      recordCacheMetric(true, name, undefined, "cachedLoader");
      const start = performance.now();
      return inflight.then((r) => {
        recordLoaderMetric(name, performance.now() - start, "HIT");
        return r as TResult;
      });
    }

    if (isDev) {
      // Dev mode: no caching, but still useful to count attempts.
      recordCacheMetric(false, name, undefined, "cachedLoader");
      const devStart = performance.now();
      const promise = withInflightTimeout(
        withTracing(
          "deco.cachedLoader",
          () => loaderFn(props),
          { "deco.loader": name, "deco.cache.policy": "no-cache-dev" },
        ),
        `cachedLoader:dev ${cacheKey}`,
      )
        .then((r) => {
          recordLoaderMetric(name, performance.now() - devStart, "BYPASS");
          return r;
        })
        .catch((err) => {
          recordLoaderMetric(name, performance.now() - devStart, "BYPASS");
          recordLoaderError(name);
          throw err;
        })
        .finally(() => inflightRequests.delete(cacheKey));
      inflightRequests.set(cacheKey, promise);
      return promise;
    }

    const entry = cache.get(cacheKey) as CacheEntry<TResult> | undefined;
    const now = Date.now();
    const isStale = entry ? now - entry.createdAt > maxAge : true;

    if (policy === "no-cache") {
      if (entry && !isStale) {
        recordCacheMetric(true, name, "HIT", "cachedLoader");
        recordLoaderMetric(name, 0, "HIT");
        return entry.value;
      }
    }

    if (policy === "stale-while-revalidate") {
      if (entry && !isStale) {
        recordCacheMetric(true, name, "HIT", "cachedLoader");
        recordLoaderMetric(name, 0, "HIT");
        return entry.value;
      }

      if (entry && isStale && !entry.refreshing) {
        // Stale-while-revalidate hit: serve stale, refresh in background.
        recordCacheMetric(true, name, "STALE-HIT", "cachedLoader");
        recordLoaderMetric(name, 0, "STALE-HIT");
        entry.refreshing = true;
        loaderFn(props)
          .then((result) => {
            // Skip the write if a purge cleared the cache mid-refresh — otherwise
            // we'd re-insert pre-purge data the purge was meant to drop.
            if (gen !== cacheGeneration) return;
            setCacheEntry(cacheKey, {
              value: result,
              createdAt: Date.now(),
              refreshing: false,
              estimatedBytes: estimateBytes(result),
            });
            evictIfNeeded();
          })
          .catch(() => {
            // Background refresh failed — entry stays stale.
            // If past the SIE window, evict so we don't serve indefinitely stale data.
            entry.refreshing = false;
            if (staleIfError > 0 && now - entry.createdAt > maxAge + staleIfError) {
              deleteCacheEntry(cacheKey);
            }
          });
        return entry.value;
      }

      if (entry) {
        // Past SIE window — still serve the stale value once but mark
        // the decision as STALE-ERROR so dashboards can distinguish
        // this from healthy SWR.
        recordCacheMetric(true, name, "STALE-ERROR", "cachedLoader");
        recordLoaderMetric(name, 0, "STALE-ERROR");
        return entry.value;
      }
    }

    // Cache miss — emit metric, then run loader inside a span so individual
    // slow loaders are visible in traces.
    recordCacheMetric(false, name, "MISS", "cachedLoader");
    const loaderStart = performance.now();
    const promise = withInflightTimeout(
      withTracing("deco.cachedLoader", () => loaderFn(props), {
        "deco.loader": name,
        "deco.cache.policy": policy,
      }),
      `cachedLoader ${cacheKey}`,
    )
      .then((result) => {
        recordLoaderMetric(name, performance.now() - loaderStart, "MISS");
        // Skip caching if a purge landed while this loader was in flight — still
        // return the fresh value to the caller, just don't persist a raced entry.
        if (gen === cacheGeneration) {
          setCacheEntry(cacheKey, {
            value: result,
            createdAt: Date.now(),
            refreshing: false,
            estimatedBytes: estimateBytes(result),
          });
          evictIfNeeded();
        }
        return result;
      })
      .catch((err) => {
        // SIE fallback: if we have a stale entry within the error window, return it
        if (staleIfError > 0 && entry) {
          const age = now - entry.createdAt;
          if (age < maxAge + staleIfError) {
            console.warn(
              `[cachedLoader] ${name}: origin error, serving stale entry (age=${Math.round(age / 1000)}s, sie=${Math.round(staleIfError / 1000)}s)`,
            );
            recordLoaderMetric(name, performance.now() - loaderStart, "STALE-ERROR");
            return entry.value;
          }
        }
        recordLoaderMetric(name, performance.now() - loaderStart, "MISS");
        recordLoaderError(name);
        throw err;
      })
      .finally(() => inflightRequests.delete(cacheKey));

    inflightRequests.set(cacheKey, promise);
    return promise;
  };
}


// ---------------------------------------------------------------------------
// Module loader dedup (the `@decocms/apps` cache/cacheKey convention)
//
// Distinct from `createCachedLoader` above (VTEX's byte-capped SWR cache): the
// module path is DEDUP-ONLY. A loader that opts in via `export const cache`
// gets single-flight — concurrent identical invocations in one render (N
// sections referencing the same loader) share one upstream call — but nothing
// is retained past settlement, so there is zero cross-request staleness. This
// is the deliberately-conservative fix for the #339 N+1 (2–3× product GraphQL
// per PDP render) without the SWR machinery's stale-serving semantics.
// ---------------------------------------------------------------------------

const moduleInflight = new Map<string, Promise<unknown>>();

/**
 * Wrap an `@decocms/apps`-shaped loader module so its `cache`/`cacheKey` exports
 * drive single-flight dedup. Loaders without a `cache` export (or `"no-store"`)
 * are returned unwrapped — they run on every call, matching apps' default.
 *
 * The dedup key is `${name}::${cacheKey(props, req)}`; `req` comes from the
 * caller or, on the CMS-resolution path (which passes only props), from
 * `RequestContext.current` — both execute inside the same AsyncLocalStorage
 * scope. `cacheKey` returning `null`, or `req` being unavailable when `cacheKey`
 * needs it, falls back to running fresh / keying on `JSON.stringify(props)`.
 */
export function createCachedLoaderFromModule<TProps, TResult>(
  name: string,
  mod: LoaderModule<TProps, TResult>,
): (props: TProps, req?: Request) => Promise<TResult> {
  const policy: CachePolicy = typeof mod.cache === "string"
    ? mod.cache
    : mod.cache && typeof mod.cache === "object"
      ? "stale-while-revalidate"
      : "no-store";

  // Only `stale-while-revalidate` (or `{ maxAge }`) opts into dedup — matching
  // `@decocms/apps`/deco, where `no-store` (the default) and `no-cache` both
  // bypass single-flight and run on every call. Return unwrapped otherwise.
  if (policy !== "stale-while-revalidate") return mod.default;

  const cacheKeyFn = mod.cacheKey;

  return (props: TProps, req?: Request): Promise<TResult> => {
    const request = req ?? RequestContext.current?.request ?? undefined;

    let keyPart: string | null;
    if (cacheKeyFn) {
      // A cacheKey that dereferences `req` (e.g. `new URL(req.url)`) would throw
      // when the request is unavailable — fall back to props-hash dedup instead.
      keyPart = request ? cacheKeyFn(props, request) : JSON.stringify(props);
    } else {
      keyPart = JSON.stringify(props);
    }

    // Explicit null → the loader declared this call uncacheable: run fresh.
    if (keyPart === null) return mod.default(props, req);

    const key = `${BUILD}::${name}::${keyPart}`;
    const existing = moduleInflight.get(key) as Promise<TResult> | undefined;
    if (existing) return existing;

    const promise = Promise.resolve(mod.default(props, req)).finally(() => {
      moduleInflight.delete(key);
    });
    moduleInflight.set(key, promise);
    return promise;
  };
}

/**
 * Registry entry factory for generated loader maps (`.deco/loaders.gen.ts`).
 * Lazily imports the loader module on first call, then delegates to a memoized
 * `createCachedLoaderFromModule` wrapper so `cache`/`cacheKey` exports take
 * effect. Keeps generated code a one-liner while the dedup logic stays here,
 * unit-tested, in the framework.
 */
export function createLoaderEntry<TProps = any, TResult = any>(
  name: string,
  importFn: () => Promise<LoaderModule<TProps, TResult>>,
): (props: TProps, req?: Request) => Promise<TResult> {
  // Memoize the import+build PROMISE (not the resolved wrapper) so concurrent
  // first-calls — exactly the N-sections-per-render case — share one import
  // instead of racing into N. Reset on failure so a transient import error can
  // retry rather than poisoning the entry forever.
  let wrappedPromise:
    | Promise<(props: TProps, req?: Request) => Promise<TResult>>
    | undefined;
  return (props: TProps, req?: Request): Promise<TResult> => {
    if (!wrappedPromise) {
      wrappedPromise = importFn()
        .then((mod) => createCachedLoaderFromModule(name, mod))
        .catch((err) => {
          wrappedPromise = undefined;
          throw err;
        });
    }
    return wrappedPromise.then((wrapped) => wrapped(props, req));
  };
}

/**
 * Clear all cached entries in THIS isolate. Used both by decofile hot-reload
 * (`@decocms/blocks-admin`) and by the `POST /_cache/purge-loaders` route — an
 * escape hatch to invalidate immediately (e.g. after an out-of-band Magento/
 * catalog sync) without waiting out the TTL. Per-isolate: the route must be hit
 * for every isolate; a redeploy replaces isolates wholesale. Bumps the cache
 * generation so any loader in flight at purge time won't repopulate a cleared
 * entry with pre-purge data.
 */
export function clearLoaderCache() {
  cache.clear();
  cacheBytes = 0;
  inflightRequests.clear();
  moduleInflight.clear();
  cacheGeneration++;
}

/** Get cache stats for diagnostics. */
export function getLoaderCacheStats() {
  return {
    entries: cache.size,
    inflight: inflightRequests.size,
    estimatedBytes: cacheBytes,
    maxBytes: MAX_CACHE_BYTES,
  };
}
