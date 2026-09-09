import {
  baseBlocksKey,
  computeRevision,
  findPageByPath,
  getRevision,
  hasPageSource,
  type KVNamespace,
  loadBlocks,
  pageBlockKey,
  pageIndexKey,
  revisionKey,
  setBlocks,
  setPageSource,
  snapshotKey,
} from "@decocms/blocks/cms";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetKvHydrationStateForTests,
  ensureBlocksHydrated,
  getDeploymentId,
  isFastDeployEnabled,
  maybePollRevision,
} from "./kvHydration";

const BUNDLED = { Site: { name: "bundled" } };

/** Deployment id used across the hydration tests. */
const ID = "sha-deadbeef";
const SNAP = snapshotKey(ID);
const REV = revisionKey(ID);

/** KV stub that counts get() calls so we can assert throttling / single-load. */
function makeKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  let getCalls = 0;
  const kv: KVNamespace = {
    get: (k) => {
      getCalls++;
      return Promise.resolve(store.get(k) ?? null);
    },
    put: (k, v) => {
      store.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      store.delete(k);
      return Promise.resolve();
    },
  };
  return { kv, store, getCalls: () => getCalls };
}

function snapshotEnv(blocks: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const { kv, ...rest } = makeKV({
    [SNAP]: JSON.stringify(blocks),
    [REV]: computeRevision(blocks),
  });
  // DECO_FAST_DEPLOY="1" is the explicit opt-in required alongside the binding;
  // DECO_DEPLOYMENT_ID scopes the read to this deployment's keyed snapshot.
  return {
    env: { DECO_KV: kv, DECO_FAST_DEPLOY: "1", DECO_DEPLOYMENT_ID: ID, ...extra },
    kv,
    ...rest,
  };
}

/** Collects ctx.waitUntil promises so tests can await background polls. */
function makeCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => promises.push(p) },
    settle: () => Promise.allSettled(promises),
  };
}

beforeEach(() => {
  __resetKvHydrationStateForTests();
  setBlocks({ ...BUNDLED }); // reset in-memory decofile to a known bundled state
  vi.restoreAllMocks();
});

describe("isFastDeployEnabled", () => {
  it("is false without a KV binding even when the flag is set", () => {
    expect(isFastDeployEnabled({ DECO_FAST_DEPLOY: "1" })).toBe(false);
  });

  it("is false when a non-KV value is named DECO_KV", () => {
    expect(isFastDeployEnabled({ DECO_KV: "some-secret-string", DECO_FAST_DEPLOY: "1" })).toBe(
      false,
    );
  });

  it("is false when bound but DECO_FAST_DEPLOY is not set (explicit opt-in required)", () => {
    const { kv } = makeKV();
    expect(isFastDeployEnabled({ DECO_KV: kv })).toBe(false);
  });

  it("is true when bound AND DECO_FAST_DEPLOY=1", () => {
    const { kv } = makeKV();
    expect(isFastDeployEnabled({ DECO_KV: kv, DECO_FAST_DEPLOY: "1" })).toBe(true);
  });

  it("accepts DECO_FAST_DEPLOY=true as well", () => {
    const { kv } = makeKV();
    expect(isFastDeployEnabled({ DECO_KV: kv, DECO_FAST_DEPLOY: "true" })).toBe(true);
  });

  it("is false when DECO_FAST_DEPLOY=0 even if bound", () => {
    const { kv } = makeKV();
    expect(isFastDeployEnabled({ DECO_KV: kv, DECO_FAST_DEPLOY: "0" })).toBe(false);
  });
});

