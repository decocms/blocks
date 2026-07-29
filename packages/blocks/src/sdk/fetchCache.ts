/**
 * Shared SWR in-memory fetch cache for commerce API responses.
 *
 * Provides in-flight deduplication + stale-while-revalidate + stale-if-error
 * for server-side GET requests, keyed by full URL string. Ported from the
 * VTEX app's `fetchCache.ts` (itself inspired by deco-cx/deco
 * `runtime/fetch/fetchCache.ts`) and generalized so every commerce app
 * (VTEX, Magento, Shopify, ...) shares ONE implementation instead of each
 * rolling its own uninstrumented copy.
 *
 * **Why this lives in `@decocms/blocks/sdk` (the chokepoint):** cache hit/miss
 * telemetry only becomes automatic when a single shared util emits it. Each
 * cache instance calls {@link recordCacheMetric} with `layer: "swr"` on every
 * decision branch, so any app that routes upstream GETs through
 * {@link createFetchCache} lands hit/miss/stale in ClickHouse for free — no
 * per-app wiring. The metric is a no-op when no meter is configured (dev,
 * tests), so there is zero cost off the instrumented path.
 *
 * **Provider isolation:** every {@link createFetchCache} call owns its own
 * `store`/`inflight` Maps, so VTEX / Magento / Shopify caches never collide in
 * a shared isolate. The `provider` string rides on `deco.cache.profile` so
 * dashboards can slice hit ratio per backend.
 *
 * Note on why the SWR cache — not `createInstrumentedFetch` — must emit the
 * hit/miss counter: on a HIT the cache returns BEFORE invoking `doFetch`, so
 * the instrumented fetch (and its `http.client.request.duration` histogram)
 * never runs. Hit ratio can only be measured here.
 */

import { type CacheDecision, recordCacheMetric } from "../middleware/observability";

/** Fresh-TTL (ms) by HTTP status class. See {@link FetchCacheConfig}. */
export interface FreshTtlByStatus {
  /** 2xx — how long a success body stays fresh. */
  success: number;
  /** 404 — how long a not-found stays fresh (kept short on purpose). */
  notFound: number;
  /** 5xx — a server error is never treated as a good cache hit (use 0). */
  serverError: number;
}

export interface FetchCacheConfig {
  /**
   * Backend name — `vtex` / `magento` / `shopify` / ... Emitted as
   * `deco.cache.profile` on the `deco.cache.requests` metric so dashboards can
   * break down SWR hit ratio per provider. Also namespaces the instance's
   * in-memory Maps (each instance is already isolated, but this keeps the
   * telemetry label meaningful).
   */
  provider: string;
  /** Max distinct cache keys kept in memory; oldest `createdAt` evicted first. */
  maxEntries: number;
  /** Fresh-TTL (ms) by status class. */
  freshTtlMs: FreshTtlByStatus;
  /**
   * Stale-if-error window (ms): how long PAST the freshness TTL a last-good 2xx
   * entry may still be served while the origin is failing. Set to 0 to disable
   * stale serving.
   */
  staleIfErrorMs: number;
  /**
   * Inflight-slot backstop timeout (ms). Bounds how long a single hung
   * `fetch()` can hold a dedup entry alive. MUST stay ABOVE any per-call
   * timeout the underlying fetch owns — this is a last-resort leak backstop,
   * not the primary timeout.
   */
  inflightBackstopMs: number;
}

interface CacheEntry {
  body: unknown;
  status: number;
  createdAt: number;
  refreshing: boolean;
}

export interface FetchCacheOptions {
  /** Custom fresh TTL in ms. If provided, overrides status-based TTL. */
  ttl?: number;
  /**
   * Stale-if-error window in ms for this call. Defaults to the instance's
   * {@link FetchCacheConfig.staleIfErrorMs}. Set to 0 to disable stale serving.
   */
  sieMs?: number;
}

export interface FetchCache {
  /**
   * Wrap a GET fetch call with SWR caching + in-flight dedup. Returns the
   * parsed JSON body, or `null` for cacheable non-2xx responses (e.g. 404).
   * 5xx responses throw so the caller can handle them explicitly.
   */
  fetchWithCache<T>(
    cacheKey: string,
    doFetch: () => Promise<Response>,
    opts?: FetchCacheOptions,
  ): Promise<T | null>;
  /** Drop all entries + inflight slots (mainly for tests). */
  clear(): void;
  /** Diagnostics: current entry / inflight counts. */
  getStats(): { entries: number; inflight: number };
}

