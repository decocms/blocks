/**
 * VTEX fetch resilience — real request abort, circuit breaker, and a bounded
 * retry budget for the whole VTEX egress surface.
 *
 * Wraps a `typeof fetch` and is composed into `createVtexFetch` UNDER the
 * instrumentation layer, so it covers 100% of VTEX traffic — cached GETs,
 * Intelligent Search, and the checkout/cart/session POSTs — with zero
 * call-site changes.
 *
 * Motivation: on a VTEX upstream slowdown, the previous stack cascaded into
 * client-abort 499s (the SSR hangs on a socket that is never freed — the old
 * `fetchCache` timeout was a `Promise.race` that only frees the dedup slot, not
 * the connection) and, on the checkout POST path (which had no timeout/retry at
 * all), hard 500s — while a retry storm amplified load on an already-struggling
 * upstream.
 *
 * Three composed layers, per call:
 *   1. AbortController with a real per-attempt timeout, bounded by a total cap
 *      across retries. Frees the TCP connection on VTEX slowness. The caller's
 *      own `signal` (e.g. an SSR deadline) is unioned in, so a request-level
 *      abort also cancels the in-flight VTEX call.
 *   2. Retry for IDEMPOTENT methods only (GET/HEAD, never a request with a
 *      body — a checkout POST must never be retried) on network errors and
 *      abort-by-timeout, with exponential backoff + jitter and a per-host retry
 *      budget (token bucket) so a broad outage can't become a self-inflicted
 *      DDoS. Retrying a 5xx *status* is intentionally left to the SWR
 *      `fetchCache` layer to avoid double-retry; this layer still counts a 5xx
 *      response as a breaker failure.
 *   3. A circuit breaker per host — opens on consecutive failures, fails fast
 *      (no socket, no retry) with {@link VtexCircuitOpenError} while open, and
 *      half-opens a bounded number of probes after a cooldown. State is
 *      per-isolate: on Workers each isolate self-protects, no shared
 *      coordination needed.
 *
 * Kill-switch: set `VTEX_RESILIENCE_DISABLED=true` to fall straight through to
 * the underlying fetch (emergency escape hatch — an env flip, no code deploy).
 */

import { RequestContext } from "@decocms/blocks/sdk/requestContext";

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

// --- Errors ---------------------------------------------------------------

export class VtexCircuitOpenError extends Error {
  readonly host: string;
  readonly isVtexResilience = true as const;
  constructor(host: string) {
    super(`VTEX circuit open for ${host} — failing fast`);
    this.name = "VtexCircuitOpenError";
    this.host = host;
  }
}

export class VtexTimeoutError extends Error {
  readonly host: string;
  readonly isVtexResilience = true as const;
  constructor(host: string, ms: number) {
    super(`VTEX request to ${host} aborted after ${ms}ms`);
    this.name = "VtexTimeoutError";
    this.host = host;
  }
}

/**
 * True for errors that the SWR `fetchCache` layer must NOT retry — the breaker
 * already decided to shed load, and a timed-out request will just time out
 * again. Retrying these would defeat the fast-fail / socket-freeing behavior.
 */
export function isNonRetryableVtexError(error: unknown): boolean {
  return error instanceof VtexCircuitOpenError || error instanceof VtexTimeoutError;
}

// --- Kill switch ----------------------------------------------------------

function isDisabled(): boolean {
  try {
    return globalThis.process?.env?.VTEX_RESILIENCE_DISABLED === "true";
  } catch {
    return false;
  }
}

// --- Circuit breaker (per host) ------------------------------------------

type BreakerState = "closed" | "open" | "half-open";

interface Breaker {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  halfOpenInFlight: number;
}

const breakers = new Map<string, Breaker>();

function getBreaker(host: string): Breaker {
  let b = breakers.get(host);
  if (!b) {
    b = { state: "closed", consecutiveFailures: 0, openedAt: 0, halfOpenInFlight: 0 };
    breakers.set(host, b);
  }
  return b;
}

function breakerAllows(b: Breaker, cfg: ResilienceConfig, now: number): boolean {
  if (b.state === "closed") return true;
  if (b.state === "open") {
    if (now - b.openedAt >= cfg.breakerOpenCooldownMs) {
      b.state = "half-open";
      b.halfOpenInFlight = 0;
    } else {
      return false;
    }
  }
  if (b.halfOpenInFlight >= cfg.breakerHalfOpenProbes) return false;
  b.halfOpenInFlight++;
  return true;
}

function breakerOnSuccess(b: Breaker) {
  const wasOpen = b.state !== "closed";
  b.consecutiveFailures = 0;
  b.halfOpenInFlight = Math.max(0, b.halfOpenInFlight - 1);
  b.state = "closed";
  b.openedAt = 0;
  if (wasOpen) console.warn("[vtex-resilience] circuit CLOSED (recovered)");
}

function breakerOnFailure(b: Breaker, cfg: ResilienceConfig, host: string, now: number) {
  b.halfOpenInFlight = Math.max(0, b.halfOpenInFlight - 1);
  if (b.state === "half-open") {
    b.state = "open";
    b.openedAt = now;
    console.warn(`[vtex-resilience] circuit RE-OPENED for ${host} (probe failed)`);
    return;
  }
  b.consecutiveFailures++;
  if (b.state === "closed" && b.consecutiveFailures >= cfg.breakerConsecutiveFailures) {
    b.state = "open";
    b.openedAt = now;
    console.warn(
      `[vtex-resilience] circuit OPEN for ${host} after ${b.consecutiveFailures} consecutive failures`,
    );
  }
}