describe("ensureBlocksHydrated", () => {
  it("is a no-op when fast-deploy is disabled (keeps bundled blocks)", async () => {
    await ensureBlocksHydrated({});
    expect(loadBlocks()).toEqual(BUNDLED);
  });

  it("swaps the in-memory decofile with the KV snapshot", async () => {
    const kvBlocks = { Site: { name: "from-kv" }, "pages-home": { path: "/" } };
    const { env } = snapshotEnv(kvBlocks);
    await ensureBlocksHydrated(env);
    expect(loadBlocks()).toEqual(kvBlocks);
    expect(getRevision()).toBe(computeRevision(kvBlocks));
  });

  it("loads only once even across concurrent first requests", async () => {
    const kvBlocks = { Site: { name: "from-kv" } };
    const { env, getCalls } = snapshotEnv(kvBlocks);
    await Promise.all([
      ensureBlocksHydrated(env),
      ensureBlocksHydrated(env),
      ensureBlocksHydrated(env),
    ]);
    // SNAPSHOT + REVISION = 2 gets for a single load (not 6). The split keys
    // are not probed at all while DECO_BLOCKS_SPLIT is off.
    expect(getCalls()).toBe(2);
  });

  it("keeps the bundled snapshot when this deployment's snapshot key is absent", async () => {
    const { kv } = makeKV({ [REV]: "r" }); // revision present, but no SNAPSHOT
    await ensureBlocksHydrated({ DECO_KV: kv, DECO_FAST_DEPLOY: "1", DECO_DEPLOYMENT_ID: ID });
    expect(loadBlocks()).toEqual(BUNDLED);
  });

  it("keeps bundled (never touches KV) when no deployment id resolves", async () => {
    const kvBlocks = { Site: { name: "from-kv" } };
    const { kv, getCalls } = makeKV({ [SNAP]: JSON.stringify(kvBlocks) });
    // Fast-deploy enabled + bound, but no DECO_DEPLOYMENT_ID / BUILD_HASH.
    await ensureBlocksHydrated({ DECO_KV: kv, DECO_FAST_DEPLOY: "1" });
    expect(loadBlocks()).toEqual(BUNDLED);
    expect(getCalls()).toBe(0);
  });

  it("falls back to bundled (and does not throw) when KV errors", async () => {
    const kv: KVNamespace = {
      get: () => Promise.reject(new Error("KV down")),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      ensureBlocksHydrated({ DECO_KV: kv, DECO_FAST_DEPLOY: "1", DECO_DEPLOYMENT_ID: ID }),
    ).resolves.toBeUndefined();
    expect(loadBlocks()).toEqual(BUNDLED);
  });
});

describe("getDeploymentId", () => {
  it("prefers DECO_DEPLOYMENT_ID", () => {
    expect(getDeploymentId({ DECO_DEPLOYMENT_ID: "a", BUILD_HASH: "b" })).toBe("a");
  });

  it("falls back to BUILD_HASH", () => {
    expect(getDeploymentId({ BUILD_HASH: "b" })).toBe("b");
  });

  it("is null when nothing resolves", () => {
    expect(getDeploymentId({})).toBeNull();
  });
});

describe("maybePollRevision", () => {
  it("is a no-op before cold-start hydration has run", async () => {
    const { env, getCalls } = snapshotEnv({ Site: { name: "x" } });
    const { ctx, settle } = makeCtx();
    maybePollRevision(env, ctx); // kvHydrated is false
    await settle();
    expect(getCalls()).toBe(0);
  });

  it("reloads the decofile when the KV revision changed", async () => {
    const initial = { Site: { name: "v1" } };
    const { env, store } = snapshotEnv(initial);
    await ensureBlocksHydrated(env);
    expect(loadBlocks()).toEqual(initial);

    // Simulate a publish from another isolate: KV now holds v2.
    const updated = { Site: { name: "v2" }, "pages-x": { path: "/x" } };
    store.set(SNAP, JSON.stringify(updated));
    store.set(REV, computeRevision(updated));

    const { ctx, settle } = makeCtx();
    maybePollRevision(env, ctx);
    await settle();
    expect(loadBlocks()).toEqual(updated);
  });

  it("throttles to one probe per interval", async () => {
    const { env, getCalls } = snapshotEnv({ Site: { name: "x" } });
    await ensureBlocksHydrated(env);
    const callsAfterHydrate = getCalls();

    const { ctx, settle } = makeCtx();
    maybePollRevision(env, ctx); // fires (revision unchanged → 1 get)
    maybePollRevision(env, ctx); // throttled → no get
    maybePollRevision(env, ctx); // throttled → no get
    await settle();

    // Exactly one extra getRevision() beyond the hydrate calls.
    expect(getCalls()).toBe(callsAfterHydrate + 1);
  });
});

