import type { CacheStorage } from "./cacheStorage";
import { decodeBase64, encodeBase64 } from "./encoding";

interface StoredResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
}

/**
 * What `put` did. Reported for observability only (the edge-cache telemetry in
 * `@decocms/tanstack`); every outcome but `stored` used to be silent. The
 * write semantics are the same as before: nothing here throws.
 *
 * - `skipped:uncacheable` — no `max-age`, a `private`/`no-store`/`no-cache`
 *   `Cache-Control`, or a `Set-Cookie` on the copy to store.
 * - `skipped:too-large` — the body passed the 8 MiB buffering bound.
 * - `error` — the storage adapter threw.
 *
 * `stored` means the adapter accepted the write; an adapter may still drop it
 * on its own limits (an already-expired entry, the KV value size).
 */
export type ResponseCachePutResult =
  | "stored"
  | "skipped:uncacheable"
  | "skipped:too-large"
  | "error";

/** HTTP serialization belongs to the cache consumer, independent of its storage adapter. */
export function createResponseCache(storage: CacheStorage, scope: string) {
  const keyFor = (request: Request) => JSON.stringify([scope, "responses", request.url]);
  return {
    async match(request: Request): Promise<Response | undefined> {
      const raw = await storage.get(keyFor(request));
      if (raw === null) return undefined;
      try {
        const stored = JSON.parse(raw) as StoredResponse;
        // Uint8Array.from(string, mapper) creates a large temporary iterable array.
        // Decode straight into the byte buffer to keep cache hits proportional to body size.
        const body = decodeBase64(stored.body);
        return new Response([204, 205, 304].includes(stored.status) ? null : body, {
          status: stored.status,
          statusText: stored.statusText,
          headers: stored.headers,
        });
      } catch {
        return undefined;
      }
    },
    async put(request: Request, response: Response): Promise<ResponseCachePutResult> {
      const cc = response.headers.get("Cache-Control") ?? "";
      const ttl = Number(/(?:^|[,\s])max-age=(\d+)/i.exec(cc)?.[1] ?? 0);
      if (!ttl || /(?:private|no-store|no-cache)/i.test(cc) || response.headers.has("set-cookie"))
        return "skipped:uncacheable";
      const expiresAt = Date.now() + ttl * 1000;
      // Bound buffering before serialization; an oversized page can still stream to its caller.
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) {
            void reader.cancel().catch(() => {});
            return "skipped:too-large";
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value: StoredResponse = {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body: encodeBase64(bytes),
      };
      try {
        await storage.set(keyFor(request), JSON.stringify(value), expiresAt);
        return "stored";
      } catch {
        /* Cache writes must not fail the response or its waitUntil task. */
        return "error";
      }
    },
    async delete(request: Request): Promise<boolean> {
      // KV deletion has no "existed" result. Report an accepted deletion, avoiding an extra read.
      await storage.delete(keyFor(request));
      return true;
    },
  };
}