// --- Retry budget (token bucket per host) --------------------------------

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

function tryTakeRetryToken(host: string, cfg: ResilienceConfig, now: number): boolean {
  let bucket = buckets.get(host);
  if (!bucket) {
    bucket = { tokens: cfg.retryBudgetMax, lastRefill: now };
    buckets.set(host, bucket);
  }
  const elapsedSec = (now - bucket.lastRefill) / 1000;
  if (elapsedSec > 0) {
    bucket.tokens = Math.min(
      cfg.retryBudgetMax,
      bucket.tokens + elapsedSec * cfg.retryBudgetRefillPerSec,
    );
    bucket.lastRefill = now;
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

/** Reset all breaker + budget state. Test-only. */
export function resetResilienceState() {
  breakers.clear();
  buckets.clear();
}

// --- Helpers --------------------------------------------------------------

function hostOf(input: RequestInfo | URL): string {
  try {
    if (typeof input === "string") return new URL(input).host;
    if (input instanceof URL) return input.host;
    if (input instanceof Request) return new URL(input.url).host;
  } catch {
    /* fall through */
  }
  return "unknown";
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const m = init?.method ?? (input instanceof Request ? input.method : "GET");
  return m.toUpperCase();
}

/** Only GET/HEAD without a body are safe to retry. Never retry a mutation. */
function isIdempotent(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = methodOf(input, init);
  if (method !== "GET" && method !== "HEAD") return false;
  if (init?.body != null) return false;
  if (input instanceof Request && input.body != null) return false;
  return true;
}

function backoffDelay(cfg: ResilienceConfig, attempt: number): number {
  const base = Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** attempt);
  // Full jitter, derived from a coarse clock read so we don't depend on
  // Math.random (unavailable in some sandboxes).
  const jitter = (Date.now() % 100) / 100;
  return Math.round(base * (0.5 + 0.5 * jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for a fetch abort (DOMException / Error with name "AbortError"). */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError"
  );
}

/**
 * Union any number of upstream signals with our per-attempt timeout so a caller
 * abort, the ambient request abort (client disconnect / SSR deadline via
 * {@link RequestContext}), OR the timeout all cancel the underlying fetch and
 * free the socket.
 */
function withTimeoutSignal(
  callerSignals: Array<AbortSignal | null | undefined>,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let didTimeout = false;
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  const bound: AbortSignal[] = [];
  for (const s of callerSignals) {
    if (!s) continue;
    if (s.aborted) controller.abort();
    else {
      s.addEventListener("abort", onAbort, { once: true });
      bound.push(s);
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      for (const s of bound) s.removeEventListener("abort", onAbort);
    },
    timedOut: () => didTimeout,
  };
}

// --- The resilient fetch --------------------------------------------------

/**
 * Wrap a `typeof fetch` with abort/timeout + retry-budget + circuit breaker.
 * Pass the result as the `baseFetch` of {@link createVtexFetch}.
 */
export function createResilientFetch(
  underlying: typeof fetch = globalThis.fetch,
  config: Partial<ResilienceConfig> = {},
): typeof fetch {
  const cfg: ResilienceConfig = { ...DEFAULT_RESILIENCE_CONFIG, ...config };

  return async function resilientFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (isDisabled()) return underlying(input, init);

    const host = hostOf(input);
    const breaker = getBreaker(host);
    const idempotent = isIdempotent(input, init);
    const startedAt = Date.now();

    if (!breakerAllows(breaker, cfg, startedAt)) {
      throw new VtexCircuitOpenError(host);
    }

    const attempts = idempotent ? cfg.maxRetries + 1 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const elapsed = Date.now() - startedAt;
      const remaining = cfg.totalTimeoutMs - elapsed;
      if (remaining <= 0) break;
      const perAttempt = Math.min(cfg.perAttemptTimeoutMs, remaining);

      // Union the caller's signal with the ambient request signal so a client
      // disconnect (or a request-level SSR deadline) also aborts the VTEX call.
      const { signal, cleanup, timedOut } = withTimeoutSignal(
        [init?.signal, RequestContext.current?.signal],
        perAttempt,
      );
      try {
        const response = await underlying(input, { ...init, signal });
        cleanup();

        // A 5xx counts as a breaker failure even though we return it (the
        // SWR/edge layers decide whether to serve stale). Status retries
        // are owned by the fetchCache layer to avoid double-retry.
        if (response.status >= 500) breakerOnFailure(breaker, cfg, host, Date.now());
        else breakerOnSuccess(breaker);
        return response;
      } catch (err) {
        cleanup();

        // An abort that did NOT come from our own timeout timer is a caller /
        // ambient abort — a client disconnect or a request-level cancel via
        // RequestContext.signal. That is NOT an upstream failure: it must not
        // count toward the breaker (a burst of users hitting "stop" would
        // otherwise trip the circuit against a perfectly healthy VTEX) and must
        // not be retried (the signal is still aborted). Surface it as-is.
        if (!timedOut() && isAbortError(err)) throw err;

        lastError = timedOut() ? new VtexTimeoutError(host, perAttempt) : err;
        breakerOnFailure(breaker, cfg, host, Date.now());

        const canRetry =
          idempotent &&
          attempt < attempts - 1 &&
          Date.now() - startedAt < cfg.totalTimeoutMs &&
          tryTakeRetryToken(host, cfg, Date.now());
        if (canRetry) {
          await sleep(backoffDelay(cfg, attempt));
          continue;
        }
        throw lastError;
      }
    }

    throw lastError ?? new VtexTimeoutError(host, cfg.totalTimeoutMs);
  };
}
