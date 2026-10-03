/**
 * `kvLoader`: content kept in a Workers KV namespace instead of the bundle, for
 * large sites on Cloudflare Workers. See /next/api-reference#loaders and
 * /next/hosted-publishing#large-content-on-workers.
 *
 * Your deploy writes the content module (`{ revision, blocks }`) to `key`
 * before the new Worker takes traffic. The snapshot is read once per isolate
 * and kept; there are no drafts in it, so the pointer is ignored. A missing
 * key fails the load (`LOADER_FAILED`) and is retried on the next one.
 */
import type { Loader, Snapshot } from "@decocms/blocks";

/** The part of a Workers `KVNamespace` the loader uses. */
export interface KVNamespaceLike {
  get(key: string, type: "json"): Promise<unknown>;
}

export function kvLoader(namespace: KVNamespaceLike, { key }: { key: string }): Loader {
  let pending: Promise<Snapshot> | undefined;
  return {
    load() {
      if (pending === undefined) {
        const read = namespace.get(key, "json").then((value) => {
          if (value === null || value === undefined) {
            throw new Error(`kvLoader: no content under the KV key "${key}"`);
          }
          return value as Snapshot;
        });
        pending = read;
        read.catch(() => {
          if (pending === read) pending = undefined;
        });
      }
      return pending;
    },
  };
}
