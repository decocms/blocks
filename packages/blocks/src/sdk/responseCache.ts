import type { CacheStorage } from "./cacheStorage";

interface StoredResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
}

/** HTTP serialization belongs to the cache consumer, independent of its storage adapter. */
export function createResponseCache(storage: CacheStorage, scope: string) {
  const keyFor = (request: Request) => JSON.stringify([scope, "responses", request.url]);
  return {
    async match(request: Request): Promise<Response | undefined> {
      const raw = await storage.get(keyFor(request));
      if (raw === null) return undefined;
      try {
        const stored = JSON.parse(raw) as StoredResponse;
        const body = Uint8Array.from(atob(stored.body), (c) => c.charCodeAt(0));
        return new Response([204, 205, 304].includes(stored.status) ? null : body, {
          status: stored.status,
          statusText: stored.statusText,
          headers: stored.headers,
        });
      } catch {
        return undefined;
      }
    },
    async put(request: Request, response: Response): Promise<void> {
      const cc = response.headers.get("Cache-Control") ?? "";
      const ttl = Number(/(?:^|[,\s])max-age=(\d+)/i.exec(cc)?.[1] ?? 0);
      if (!ttl || /(?:private|no-store|no-cache)/i.test(cc) || response.headers.has("set-cookie"))
        return;
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
            return;
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
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      const value: StoredResponse = {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body: btoa(binary),
      };
      try {
        await storage.set(keyFor(request), JSON.stringify(value), expiresAt);
      } catch {
        /* Cache writes must not fail the response or its waitUntil task. */
      }
    },
    async delete(request: Request): Promise<boolean> {
      // KV deletion has no "existed" result. Report an accepted deletion, avoiding an extra read.
      await storage.delete(keyFor(request));
      return true;
    },
  };
}
