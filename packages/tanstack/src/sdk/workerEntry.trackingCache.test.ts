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

/**
 * Move the clock forward without fake timers (the cache storage and tracing
 * helpers await real promises). The `listing` profile is fresh=120s, swr=900s,
 * so +200s lands squarely in the stale-while-revalidate window.
 */
let clockOffsetMs = 0;
const INSIDE_SWR_MS = 200_000;

beforeEach(() => {
  clearLoaderCache();
  setBlocks({});
  clockOffsetMs = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
});

afterEach(() => vi.restoreAllMocks());

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

  it("revalidates a stale entry from the clean URL, not the tracked one", async () => {
    const origin = echoOrigin();
    const bindings = env();
    const worker = createDecoWorkerEntry(origin, options);

    await worker.fetch(page("/produtos"), bindings, ctx);
    await flush();

    clockOffsetMs = INSIDE_SWR_MS;
    const stale = await worker.fetch(page("/produtos?gclid=POISON42"), bindings, ctx);
    expect(stale.headers.get("X-Cache")).toBe("STALE-HIT");
    await flush();

    // The background render must see the clean URL. Rendering the tracked one
    // would be discarded by the store guard — a full SSR for nothing, on every
    // ad visitor, for the rest of the SWR window.
    const rendered = origin.fetch.mock.calls.map((c) => (c[0] as Request).url);
    expect(rendered).toHaveLength(2);
    expect(rendered[1]).not.toContain("POISON42");

    // And it refreshed the entry, so paid traffic keeps the cache warm.
    clockOffsetMs = INSIDE_SWR_MS + 1_000;
    const next = await worker.fetch(page("/produtos"), bindings, ctx);
    expect(next.headers.get("X-Cache")).toBe("HIT");
    expect(await next.text()).not.toContain("POISON42");
    expect(origin.fetch).toHaveBeenCalledTimes(2);
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

  it("labels the skipped store, like the HTML path does", async () => {
    const worker = createDecoWorkerEntry(sfnOrigin(), options);

    const tracked = await worker.fetch(
      post("https://shop.test/produtos?gclid=POISON42"),
      env(),
      ctx,
    );
    expect(tracked.headers.get("X-Cache")).toBe("MISS");
    expect(tracked.headers.get("X-Cache-Store")).toBe("skipped-tracking");
  });

  it("revalidates a stale entry from the canonical body", async () => {
    const origin = sfnOrigin();
    const bindings = env();
    const worker = createDecoWorkerEntry(origin, options);

    await worker.fetch(post("https://shop.test/produtos"), bindings, ctx);
    await flush();

    clockOffsetMs = INSIDE_SWR_MS;
    const stale = await worker.fetch(
      post("https://shop.test/produtos?gclid=POISON42"),
      bindings,
      ctx,
    );
    expect(stale.headers.get("X-Cache")).toBe("STALE-HIT");
    await flush();

    // Refreshed rather than discarded: a third request HITs without a third
    // origin render, and the stored section never saw the landing URL.
    clockOffsetMs = INSIDE_SWR_MS + 1_000;
    const next = await worker.fetch(post("https://shop.test/produtos"), bindings, ctx);
    expect(next.headers.get("X-Cache")).toBe("HIT");
    expect(await next.text()).not.toContain("POISON42");
    expect(origin.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("buildSegment geo split warning", () => {
  const geo = (path: string) =>
    new Request(`https://shop.test${path}`, {
      headers: { accept: "text/html", "cf-region-code": "RJ" },
    });
  const cfRegionSegment = (req: Request) => ({
    device: "desktop" as const,
    regionId: req.headers.get("cf-region-code") ?? undefined,
  });
  const warned = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter((c) => String(c[0]).includes("buildSegment sets regionId"));

  it("warns once when regionId is the CF region and no location matcher exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A loaded decofile with no location matcher — that's what makes
    // `geoCacheKey: "auto"` resolving to "off" an answer and not a default.
    setBlocks({ "/": { __resolveType: "website/pages/Page.tsx" } });
    const worker = createDecoWorkerEntry(echoOrigin(), {
      ...options,
      geoCacheKey: "auto",
      buildSegment: cfRegionSegment,
    });
    await worker.fetch(geo("/a"), env(), ctx);
    await worker.fetch(geo("/b"), env(), ctx);
    expect(warned(warn)).toHaveLength(1);
  });

  it("stays quiet before the decofile loads", async () => {
    // `_autoGeoKey` defaults to "off", so warning here would tell a site that
    // DOES have a location matcher to delete the fallback it needs — and the
    // flag latches, so the bogus advice is all they ever see.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const worker = createDecoWorkerEntry(echoOrigin(), {
      ...options,
      geoCacheKey: "auto",
      buildSegment: cfRegionSegment,
    });
    await worker.fetch(geo("/a"), env(), ctx);
    expect(warned(warn)).toHaveLength(0);

    // Once the decofile lands and really has no matcher, it does warn.
    setBlocks({ "/": { __resolveType: "website/pages/Page.tsx" } });
    await worker.fetch(geo("/b"), env(), ctx);
    expect(warned(warn)).toHaveLength(1);
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
