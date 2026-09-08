import { RequestContext } from "./requestContext";

/** Storage only. Values are serialized by the caller; expiration is absolute epoch ms. */
export interface CacheStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiresAt: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CacheStorageContext {
  storage: CacheStorage | null;
  /** Include site, deployment and content revision. Never use a tenant-wide global binding. */
  scope: string;
  /** Bypass both memory and shared storage for previews or private requests. */
  disabled?: boolean;
  waitUntil?: (work: Promise<unknown>) => void;
}

const BAG_KEY = "deco:cache-storage";

export function bindCacheStorage(context: CacheStorageContext): void {
  RequestContext.setBag(BAG_KEY, context);
}

export function getCacheStorageContext(): CacheStorageContext | undefined {
  return RequestContext.getBag<CacheStorageContext>(BAG_KEY);
}

/** Keep optional cache work alive on Workers, without letting storage errors fail a request. */
export function cacheBackground(work: Promise<unknown>): void {
  const safe = work.catch(() => {});
  getCacheStorageContext()?.waitUntil?.(safe);
}

export async function hashCacheKey(key: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface StoredValue {
  value: string;
  expiresAt: number;
}

function decode(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const entry = JSON.parse(raw) as StoredValue;
    return typeof entry.value === "string" &&
      Number.isFinite(entry.expiresAt) &&
      Date.now() < entry.expiresAt
      ? entry.value
      : null;
  } catch {
    return null;
  }
}

/** Bounded LRU adapter, useful in Node, development and tests. */
export function createMemoryCacheStorage(maxBytes = 32 * 1024 * 1024): CacheStorage {
  const entries = new Map<string, string>();
  let bytes = 0;
  function remove(key: string) {
    const old = entries.get(key);
    if (old !== undefined) bytes -= (key.length + old.length) * 2;
    entries.delete(key);
  }
  return {
    async get(key) {
      const raw = entries.get(key);
      const value = decode(raw ?? null);
      if (value === null) remove(key);
      else {
        entries.delete(key);
        entries.set(key, raw!);
      }
      return value;
    },
    async set(key, value, expiresAt) {
      remove(key);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
      const raw = JSON.stringify({ value, expiresAt });
      const size = (key.length + raw.length) * 2;
      if (size > maxBytes) return;
      entries.set(key, raw);
      bytes += size;
      while (bytes > maxBytes) remove(entries.keys().next().value!);
    },
    async delete(key) {
      remove(key);
    },
  };
}

/** Structural binding type; the core has no Cloudflare package dependency. */
export interface CacheKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createKVCacheStorage(
  kv: CacheKVNamespace,
  prefix = "deco-cache:v1:",
): CacheStorage {
  const keyFor = async (key: string) => prefix + (await hashCacheKey(key));
  return {
    async get(key) {
      return decode(await kv.get(await keyFor(key)));
    },
    async set(key, value, expiresAt) {
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
      const raw = JSON.stringify({ value, expiresAt });
      // Leave space below KV's 25 MiB value limit. Oversized cache entries are optional.
      if (new TextEncoder().encode(raw).byteLength > 25 * 1024 * 1024) return;
      await kv.put(await keyFor(key), raw, {
        expirationTtl: Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000)),
      });
    },
    async delete(key) {
      await kv.delete(await keyFor(key));
    },
  };
}

/** The app supplies the native cache and its origin; no global API detection in consumers. */
export function createWebCacheStorage(
  cache: Pick<Cache, "match" | "put" | "delete">,
  origin: string,
): CacheStorage {
  const requestFor = async (key: string) =>
    new Request(new URL(`/__deco_cache/${await hashCacheKey(key)}`, origin));
  return {
    async get(key) {
      const response = await cache.match(await requestFor(key));
      return decode(response ? await response.text() : null);
    },
    async set(key, value, expiresAt) {
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
      await cache.put(
        await requestFor(key),
        new Response(JSON.stringify({ value, expiresAt }), {
          headers: {
            "Cache-Control": `public, max-age=${Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000))}`,
          },
        }),
      );
    },
    async delete(key) {
      await cache.delete(await requestFor(key));
    },
  };
}

