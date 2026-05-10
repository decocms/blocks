/**
 * Shared in-memory state for the cached loader.
 *
 * Lives in `core/` so framework-agnostic admin handlers (notably the
 * decofile hot-reload endpoint) can clear it on configuration changes
 * without depending on the tanstack tier.
 *
 * The `cachedLoader` in `tanstack/sdk/cachedLoader.ts` reads/writes these
 * Maps; `clearLoaderCache()` and `getLoaderCacheStats()` are the public
 * surface for diagnostics and hot-reload invalidation.
 */

interface CacheEntry<T = unknown> {
  value: T;
  createdAt: number;
  refreshing: boolean;
}

export const loaderCache = new Map<string, CacheEntry>();

export const inflightLoaderRequests = new Map<string, Promise<unknown>>();

export type { CacheEntry };

/** Clear all cached entries. Useful for decofile hot-reload. */
export function clearLoaderCache(): void {
  loaderCache.clear();
  inflightLoaderRequests.clear();
}

/** Get cache stats for diagnostics. */
export function getLoaderCacheStats(): { entries: number; inflight: number } {
  return {
    entries: loaderCache.size,
    inflight: inflightLoaderRequests.size,
  };
}
