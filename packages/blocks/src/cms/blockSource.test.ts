import { describe, expect, it } from "vitest";
import {
  BundledBlockSource,
  computeRevision,
  DEPLOYMENTS_KEY,
  type KVNamespace,
  LIVE_KEY,
  revisionKey,
  snapshotKey,
} from "./blockSource";
import { djb2Hex } from "../sdk/djb2";

describe("computeRevision", () => {
  it("matches loader.ts computeRevision (djb2Hex of JSON.stringify)", () => {
    const blocks = { Site: { name: "x" }, "pages-home": { path: "/" } };
    expect(computeRevision(blocks)).toBe(djb2Hex(JSON.stringify(blocks)));
  });

  it("is stable for the same input and differs on change", () => {
    const a = { a: 1 };
    const b = { a: 2 };
    expect(computeRevision(a)).toBe(computeRevision(a));
    expect(computeRevision(a)).not.toBe(computeRevision(b));
  });

  it("hashes an empty decofile without throwing", () => {
    expect(typeof computeRevision({})).toBe("string");
  });
});

describe("BundledBlockSource", () => {
  it("loadSnapshot resolves null (bundled is applied at startup, not here)", async () => {
    const src = new BundledBlockSource();
    await expect(src.loadSnapshot()).resolves.toBeNull();
  });

  it("getRevision resolves null", async () => {
    const src = new BundledBlockSource();
    await expect(src.getRevision()).resolves.toBeNull();
  });
});

describe("KV key layout (per deployment)", () => {
  it("keys the snapshot and revision by deployment id", () => {
    expect(snapshotKey("abc123")).toBe("decofile:abc123");
    expect(revisionKey("abc123")).toBe("index:revision:abc123");
  });

  it("exposes stable pointer/bookkeeping keys", () => {
    expect(LIVE_KEY).toBe("index:live");
    expect(DEPLOYMENTS_KEY).toBe("index:deployments");
  });
});

describe("KVNamespace structural type", () => {
  it("a plain Map-backed stub satisfies the interface", async () => {
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

    const key = revisionKey("abc123");
    await kv.put(key, "abc");
    await expect(kv.get(key)).resolves.toBe("abc");
    await kv.delete(key);
    await expect(kv.get(key)).resolves.toBeNull();
  });
});
