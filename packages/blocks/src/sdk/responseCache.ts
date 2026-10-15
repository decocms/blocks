import type { CacheStorage } from "./cacheStorage";
import { decodeBase64 } from "./encoding";

interface StoredResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
}

interface StoredHead {
  status: number;
  statusText: string;
  headers: [string, string][];
  expiresAt: number;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const NULL_BODY = [204, 205, 304];

/** Frame: u32 big-endian head length, UTF-8 JSON head, raw body. One copy of the body, no base64. */
function encodeFrame(
  head: StoredHead,
  chunks: Uint8Array[],
  size: number,
): Uint8Array<ArrayBuffer> {
  const headBytes = new TextEncoder().encode(JSON.stringify(head));
  const frame = new Uint8Array(4 + headBytes.byteLength + size);
  new DataView(frame.buffer).setUint32(0, headBytes.byteLength);
  frame.set(headBytes, 4);
  let offset = 4 + headBytes.byteLength;
  for (const chunk of chunks) {
    frame.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return frame;
}

function decodeFrame(frame: Uint8Array<ArrayBuffer>): Response | undefined {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const headLength = view.getUint32(0);
  const head = JSON.parse(
    new TextDecoder().decode(frame.subarray(4, 4 + headLength)),
  ) as StoredHead;
  if (!Number.isFinite(head.expiresAt) || Date.now() >= head.expiresAt) return undefined;
  // subarray is a view: the body is handed to Response without another copy.
  const body = frame.subarray(4 + headLength);
  return new Response(NULL_BODY.includes(head.status) ? null : body, {
    status: head.status,
    statusText: head.statusText,
    headers: head.headers,
  });
}

/** Buffer a body up to the cap; `undefined` when it is larger (the caller still streams it). */
async function readBody(
  response: Response,
): Promise<{ chunks: Uint8Array[]; size: number } | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return { chunks, size };
  while (true) {
    const { done, value } = await reader.read();
    if (done) return { chunks, size };
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
}

export interface ResponseCacheOptions {
  /**
   * Store bodies as raw bytes when the storage supports it (`getBytes`/`setBytes`). Each
   * cached ~1 MB page otherwise passes through a binary string, base64 and two JSON copies
   * per storage tier — about 10x its size in transient allocations, the largest allocator
   * measured on a production storefront. Bytes entries use their own keys, so turning this
   * on or off never reads the other format; it only starts that format's cache cold.
   */
  bytes?: boolean;
}

/** HTTP serialization belongs to the cache consumer, independent of its storage adapter. */
export function createResponseCache(
  storage: CacheStorage,
  scope: string,
  { bytes = false }: ResponseCacheOptions = {},
) {
  const keyFor = (request: Request) => JSON.stringify([scope, "responses", request.url]);
  const bytesKeyFor = (request: Request) => JSON.stringify([scope, "responses:bytes", request.url]);
  const { getBytes, setBytes } = storage;
  const bytesStore = bytes && getBytes && setBytes ? { getBytes, setBytes } : undefined;
  return {
    async match(request: Request): Promise<Response | undefined> {
      if (bytesStore) {
        const frame = await bytesStore.getBytes.call(storage, bytesKeyFor(request));
        if (frame === null) return undefined;
        try {
          return decodeFrame(frame);
        } catch {
          return undefined;
        }
      }
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
    async put(request: Request, response: Response): Promise<void> {
      const cc = response.headers.get("Cache-Control") ?? "";
      const ttl = Number(/(?:^|[,\s])max-age=(\d+)/i.exec(cc)?.[1] ?? 0);
      if (!ttl || /(?:private|no-store|no-cache)/i.test(cc) || response.headers.has("set-cookie"))
        return;
      const expiresAt = Date.now() + ttl * 1000;
      if (bytesStore) {
        const body = await readBody(response);
        if (!body) return;
        const head: StoredHead = {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
          expiresAt,
        };
        try {
          await bytesStore.setBytes.call(
            storage,
            bytesKeyFor(request),
            encodeFrame(head, body.chunks, body.size),
            expiresAt,
          );
        } catch {
          /* Cache writes must not fail the response or its waitUntil task. */
        }
        return;
      }
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
      // Delete both formats: a purge must work whichever way the flag was when it was written.
      await Promise.all([storage.delete(keyFor(request)), storage.delete(bytesKeyFor(request))]);
      return true;
    },
  };
}
