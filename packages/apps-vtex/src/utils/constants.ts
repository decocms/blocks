/**
 * Tuning knobs for VTEX request resilience (timeouts, retries, circuit
 * breaker), with the reasoning for each number next to it.
 */

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
