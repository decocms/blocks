// @vitest-environment node

import { setBlocks } from "@decocms/blocks/cms";
import { clearLoaderCache, createCachedLoader } from "@decocms/blocks/sdk/cachedLoader";
import {
  type CacheKVNamespace,
  createKVCacheStorage,
  getCacheStorageContext,
} from "@decocms/blocks/sdk/cacheStorage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchCache } from "@decocms/blocks/sdk/fetchCache";
import { __resetKvHydrationStateForTests, DATA_VERSION_TIMEOUT_MS } from "./kvHydration";

const FETCH_KNOBS = {
  maxEntries: 10,
  freshTtlMs: { success: 60_000, notFound: 1_000, serverError: 0 },
  staleIfErrorMs: 60_000,
  inflightBackstopMs: 5_000,
};
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

  // A fresh fetch cache per request: its memory tier can't answer, so a hit
  // proves the shared (KV) entry was found under the same key.
  function fetchWorker(opts: object = {}) {
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    const worker = createDecoWorkerEntry(
      {
        fetch: async () => {
          const cache = createFetchCache({ provider: "test", ...FETCH_KNOBS });
          const body = await cache.fetchWithCache("https://upstream.test/x", upstream);
          return Response.json(body, { headers: { "cache-control": "no-store" } });
        },
      },
      { ...options, ...opts },
    );
    return { worker, upstream };
  }

  it("DECO_DATA_CACHE_ON_DEPLOY=preserve keeps fetch results across deploys and publishes", async () => {
    const { worker, upstream } = fetchWorker();
    const bindings = { ...env(), DECO_DATA_CACHE_ON_DEPLOY: "preserve" };
    await worker.fetch(request("/one"), bindings, ctx);
    await flush();
    // Distinct paths: only the fetch cache is under test, not the HTML cache.
    await worker.fetch(request("/two"), { ...bindings, BUILD_HASH: "build-B" }, ctx);
    // A CMS publish (new decofile revision) keeps them too.
    setBlocks({ published: { __resolveType: "x" } });
    await worker.fetch(request("/three"), { ...bindings, BUILD_HASH: "build-B" }, ctx);
    expect(upstream).toHaveBeenCalledTimes(1);
    // A new DECO_DATA_CACHE_PURGE value drops the preserved data once.
    await worker.fetch(request("/four"), { ...bindings, DECO_DATA_CACHE_PURGE: "2026-09-22" }, ctx);
    expect(upstream).toHaveBeenCalledTimes(2);
    await flush();
  });

  it("loader results stay per-build even with preserve", async () => {
    const upstream = vi.fn(async () => ({ n: 1 }));
    const loader = createCachedLoader("worker-preserve-loader", upstream, {
      policy: "no-cache",
      maxAge: 60_000,
    });
    const worker = createDecoWorkerEntry(
      {
        fetch: async () =>
          Response.json(await loader({}), { headers: { "cache-control": "no-store" } }),
      },
      options,
    );
    const bindings = { ...env(), DECO_DATA_CACHE_ON_DEPLOY: "preserve" };
    await worker.fetch(request("/a"), bindings, ctx);
    await flush();
    clearLoaderCache();
    await worker.fetch(request("/b"), { ...bindings, BUILD_HASH: "build-B" }, ctx);
    expect(upstream).toHaveBeenCalledTimes(2);
    await flush();
  });

  it("invalidate or unset keeps fetch results per build", async () => {
    for (const extra of [{}, { DECO_DATA_CACHE_ON_DEPLOY: "invalidate" }, { DECO_DATA_CACHE_ON_DEPLOY: "yes" }]) {
      const { worker, upstream } = fetchWorker();
      const bindings = { ...env(), ...extra };
      await worker.fetch(request("/a"), bindings, ctx);
      await flush();
      await worker.fetch(request("/b"), { ...bindings, BUILD_HASH: "build-B" }, ctx);
      expect(upstream).toHaveBeenCalledTimes(2);
      await flush();
    }
  });

  it("a new cache:data-version in DECO_KV purges preserved data without a deploy", async () => {
    __resetKvHydrationStateForTests();
    const { worker, upstream } = fetchWorker();
    const DECO_KV = makeKV();
    const bindings = { ...env(), DECO_KV, DECO_DATA_CACHE_ON_DEPLOY: "preserve" };
    await worker.fetch(request("/a"), bindings, ctx);
    await flush();
    await worker.fetch(request("/b"), bindings, ctx);
    expect(upstream).toHaveBeenCalledTimes(1);
    await DECO_KV.put("cache:data-version", "v2", { expirationTtl: 60 });
    __resetKvHydrationStateForTests(); // skip the poll interval
    await worker.fetch(request("/c"), bindings, ctx);
    expect(upstream).toHaveBeenCalledTimes(2);
    await flush();
  });

  it("a hung cache:data-version read falls back instead of holding the request", async () => {
    vi.useFakeTimers();
    try {
      __resetKvHydrationStateForTests();
      const { worker, upstream } = fetchWorker();
      const DECO_KV = { ...makeKV(), get: () => new Promise<string | null>(() => {}) };
      const bindings = { ...env(), DECO_KV, DECO_DATA_CACHE_ON_DEPLOY: "preserve" };
      const pending = worker.fetch(request("/a"), bindings, ctx);
      await vi.advanceTimersByTimeAsync(DATA_VERSION_TIMEOUT_MS);
      expect((await pending).status).toBe(200);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      await flush();
    }
  });

  it("honours dataCacheOnDeployEnv renames and opt-out", async () => {
    const run = async (opts: object, extra: Record<string, string>) => {
      const { worker, upstream } = fetchWorker(opts);
      const bindings = { ...env(), ...extra };
      await worker.fetch(request("/a"), bindings, ctx);
      await flush();
      await worker.fetch(request("/b"), { ...bindings, BUILD_HASH: "build-B" }, ctx);
      await flush();
      return upstream.mock.calls.length;
    };
    expect(await run({ dataCacheOnDeployEnv: "KEEP" }, { KEEP: "preserve" })).toBe(1);
    expect(
      await run({ dataCacheOnDeployEnv: false }, { DECO_DATA_CACHE_ON_DEPLOY: "preserve" }),
    ).toBe(2);
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