/**
 * Race a Promise against a timeout so callers' `.finally()` always runs.
 * Critical for evicting the inflight Map entry when a `fetch()` hangs —
 * without this, a never-settling Promise leaks the Map slot forever and every
 * subsequent request for the same key joins the zombie Promise.
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

/**
 * Create an isolated SWR fetch cache instance for one provider.
 *
 * @example
 * const cache = createFetchCache({ provider: "vtex", ...VTEX_KNOBS });
 * const body = await cache.fetchWithCache(url, () => fetch(url));
 */
export function createFetchCache(config: FetchCacheConfig): FetchCache {
  const { provider, maxEntries, freshTtlMs, staleIfErrorMs, inflightBackstopMs } = config;

  const store = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<CacheEntry>>();

  function freshTtlForStatus(status: number): number {
    if (status >= 200 && status < 300) return freshTtlMs.success;
    if (status === 404) return freshTtlMs.notFound;
    if (status >= 500) return freshTtlMs.serverError;
    return 0;
  }

  function evictIfNeeded() {
    if (store.size <= maxEntries) return;
    const sorted = [...store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toRemove = sorted.slice(0, store.size - maxEntries);
    for (const [key] of toRemove) store.delete(key);
  }

  // Single attempt on purpose — the underlying fetch (resilience layer) owns
  // retries/backoff/breaker. Retrying here would multiply upstream calls and
  // re-enter the breaker too fast.
  async function executeFetch(url: string, doFetch: () => Promise<Response>): Promise<CacheEntry> {
    const response = await doFetch();
    if (response.status >= 500) {
      throw new Error(`fetchWithCache: ${response.status} ${response.statusText} — ${url}`);
    }
    const body = response.ok ? await response.json() : null;
    return { body, status: response.status, createdAt: Date.now(), refreshing: false };
  }

  function emit(decision: CacheDecision) {
    // `hit` is true for every branch that avoids a foreground upstream fetch
    // (fresh, dedup-join, stale-serve); MISS is the only non-hit.
    recordCacheMetric(decision !== "MISS", provider, decision, "swr");
  }

  function fetchWithCache<T>(
    cacheKey: string,
    doFetch: () => Promise<Response>,
    opts?: FetchCacheOptions,
  ): Promise<T | null> {
    const now = Date.now();
    const entry = store.get(cacheKey);

    if (entry) {
      const maxAge = opts?.ttl ?? freshTtlForStatus(entry.status);
      const age = now - entry.createdAt;
      const isStale = age > maxAge;

      if (!isStale) {
        emit("HIT");
        return Promise.resolve(entry.body as T | null);
      }

      // Beyond the stale-if-error window the last-good entry is too old to keep
      // serving during an outage: drop it and fall through to a foreground
      // refetch (cold path, counted as MISS there). On a healthy origin this is
      // never reached because the background refresh keeps resetting createdAt.
      const sieMs = opts?.sieMs ?? staleIfErrorMs;
      const tooStale = age > maxAge + sieMs;

      if (!tooStale) {
        if (!entry.refreshing) {
          entry.refreshing = true;
          // Background refresh: no retry — stale data is already being served.
          withTimeout(
            executeFetch(cacheKey, doFetch),
            inflightBackstopMs,
            `fetchCache stale-refresh ${cacheKey}`,
          )
            .then((fresh) => {
              const ttl = opts?.ttl ?? freshTtlForStatus(fresh.status);
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
        // Serve last-good within the SIE window: this is the stale-while-
        // revalidate serve.
        emit("STALE-HIT");
        return Promise.resolve(entry.body as T | null);
      }

      store.delete(cacheKey);
      // fall through to the cold path below with the dead entry removed
    }

    const existing = inflight.get(cacheKey);
    if (existing) {
      // Joined an in-flight upstream fetch — no upstream call of our own.
      emit("HIT");
      return existing.then((e) => e.body as T | null);
    }

    // Cold miss: run the loader. Wrap with a timeout so `.finally()` always
    // evicts the inflight slot even if `executeFetch` never settles.
    emit("MISS");
    const promise = withTimeout(
      executeFetch(cacheKey, doFetch),
      inflightBackstopMs,
      `fetchCache ${cacheKey}`,
    )
      .then((fresh) => {
        const ttl = opts?.ttl ?? freshTtlForStatus(fresh.status);
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

  return {
    fetchWithCache,
    clear() {
      store.clear();
      inflight.clear();
    },
    getStats() {
      return { entries: store.size, inflight: inflight.size };
    },
  };
}
