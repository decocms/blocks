// @vitest-environment node

import { DEPLOYMENT_ID_ENV, getRevision, setBlocks } from "@decocms/blocks/cms";
import { clearLoaderCache, createCachedLoader } from "@decocms/blocks/sdk/cachedLoader";
import {
  type CacheKVNamespace,
  createKVCacheStorage,
  getCacheStorageContext,
} from "@decocms/blocks/sdk/cacheStorage";
import { createFetchCache } from "@decocms/blocks/sdk/fetchCache";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
// A STALE-HIT only starts its revalidation once the stale body went out
// (afterBodySent), so every fetch here reads the body, like a real client.
async function served(pending: Promise<Response>): Promise<Response> {
  const res = await pending;
  return new Response(await res.text(), res);
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
    expect((await served(first.fetch(request(), bindings, ctx))).headers.get("x-cache")).toBe(
      "MISS",
    );
    await flush();
    const second = createDecoWorkerEntry(origin, options);
    const hit = await served(second.fetch(request(), bindings, ctx));
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("page");
    expect(origin.fetch).toHaveBeenCalledTimes(1);
    const changed = await served(
      second.fetch(request(), { ...bindings, BUILD_HASH: "build-B" }, ctx),
    );
    expect(changed.headers.get("x-cache")).toBe("MISS");
    await flush();
  });

  const versionedOrigin = () => {
    let n = 0;
    return {
      fetch: vi.fn(
        async () => new Response(`page v${++n}`, { headers: { "content-type": "text/html" } }),
      ),
    };
  };
  const purgeAll = () =>
    new Request("https://shop.test/_cache/purge", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    });

  it("by default (invalidate) a CMS publish starts the HTML cache cold", async () => {
    for (const extra of [
      {},
      { DECO_HTML_CACHE_ON_PUBLISH: "invalidate" },
      { DECO_HTML_CACHE_ON_PUBLISH: "yes" },
    ]) {
      setBlocks({});
      const origin = versionedOrigin();
      const worker = createDecoWorkerEntry(origin, options);
      const bindings = { ...env(), ...extra };
      await served(worker.fetch(request(), bindings, ctx));
      await flush();
      setBlocks({ published: { __resolveType: "x" } });
      const after = await served(worker.fetch(request(), bindings, ctx));
      expect(after.headers.get("x-cache")).toBe("MISS");
      expect(after.headers.has("x-deco-revision")).toBe(false);
      await flush();
    }
  });

  it("DECO_HTML_CACHE_ON_PUBLISH=stale serves the previous revision as STALE-HIT and refreshes it in background", async () => {
    const origin = versionedOrigin();
    const worker = createDecoWorkerEntry(origin, options);
    const bindings = { ...env(), DECO_HTML_CACHE_ON_PUBLISH: "stale" };
    expect((await served(worker.fetch(request(), bindings, ctx))).headers.get("x-cache")).toBe(
      "MISS",
    );
    await flush();
    expect((await served(worker.fetch(request(), bindings, ctx))).headers.get("x-cache")).toBe(
      "HIT",
    );

    setBlocks({ published: { __resolveType: "x" } });
    const stale = await served(worker.fetch(request(), bindings, ctx));
    expect(stale.headers.get("x-cache")).toBe("STALE-HIT");
    expect(await stale.text()).toBe("page v1");
    await flush();

    const refreshed = await served(worker.fetch(request(), bindings, ctx));
    expect(refreshed.headers.get("x-cache")).toBe("HIT");
    expect(await refreshed.text()).toBe("page v2");
    expect(origin.fetch).toHaveBeenCalledTimes(2);
    await flush();
  });

  it('POST /_cache/purge {"all": true} starts every HTML entry cold through cache:html-version', async () => {
    __resetKvHydrationStateForTests();
    const origin = versionedOrigin();
    const worker = createDecoWorkerEntry(origin, options);
    const DECO_KV = makeKV();
    const bindings = { ...env(), DECO_KV, DECO_HTML_CACHE_ON_PUBLISH: "stale" };
    await served(worker.fetch(request(), bindings, ctx));
    await flush();
    expect((await served(worker.fetch(request(), bindings, ctx))).headers.get("x-cache")).toBe(
      "HIT",
    );

    const purged = await served(worker.fetch(purgeAll(), bindings, ctx));
    expect(purged.status).toBe(200);
    const { version } = (await purged.json()) as { version: string };
    expect(await DECO_KV.get("cache:html-version")).toBe(version);

    const after = await served(worker.fetch(request(), bindings, ctx));
    expect(after.headers.get("x-cache")).toBe("MISS");
    expect(await after.text()).toBe("page v2");
    await flush();

    // Another isolate (another colo) adopts the version on its next read of the key.
    __resetKvHydrationStateForTests();
    const other = createDecoWorkerEntry(origin, options);
    expect((await served(other.fetch(request(), bindings, ctx))).headers.get("x-cache")).toBe(
      "HIT",
    );
    await flush();
  });

  it('{"all": true} is refused without the stale mode or without DECO_KV', async () => {
    const worker = createDecoWorkerEntry(versionedOrigin(), options);
    expect((await served(worker.fetch(purgeAll(), env(), ctx))).status).toBe(400);
    const noKv = await worker.fetch(
      purgeAll(),
      { ...env(), DECO_HTML_CACHE_ON_PUBLISH: "stale" },
      ctx,
    );
    expect(noKv.status).toBe(501);
    const unauthorized = new Request("https://shop.test/_cache/purge", {
      method: "POST",
      body: JSON.stringify({ all: true }),
    });
    expect(
      (
        await served(
          worker.fetch(unauthorized, { ...env(), DECO_HTML_CACHE_ON_PUBLISH: "stale" }, ctx),
        )
      ).status,
    ).toBe(401);
  });

  const staleEnv = () => ({ ...env(), DECO_HTML_CACHE_ON_PUBLISH: "stale" });
  const PUBLISHED = { published: { __resolveType: "x" } };

  it("stamps the revision the render started with, not the one at store time", async () => {
    let n = 0;
    const origin = {
      fetch: vi.fn(async () => {
        const body = `page v${++n}`;
        // The poll swaps the decofile while this render is still running.
        if (n === 1) setBlocks(PUBLISHED);
        return new Response(body, { headers: { "content-type": "text/html" } });
      }),
    };
    const worker = createDecoWorkerEntry(origin, options);
    const bindings = staleEnv();
    await served(worker.fetch(request(), bindings, ctx));
    await flush();
    // Old content must not become a fresh HIT under the new revision.
    const next = await served(worker.fetch(request(), bindings, ctx));
    expect(next.headers.get("x-cache")).toBe("STALE-HIT");
    await flush();
    expect((await served(worker.fetch(request(), bindings, ctx))).headers.get("x-cache")).toBe(
      "HIT",
    );
  });

  it("an isolate that hasn't polled the publish yet doesn't put its old revision back", async () => {
    __resetKvHydrationStateForTests();
    const DECO_KV = makeKV();
    const bindings = {
      ...staleEnv(),
      DECO_KV,
      DECO_FAST_DEPLOY: "1",
      [DEPLOYMENT_ID_ENV]: "dep-1",
    };
    const origin = versionedOrigin();
    const worker = createDecoWorkerEntry(origin, options);
    setBlocks(PUBLISHED);
    await DECO_KV.put("index:revision:dep-1", getRevision() ?? "", { expirationTtl: 60 });
    await served(worker.fetch(request(), bindings, ctx)); // v1, at the published revision
    await flush();

    setBlocks({}); // a laggard isolate, still on the previous revision
    expect((await served(worker.fetch(request(), bindings, ctx))).headers.get("x-cache")).toBe(
      "STALE-HIT",
    );
    await flush(); // renders v2 at the old revision — must not be stored

    setBlocks(PUBLISHED);
    const current = await served(worker.fetch(request(), bindings, ctx));
    expect(current.headers.get("x-cache")).toBe("HIT");
    expect(await current.text()).toBe("page v1");
    await flush();
  });

  it("drops the entry when the revalidation no longer gets a 200 (unpublished page)", async () => {
    let status = 200;
    const origin = {
      fetch: vi.fn(
        async () =>
          new Response(status === 200 ? "landing" : "gone", {
            status,
            headers: { "content-type": "text/html" },
          }),
      ),
    };
    const worker = createDecoWorkerEntry(origin, options);
    const bindings = staleEnv();
    await served(worker.fetch(request("/night-sale"), bindings, ctx));
    await flush();
    setBlocks(PUBLISHED);
    status = 404;
    expect(
      (await served(worker.fetch(request("/night-sale"), bindings, ctx))).headers.get("x-cache"),
    ).toBe("STALE-HIT");
    await flush();
    const after = await served(worker.fetch(request("/night-sale"), bindings, ctx));
    expect(after.status).toBe(404);
    expect(await after.text()).toBe("gone");
  });

  it("keeps the entry when the revalidation gets a status a visitor's headers can provoke", async () => {
    for (const status of [302, 403]) {
      setBlocks({});
      let current = 200;
      const origin = {
        fetch: vi.fn(
          async () =>
            new Response(current === 200 ? "landing" : "", {
              status: current,
              headers: {
                "content-type": "text/html",
                ...(current === 302 ? { location: "/" } : {}),
              },
            }),
        ),
      };
      const worker = createDecoWorkerEntry(origin, options);
      const bindings = staleEnv();
      await served(worker.fetch(request("/kept"), bindings, ctx));
      await flush();
      setBlocks(PUBLISHED);
      current = status;
      await served(worker.fetch(request("/kept"), bindings, ctx));
      await flush();
      const after = await served(worker.fetch(request("/kept"), bindings, ctx));
      expect(after.headers.get("x-cache")).toBe("STALE-HIT");
      expect(await after.text()).toBe("landing");
      await flush();
    }
  });

  it("server functions follow the same rules with stale, and the revision header never leaks", async () => {
    let n = 0;
    const origin = {
      fetch: vi.fn(
        async () =>
          new Response(`"v${++n}"`, {
            headers: { "X-Deco-Cacheable": "true", "content-type": "application/json" },
          }),
      ),
    };
    const worker = createDecoWorkerEntry(origin, options);
    const bindings = staleEnv();
    const post = () =>
      new Request("https://shop.test/_serverFn/public", { method: "POST", body: '"q"' });
    await served(worker.fetch(post(), bindings, ctx));
    await flush();
    const hit = await served(worker.fetch(post(), bindings, ctx));
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.has("x-deco-revision")).toBe(false);
    setBlocks(PUBLISHED);
    const stale = await served(worker.fetch(post(), bindings, ctx));
    expect(stale.headers.get("x-cache")).toBe("STALE-HIT");
    expect(await stale.text()).toBe('"v1"');
    expect(stale.headers.has("x-deco-revision")).toBe(false);
    await flush();
    expect(await (await served(worker.fetch(post(), bindings, ctx))).text()).toBe('"v2"');
    await flush();

    const page = createDecoWorkerEntry(versionedOrigin(), options);
    await served(page.fetch(request("/leak"), bindings, ctx));
    await flush();
    const htmlHit = await served(page.fetch(request("/leak"), bindings, ctx));
    expect(htmlHit.headers.get("x-cache")).toBe("HIT");
    expect(htmlHit.headers.has("x-deco-revision")).toBe(false);
  });

  it("an unknown purge version (first KV read timed out) skips the cache instead of reading the pre-purge one", async () => {
    vi.useFakeTimers();
    try {
      __resetKvHydrationStateForTests();
      const origin = versionedOrigin();
      const worker = createDecoWorkerEntry(origin, options);
      const DECO_KV = { ...makeKV(), get: () => new Promise<string | null>(() => {}) };
      const bindings = { ...staleEnv(), DECO_KV };
      for (const _ of [1, 2]) {
        const pending = worker.fetch(request("/purged"), bindings, ctx);
        await vi.advanceTimersByTimeAsync(DATA_VERSION_TIMEOUT_MS);
        expect((await pending).status).toBe(200);
      }
      expect(origin.fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await flush();
    }
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
    await served(worker.fetch(request("/one"), bindings, ctx));
    await flush();
    clearLoaderCache();
    await served(worker.fetch(request("/two"), bindings, ctx));
    expect(upstream).toHaveBeenCalledTimes(1);
    await served(worker.fetch(request("/two", { authorization: "Bearer private" }), bindings, ctx));
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
    await served(worker.fetch(request("/one"), bindings, ctx));
    await flush();
    // Distinct paths: only the fetch cache is under test, not the HTML cache.
    await served(worker.fetch(request("/two"), { ...bindings, BUILD_HASH: "build-B" }, ctx));
    // A CMS publish (new decofile revision) keeps them too.
    setBlocks({ published: { __resolveType: "x" } });
    await served(worker.fetch(request("/three"), { ...bindings, BUILD_HASH: "build-B" }, ctx));
    expect(upstream).toHaveBeenCalledTimes(1);
    // A new DECO_DATA_CACHE_PURGE value drops the preserved data once.
    await served(
      worker.fetch(request("/four"), { ...bindings, DECO_DATA_CACHE_PURGE: "2026-09-22" }, ctx),
    );
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
    await served(worker.fetch(request("/a"), bindings, ctx));
    await flush();
    clearLoaderCache();
    await served(worker.fetch(request("/b"), { ...bindings, BUILD_HASH: "build-B" }, ctx));
    expect(upstream).toHaveBeenCalledTimes(2);
    await flush();
  });

  it("invalidate or unset keeps fetch results per build", async () => {
    for (const extra of [
      {},
      { DECO_DATA_CACHE_ON_DEPLOY: "invalidate" },
      { DECO_DATA_CACHE_ON_DEPLOY: "yes" },
    ]) {
      const { worker, upstream } = fetchWorker();
      const bindings = { ...env(), ...extra };
      await served(worker.fetch(request("/a"), bindings, ctx));
      await flush();
      await served(worker.fetch(request("/b"), { ...bindings, BUILD_HASH: "build-B" }, ctx));
      expect(upstream).toHaveBeenCalledTimes(2);
      await flush();
    }
  });

  it("a new cache:data-version in DECO_KV purges preserved data without a deploy", async () => {
    __resetKvHydrationStateForTests();
    const { worker, upstream } = fetchWorker();
    const DECO_KV = makeKV();
    const bindings = { ...env(), DECO_KV, DECO_DATA_CACHE_ON_DEPLOY: "preserve" };
    await served(worker.fetch(request("/a"), bindings, ctx));
    await flush();
    await served(worker.fetch(request("/b"), bindings, ctx));
    expect(upstream).toHaveBeenCalledTimes(1);
    await DECO_KV.put("cache:data-version", "v2", { expirationTtl: 60 });
    __resetKvHydrationStateForTests(); // skip the poll interval
    await served(worker.fetch(request("/c"), bindings, ctx));
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
      await served(worker.fetch(request("/a"), bindings, ctx));
      await flush();
      await served(worker.fetch(request("/b"), { ...bindings, BUILD_HASH: "build-B" }, ctx));
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
    expect(
      (await served(worker.fetch(post('"first"'), bindings, ctx))).headers.get("x-cache"),
    ).toBe("MISS");
    await flush();
    const hit = await served(worker.fetch(post('"first"'), bindings, ctx));
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe('"first"');
    expect(
      (await served(worker.fetch(post('"second"'), bindings, ctx))).headers.get("x-cache"),
    ).toBe("MISS");
    await flush();
    expect(origin.fetch).toHaveBeenCalledTimes(2);
    const unmarked = createDecoWorkerEntry({ fetch: async () => new Response("private") }, options);
    expect(
      (await served(unmarked.fetch(post('"third"'), bindings, ctx))).headers.get("x-cache"),
    ).toBe("BYPASS");
  });

  it("purges HTML through the configured adapter", async () => {
    const worker = createDecoWorkerEntry(
      { fetch: async () => new Response("page", { headers: { "content-type": "text/html" } }) },
      options,
    );
    const bindings = env();
    await served(worker.fetch(request(), bindings, ctx));
    await flush();
    expect((await served(worker.fetch(request(), bindings, ctx))).headers.get("x-cache")).toBe(
      "HIT",
    );
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
    expect((await served(worker.fetch(request(), bindings, ctx))).headers.get("x-cache")).toBe(
      "MISS",
    );
    await flush();
  });
});
