/**
 * SWR in-memory fetch cache for VTEX API responses.
 *
 * Inspired by deco-cx/deco runtime/fetch/fetchCache.ts.
 * Provides in-flight deduplication + stale-while-revalidate for GET requests.
 *
 * Only caches on the server side. Keyed by full URL string.
 */

const DEFAULT_MAX_ENTRIES = 500;
// Stale-if-error window: how long past the freshness TTL a last-good entry may
// still be served when the origin is failing (5xx / timeout / circuit open).
// Bounds "availability first" — a warm key survives a full VTEX outage for up
// to 24h with zero upstream pressure, after which the entry is considered too
// stale to serve and the error surfaces (→ degraded / branded error page).
// Mirrors the edge `sie` window sites configure for product/listing.
const STALE_IF_ERROR_MS = 86_400_000; // 24h
// Inflight-slot backstop timeout. Bounds how long a single hung `fetch()` can
// hold an inflight entry alive. Without this, a VTEX subrequest that never
// settles leaks the inflight Map slot forever and every subsequent request for
// the same cache key joins the zombie Promise, pinning memory until
// `exceededMemory` (observed in prod: 514 hard crashes / 24h on a PLP route).
//
// MUST stay ABOVE the resilience layer's totalTimeoutMs (12s) — the resilient
// fetch owns real per-call abort/timeout now, so this is only a last-resort
// backstop. If it fired first (e.g. at 10s) it would kill a slow-but-
// recoverable response the resilience layer was about to deliver at ~12s,
// discard the good body (never cached), and free the dedup slot early so a
// concurrent request launches a duplicate upstream fetch.
const FETCH_TIMEOUT_MS = 15_000;

interface CacheEntry {
  body: unknown;
  status: number;
  createdAt: number;
  refreshing: boolean;
}

const TTL_BY_STATUS: Record<string, number> = {
  "2xx": 180_000, // 3 min for success
  "404": 10_000, // 10s for not found
  "5xx": 0, // never cache server errors
};

function ttlForStatus(status: number): number {
  if (status >= 200 && status < 300) return TTL_BY_STATUS["2xx"];
  if (status === 404) return TTL_BY_STATUS["404"];
  if (status >= 500) return TTL_BY_STATUS["5xx"];
  return 0;
}

const store = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

function evictIfNeeded() {
  if (store.size <= DEFAULT_MAX_ENTRIES) return;
  const sorted = [...store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  const toRemove = sorted.slice(0, store.size - DEFAULT_MAX_ENTRIES);
  for (const [key] of toRemove) store.delete(key);
}

/**
 * Race a Promise against a timeout so callers' `.finally()` always runs.
 * Critical for evicting the inflight Map entry when a `fetch()` hangs —
 * without this, a never-settling Promise leaks the Map slot forever and
 * every subsequent request for the same key joins the zombie Promise.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function executeFetch(url: string, doFetch: () => Promise<Response>): Promise<CacheEntry> {
  // Single attempt on purpose. The resilience layer (`createResilientFetch`,
  // wired as the VTEX fetch's baseFetch) owns retries, backoff+jitter, the
  // per-host retry budget, and the circuit breaker. Retrying here would:
  //   - double-retry network errors (resilience 3× × fetchCache 3× = up to 9
  //     upstream calls per logical request — the retry storm the budget
  //     prevents), and
  //   - re-enter the breaker on every 5xx retry, opening it ~3× too fast.
  const response = await doFetch();

  if (response.status >= 500) {
    throw new Error(`fetchWithCache: ${response.status} ${response.statusText} — ${url}`);
  }

  const body = response.ok ? await response.json() : null;
  return {
    body,
    status: response.status,
    createdAt: Date.now(),
    refreshing: false,
  };
}

export interface FetchCacheOptions {
  /**
   * Custom TTL in ms. If provided, overrides status-based TTL.
   */
  ttl?: number;
  /**
   * Stale-if-error window in ms. How long past the freshness TTL a last-good
   * entry may still be served while the origin is failing. Defaults to
   * {@link STALE_IF_ERROR_MS} (24h). Set to 0 to disable stale serving.
   */
  sieMs?: number;
}

/**
 * Wrap a GET fetch call with SWR caching and in-flight dedup.
 *
 * Returns `null` for non-2xx responses that are cached (e.g. 404).
 * 5xx responses throw so the caller can handle them explicitly.
 *
 * @param cacheKey - Unique key (typically the full URL)
 * @param doFetch - The actual fetch call to execute
 * @param opts - Optional overrides
 * @returns Parsed JSON body, or null for cacheable error responses (e.g. 404)
 */
export function fetchWithCache<T>(
  cacheKey: string,
  doFetch: () => Promise<Response>,
  opts?: FetchCacheOptions,
): Promise<T | null> {
  const now = Date.now();
  const entry = store.get(cacheKey);

  if (entry) {
    const maxAge = opts?.ttl ?? ttlForStatus(entry.status);
    const age = now - entry.createdAt;
    const isStale = age > maxAge;

    if (!isStale) return Promise.resolve(entry.body as T | null);

    // Beyond the stale-if-error window the last-good entry is too old to keep
    // serving during an outage: drop it and fall through to a foreground
    // refetch (cold path). On a healthy origin this is never reached because
    // the background refresh below keeps resetting `createdAt`.
    const sieMs = opts?.sieMs ?? STALE_IF_ERROR_MS;
    const tooStale = age > maxAge + sieMs;

    if (!tooStale) {
      if (!entry.refreshing) {
        entry.refreshing = true;
        // Background refresh: no retry — stale data is already being served.
        // Timeout guards against a hung VTEX response leaving `refreshing`
        // stuck true forever (which would silently disable revalidation).
        withTimeout(
          executeFetch(cacheKey, doFetch),
          FETCH_TIMEOUT_MS,
          `fetchCache stale-refresh ${cacheKey}`,
        )
          .then((fresh) => {
            const ttl = opts?.ttl ?? ttlForStatus(fresh.status);
            const existingWasSuccess = entry.status >= 200 && entry.status < 300;
            const freshIsError = fresh.status >= 400;
            const wouldDowngrade = existingWasSuccess && freshIsError;
            if (ttl > 0 && !wouldDowngrade) {
              store.set(cacheKey, fresh);
            } else {
              entry.refreshing = false;
            }
          })
          .catch(() => {
            entry.refreshing = false;
          });
      }
      // Serve last-good while it is within the SIE window (stale-if-error).
      return Promise.resolve(entry.body as T | null);
    }

    store.delete(cacheKey);
    // fall through to the cold path below with the dead entry removed
  }

  const existing = inflight.get(cacheKey);
  if (existing) return existing.then((e) => e.body as T | null);

  // Wrap with a timeout so the `.finally()` below always runs and evicts
  // the inflight slot — even if `executeFetch` never settles. See the
  // FETCH_TIMEOUT_MS comment at the top of this file for the leak this
  // guards against.
  const promise = withTimeout(
    executeFetch(cacheKey, doFetch),
    FETCH_TIMEOUT_MS,
    `fetchCache ${cacheKey}`,
  )
    .then((fresh) => {
      const ttl = opts?.ttl ?? ttlForStatus(fresh.status);
      if (ttl > 0) {
        store.set(cacheKey, fresh);
        evictIfNeeded();
      }
      return fresh;
    })
    .finally(() => inflight.delete(cacheKey));

  inflight.set(cacheKey, promise);
  return promise.then((e) => e.body as T | null);
}

export function clearFetchCache() {
  store.clear();
  inflight.clear();
}

export function getFetchCacheStats() {
  return {
    entries: store.size,
    inflight: inflight.size,
  };
}
