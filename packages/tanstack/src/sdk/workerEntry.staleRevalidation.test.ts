// @vitest-environment node

import { setBlocks } from "@decocms/blocks/cms";
import { clearLoaderCache } from "@decocms/blocks/sdk/cachedLoader";
import { type CacheKVNamespace, createKVCacheStorage } from "@decocms/blocks/sdk/cacheStorage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecoWorkerEntry } from "./workerEntry";

// A STALE-HIT is meant to answer from the stored copy right away. Measured on a
// production storefront (QA-166, Oficina Reserva, PLP `/roupas/sueteres`): 8
// visitors arriving together on an entry past `fresh` all got STALE-HIT and all
// took 1.12 s, against 0.2-0.5 s for a HIT — the background re-render started
// before the stale body went out, and every STALE-HIT started one.

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

const htmlOrigin = () => ({
  fetch: vi.fn(
    async (req: Request) =>
      new Response(`<html>rendered ${req.url}</html>`, {
        headers: { "content-type": "text/html" },
      }),
  ),
});
const sfnOrigin = () => ({
  fetch: vi.fn(
    async (req: Request) =>
      new Response(`section for ${await req.text()}`, {
        headers: { "content-type": "application/json", "X-Deco-Cacheable": "true" },
      }),
  ),
});

const page = (path: string) =>
  new Request(`https://shop.test${path}`, { headers: { accept: "text/html" } });
const post = (pageUrl: string) =>
  new Request("https://shop.test/_serverFn/abc123", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: { component: "Shelf", pageUrl } }),
  });

/** `listing` is fresh=120s, swr=900s: +200s lands inside the SWR window. */
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

describe("HTML STALE-HIT", () => {
  it("renders once for concurrent stale visitors, after the stale body went out", async () => {
    const origin = htmlOrigin();
    const bindings = env();
    const worker = createDecoWorkerEntry(origin, options);

    await worker.fetch(page("/produtos"), bindings, ctx);
    await flush();
    expect(origin.fetch).toHaveBeenCalledTimes(1);

    clockOffsetMs = INSIDE_SWR_MS;
    const stale = await Promise.all(
      Array.from({ length: 5 }, () => worker.fetch(page("/produtos"), bindings, ctx)),
    );
    for (const res of stale) expect(res.headers.get("X-Cache")).toBe("STALE-HIT");
    // Nothing re-rendered while the stale copies were still on their way out.
    expect(origin.fetch).toHaveBeenCalledTimes(1);

    for (const res of stale) await res.text();
    await flush();
    // One refresh for all five, not one each.
    expect(origin.fetch).toHaveBeenCalledTimes(2);

    clockOffsetMs = INSIDE_SWR_MS + 1_000;
    const next = await worker.fetch(page("/produtos"), bindings, ctx);
    expect(next.headers.get("X-Cache")).toBe("HIT");
  });

  it("revalidates again once the previous refresh settled", async () => {
    const origin = htmlOrigin();
    const bindings = env();
    const worker = createDecoWorkerEntry(origin, options);

    await worker.fetch(page("/produtos"), bindings, ctx);
    await flush();

    clockOffsetMs = INSIDE_SWR_MS;
    await (await worker.fetch(page("/produtos"), bindings, ctx)).text();
    await flush();
    expect(origin.fetch).toHaveBeenCalledTimes(2);

    // The refreshed entry goes stale in turn and is refreshed again.
    clockOffsetMs = INSIDE_SWR_MS * 2;
    const stale = await worker.fetch(page("/produtos"), bindings, ctx);
    expect(stale.headers.get("X-Cache")).toBe("STALE-HIT");
    await stale.text();
    await flush();
    expect(origin.fetch).toHaveBeenCalledTimes(3);
  });

  it("still refreshes when the client goes away mid-body", async () => {
    const origin = htmlOrigin();
    const bindings = env();
    const worker = createDecoWorkerEntry(origin, options);

    await worker.fetch(page("/produtos"), bindings, ctx);
    await flush();

    clockOffsetMs = INSIDE_SWR_MS;
    const stale = await worker.fetch(page("/produtos"), bindings, ctx);
    await stale.body?.cancel();
    await flush();
    expect(origin.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("POST server fn STALE-HIT (client-side navigation)", () => {
  it("renders once for concurrent stale visitors, after the stale body went out", async () => {
    const origin = sfnOrigin();
    const bindings = env();
    const worker = createDecoWorkerEntry(origin, options);

    await worker.fetch(post("https://shop.test/produtos"), bindings, ctx);
    await flush();
    expect(origin.fetch).toHaveBeenCalledTimes(1);

    clockOffsetMs = INSIDE_SWR_MS;
    const stale = await Promise.all(
      Array.from({ length: 5 }, () =>
        worker.fetch(post("https://shop.test/produtos"), bindings, ctx),
      ),
    );
    for (const res of stale) expect(res.headers.get("X-Cache")).toBe("STALE-HIT");
    expect(origin.fetch).toHaveBeenCalledTimes(1);

    for (const res of stale) await res.text();
    await flush();
    expect(origin.fetch).toHaveBeenCalledTimes(2);

    clockOffsetMs = INSIDE_SWR_MS + 1_000;
    const next = await worker.fetch(post("https://shop.test/produtos"), bindings, ctx);
    expect(next.headers.get("X-Cache")).toBe("HIT");
  });
});

describe("revalidation claim", () => {
  it("expires a refresh that never settled, so the entry does not stay stale", async () => {
    let hang = false;
    const origin = {
      fetch: vi.fn(async (req: Request) => {
        // A render whose I/O was cancelled under it: never settles.
        if (hang) return new Promise<Response>(() => {});
        return new Response(`<html>rendered ${req.url}</html>`, {
          headers: { "content-type": "text/html" },
        });
      }),
    };
    const bindings = env();
    const worker = createDecoWorkerEntry(origin, options);

    await worker.fetch(page("/produtos"), bindings, ctx);
    await flush();

    hang = true;
    clockOffsetMs = INSIDE_SWR_MS;
    await (await worker.fetch(page("/produtos"), bindings, ctx)).text();
    await Promise.resolve();
    expect(origin.fetch).toHaveBeenCalledTimes(2);
    jobs.splice(0); // the hung refresh is never awaited

    // Inside the claim window: no second render on top of the hung one.
    clockOffsetMs = INSIDE_SWR_MS + 10_000;
    await (await worker.fetch(page("/produtos"), bindings, ctx)).text();
    await Promise.resolve();
    expect(origin.fetch).toHaveBeenCalledTimes(2);
    jobs.splice(0);

    // Past it: the next stale visitor claims a fresh refresh.
    hang = false;
    clockOffsetMs = INSIDE_SWR_MS + 31_000;
    await (await worker.fetch(page("/produtos"), bindings, ctx)).text();
    await flush();
    expect(origin.fetch).toHaveBeenCalledTimes(3);
  });
});
