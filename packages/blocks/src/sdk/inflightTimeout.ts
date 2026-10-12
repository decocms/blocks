/**
 * Inflight-Promise timeout guard for module-level dedup caches.
 *
 * Background: across `@decocms/start` (and `@decocms/apps`) we keep
 * `Map<string, Promise<...>>` caches at module scope to dedup concurrent
 * resolutions of the same loader / section / layout block. Entries are
 * evicted via `.finally()` on the stored Promise.
 *
 * The problem: if the wrapped work never settles — e.g. an upstream `fetch()`
 * hangs because a CDN holds the TCP connection open — the `.finally()` never
 * runs and the Map entry leaks forever. With
 * `no_handle_cross_request_promise_resolution: true` on the consumer Worker,
 * the zombie Promise survives across requests. Every subsequent caller for
 * the same key `await`s it, pinning request context into memory until
 * `exceededMemory` terminates the isolate.
 *
 * Production observation on a TanStack Start storefront (24h window): 514
 * hard `exceededMemory` crashes, with CPU time ~0 and wall time in the tens
 * of minutes — workers sleeping on the dead Promise, not computing.
 *
 * Fix: race the stored Promise against a timeout so its terminal state is
 * guaranteed, which means `.finally()` always runs and the Map slot is
 * freed. The underlying hung work is abandoned (the CF runtime will GC it
 * once the request ends).
 */

/** Default per-entry timeout for inflight dedup caches. */
export const DEFAULT_INFLIGHT_TIMEOUT_MS = 10_000;

/**
 * Race `work` against a timeout. If `work` doesn't settle within `ms`, the
 * returned Promise rejects with a descriptive error so callers' `.finally()`
 * cleanup always runs.
 */
export function withInflightTimeout<T>(
  work: Promise<T>,
  label: string,
  ms: number = DEFAULT_INFLIGHT_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `[blocks] inflight cache entry "${label}" timed out after ${ms}ms`,
        ),
      );
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Join a shared inflight Promise with a timeout of the JOINER's own.
 *
 * `withInflightTimeout` arms its timer in the owner's request. On Cloudflare
 * Workers that request's I/O — and its timers — are cancelled when its client
 * disconnects (reload, navigation, closed tab), so a Promise the owner left in
 * a module-level dedup map may never settle, and the owner's timeout never
 * fires either. Every later caller that joins it would hang for the life of
 * the isolate.
 *
 * The timer here is created by the caller that joins, so it lives as long as
 * that caller's request. If `shared` has not settled within `ms`, `onStall`
 * runs and its result answers the joiner instead — callers use it to evict the
 * dead slot (when it still holds `shared`) and start their own work. If
 * `shared` settles first, the joiner gets its result, as before.
 */
export function joinInflight<T>(
  shared: Promise<T>,
  onStall: () => Promise<T>,
  ms: number = DEFAULT_INFLIGHT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onStall().then(resolve, reject);
    }, ms);
    shared.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