/** Reject values JSON would silently change, including dates, functions and circular references. */
function serialize(value: unknown): string | undefined {
  const seen = new Set<object>();
  function check(v: unknown): void {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    // Optional object fields are common in section props. JSON omits them safely.
    if (v === undefined) return;
    if (typeof v !== "object" || seen.has(v)) throw new Error("Unsupported cached value");
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    ) {
      throw new Error("Unsupported cached object");
    }
    seen.add(v);
    for (const item of Object.values(v)) check(item);
    seen.delete(v);
  }
  check(value);
  return JSON.stringify(value);
}

/**
 * Typed cache with a bounded, decoded memory tier. All remote access uses CacheStorage.
 * Call key() once per operation so a content change cannot redirect an in-flight write.
 * In-flight promises remain in the calling isolate; only completed results are persisted.
 */
export function createCacheStore<T>(
  namespace: string,
  maxEntries = 200,
  maxBytes = 4 * 1024 * 1024,
  sizeOf?: (value: T) => number,
) {
  const local = new Map<string, { value: T; expiresAt: number; bytes: number }>();
  let bytes = 0;
  let generation = 0;
  function remove(key: string) {
    const entry = local.get(key);
    if (entry) bytes -= entry.bytes;
    local.delete(key);
  }
  function remember(key: string, value: T, expiresAt: number) {
    remove(key);
    let size: number;
    try {
      size = sizeOf
        ? sizeOf(value)
        : Math.max(512, (key.length + (JSON.stringify(value)?.length ?? 0)) * 2);
    } catch {
      size = 1024;
    }
    if (size > maxBytes) return;
    local.set(key, { value, expiresAt, bytes: size });
    bytes += size;
    while (local.size > 0 && (local.size > maxEntries || bytes > maxBytes))
      remove(local.keys().next().value!);
  }
  function get(key: string): T | undefined {
    if (getCacheStorageContext()?.disabled) return undefined;
    const entry = local.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      remove(key);
      return undefined;
    }
    local.delete(key);
    local.set(key, entry);
    return entry.value;
  }
  return {
    key(raw: string): string {
      return JSON.stringify([getCacheStorageContext()?.scope ?? "local", namespace, raw]);
    },
    get,
    async read(key: string): Promise<T | undefined> {
      const hit = get(key);
      if (hit !== undefined) return hit;
      const context = getCacheStorageContext();
      if (!context?.storage || context.disabled) return undefined;
      const gen = generation;
      try {
        const raw = await context.storage.get(key);
        if (gen !== generation) return undefined;
        const concurrent = get(key);
        if (concurrent !== undefined) return concurrent;
        if (raw === null) return undefined;
        const entry = JSON.parse(raw) as { value: T; expiresAt: number };
        if (!Number.isFinite(entry.expiresAt) || Date.now() >= entry.expiresAt) return undefined;
        remember(key, entry.value, entry.expiresAt);
        return entry.value;
      } catch {
        return undefined;
      }
    },
    set(key: string, value: T, expiresAt: number, persist = true): void {
      if (
        getCacheStorageContext()?.disabled ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
      )
        return;
      remember(key, value, expiresAt);
      const storage = getCacheStorageContext()?.storage;
      if (!persist || !storage || !Number.isFinite(expiresAt)) return;
      try {
        const raw = serialize({ value, expiresAt });
        if (raw !== undefined) cacheBackground(storage.set(key, raw, expiresAt));
      } catch {
        /* Non-serializable results remain in the memory tier. */
      }
    },
    delete(key: string): void {
      remove(key);
    },
    /** Local eviction only. Shared invalidation uses a new scope/version or storage.delete(). */
    clear(): void {
      local.clear();
      bytes = 0;
      generation++;
    },
    get size(): number {
      return local.size;
    },
    get estimatedBytes(): number {
      return bytes;
    },
    *entries(): IterableIterator<[string, T]> {
      for (const [key, entry] of local) yield [key, entry.value];
    },
  };
}
