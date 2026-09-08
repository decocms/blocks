// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearLoaderCache, createCachedLoader } from "./cachedLoader";
import {
  bindCacheStorage,
  type CacheStorage,
  createCacheStore,
  createKVCacheStorage,
  createMemoryCacheStorage,
  createWebCacheStorage,
} from "./cacheStorage";
import { RequestContext } from "./requestContext";
import { createResponseCache } from "./responseCache";

function fakeKV() {
  const values = new Map<string, string>();
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts: { expirationTtl: number }) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

const pending: Promise<unknown>[] = [];
function run<T>(storage: CacheStorage | null, scope: string, fn: () => T): T {
  return RequestContext.run(new Request("https://site.test/"), () => {
    bindCacheStorage({ storage, scope, waitUntil: (work) => pending.push(work) });
    return fn();
  });
}
async function flush() {
  await Promise.all(pending.splice(0));
}
afterEach(async () => {
  await flush();
  clearLoaderCache();
  vi.useRealTimers();
});

function fakeWebCache(): Cache {
  const values = new Map<string, Response>();
  return {
    async match(req: Request) {
      return values.get(req.url)?.clone();
    },
    async put(req: Request, response: Response) {
      values.set(req.url, response.clone());
    },
    async delete(req: Request) {
      return values.delete(req.url);
    },
  } as Cache;
}

for (const [name, make] of [
  ["memory", () => createMemoryCacheStorage()],
  ["KV", () => createKVCacheStorage(fakeKV())],
  ["Web Cache API", () => createWebCacheStorage(fakeWebCache(), "https://site.test")],
] as const) {
  describe(`${name} storage contract`, () => {
    it("round-trips, overwrites and deletes values", async () => {
      const storage = make();
      expect(await storage.get("missing")).toBeNull();
      await storage.set("key", "first", Date.now() + 60_000);
      expect(await storage.get("key")).toBe("first");
      await storage.set("key", "second", Date.now() + 60_000);
      expect(await storage.get("key")).toBe("second");
      await storage.delete("key");
      expect(await storage.get("key")).toBeNull();
    });
    it("enforces logical expiry even if the backend retains the record", async () => {
      vi.useFakeTimers();
      const storage = make();
      await storage.set("short", "body", Date.now() + 500);
      expect(await storage.get("short")).toBe("body");
      vi.advanceTimersByTime(500);
      expect(await storage.get("short")).toBeNull();
    });
  });
}

it("uses KV's minimum physical TTL while enforcing shorter logical expiry", async () => {
  const kv = fakeKV();
  await createKVCacheStorage(kv).set("a".repeat(1000), "value", Date.now() + 2000);
  expect(kv.put.mock.calls[0][2]).toEqual({ expirationTtl: 60 });
  expect(kv.put.mock.calls[0][0].length).toBeLessThan(512);
});

it("hydrates another store and isolates namespace, site and deployment", async () => {
  const storage = createKVCacheStorage(fakeKV());
  const first = createCacheStore<{ n: number }>("loaders");
  await run(storage, "site:build-A", async () => {
    first.set(first.key("item"), { n: 1 }, Date.now() + 60_000);
    await flush();
  });
  const second = createCacheStore<{ n: number }>("loaders");
  expect(await run(storage, "site:build-A", () => second.read(second.key("item")))).toEqual({
    n: 1,
  });
  for (const scope of ["other-site:build-A", "site:build-B"]) {
    expect(await run(storage, scope, () => second.read(second.key("item")))).toBeUndefined();
  }
  const sections = createCacheStore("sections");
  expect(
    await run(storage, "site:build-A", () => sections.read(sections.key("item"))),
  ).toBeUndefined();
});

it("does not switch bindings between concurrent requests", async () => {
  const a = createMemoryCacheStorage();
  const b = createMemoryCacheStorage();
  const cache = createCacheStore<string>("concurrent");
  await Promise.all(
    [a, b].map((storage, i) =>
      run(storage, `site-${i}`, async () => {
        await Promise.resolve();
        cache.set(cache.key("key"), String(i), Date.now() + 60_000);
      }),
    ),
  );
  await flush();
  cache.clear();
  expect(await run(a, "site-0", () => cache.read(cache.key("key")))).toBe("0");
  expect(await run(b, "site-1", () => cache.read(cache.key("key")))).toBe("1");
});

