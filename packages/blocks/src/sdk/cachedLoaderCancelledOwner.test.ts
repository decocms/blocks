import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLoaderCache,
  createCachedLoader,
  createCachedLoaderFromModule,
  type LoaderModule,
} from "./cachedLoader";
import { bindCacheStorage } from "./cacheStorage";
import { DEFAULT_INFLIGHT_TIMEOUT_MS, joinInflight } from "./inflightTimeout";
import { RequestContext } from "./requestContext";

// On Cloudflare Workers, a Promise's subrequests and timers belong to the
// request that created it. When that client disconnects, the runtime cancels
// them: the shared Promise left in a dedup map never settles, and the owner's
// `withInflightTimeout` never fires. These tests reproduce that by never
// resolving the owner's work and, for `createCachedLoader`, clearing the
// owner's timers (what the runtime does to a cancelled request).

const never = <T>() => new Promise<T>(() => {});

/** Run `fn` as a worker request would: inside a RequestContext with `waitUntil` bound. */
function inRequest<T>(waitUntil: (p: Promise<unknown>) => void, fn: () => T): T {
  return RequestContext.run(new Request("https://store.test/"), () => {
    bindCacheStorage({ storage: null, scope: "test", waitUntil });
    return fn();
  });
}

beforeEach(() => {
  clearLoaderCache();
});

afterEach(() => {
  clearLoaderCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("joinInflight", () => {
  it("answers with the shared result when it settles in time", async () => {
    vi.useFakeTimers();
    const onStall = vi.fn(async () => "fresh");
    const joined = joinInflight(Promise.resolve("shared"), onStall);
    await expect(joined).resolves.toBe("shared");
    await vi.advanceTimersByTimeAsync(DEFAULT_INFLIGHT_TIMEOUT_MS);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("propagates the shared rejection", async () => {
    const joined = joinInflight(Promise.reject(new Error("upstream")), async () => "fresh");
    await expect(joined).rejects.toThrow("upstream");
  });

  it("falls back to its own work when the shared Promise never settles", async () => {
    vi.useFakeTimers();
    const joined = joinInflight(never<string>(), async () => "fresh");
    await vi.advanceTimersByTimeAsync(DEFAULT_INFLIGHT_TIMEOUT_MS);
    await expect(joined).resolves.toBe("fresh");
  });
});

describe("createCachedLoaderFromModule — owner request cancelled", () => {
  it("a joiner of a flight that never settles runs again after the timeout", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      // First call: its request was cancelled, the Promise never settles.
      if (calls === 1) return never<string>();
      return "minicart";
    });
    const mod: LoaderModule = { default: fn, cache: "stale-while-revalidate" };
    const loader = createCachedLoaderFromModule("site/loaders/minicart", mod);

    void loader({ cart: "abc" }); // owner — abandoned
    const joiner = loader({ cart: "abc" });
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DEFAULT_INFLIGHT_TIMEOUT_MS);
    await expect(joiner).resolves.toBe("minicart");
    expect(fn).toHaveBeenCalledTimes(2);

    // The dead slot is gone: the next call runs (and settles) instead of hanging.
    await expect(loader({ cart: "abc" })).resolves.toBe("minicart");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("an old flight settling late does not evict the newer one", async () => {
    vi.useFakeTimers();
    let releaseOld!: (v: string) => void;
    let releaseNew!: (v: string) => void;
    const fn = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string>((r) => (releaseOld = r)))
      .mockImplementationOnce(() => new Promise<string>((r) => (releaseNew = r)))
      .mockImplementation(async () => "third");
    const mod: LoaderModule = { default: fn, cache: "stale-while-revalidate" };
    const loader = createCachedLoaderFromModule("site/loaders/late", mod);

    void loader({ k: 1 });
    const joiner = loader({ k: 1 });
    await vi.advanceTimersByTimeAsync(DEFAULT_INFLIGHT_TIMEOUT_MS); // joiner starts flight #2
    expect(fn).toHaveBeenCalledTimes(2);

    releaseOld("old"); // flight #1 settles late
    await vi.advanceTimersByTimeAsync(0);
    // The joiner was still listening to flight #1: whichever settles first answers it.
    await expect(joiner).resolves.toBe("old");

    // A new caller still joins flight #2 rather than starting a third.
    const another = loader({ k: 1 });
    releaseNew("new");
    await expect(another).resolves.toBe("new");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("registers the owner's work with waitUntil, once per flight", async () => {
    let release!: (v: string) => void;
    const fn = vi.fn(() => new Promise<string>((r) => (release = r)));
    const mod: LoaderModule = { default: fn, cache: "stale-while-revalidate" };
    const loader = createCachedLoaderFromModule("site/loaders/kept", mod);
    const ownerWaitUntil = vi.fn();
    const joinerWaitUntil = vi.fn();

    const owner = inRequest(ownerWaitUntil, () => loader({ k: 1 }));
    const joiner = inRequest(joinerWaitUntil, () => loader({ k: 1 }));
    release("ok");
    await expect(Promise.all([owner, joiner])).resolves.toEqual(["ok", "ok"]);

    expect(ownerWaitUntil).toHaveBeenCalledTimes(1);
    expect(joinerWaitUntil).not.toHaveBeenCalled();
  });
});

describe("createCachedLoader — owner request cancelled", () => {
  it("a joiner recovers when the owner's Promise and its timeout are both dead", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const loaderFn = vi.fn(async (_p: { id: number }) => {
      calls += 1;
      if (calls === 1) return never<{ v: number }>();
      return { v: 2 };
    });
    const cached = createCachedLoader("t/cancelled-owner", loaderFn, {
      policy: "stale-while-revalidate",
      maxAge: 60_000,
    });

    void cached({ id: 1 });
    // The runtime cancelled the owner's request: its inflight timeout is gone too.
    vi.clearAllTimers();

    const joiner = cached({ id: 1 });
    await vi.advanceTimersByTimeAsync(DEFAULT_INFLIGHT_TIMEOUT_MS);
    await expect(joiner).resolves.toEqual({ v: 2 });
    expect(loaderFn).toHaveBeenCalledTimes(2);

    // Cached by the joiner's own flight: the next call is a HIT.
    await expect(cached({ id: 1 })).resolves.toEqual({ v: 2 });
    expect(loaderFn).toHaveBeenCalledTimes(2);
  });

  it("joiners of a live owner still share its single upstream call", async () => {
    let release!: (v: { v: number }) => void;
    const loaderFn = vi.fn(() => new Promise<{ v: number }>((r) => (release = r)));
    const cached = createCachedLoader("t/live-owner", loaderFn, {
      policy: "stale-while-revalidate",
      maxAge: 60_000,
    });

    const a = cached({ id: 1 });
    const b = cached({ id: 1 });
    release({ v: 1 });
    await expect(Promise.all([a, b])).resolves.toEqual([{ v: 1 }, { v: 1 }]);
    expect(loaderFn).toHaveBeenCalledTimes(1);
  });

  it("registers the owner's miss with waitUntil", async () => {
    const loaderFn = vi.fn(async (p: { id: number }) => ({ v: p.id }));
    const cached = createCachedLoader("t/kept", loaderFn, {
      policy: "stale-while-revalidate",
      maxAge: 60_000,
    });
    const waitUntil = vi.fn();

    await inRequest(waitUntil, () => cached({ id: 1 }));
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});
