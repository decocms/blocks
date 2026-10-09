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
 * A dedup slot that remembers when its flight started.
 *
 * Expiry is checked against `startedAt` on read rather than scheduled with a
 * timer: on Workers, a `setTimeout` registered by a request whose response
 * already went out (or that was cancelled) never fires, so a timer-based
 * release would leave exactly the zombie slot it was meant to free.
 */
export interface InflightSlot<V> {
  readonly promise: Promise<V>;
  readonly startedAt: number;
}

/** Module-level dedup map whose slots expire after a bound (see `getLiveInflight`). */
export type InflightMap<K, V> = Map<K, InflightSlot<V>>;

/**
 * Return the promise of a flight still worth joining, or `undefined`.
 *
 * A slot older than `ms` is deleted and treated as absent, so the caller starts
 * its own work instead of awaiting a possibly-hung one forever. Unlike
 * `withInflightTimeout`, nothing is rejected: whoever already joined the old
 * flight keeps waiting on it — only NEW callers stop joining it.
 */
export function getLiveInflight<K, V>(
  map: InflightMap<K, V>,
  key: K,
  ms: number = DEFAULT_INFLIGHT_TIMEOUT_MS,
): Promise<V> | undefined {
  const slot = map.get(key);
  if (!slot) return undefined;
  if (Date.now() - slot.startedAt > ms) {
    map.delete(key);
    return undefined;
  }
  return slot.promise;
}

/**
 * Register `work` as the flight for `key` and return the promise to hand out.
 *
 * The slot is cleared when `work` settles, but only if it is still this
 * flight's — a newer flight that replaced an expired one keeps its slot. Slots
 * of other keys that already expired are swept here too: a hung flight whose
 * key is never read again would otherwise stay in the map for the life of the
 * isolate.
 */
export function setInflight<K, V>(
  map: InflightMap<K, V>,
  key: K,
  work: Promise<V>,
  ms: number = DEFAULT_INFLIGHT_TIMEOUT_MS,
): Promise<V> {
  const now = Date.now();
  for (const [k, s] of map) {
    if (now - s.startedAt > ms) map.delete(k);
  }
  const slot: InflightSlot<V> = {
    startedAt: now,
    promise: work.finally(() => {
      if (map.get(key) === slot) map.delete(key);
    }),
  };
  map.set(key, slot);
  return slot.promise;
}
