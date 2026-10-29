// @vitest-environment node

import { setBlocks } from "@decocms/blocks/cms";
import { clearLoaderCache } from "@decocms/blocks/sdk/cachedLoader";
import { type CacheKVNamespace, createKVCacheStorage } from "@decocms/blocks/sdk/cacheStorage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecoWorkerEntry } from "./workerEntry";

const g = globalThis as { __DECO_BUILD_HASH__?: string; __DECO_ASSETS_HASH__?: string };

function makeKV(): CacheKVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
}
const jobs: Promise<unknown>[] = [];
const ctx = { waitUntil: (work: Promise<unknown>) => jobs.push(work), passThroughOnException() {} };
async function flush() {
  while (jobs.length) await Promise.all(jobs.splice(0));
}
const request = () => new Request("https://shop.test/", { headers: { accept: "text/html" } });

function setup(edgeCacheVersion?: "build" | "assets") {
  const origin = {
    fetch: vi.fn(async () => new Response("page", { headers: { "content-type": "text/html" } })),
  };
  const bindings = { CACHE: makeKV() };
  const worker = createDecoWorkerEntry(origin, {
    observability: false,
    outboundUserAgent: false,
    geoCacheKey: "off",
    edgeCacheVersion,
    cacheStorage: (b: Record<string, unknown>) => createKVCacheStorage(b.CACHE as CacheKVNamespace),
  });
  const get = async (env: Record<string, unknown> = bindings) => {
    const res = await worker.fetch(request(), env, ctx);
    await flush();
    return res;
  };
  return { get, bindings, origin };
}

beforeEach(() => {
  clearLoaderCache();
  setBlocks({});
  g.__DECO_BUILD_HASH__ = "build-A";
  g.__DECO_ASSETS_HASH__ = "assets-1";
});
afterEach(() => {
  delete g.__DECO_BUILD_HASH__;
  delete g.__DECO_ASSETS_HASH__;
});

describe("edgeCacheVersion", () => {
  it("default: a new build starts the HTML cache cold", async () => {
    const { get } = setup();
    expect((await get()).headers.get("x-cache")).toBe("MISS");
    expect((await get()).headers.get("x-cache")).toBe("HIT");
    g.__DECO_BUILD_HASH__ = "build-B";
    expect((await get()).headers.get("x-cache")).toBe("MISS");
  });

  it('"assets": a new build with the same client assets keeps the cache warm', async () => {
    const { get, origin } = setup("assets");
    expect((await get()).headers.get("x-cache")).toBe("MISS");
    g.__DECO_BUILD_HASH__ = "build-B";
    const res = await get();
    expect(res.headers.get("x-cache")).toBe("HIT");
    // The header still reports the deploy, not the cache namespace.
    expect(res.headers.get("x-cache-version")).toBe("build-B");
    expect(origin.fetch).toHaveBeenCalledTimes(1);
  });

  it('"assets": changed client assets start the cache cold', async () => {
    const { get } = setup("assets");
    await get();
    g.__DECO_ASSETS_HASH__ = "assets-2";
    expect((await get()).headers.get("x-cache")).toBe("MISS");
  });

  it('"assets": the unresolved placeholder falls back to the build hash, and says so', async () => {
    g.__DECO_ASSETS_HASH__ = "__DECO_ASSETS_HASH_UNRESOLVED__";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { get } = setup("assets");
    await get();
    g.__DECO_BUILD_HASH__ = "build-B";
    expect((await get()).headers.get("x-cache")).toBe("MISS");
    const msgs = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("edgeCacheVersion"));
    expect(msgs).toHaveLength(1);
    warn.mockRestore();
  });

  it('"assets": an explicit env BUILD_HASH still wins', async () => {
    const { get, bindings } = setup("assets");
    await get({ ...bindings, BUILD_HASH: "pinned-1" });
    expect((await get({ ...bindings, BUILD_HASH: "pinned-1" })).headers.get("x-cache")).toBe("HIT");
    expect((await get({ ...bindings, BUILD_HASH: "pinned-2" })).headers.get("x-cache")).toBe(
      "MISS",
    );
  });
});
