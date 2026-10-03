/**
 * `kvLoader(namespace, { key })`: the content snapshot your deploy stored in a
 * Workers KV namespace, for sites whose content is too large to bundle. See
 * /next/api-reference#loaders and /next/hosted-publishing#large-content-on-workers.
 */
import type { Loader, Snapshot } from "@decocms/blocks";

/** The one KV method this loader calls; a Workers `KVNamespace` binding fits it. */
export interface KVNamespaceLike {
  get(key: string, type: "json"): Promise<unknown>;
}

/**
 * Reads the snapshot under `key` once per isolate and keeps it. It ignores
 * draft pointers and has no `update()`: the deploy writes the key before the
 * Worker takes traffic, and it doesn't change while the Worker runs. A missing
 * key or a failed read isn't kept, so the next request reads KV again.
 *
 * The kept read is a promise shared across requests, so the Worker needs the
 * `no_handle_cross_request_promise_resolution` compatibility flag, as the CMS
 * itself does (see /next/tanstack-start-descriptors).
 */
export function kvLoader(namespace: KVNamespaceLike, options: { key: string }): Loader {
  const { key } = options;
  let snapshot: Promise<Snapshot> | undefined;
  return {
    load() {
      if (snapshot === undefined) {
        const pending = namespace.get(key, "json").then((value) => {
          if (value === null || value === undefined) {
            throw new Error(`kvLoader: no content snapshot under the KV key "${key}"`);
          }
          return value as Snapshot;
        });
        snapshot = pending;
        pending.catch(() => {
          if (snapshot === pending) snapshot = undefined;
        });
      }
      return snapshot;
    },
  };
}
