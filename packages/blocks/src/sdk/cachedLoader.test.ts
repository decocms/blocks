import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLoaderCache, createCachedLoader, getLoaderCacheStats } from "./cachedLoader";

describe("createCachedLoader", () => {
  beforeEach(() => {
    clearLoaderCache();
  });
  afterEach(() => {
    clearLoaderCache();
    vi.restoreAllMocks();
  });

  it("serves a fresh entry from cache (MISS then HIT) within maxAge", async () => {
    const loaderFn = vi.fn(async (p: { id: number }) => ({ v: p.id }));
    const cached = createCachedLoader("t/basic", loaderFn, {
      policy: "stale-while-revalidate",
      maxAge: 60_000,
    });

    await cached({ id: 1 }); // MISS
    await cached({ id: 1 }); // HIT — same key, within maxAge

    expect(loaderFn).toHaveBeenCalledTimes(1);
    expect(getLoaderCacheStats().entries).toBe(1);
  });

  it("distinct props produce distinct entries", async () => {
    const loaderFn = vi.fn(async (p: { id: number }) => ({ v: p.id }));
    const cached = createCachedLoader("t/props", loaderFn, {
      policy: "stale-while-revalidate",
      maxAge: 60_000,
    });

    await cached({ id: 1 });
    await cached({ id: 2 });

    expect(loaderFn).toHaveBeenCalledTimes(2);
    expect(getLoaderCacheStats().entries).toBe(2);
  });

  it("clearLoaderCache() empties the cache so the next call is a MISS", async () => {
    const loaderFn = vi.fn(async (p: { id: number }) => ({ v: p.id }));
    const cached = createCachedLoader("t/bust", loaderFn, {
      policy: "stale-while-revalidate",
      maxAge: 60_000,
    });

    await cached({ id: 1 }); // MISS
    await cached({ id: 1 }); // HIT
    expect(loaderFn).toHaveBeenCalledTimes(1);

    clearLoaderCache();
    expect(getLoaderCacheStats().entries).toBe(0);

    await cached({ id: 1 }); // MISS again — cache was cleared
    expect(loaderFn).toHaveBeenCalledTimes(2);
  });

  it("a purge during an in-flight loader does not repopulate the cleared entry", async () => {
    // Loader we can resolve manually, to hold it "in flight" across the purge.
    let release!: (v: { v: number }) => void;
    const loaderFn = vi.fn(
      () =>
        new Promise<{ v: number }>((res) => {
          release = res;
        }),
    );
    const cached = createCachedLoader("t/race", loaderFn, {
      policy: "stale-while-revalidate",
      maxAge: 60_000,
    });

    const inflight = cached({ id: 1 }); // MISS — loader now pending
    clearLoaderCache(); // purge lands while the loader is in flight
    release({ v: 99 }); // loader resolves with pre-purge data
    await expect(inflight).resolves.toEqual({ v: 99 }); // caller still gets its value

    // ...but the raced result must NOT have been written back to the cache.
    expect(getLoaderCacheStats().entries).toBe(0);
  });

  it("warns once per loader name when maxAge is very long", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaderFn = vi.fn(async () => ({}));

    // > 10 min → warns
    createCachedLoader("t/long-a", loaderFn, {
      policy: "stale-while-revalidate",
      maxAge: 3_600_000,
    });
    // same name again → deduped, no second warning
    createCachedLoader("t/long-a", loaderFn, {
      policy: "stale-while-revalidate",
      maxAge: 3_600_000,
    });
    // short maxAge → no warning
    createCachedLoader("t/short", loaderFn, {
      policy: "stale-while-revalidate",
      maxAge: 60_000,
    });

    const longWarnings = warn.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("t/long-a"),
    );
    const shortWarnings = warn.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("t/short"),
    );
    expect(longWarnings).toHaveLength(1);
    expect(shortWarnings).toHaveLength(0);
  });

  it("no-store policy bypasses the cache entirely", async () => {
    const loaderFn = vi.fn(async () => ({}));
    const cached = createCachedLoader("t/nostore", loaderFn, { policy: "no-store" });

    await cached({});
    await cached({});

    expect(loaderFn).toHaveBeenCalledTimes(2);
    expect(getLoaderCacheStats().entries).toBe(0);
  });

  it("shouldCache=false returns the result without storing it", async () => {
    const loaderFn = vi.fn(async () => ({ products: [] as number[] }));
    const cached = createCachedLoader("t/should-cache-miss", loaderFn, {
      policy: "stale-while-revalidate",
      maxAge: 60_000,
      shouldCache: (r) => (r as { products: number[] }).products.length > 0,
    });

    expect(await cached({})).toEqual({ products: [] });
    await cached({}); // not stored: goes to origin again

    expect(loaderFn).toHaveBeenCalledTimes(2);
    expect(getLoaderCacheStats().entries).toBe(0);
  });

  it("an uncacheable SWR refresh keeps the stale entry and retries on the next hit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T16:00:00.000Z"));
    const results = [[1], [], [2]];
    const loaderFn = vi.fn(async () => ({ products: results.shift() ?? [] }));
    const cached = createCachedLoader("t/should-cache-swr", loaderFn, {
      policy: "stale-while-revalidate",
      maxAge: 1_000,
      shouldCache: (r) => (r as { products: number[] }).products.length > 0,
    });

    await cached({}); // MISS -> stores [1]
    vi.setSystemTime(new Date("2026-05-18T16:00:05.000Z")); // now stale
    expect(await cached({})).toEqual({ products: [1] }); // refresh returns [] -> not stored
    await vi.runAllTimersAsync();
    expect(await cached({})).toEqual({ products: [1] }); // still stale [1]; refresh runs again
    await vi.runAllTimersAsync();

    expect(loaderFn).toHaveBeenCalledTimes(3);
    vi.setSystemTime(new Date("2026-05-18T16:00:05.500Z")); // within maxAge of the [2] write
    expect(await cached({})).toEqual({ products: [2] });
    vi.useRealTimers();
  });
});
