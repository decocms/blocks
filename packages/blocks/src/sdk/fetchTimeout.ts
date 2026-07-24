/**
 * Default network-level timeout for outbound `fetch()` calls.
 *
 * Background: nothing in `@decocms/blocks` previously bounded how long an
 * outbound fetch could hang. `withInflightTimeout` (see `./inflightTimeout.ts`)
 * only frees the module-level dedup Map slot when a wrapped Promise never
 * settles — it abandons the underlying fetch rather than aborting it, so the
 * TCP connection (and the isolate memory pinned to it) stays alive until the
 * runtime kills the request. This module fixes the root cause: actually abort
 * the request via `AbortSignal.timeout`, composed with any caller-supplied
 * signal so callers that already do their own cancellation aren't overridden.
 */

/** Default per-request timeout for outbound fetch calls. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Combine a caller-supplied `AbortSignal` (if any) with a timeout signal, so
 * neither cancellation source is lost. Pass `timeoutMs <= 0` or
 * non-finite to opt out of the timeout entirely (e.g. long-lived streaming
 * requests) while still honoring the caller's own signal.
 */
export function withTimeoutSignal(
  signal: AbortSignal | undefined | null,
  timeoutMs: number,
): AbortSignal | undefined {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return signal ?? undefined;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

/**
 * Wrap a `fetch` implementation so every call is aborted after `timeoutMs`
 * unless it settles first. Use directly at ad-hoc fetch call sites that
 * don't go through `createInstrumentedFetch` (e.g. one-off API clients).
 *
 * When `baseFetch` is omitted, `globalThis.fetch` is resolved on every call
 * (not captured once at wrap time) so tests that swap `globalThis.fetch`
 * with a mock after this module loads still get intercepted.
 */
export function withFetchTimeout(
  baseFetch?: typeof fetch,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): typeof fetch {
  return (input, init) =>
    (baseFetch ?? globalThis.fetch)(input, {
      ...init,
      signal: withTimeoutSignal(init?.signal, timeoutMs),
    });
}
