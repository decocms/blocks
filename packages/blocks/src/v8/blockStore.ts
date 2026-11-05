/**
 * Hosted block bodies by hash (see /next/hosted-releases-internals): an LRU
 * per isolate, bounded by bytes, in front of plain `fetch()` of
 * `sites/<site>/blocks/<hash>.json` through the delivery CDN.
 *
 * A hash always means the same body, so nothing here is ever invalidated.
 * Concurrent requests for one hash share one fetch; a fetch that fails isn't
 * kept, so the next request that needs it tries again.
 */

import { BoundedMap } from "./boundedMap.ts";
import type { BodySource } from "./contentIndex.ts";

/** The default byte bound of the LRU: the sum of the bodies' JSON text lengths. */
export const DEFAULT_BLOCK_CACHE_BYTES = 32 * 1024 * 1024;

/** A fetched body and the length of its JSON text. */
export interface FetchedBody {
  body: unknown;
  bytes: number;
}

export class BlockStore implements BodySource {
  readonly #fetch: (hash: string, name: string) => Promise<FetchedBody>;
  readonly #lru: BoundedMap<string, FetchedBody>;
  readonly #inFlight = new Map<string, Promise<unknown>>();

  constructor(
    fetchBody: (hash: string, name: string) => Promise<FetchedBody>,
    limitBytes = DEFAULT_BLOCK_CACHE_BYTES,
  ) {
    this.#fetch = fetchBody;
    this.#lru = new BoundedMap(limitBytes, (entry) => entry.bytes);
  }

  peek(hash: string): unknown | undefined {
    return this.#lru.get(hash)?.body;
  }

  get(hash: string, name: string): Promise<unknown> {
    const held = this.#lru.get(hash);
    if (held !== undefined) return Promise.resolve(held.body);
    let pending = this.#inFlight.get(hash);
    if (pending === undefined) {
      const fetching = this.#fetch(hash, name).then((fetched) => {
        this.#lru.set(hash, fetched);
        return fetched.body;
      });
      pending = fetching;
      this.#inFlight.set(hash, fetching);
      const settle = () => {
        if (this.#inFlight.get(hash) === fetching) this.#inFlight.delete(hash);
      };
      fetching.then(settle, settle);
    }
    return pending;
  }
}
