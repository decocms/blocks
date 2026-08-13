/**
 * VTEX SWR fetch cache — a thin binding over the shared, instrumented
 * `createFetchCache` in `@decocms/blocks/sdk/fetchCache`.
 *
 * The implementation (in-flight dedup, stale-while-revalidate, stale-if-error,
 * inflight backstop) now lives ONCE in the framework so every commerce app
 * shares it and emits `deco.cache.requests{layer="swr"}` automatically. This
 * module just wires VTEX's tuning constants (`./constants`) and the
 * `provider: "vtex"` label into a single module-level instance, preserving the
 * public surface (`fetchWithCache` / `clearFetchCache` / `getFetchCacheStats` /
 * `FetchCacheOptions`) that `client.ts` and existing tests depend on.
 */

import {
  createFetchCache,
  type FetchCacheOptions as SharedFetchCacheOptions,
} from "@decocms/blocks/sdk/fetchCache";
import {
  FETCH_CACHE_FRESH_TTL_MS,
  FETCH_CACHE_INFLIGHT_BACKSTOP_MS,
  FETCH_CACHE_MAX_ENTRIES,
  FETCH_CACHE_STALE_IF_ERROR_MS,
} from "./constants";

export type FetchCacheOptions = SharedFetchCacheOptions;

const cache = createFetchCache({
  provider: "vtex",
  maxEntries: FETCH_CACHE_MAX_ENTRIES,
  freshTtlMs: FETCH_CACHE_FRESH_TTL_MS,
  staleIfErrorMs: FETCH_CACHE_STALE_IF_ERROR_MS,
  inflightBackstopMs: FETCH_CACHE_INFLIGHT_BACKSTOP_MS,
});

/**
 * Wrap a GET fetch call with SWR caching and in-flight dedup.
 *
 * Returns `null` for non-2xx responses that are cached (e.g. 404).
 * 5xx responses throw so the caller can handle them explicitly.
 */
export function fetchWithCache<T>(
  cacheKey: string,
  doFetch: () => Promise<Response>,
  opts?: FetchCacheOptions,
): Promise<T | null> {
  return cache.fetchWithCache<T>(cacheKey, doFetch, opts);
}

export function clearFetchCache() {
  cache.clear();
}

export function getFetchCacheStats() {
  return cache.getStats();
}