it("retains non-JSON values locally without silently corrupting them in KV", async () => {
  const kv = fakeKV();
  const cache = createCacheStore<{ date: Date }>("dates");
  await run(createKVCacheStorage(kv), "site", async () => {
    const value = { date: new Date() };
    cache.set(cache.key("key"), value, Date.now() + 60_000);
    expect(cache.get(cache.key("key"))).toBe(value);
    await flush();
    expect(kv.put).not.toHaveBeenCalled();
  });
});

it("deduplicates a cold loader through slow storage and survives a memory wipe", async () => {
  const storage = createKVCacheStorage(fakeKV());
  const fn = vi.fn(async () => ({ product: 42 }));
  const loader = createCachedLoader("test", fn, {
    policy: "stale-while-revalidate",
    maxAge: 60_000,
  });
  await run(storage, "site", async () => {
    const values = await Promise.all([loader({}), loader({}), loader({})]);
    expect(values).toEqual([{ product: 42 }, { product: 42 }, { product: 42 }]);
    expect(fn).toHaveBeenCalledTimes(1);
    await flush();
    clearLoaderCache();
    expect(await loader({})).toEqual({ product: 42 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

it("falls back to the loader when storage reads and writes fail", async () => {
  const failure = async () => {
    throw new Error("KV unavailable");
  };
  const fn = vi.fn(async () => "origin");
  const loader = createCachedLoader("failure", fn, { policy: "no-cache", maxAge: 1000 });
  expect(await run({ get: failure, set: failure, delete: failure }, "site", () => loader({}))).toBe(
    "origin",
  );
  await flush();
});

it("round-trips binary responses, headers and status through KV", async () => {
  const cache = createResponseCache(createKVCacheStorage(fakeKV()), "site:build");
  const req = new Request("https://site.test/image");
  const bytes = new Uint8Array([0, 255, 128, 1]);
  await cache.put(
    req,
    new Response(bytes, {
      status: 203,
      headers: {
        "cache-control": "public, max-age=60",
        "content-type": "application/octet-stream",
        "x-deco-stored-at": "123",
      },
    }),
  );
  const response = await cache.match(req);
  expect(response?.status).toBe(203);
  expect(response?.headers.get("x-deco-stored-at")).toBe("123");
  expect(new Uint8Array(await response!.arrayBuffer())).toEqual(bytes);
  await cache.delete(req);
  expect(await cache.match(req)).toBeUndefined();
});

it("refuses to serialize private HTTP responses or cookies", async () => {
  const storage = createMemoryCacheStorage();
  const cache = createResponseCache(storage, "site");
  const req = new Request("https://site.test/");
  await cache.put(
    req,
    new Response("private", { headers: { "cache-control": "private, max-age=60" } }),
  );
  expect(await cache.match(req)).toBeUndefined();
  await cache.put(
    req,
    new Response("cookie", {
      headers: { "cache-control": "public, max-age=60", "set-cookie": "session=secret" },
    }),
  );
  expect(await cache.match(req)).toBeUndefined();
});

it("bounds SWR separately from stale-if-error and stops serving at the final TTL", async () => {
  vi.useFakeTimers();
  const storage = createKVCacheStorage(fakeKV());
  let fail = false;
  const origin = vi.fn(async () => {
    if (fail) throw new Error("origin down");
    return "last good";
  });
  const loader = createCachedLoader("bounded-stale", origin, {
    policy: "stale-while-revalidate",
    maxAge: 100,
    staleWhileRevalidate: 100,
    staleIfError: 300,
  });
  await run(storage, "bounded", async () => {
    expect(await loader({})).toBe("last good");
    await flush();
    fail = true;
    vi.advanceTimersByTime(150);
    expect(await loader({})).toBe("last good");
    await flush();
    vi.advanceTimersByTime(100);
    expect(await loader({})).toBe("last good");
    expect(origin).toHaveBeenCalledTimes(3); // foreground retry once SWR has elapsed
    vi.advanceTimersByTime(150);
    await expect(loader({})).rejects.toThrow("origin down");
  });
});
