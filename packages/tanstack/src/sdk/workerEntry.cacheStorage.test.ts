// @vitest-environment node

import { setBlocks } from "@decocms/blocks/cms";
import { clearLoaderCache, createCachedLoader } from "@decocms/blocks/sdk/cachedLoader";
import {
  type CacheKVNamespace,
  createKVCacheStorage,
  getCacheStorageContext,
} from "@decocms/blocks/sdk/cacheStorage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDecoWorkerEntry } from "./workerEntry";

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
const request = (path = "/", headers: Record<string, string> = {}) =>
  new Request(`https://shop.test${path}`, {
    headers: { accept: "text/html", ...headers },
  });
const env = () => ({ CACHE: makeKV(), BUILD_HASH: "build-A", PURGE_TOKEN: "test-token" });
const options = {
  observability: false as const,
  outboundUserAgent: false as const,
  geoCacheKey: "off" as const,
  buildSegment: (req: Request) => ({
    device: "desktop" as const,
    loggedIn: req.headers.has("authorization"),
  }),
  cacheStorage: (bindings: Record<string, unknown>) =>
    createKVCacheStorage(bindings.CACHE as CacheKVNamespace),
};
beforeEach(() => {
  clearLoaderCache();
  setBlocks({});
});

describe("worker cache storage injection", () => {
  it("uses the injected KV for HTML, with no global Cache API, across worker instances", async () => {
    const origin = {
      fetch: vi.fn(async () => new Response("page", { headers: { "content-type": "text/html" } })),
    };
    const bindings = env();
    const first = createDecoWorkerEntry(origin, options);
    expect((await first.fetch(request(), bindings, ctx)).headers.get("x-cache")).toBe("MISS");
    await flush();
    const second = createDecoWorkerEntry(origin, options);
    const hit = await second.fetch(request(), bindings, ctx);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("page");
    expect(origin.fetch).toHaveBeenCalledTimes(1);
    const changed = await second.fetch(request(), { ...bindings, BUILD_HASH: "build-B" }, ctx);
    expect(changed.headers.get("x-cache")).toBe("MISS");
    await flush();
  });

  it("uses the same adapter for loader results and isolates authenticated requests", async () => {
    const upstream = vi.fn(async () => ({ n: upstream.mock.calls.length }));
    const loader = createCachedLoader("worker-cache-test", upstream, {
      policy: "no-cache",
      maxAge: 60_000,
    });
    const origin = {
      fetch: vi.fn(async () => {
        expect(getCacheStorageContext()).toBeDefined();
        return Response.json(await loader({}), { headers: { "cache-control": "no-store" } });
      }),
    };
    const worker = createDecoWorkerEntry(origin, options);
    const bindings = env();
    await worker.fetch(request("/one"), bindings, ctx);
    await flush();
    clearLoaderCache();
    await worker.fetch(request("/two"), bindings, ctx);
    expect(upstream).toHaveBeenCalledTimes(1);
    await worker.fetch(request("/two", { authorization: "Bearer private" }), bindings, ctx);
    expect(upstream).toHaveBeenCalledTimes(2);
    await flush();
  });

  it("stores public server-function POSTs by body and excludes unmarked responses", async () => {
    const origin = {
      fetch: vi.fn(
        async (req: Request) =>
          new Response(await req.text(), {
            headers: { "X-Deco-Cacheable": "true", "content-type": "application/json" },
          }),
      ),
    };
    const worker = createDecoWorkerEntry(origin, options);
    const bindings = env();
    const post = (body: string) =>
      new Request("https://shop.test/_serverFn/public", { method: "POST", body });
    expect((await worker.fetch(post('"first"'), bindings, ctx)).headers.get("x-cache")).toBe(
      "MISS",
    );
    await flush();
    const hit = await worker.fetch(post('"first"'), bindings, ctx);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe('"first"');
    expect((await worker.fetch(post('"second"'), bindings, ctx)).headers.get("x-cache")).toBe(
      "MISS",
    );
    await flush();
    expect(origin.fetch).toHaveBeenCalledTimes(2);
    const unmarked = createDecoWorkerEntry({ fetch: async () => new Response("private") }, options);
    expect((await unmarked.fetch(post('"third"'), bindings, ctx)).headers.get("x-cache")).toBe(
      "BYPASS",
    );
  });

  it("purges HTML through the configured adapter", async () => {
    const worker = createDecoWorkerEntry(
      { fetch: async () => new Response("page", { headers: { "content-type": "text/html" } }) },
      options,
    );
    const bindings = env();
    await worker.fetch(request(), bindings, ctx);
    await flush();
    expect((await worker.fetch(request(), bindings, ctx)).headers.get("x-cache")).toBe("HIT");
    const purge = await worker.fetch(
      new Request("https://shop.test/_cache/purge", {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
        body: JSON.stringify({ paths: ["/"] }),
      }),
      bindings,
      ctx,
    );
    expect(purge.status).toBe(200);
    expect((await worker.fetch(request(), bindings, ctx)).headers.get("x-cache")).toBe("MISS");
    await flush();
  });
});
