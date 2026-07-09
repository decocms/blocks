import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KV_KEYS, type KVNamespace, getRevision, loadBlocks, setBlocks } from "@decocms/blocks/cms";
import { handleDecofileReload, setFastDeployKVGetter } from "./decofile";

// handleDecofileReload's dev-bypass keys off NODE_ENV === "development" (see
// decofile.ts), not import.meta.env.DEV. Vitest itself runs with
// NODE_ENV=test (not "development"), so force it here to preserve this
// suite's original intent: exercise the reload handler via the same no-auth
// branch the dev Vite plugin / `next dev` use, without needing a token.
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
beforeAll(() => {
  process.env.NODE_ENV = "development";
});
afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

// decofile.ts no longer hard-imports getFastDeployKV (that would create a
// admin → tanstack dependency, which is backwards). Instead the
// getter is injected — mirror the enablement rule that used to live in
// sdk/kvHydration.ts (DECO_FAST_DEPLOY flag + duck-typed DECO_KV binding) so
// these tests still exercise the KV write-through path end-to-end.
setFastDeployKVGetter((env) => {
  const flag = env.DECO_FAST_DEPLOY;
  if (flag !== "1" && flag !== "true") return null;
  const binding = env.DECO_KV as KVNamespace | undefined;
  if (binding && typeof binding.get === "function") return binding;
  return null;
});

function reload(payload: unknown, env?: Record<string, unknown>) {
  const req = new Request("http://x/.decofile", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
  return handleDecofileReload(req, env);
}

function makeKV() {
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
  return { kv, store };
}

beforeEach(() => {
  setBlocks({ Site: { name: "base" }, "pages-home": { path: "/" } });
});

describe("handleDecofileReload — full replacement (back-compat)", () => {
  it("replaces the whole decofile when body is a raw block map", async () => {
    const full = { Site: { name: "new" }, "pages-x": { path: "/x" } };
    const res = await reload(full);
    const json = (await res.json()) as { mode: string; ok: boolean };
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.mode).toBe("full");
    expect(loadBlocks()).toEqual(full);
  });
});

describe("handleDecofileReload — delta payloads", () => {
  it("adds/updates blocks, leaving others intact", async () => {
    const res = await reload({ blocks: { "pages-x": { path: "/x" } } });
    const json = (await res.json()) as { mode: string };
    expect(json.mode).toBe("delta");
    expect(loadBlocks()).toEqual({
      Site: { name: "base" },
      "pages-home": { path: "/" },
      "pages-x": { path: "/x" },
    });
  });

  it("deletes a block when its delta value is null", async () => {
    await reload({ blocks: { "pages-home": null } });
    expect(loadBlocks()).toEqual({ Site: { name: "base" } });
  });

  it("does NOT treat a full decofile that has many keys as a delta", async () => {
    const res = await reload({ Site: { name: "a" }, blocks: { name: "a block named blocks" } });
    const json = (await res.json()) as { mode: string };
    // Two top-level keys → full replacement, not a delta envelope.
    expect(json.mode).toBe("full");
  });
});