// ---------------------------------------------------------------------------
// Bundles that ship no decofile (`decoVitePlugin({ fastDeploy: true })`)
//
// With the decofile stubbed out of the server bundle, KV is the ONLY source of
// content. The "warn and serve bundled" recovery would serve an EMPTY site —
// 200s with no pages, which get edge-cached and outlive the KV failure that
// caused them. These assert it fails loudly instead.
//
// The signal is the build-time `__DECO_BLOCKS_STUBBED__` define, NOT an empty
// in-memory map: draft overrides can make a stubbed bundle look populated, and
// a legitimately-empty decofile would look stubbed. Both are covered below.
// ---------------------------------------------------------------------------
declare global {
  // eslint-disable-next-line no-var
  var __DECO_BLOCKS_STUBBED__: boolean | undefined;
}

/** Simulates a build made with `fastDeploy: true`. */
function withStubbedBundle() {
  globalThis.__DECO_BLOCKS_STUBBED__ = true;
}

describe("ensureBlocksHydrated when the bundle ships no decofile", () => {
  beforeEach(() => {
    globalThis.__DECO_BLOCKS_STUBBED__ = undefined;
  });

  it("throws when the snapshot is missing instead of serving an empty site", async () => {
    withStubbedBundle();
    setBlocks({});
    const { kv } = makeKV(); // no decofile:<id> seeded
    const env = { DECO_KV: kv, DECO_FAST_DEPLOY: "1", DECO_DEPLOYMENT_ID: ID };

    await expect(ensureBlocksHydrated(env)).rejects.toThrow(/and this bundle ships no decofile/);
  });

  it("throws when the snapshot exists but is empty", async () => {
    // A seed that wrote `{}` would otherwise take the success branch, latch,
    // and serve the empty edge-cached site this guard exists to prevent.
    withStubbedBundle();
    setBlocks({});
    const { kv } = makeKV({ [SNAP]: "{}", [REV]: computeRevision({}) });

    await expect(
      ensureBlocksHydrated({ DECO_KV: kv, DECO_FAST_DEPLOY: "1", DECO_DEPLOYMENT_ID: ID }),
    ).rejects.toThrow(/and this bundle ships no decofile/);
  });

  it("throws when KV itself fails", async () => {
    withStubbedBundle();
    setBlocks({});
    const kv = {
      get: () => Promise.reject(new Error("KV unreachable")),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    } as unknown as KVNamespace;

    await expect(
      ensureBlocksHydrated({ DECO_KV: kv, DECO_FAST_DEPLOY: "1", DECO_DEPLOYMENT_ID: ID }),
    ).rejects.toThrow(/KV unreachable/);
  });

  it("throws when no deployment id resolves", async () => {
    withStubbedBundle();
    setBlocks({});
    const { kv } = makeKV();

    await expect(ensureBlocksHydrated({ DECO_KV: kv, DECO_FAST_DEPLOY: "1" })).rejects.toThrow(
      /no deployment id/,
    );
  });

  it("is not rescued by a populated in-memory map (draft-preview overrides)", async () => {
    // `bindRequestDraft` composes overrides into loadBlocks() BEFORE hydration.
    // Inferring "has a fallback" from the map would latch here and then serve
    // the empty base decofile for the isolate's life.
    withStubbedBundle();
    setBlocks({ "pages-Draft": { name: "override" } });
    const { kv } = makeKV();

    await expect(
      ensureBlocksHydrated({ DECO_KV: kv, DECO_FAST_DEPLOY: "1", DECO_DEPLOYMENT_ID: ID }),
    ).rejects.toThrow(/and this bundle ships no decofile/);
  });

  it("does not latch hydration on the fatal path, so the next request retries", async () => {
    withStubbedBundle();
    setBlocks({});
    const blocks = { Site: { name: "from-kv" } };
    const store = new Map<string, string>();
    const kv: KVNamespace = {
      get: (k) => Promise.resolve(store.get(k) ?? null),
      put: (k, v) => {
        store.set(k, v);
        return Promise.resolve();
      },
      delete: (k) => {
        store.delete(k);
        return Promise.resolve();
      },
    };
    const env = { DECO_KV: kv, DECO_FAST_DEPLOY: "1", DECO_DEPLOYMENT_ID: ID };

    // First request: snapshot absent → fatal.
    await expect(ensureBlocksHydrated(env)).rejects.toThrow();

    // Operator seeds it; the isolate must pick it up rather than stay empty.
    store.set(SNAP, JSON.stringify(blocks));
    store.set(REV, computeRevision(blocks));

    await expect(ensureBlocksHydrated(env)).resolves.toBeUndefined();
    expect(loadBlocks()).toEqual(blocks);
  });
});

