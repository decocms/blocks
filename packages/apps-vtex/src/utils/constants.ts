/**
 * Tuning knobs for the VTEX fetch resilience + cache layer.
 *
 * Every timeout, limit, and threshold that governs how `resilience.ts`
 * (abort/timeout, circuit breaker, retry budget) and `fetchCache.ts` (SWR +
 * stale-if-error) behave under VTEX slowness/outages lives HERE, in one file,
 * with the reasoning for each number next to it. Auditing or tuning the
 * resilience posture means reading one file, not hunting across two.
 */

// ---------------------------------------------------------------------------
// fetchCache.ts — SWR + stale-if-error cache for VTEX GET responses
// ---------------------------------------------------------------------------

/** Max distinct cache keys kept in memory; oldest `createdAt` evicted first. */
export const FETCH_CACHE_MAX_ENTRIES = 500;

/**
 * How long a cached response is considered FRESH, keyed by status class.
 * Past this the entry is stale — served via SWR (2xx) while a background
 * refresh runs, or treated as expired (404/5xx). See `ttlForStatus` in
 * `fetchCache.ts`.
 */
export const FETCH_CACHE_FRESH_TTL_MS = {
  /** 2xx — 3 min. Catalog/price data doesn't need to be second-fresh. */
  success: 180_000,
  /** 404 — 10s. Short on purpose: a just-published SKU shouldn't 404 long. */
  notFound: 10_000,
  /** 5xx — never "fresh". A server error is never treated as a good cache hit. */
  serverError: 0,
} as const;

/**
 * Stale-if-error window: how long PAST the freshness TTL a last-good 2xx entry
 * may still be served when the origin is failing (5xx / timeout / circuit
 * open). This is the "availability first" knob — a warm key survives a full
 * VTEX outage for up to this long with zero upstream pressure; once an entry
 * is older than `freshTtl + this`, it's considered too stale to serve and the
 * error surfaces (→ the degraded / branded-error path takes over). Mirrors the
 * edge `sie` window sites configure for the product/listing cache profiles.
 */
export const FETCH_CACHE_STALE_IF_ERROR_MS = 86_400_000; // 24h

/**
 * Inflight-slot backstop timeout. Bounds how long a single hung `fetch()` can
 * hold a dedup entry alive. Without this, a VTEX subrequest that never
 * settles leaks the inflight Map slot forever and every subsequent request
 * for the same cache key joins the zombie Promise, pinning memory until
 * `exceededMemory` (observed in prod: 514 hard crashes / 24h on a PLP route).
 *
 * MUST stay ABOVE `RESILIENCE_CONFIG.totalTimeoutMs` (see below) — the
 * resilient fetch already owns real per-call abort/timeout, so this is only a
 * last-resort backstop. If it fired first it would kill a slow-but-recoverable
 * response the resilience layer was about to deliver, discard the good body
 * (it never reaches the cache), and free the dedup slot early so a concurrent
 * request launches a duplicate upstream fetch.
 */
export const FETCH_CACHE_INFLIGHT_BACKSTOP_MS = 15_000;

// ---------------------------------------------------------------------------
// resilience.ts — abort/timeout, retry budget, circuit breaker
// ---------------------------------------------------------------------------

export interface ResilienceConfig {
  /** Per-attempt timeout in ms. Aborts the socket. */
  perAttemptTimeoutMs: number;
  /** Total time budget across all attempts (incl. backoff) in ms. */
  totalTimeoutMs: number;
  /** Max retries for idempotent requests (attempts = maxRetries + 1). */
  maxRetries: number;
  /** Exponential backoff base in ms. */
  backoffBaseMs: number;
  /** Exponential backoff cap in ms. */
  backoffCapMs: number;
  /** Consecutive failures before the breaker opens. */
  breakerConsecutiveFailures: number;
  /** How long the breaker stays open before half-opening, in ms. */
  breakerOpenCooldownMs: number;
  /** Number of probe requests allowed while half-open. */
  breakerHalfOpenProbes: number;
  /** Max retry tokens per host (token bucket). */
  retryBudgetMax: number;
  /** Token refill rate per second. */
  retryBudgetRefillPerSec: number;
}

export const DEFAULT_RESILIENCE_CONFIG: ResilienceConfig = {
  perAttemptTimeoutMs: 8_000,
  totalTimeoutMs: 12_000,
  maxRetries: 2,
  backoffBaseMs: 150,
  backoffCapMs: 1_000,
  breakerConsecutiveFailures: 5,
  breakerOpenCooldownMs: 5_000,
  breakerHalfOpenProbes: 3,
  retryBudgetMax: 20,
  retryBudgetRefillPerSec: 5,
};
