/**
 * Magento SWR fetch cache — a thin binding over the shared, instrumented
 * `createFetchCache` in `@decocms/blocks/sdk/fetchCache`.
 *
 * Same shared implementation VTEX uses (in-flight dedup, stale-while-
 * revalidate, stale-if-error, inflight backstop), wired with Magento's tuning
 * constants and the `provider: "magento"` label. Every call emits
 * `deco.cache.requests{layer="swr",profile="magento"}` automatically.
 *
 * Cache key is caller-supplied (not required to be a URL): REST GETs key by
 * their URL; GraphQL POSTs can key by a hash of `query + variables`. Callers
 * pass the closure that performs the actual `magentoFetch`, so a HIT never
 * touches the network.
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
  provider: "magento",
  maxEntries: FETCH_CACHE_MAX_ENTRIES,
  freshTtlMs: FETCH_CACHE_FRESH_TTL_MS,
  staleIfErrorMs: FETCH_CACHE_STALE_IF_ERROR_MS,
  inflightBackstopMs: FETCH_CACHE_INFLIGHT_BACKSTOP_MS,
});

/**
 * Wrap a Magento GET with SWR caching + in-flight dedup. Returns the parsed
 * JSON body, or `null` for cacheable non-2xx responses (e.g. 404). 5xx throw.
 */
export function magentoCachedFetch<T>(
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
