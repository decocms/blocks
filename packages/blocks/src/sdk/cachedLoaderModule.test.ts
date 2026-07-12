import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearLoaderCache,
  createCachedLoaderFromModule,
  createLoaderEntry,
  type LoaderModule,
} from "./cachedLoader";
import { RequestContext } from "./requestContext";

/** A loader whose `default` we can count calls on and control resolution of. */
function makeLoader<T>(result: T) {
  let resolve!: (v: T) => void;
  const gate = new Promise<T>((r) => (resolve = r));
  const fn = vi.fn(async (_props: unknown, _req?: Request) => {
    await gate;
    return result;
  });
  return { fn, release: () => resolve(result) };
}

afterEach(() => {
  clearLoaderCache();
  vi.restoreAllMocks();
});

describe("createCachedLoaderFromModule — dedup-only (no SWR)", () => {
  it("runs on every call when the module has no `cache` export (apps no-store default)", async () => {
    const { fn, release } = makeLoader("x");
    release();
    const mod: LoaderModule = { default: fn };
    const loader = createCachedLoaderFromModule("site/loaders/plain", mod);

    // No wrap at all → returns the original function identity.
    expect(loader).toBe(fn);

    await loader({ a: 1 });
    await loader({ a: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("runs on every call for `no-cache` (only stale-while-revalidate opts into dedup)", async () => {
    const { fn, release } = makeLoader("x");
    const mod: LoaderModule = { default: fn, cache: "no-cache" };
    const loader = createCachedLoaderFromModule("site/loaders/nocache", mod);

    expect(loader).toBe(fn);
    const p1 = loader({ a: 1 });
    const p2 = loader({ a: 1 });
    release();
    await Promise.all([p1, p2]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent identical calls into ONE upstream call when `cache` opts in", async () => {
    const { fn, release } = makeLoader("shelf");
    const mod: LoaderModule = { default: fn, cache: "stale-while-revalidate" };
    const loader = createCachedLoaderFromModule("site/loaders/related", mod);

    // Three sections on one render invoke the same loader concurrently.
    const p1 = loader({ slug: "abc" });
    const p2 = loader({ slug: "abc" });
    const p3 = loader({ slug: "abc" });
    release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toBe("shelf");
    expect(r2).toBe("shelf");
    expect(r3).toBe("shelf");
    // The #339 N+1 fix: 3 concurrent references → 1 upstream call.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retain results across settlement (no cross-request staleness)", async () => {
    const { fn, release } = makeLoader("v");
    release();
    const mod: LoaderModule = { default: fn, cache: "stale-while-revalidate" };
    const loader = createCachedLoaderFromModule("site/loaders/nostale", mod);

    await loader({ slug: "abc" });
    // Sequential (non-concurrent) call after the first settled → re-runs.
    await loader({ slug: "abc" });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("dedups by the module's custom cacheKey(props, req), not raw props", async () => {
    const { fn, release } = makeLoader("p");
    const mod: LoaderModule = {
      default: fn,
      cache: "stale-while-revalidate",
      // Key only on pathname — ignores tracking params on the URL.
      cacheKey: (_props, req) => new URL(req!.url).pathname,
    };
    const loader = createCachedLoaderFromModule("site/loaders/pdp", mod);

    const reqA = new Request("https://x.test/produto?utm_source=a");
    const reqB = new Request("https://x.test/produto?utm_source=b");
    const p1 = loader({ id: 1 }, reqA);
    const p2 = loader({ id: 2 }, reqB); // different props + url, same pathname
    release();
    await Promise.all([p1, p2]);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs fresh (no dedup) when cacheKey returns null", async () => {
    const { fn, release } = makeLoader("p");
    const mod: LoaderModule = {
      default: fn,
      cache: "stale-while-revalidate",
      cacheKey: () => null,
    };
    const loader = createCachedLoaderFromModule("site/loaders/personalized", mod);

    const req = new Request("https://x.test/");
    const p1 = loader({ id: 1 }, req);
    const p2 = loader({ id: 1 }, req);
    release();
    await Promise.all([p1, p2]);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("sources req from RequestContext when the caller passes none (CMS-resolution path)", async () => {
    const { fn, release } = makeLoader("p");
    const seen: string[] = [];
    const mod: LoaderModule = {
      default: fn,
      cache: "stale-while-revalidate",
      cacheKey: (_props, req) => {
        seen.push(new URL(req!.url).pathname);
        return new URL(req!.url).pathname;
      },
    };
    const loader = createCachedLoaderFromModule("site/loaders/ctx", mod);

    const req = new Request("https://x.test/categoria");
    await RequestContext.run(req, async () => {
      // Called with ONLY props, mirroring resolve.ts internalResolve.
      const p1 = loader({ a: 1 });
      const p2 = loader({ a: 1 });
      release();
      await Promise.all([p1, p2]);
    });

    expect(seen).toContain("/categoria");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("falls back to props-hash dedup when cacheKey needs req but none is available", async () => {
    const { fn, release } = makeLoader("p");
    const mod: LoaderModule = {
      default: fn,
      cache: "stale-while-revalidate",
      // Would throw on undefined req — the wrapper must not call it without one.
      cacheKey: (_props, req) => new URL(req!.url).pathname,
    };
    const loader = createCachedLoaderFromModule("site/loaders/noreq", mod);

    // No req arg, no RequestContext scope.
    const p1 = loader({ a: 1 });
    const p2 = loader({ a: 1 });
    release();
    await expect(Promise.all([p1, p2])).resolves.toEqual(["p", "p"]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("propagates loader errors and clears the in-flight entry", async () => {
    const err = new Error("upstream down");
    const fn = vi.fn(async () => {
      throw err;
    });
    const mod: LoaderModule = { default: fn, cache: "stale-while-revalidate" };
    const loader = createCachedLoaderFromModule("site/loaders/boom", mod);

    await expect(loader({ a: 1 })).rejects.toThrow("upstream down");
    // A retry after failure is not blocked by a stuck in-flight entry.
    await expect(loader({ a: 1 })).rejects.toThrow("upstream down");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("createLoaderEntry — lazy import + wrap", () => {
  it("imports the module once and dedups concurrent calls", async () => {
    const { fn, release } = makeLoader("lazy");
    const importFn = vi.fn(async () => ({
      default: fn,
      cache: "stale-while-revalidate" as const,
    }));
    const entry = createLoaderEntry("site/loaders/lazy", importFn);

    const p1 = entry({ a: 1 });
    const p2 = entry({ a: 1 });
    release();
    await Promise.all([p1, p2]);

    expect(importFn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes non-opted-in loaders straight through", async () => {
    const { fn, release } = makeLoader("plain");
    release();
    const entry = createLoaderEntry("site/loaders/plain", async () => ({ default: fn }));

    await entry({ a: 1 });
    await entry({ a: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