describe("handleDecofileReload — KV write-through", () => {
  it("writes the snapshot + revision to KV when DECO_KV is bound", async () => {
    const { kv, store } = makeKV();
    const res = await reload(
      { blocks: { "pages-x": { path: "/x" } } },
      { DECO_KV: kv, DECO_FAST_DEPLOY: "1" },
    );
    const json = (await res.json()) as { kvWritten: boolean; revision: string };

    expect(json.kvWritten).toBe(true);
    expect(store.get(KV_KEYS.SNAPSHOT)).toBe(JSON.stringify(loadBlocks()));
    expect(store.get(KV_KEYS.REVISION)).toBe(getRevision());
    expect(store.get(KV_KEYS.REVISION)).toBe(json.revision);
  });

  it("reports kvWritten=false when no KV binding is present", async () => {
    const res = await reload({ blocks: { "pages-x": { path: "/x" } } }, {});
    const json = (await res.json()) as { kvWritten: boolean };
    expect(json.kvWritten).toBe(false);
  });

  it("reports kvWritten=false when bound but DECO_FAST_DEPLOY is not set", async () => {
    const { kv, store } = makeKV();
    const res = await reload({ blocks: { "pages-x": { path: "/x" } } }, { DECO_KV: kv });
    const json = (await res.json()) as { kvWritten: boolean };
    expect(json.kvWritten).toBe(false);
    expect(store.size).toBe(0); // nothing written to KV
  });

  it("does not fail the request when the KV write throws", async () => {
    const env = {
      DECO_FAST_DEPLOY: "1",
      DECO_KV: {
        get: () => Promise.resolve(null),
        put: () => Promise.reject(new Error("KV down")),
        delete: () => Promise.resolve(),
      } as KVNamespace,
    };
    const res = await reload({ blocks: { "pages-x": { path: "/x" } } }, env);
    const json = (await res.json()) as { ok: boolean; kvWritten: boolean };
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.kvWritten).toBe(false);
    // Local state still updated despite KV failure.
    expect(loadBlocks()["pages-x"]).toEqual({ path: "/x" });
  });
});

describe("handleDecofileReload — validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const req = new Request("http://x/.decofile", { method: "POST", body: "{not json" });
    const res = await handleDecofileReload(req, {});
    expect(res.status).toBe(400);
  });

  it("returns 400 when the body is not an object", async () => {
    const res = await reload([1, 2, 3], {});
    expect(res.status).toBe(400);
  });
});

describe("handleDecofileReload — auth gate outside dev (fail-closed)", () => {
  // These tests deliberately leave the file-level NODE_ENV=development
  // override and simulate the production posture per-test: the reload
  // endpoint is DESTRUCTIVE (a posted body fully replaces the in-memory
  // registry), and the dev bypass predicate changed once already
  // (import.meta.env.DEV -> NODE_ENV) — this suite pins the fail-closed
  // side so the next predicate change can't silently open it.
  const DEV_VALUE = process.env.NODE_ENV;

  function reloadWithAuth(authHeader: string | null, env?: Record<string, unknown>) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authHeader !== null) headers.Authorization = authHeader;
    const req = new Request("http://x/.decofile", {
      method: "POST",
      body: JSON.stringify({ Site: { name: "attacker" } }),
      headers,
    });
    return handleDecofileReload(req, env);
  }

  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });
  afterEach(() => {
    process.env.NODE_ENV = DEV_VALUE;
    delete process.env.DECO_RELEASE_RELOAD_TOKEN;
  });

  it("401s with no Authorization header and leaves the registry untouched", async () => {
    const res = await reloadWithAuth(null, {});
    expect(res.status).toBe(401);
    expect((loadBlocks().Site as { name: string }).name).toBe("base");
  });

  it("401s when NO reload token is configured at all (fail-closed, not fail-open)", async () => {
    const res = await reloadWithAuth("anything", {});
    expect(res.status).toBe(401);
    expect((loadBlocks().Site as { name: string }).name).toBe("base");
  });

  it("401s on a wrong token and leaves the registry untouched", async () => {
    const res = await reloadWithAuth("wrong-token", {
      DECO_RELEASE_RELOAD_TOKEN: "right-token",
    });
    expect(res.status).toBe(401);
    expect((loadBlocks().Site as { name: string }).name).toBe("base");
  });

  it("401s when NODE_ENV is unset (fail-closed by default)", async () => {
    delete process.env.NODE_ENV;
    const res = await reloadWithAuth(null, {});
    expect(res.status).toBe(401);
    expect((loadBlocks().Site as { name: string }).name).toBe("base");
  });

  it("accepts the correct token and performs the replacement", async () => {
    const res = await reloadWithAuth("right-token", {
      DECO_RELEASE_RELOAD_TOKEN: "right-token",
    });
    expect(res.status).toBe(200);
    expect((loadBlocks().Site as { name: string }).name).toBe("attacker");
  });
});
