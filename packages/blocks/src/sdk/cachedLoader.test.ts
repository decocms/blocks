import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bustLoaderCache,
  clearLoaderCache,
  createCachedLoader,
  getLoaderCacheStats,
} from "./cachedLoader";

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

  it("bustLoaderCache() empties the cache so the next call is a MISS", async () => {
    const loaderFn = vi.fn(async (p: { id: number }) => ({ v: p.id }));
    const cached = createCachedLoader("t/bust", loaderFn, {
      policy: "stale-while-revalidate",
      maxAge: 60_000,
    });

    await cached({ id: 1 }); // MISS
    await cached({ id: 1 }); // HIT
    expect(loaderFn).toHaveBeenCalledTimes(1);

    bustLoaderCache();
    expect(getLoaderCacheStats().entries).toBe(0);

    await cached({ id: 1 }); // MISS again — cache was busted
    expect(loaderFn).toHaveBeenCalledTimes(2);
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
});
