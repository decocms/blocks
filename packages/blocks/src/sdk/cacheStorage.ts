import { RequestContext } from "./requestContext";

/** Storage only. Values are serialized by the caller; expiration is absolute epoch ms. */
export interface CacheStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiresAt: number): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Optional opaque-bytes variant, for values that are bytes already (HTTP bodies).
   * Storing those as strings costs a binary string, base64 and JSON copy of each body.
   * `expiresAt` drives physical expiry; callers that need exact expiry encode it in the value.
   */
  getBytes?(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  setBytes?(key: string, value: Uint8Array<ArrayBuffer>, expiresAt: number): Promise<void>;
}

export interface CacheStorageContext {
  storage: CacheStorage | null;
  /** Include site, deployment and content revision. Never use a tenant-wide global binding. */
  scope: string;
  /**
   * Scope for build-independent DATA caches (`createFetchCache`): raw upstream
   * responses, keyed with a site-chosen data version instead of the build hash
   * and CMS revision so they survive deploys and publishes. Defaults to `scope`.
   */
  dataScope?: string;
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
  const binary = new Map<string, { value: Uint8Array<ArrayBuffer>; expiresAt: number }>();
  let bytes = 0;
  function remove(key: string) {
    const old = entries.get(key);
    if (old !== undefined) bytes -= (key.length + old.length) * 2;
    entries.delete(key);
    const oldBinary = binary.get(key);
    if (oldBinary) bytes -= key.length * 2 + oldBinary.value.byteLength;
    binary.delete(key);
  }
  function evict() {
    while (bytes > maxBytes) {
      const oldest = entries.keys().next().value ?? binary.keys().next().value;
      if (oldest === undefined) break;
      remove(oldest);
    }
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
      evict();
    },
    async delete(key) {
      remove(key);
    },
    async getBytes(key) {
      const entry = binary.get(key);
      if (!entry || Date.now() >= entry.expiresAt) {
        remove(key);
        return null;
      }
      binary.delete(key);
      binary.set(key, entry);
      return entry.value;
    },
    async setBytes(key, value, expiresAt) {
      remove(key);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
      const size = key.length * 2 + value.byteLength;
      if (size > maxBytes) return;
      binary.set(key, { value: value.slice(), expiresAt });
      bytes += size;
      evict();
    },
  };
}

/** Structural binding type; the core has no Cloudflare package dependency. */
export interface CacheKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The binary half of a Workers KV binding. Real bindings satisfy both; minimal fakes need not. */
interface BinaryCacheKVNamespace {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(
    key: string,
    value: Uint8Array<ArrayBuffer>,
    options: { expirationTtl: number },
  ): Promise<void>;
}

// Leave space below KV's 25 MiB value limit. Oversized cache entries are optional.
const KV_MAX_VALUE_BYTES = 25 * 1024 * 1024;
const kvTtl = (expiresAt: number) => Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));

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
      // UTF-8 is at most 3 bytes per UTF-16 unit: only encode (a full copy) when that bound
      // can exceed the limit. Encoding every value just to size it doubled each write.
      if (
        raw.length * 3 > KV_MAX_VALUE_BYTES &&
        new TextEncoder().encode(raw).byteLength > KV_MAX_VALUE_BYTES
      )
        return;
      await kv.put(await keyFor(key), raw, { expirationTtl: kvTtl(expiresAt) });
    },
    async delete(key) {
      await kv.delete(await keyFor(key));
    },
    async getBytes(key) {
      const raw = await (kv as unknown as BinaryCacheKVNamespace).get(
        await keyFor(key),
        "arrayBuffer",
      );
      return raw ? new Uint8Array(raw) : null;
    },
    async setBytes(key, value, expiresAt) {
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
      if (value.byteLength > KV_MAX_VALUE_BYTES) return;
      await (kv as unknown as BinaryCacheKVNamespace).put(await keyFor(key), value, {
        expirationTtl: kvTtl(expiresAt),
      });
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
    async getBytes(key) {
      const response = await cache.match(await requestFor(key));
      return response ? new Uint8Array(await response.arrayBuffer()) : null;
    },
    async setBytes(key, value, expiresAt) {
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
      await cache.put(
        await requestFor(key),
        new Response(value, {
          headers: {
            "Cache-Control": `public, max-age=${Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000))}`,
          },
        }),
      );
    },
  };
}

