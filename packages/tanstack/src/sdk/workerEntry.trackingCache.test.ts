// @vitest-environment node

import { setBlocks } from "@decocms/blocks/cms";
import { clearLoaderCache } from "@decocms/blocks/sdk/cachedLoader";
import { type CacheKVNamespace, createKVCacheStorage } from "@decocms/blocks/sdk/cacheStorage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecoWorkerEntry } from "./workerEntry";

// Regression suite for cache poisoning via tracking params, measured on a
// production storefront: a MISS on `/produtos/vestido?gclid=POISON42` stored the
// page under the clean key, and the next visitor on `/produtos/vestido` got a
// HIT with `POISON42` embedded 14 times (page URL, router match id, analytics
// `category_url`, pagination base URL).

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
const ctx = { waitUntil: (w: Promise<unknown>) => jobs.push(w), passThroughOnException() {} };
async function flush() {
  while (jobs.length) await Promise.all(jobs.splice(0));
}

const options = {
  observability: false as const,
  outboundUserAgent: false as const,
  geoCacheKey: "off" as const,
  buildSegment: () => ({ device: "desktop" as const }),
  cacheStorage: (bindings: Record<string, unknown>) =>
    createKVCacheStorage(bindings.CACHE as CacheKVNamespace),
};
const env = () => ({ CACHE: makeKV(), BUILD_HASH: "build-A" });

/** Origin that embeds the URL it rendered — like a real page does. */
const echoOrigin = () => ({
  fetch: vi.fn(
    async (req: Request) =>
      new Response(`<html>rendered ${req.url}</html>`, {
        headers: { "content-type": "text/html" },
      }),
  ),
});

const page = (path: string) =>
  new Request(`https://shop.test${path}`, { headers: { accept: "text/html" } });

beforeEach(() => {
  clearLoaderCache();
  setBlocks({});
});

describe("tracking params never poison the edge cache", () => {
  it("does not store a page rendered from a tracked URL", async () => {
    const origin = echoOrigin();
    const bindings = env();
    const worker = createDecoWorkerEntry(origin, options);

    const tracked = await worker.fetch(page("/produtos?gclid=POISON42"), bindings, ctx);
    expect(tracked.headers.get("X-Cache")).toBe("MISS");
    expect(tracked.headers.get("X-Cache-Store")).toBe("skipped-tracking");
    await flush();

    const clean = await worker.fetch(page("/produtos"), bindings, ctx);
    expect(clean.headers.get("X-Cache")).toBe("MISS");
    expect(await clean.text()).not.toContain("POISON42");
  });

  it("still serves tracked requests from the clean entry", async () => {
    const origin = echoOrigin();
    const bindings = env();
    const worker = createDecoWorkerEntry(origin, options);

    await worker.fetch(page("/produtos"), bindings, ctx);
    await flush();

    const tracked = await worker.fetch(page("/produtos?utm_source=ads&gclid=X1"), bindings, ctx);
    expect(tracked.headers.get("X-Cache")).toBe("HIT");
    const body = await tracked.text();
    expect(body).not.toContain("X1");
    expect(body).not.toContain("utm_source");
    expect(origin.fetch).toHaveBeenCalledTimes(1);
  });

  it("stores clean pages as before", async () => {
    const origin = echoOrigin();
    const bindings = env();
    const worker = createDecoWorkerEntry(origin, options);

    const first = await worker.fetch(page("/produtos?sort=price:asc"), bindings, ctx);
    expect(first.headers.get("X-Cache-Store")).toBeNull();
    await flush();
    const second = await worker.fetch(page("/produtos?sort=price:asc"), bindings, ctx);
    expect(second.headers.get("X-Cache")).toBe("HIT");
  });
});

describe("POST server fn: tracked pageUrl converges on one key and is never stored", () => {
  const sfnOrigin = () => ({
    fetch: vi.fn(async (req: Request) => {
      const body = await req.text();
      return new Response(`section for ${body}`, {
        headers: { "content-type": "application/json", "X-Deco-Cacheable": "true" },
      });
    }),
  });
  const post = (pageUrl: string) =>
    new Request("https://shop.test/_serverFn/abc123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: { component: "Shelf", pageUrl } }),
    });

  afterEach(() => vi.restoreAllMocks());

  it("serves a tracked body from the clean body's entry", async () => {
    const origin = sfnOrigin();
    const bindings = env();
    const worker = createDecoWorkerEntry(origin, options);

    const clean = await worker.fetch(post("https://shop.test/produtos"), bindings, ctx);
    expect(clean.headers.get("X-Cache")).toBe("MISS");
    await flush();

    const tracked = await worker.fetch(
      post("https://shop.test/produtos?gclid=POISON42"),
      bindings,
      ctx,
    );
    expect(tracked.headers.get("X-Cache")).toBe("HIT");
    expect(await tracked.text()).not.toContain("POISON42");
  });

  it("does not store a response rendered from a tracked body", async () => {
    const origin = sfnOrigin();
    const bindings = env();
    const worker = createDecoWorkerEntry(origin, options);

    await worker.fetch(post("https://shop.test/produtos?gclid=POISON42"), bindings, ctx);
    await flush();

    const clean = await worker.fetch(post("https://shop.test/produtos"), bindings, ctx);
    expect(clean.headers.get("X-Cache")).toBe("MISS");
    expect(await clean.text()).not.toContain("POISON42");
  });
});

describe("buildSegment geo split warning", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns once when regionId is the CF region and no location matcher exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const worker = createDecoWorkerEntry(echoOrigin(), {
      ...options,
      geoCacheKey: "auto",
      buildSegment: (req: Request) => ({
        device: "desktop" as const,
        regionId: req.headers.get("cf-region-code") ?? undefined,
      }),
    });
    const geo = (path: string) =>
      new Request(`https://shop.test${path}`, {
        headers: { accept: "text/html", "cf-region-code": "RJ" },
      });
    await worker.fetch(geo("/a"), env(), ctx);
    await worker.fetch(geo("/b"), env(), ctx);
    const calls = warn.mock.calls.filter((c) =>
      String(c[0]).includes("buildSegment sets regionId"),
    );
    expect(calls).toHaveLength(1);
  });

  it("stays quiet for a VTEX regionId", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const worker = createDecoWorkerEntry(echoOrigin(), {
      ...options,
      geoCacheKey: "auto",
      buildSegment: () => ({
        device: "desktop" as const,
        regionId: "v2.1BB18CE648B5111D0933734ED83EC783",
      }),
    });
    await worker.fetch(
      new Request("https://shop.test/a", {
        headers: { accept: "text/html", "cf-region-code": "RJ" },
      }),
      env(),
      ctx,
    );
    expect(warn.mock.calls.some((c) => String(c[0]).includes("buildSegment sets regionId"))).toBe(
      false,
    );
  });
});
