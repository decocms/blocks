/**
 * Hosted block bodies by hash (see /next/hosted-releases-internals): an LRU
 * per isolate, bounded by bytes, in front of plain `fetch()` of
 * `sites/<site>/blocks/<hash>.json` through the delivery CDN.
 *
 * A hash always means the same body, so nothing here is ever invalidated.
 * Concurrent requests for one hash share one fetch; a fetch that fails isn't
 * kept, so the next request that needs it tries again.
 *
 * A shared fetch belongs to the request that started it, and some runtimes
 * (Cloudflare Workers) stop a request's I/O with its response: a fetch the
 * request only prefetched would then never settle, and every later request
 * that needs the body would wait on it forever. So:
 * - every fetch is kept alive until it settles (`keepAlive`: the platform's
 *   `waitUntil`), whoever started it;
 * - a request that joins another's fetch waits for it no longer than that
 *   fetch's own deadline (the 10 s every fetch has, plus a margin): past it
 *   the fetch is dropped from the map, that request's read fails with a
 *   `"timeout"` `ContentUnavailableError`, and the next request fetches
 *   again; a fetch already past its deadline when a request asks is dropped
 *   and fetched again at once.
 */

import { keepAlive } from "./background.ts";
import { BoundedMap } from "./boundedMap.ts";
import type { BodySource } from "./contentIndex.ts";
import { ContentUnavailableError } from "./errors.ts";

/** The default byte bound of the LRU: the sum of the bodies' JSON text lengths. */
export const DEFAULT_BLOCK_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * How long a shared fetch may stay in flight: the 10 s each fetch has
 * (headers and body), plus a second's margin. A fetch still in flight past
 * it is one whose request went away.
 */
export const IN_FLIGHT_DEADLINE_MS = 11_000;

/** A fetched body and the length of its JSON text. */
export interface FetchedBody {
  body: unknown;
  bytes: number;
}

interface InFlight {
  body: Promise<unknown>;
  /** When it started, in ms since the epoch. */
  at: number;
}

export class BlockStore implements BodySource {
  readonly #fetch: (hash: string, name: string) => Promise<FetchedBody>;
  readonly #lru: BoundedMap<string, FetchedBody>;
  readonly #deadlineMs: number;
  readonly #inFlight = new Map<string, InFlight>();

  constructor(
    fetchBody: (hash: string, name: string) => Promise<FetchedBody>,
    limitBytes = DEFAULT_BLOCK_CACHE_BYTES,
    deadlineMs = IN_FLIGHT_DEADLINE_MS,
  ) {
    this.#fetch = fetchBody;
    this.#lru = new BoundedMap(limitBytes, (entry) => entry.bytes);
    this.#deadlineMs = deadlineMs;
  }

  peek(hash: string): unknown | undefined {
    return this.#lru.get(hash)?.body;
  }

  get(hash: string, name: string): Promise<unknown> {
    const held = this.#lru.get(hash);
    if (held !== undefined) return Promise.resolve(held.body);
    const shared = this.#inFlight.get(hash);
    if (shared !== undefined) {
      const left = shared.at + this.#deadlineMs - Date.now();
      if (left > 0) return this.#join(hash, name, shared, left);
      // Past its deadline: its request went away without settling it.
      this.#inFlight.delete(hash);
    }
    return this.#start(hash, name);
  }

  #start(hash: string, name: string): Promise<unknown> {
    const body = this.#fetch(hash, name).then((fetched) => {
      this.#lru.set(hash, fetched);
      return fetched.body;
    });
    const entry: InFlight = { body, at: Date.now() };
    this.#inFlight.set(hash, entry);
    const settle = () => {
      if (this.#inFlight.get(hash) === entry) this.#inFlight.delete(hash);
    };
    body.then(settle, settle);
    keepAlive(body);
    return body;
  }

  /** Another request's fetch, awaited for at most `ms`. */
  #join(hash: string, name: string, entry: InFlight, ms: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#inFlight.get(hash) === entry) this.#inFlight.delete(hash);
        reject(
          new ContentUnavailableError(
            "timeout",
            `block "${name}" (${hash}): no answer within ${this.#deadlineMs} ms`,
          ),
        );
      }, ms) as unknown as { unref?: () => void };
      timer?.unref?.();
      entry.body.then(
        (body) => {
          clearTimeout(timer as unknown as number);
          resolve(body);
        },
        (error: unknown) => {
          clearTimeout(timer as unknown as number);
          reject(error);
        },
      );
    });
  }
}