/**
 * Deadline every operation of a shared storage, reporting a miss (or a dropped write) when it
 * is exceeded. A `DECO_KV.get` that never settled once held PLPs for 100 s until Cloudflare
 * answered 524; the cache is an optimization and must never block a render.
 * ponytail: Promise.race, not an abort — the KV binding takes no AbortSignal.
 */
export function timeBoxedCacheStorage(
  storage: CacheStorage,
  {
    timeoutMs = 1_500,
    onTimeout,
  }: { timeoutMs?: number; onTimeout?: (operation: string) => void } = {},
): CacheStorage {
  function timeBox<T>(operation: string, work: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      work.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          onTimeout?.(operation);
          resolve(fallback);
        }, timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  const { getBytes, setBytes } = storage;
  return {
    get: (key) => timeBox("get", storage.get(key), null),
    set: (key, value, expiresAt) => timeBox("set", storage.set(key, value, expiresAt), undefined),
    delete: (key) => timeBox("delete", storage.delete(key), undefined),
    ...(getBytes && setBytes
      ? {
          getBytes: (key: string) => timeBox("get", getBytes.call(storage, key), null),
          setBytes: (key: string, value: Uint8Array<ArrayBuffer>, expiresAt: number) =>
            timeBox("set", setBytes.call(storage, key, value, expiresAt), undefined),
        }
      : {}),
  };
}

/**
 * A fast per-location tier (`caches.default`) in front of a shared one (KV): colo hits skip the
 * KV round trip, colo misses still find what another location wrote. A value found only in the
 * shared tier is copied to the colo for `backfillTtlMs` — `get` cannot see the real expiry, so
 * consumers must judge freshness from the value itself (responses and loader entries do).
 */
export function tieredCacheStorage(
  colo: CacheStorage,
  shared: CacheStorage,
  { backfillTtlMs = 60_000 }: { backfillTtlMs?: number } = {},
): CacheStorage {
  const tiered: CacheStorage = {
    async get(key) {
      const local = await colo.get(key).catch(() => null);
      if (local !== null) return local;
      const value = await shared.get(key);
      if (value !== null) cacheBackground(colo.set(key, value, Date.now() + backfillTtlMs));
      return value;
    },
    set: (key, value, expiresAt) =>
      Promise.all([
        colo.set(key, value, expiresAt).catch(() => {}),
        shared.set(key, value, expiresAt),
      ]).then(() => {}),
    delete: (key) =>
      Promise.all([colo.delete(key).catch(() => {}), shared.delete(key)]).then(() => {}),
  };
  if (!colo.getBytes || !colo.setBytes || !shared.getBytes || !shared.setBytes) return tiered;
  const [coloGet, coloSet, sharedGet, sharedSet] = [
    colo.getBytes,
    colo.setBytes,
    shared.getBytes,
    shared.setBytes,
  ];
  return {
    ...tiered,
    async getBytes(key) {
      const local = await coloGet.call(colo, key).catch(() => null);
      if (local !== null) return local;
      const value = await sharedGet.call(shared, key);
      if (value !== null)
        cacheBackground(coloSet.call(colo, key, value, Date.now() + backfillTtlMs));
      return value;
    },
    setBytes: (key, value, expiresAt) =>
      Promise.all([
        coloSet.call(colo, key, value, expiresAt).catch(() => {}),
        sharedSet.call(shared, key, value, expiresAt),
      ]).then(() => {}),
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
  /** `"data"`: key by `dataScope` — only for values that don't depend on the build. */
  kind: "build" | "data" = "build",
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
      const context = getCacheStorageContext();
      const scope = (kind === "data" ? context?.dataScope : undefined) ?? context?.scope;
      return JSON.stringify([scope ?? "local", namespace, raw]);
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