describe("ensureBlocksHydrated when the bundle DOES ship a decofile (default)", () => {
  beforeEach(() => {
    globalThis.__DECO_BLOCKS_STUBBED__ = undefined;
  });

  it("warns and serves bundled when KV fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = {
      get: () => Promise.reject(new Error("KV unreachable")),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    } as unknown as KVNamespace;

    await expect(
      ensureBlocksHydrated({ DECO_KV: kv, DECO_FAST_DEPLOY: "1", DECO_DEPLOYMENT_ID: ID }),
    ).resolves.toBeUndefined();
    expect(loadBlocks()).toEqual(BUNDLED);
    expect(warn).toHaveBeenCalled();
  });

  it("does not 5xx a site whose bundled decofile is legitimately empty", async () => {
    // New site / missing blocks.gen.json. Before the build-time flag this
    // looked identical to a stubbed bundle and started failing requests.
    setBlocks({});
    const { kv } = makeKV(); // no snapshot seeded either

    await expect(
      ensureBlocksHydrated({ DECO_KV: kv, DECO_FAST_DEPLOY: "1", DECO_DEPLOYMENT_ID: ID }),
    ).resolves.toBeUndefined();
  });
});

describe("ensureBlocksHydrated — split layout (DECO_BLOCKS_SPLIT)", () => {
  const home = { name: "Home", path: "/", sections: [] };
  const full = { Site: { name: "kv" }, "pages-home": home };

  /** KV seeded with BOTH layouts, exactly as the CI sync writes them. */
  function splitKV() {
    return makeKV({
      [baseBlocksKey(ID)]: JSON.stringify({ Site: { name: "kv" } }),
      [pageIndexKey(ID)]: JSON.stringify([{ key: "pages-home", path: "/" }]),
      [pageBlockKey(ID, "pages-home")]: JSON.stringify(home),
      [SNAP]: JSON.stringify(full),
      [REV]: computeRevision(full),
    });
  }

  beforeEach(() => {
    setPageSource(null);
    __resetKvHydrationStateForTests();
    setBlocks(BUNDLED);
  });

  it("hydrates only the non-page half and routes pages through KV", async () => {
    const { kv } = splitKV();
    await ensureBlocksHydrated({
      DECO_KV: kv,
      DECO_FAST_DEPLOY: "1",
      DECO_DEPLOYMENT_ID: ID,
      DECO_BLOCKS_SPLIT: "1",
    });

    expect(loadBlocks()).toEqual({ Site: { name: "kv" } });
    expect(hasPageSource()).toBe(true);
    await expect(findPageByPath("/")).resolves.toMatchObject({ blockKey: "pages-home" });

    // The revision must be the WHOLE decofile's, not a hash of the base half,
    // or the poller would see a permanent mismatch and reload every tick.
    expect(getRevision()).toBe(computeRevision(full));
  });

  it("ignores the split keys and loads the whole snapshot when the flag is off", async () => {
    const { kv } = splitKV();
    await ensureBlocksHydrated({ DECO_KV: kv, DECO_FAST_DEPLOY: "1", DECO_DEPLOYMENT_ID: ID });

    expect(hasPageSource()).toBe(false);
    expect(loadBlocks()).toEqual(full);
  });

  it("falls back to the whole snapshot when the split keys are absent", async () => {
    const { kv } = makeKV({ [SNAP]: JSON.stringify(full), [REV]: computeRevision(full) });
    await ensureBlocksHydrated({
      DECO_KV: kv,
      DECO_FAST_DEPLOY: "1",
      DECO_DEPLOYMENT_ID: ID,
      DECO_BLOCKS_SPLIT: "1",
    });

    // Flag on but the deployment was synced by a writer that had it off — a
    // mixed fleet has to keep serving.
    expect(hasPageSource()).toBe(false);
    expect(loadBlocks()).toEqual(full);
  });
});
