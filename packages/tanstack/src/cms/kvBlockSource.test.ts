import { describe, expect, it } from "vitest";
import { computeRevision, type KVNamespace, revisionKey, snapshotKey } from "@decocms/blocks/cms";
import { KVBlockSource } from "./kvBlockSource";

const ID = "sha-abc123";
const SNAP = snapshotKey(ID);
const REV = revisionKey(ID);

function makeKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
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
}

describe("KVBlockSource.loadSnapshot", () => {
  it("returns null when the snapshot key is missing", async () => {
    const src = new KVBlockSource(makeKV(), ID);
    await expect(src.loadSnapshot()).resolves.toBeNull();
  });

  it("reads the key for its own deployment id, not another", async () => {
    const blocks = { Site: { name: "x" } };
    // Store under a DIFFERENT deployment id — this source must not see it.
    const src = new KVBlockSource(
      makeKV({ [snapshotKey("other-sha")]: JSON.stringify(blocks) }),
      ID,
    );
    await expect(src.loadSnapshot()).resolves.toBeNull();
  });

  it("returns blocks with the stored revision", async () => {
    const blocks = { Site: { name: "x" } };
    const src = new KVBlockSource(
      makeKV({
        [SNAP]: JSON.stringify(blocks),
        [REV]: "stored-rev",
      }),
      ID,
    );
    await expect(src.loadSnapshot()).resolves.toEqual({ blocks, revision: "stored-rev" });
  });

  it("recomputes the revision when only the snapshot is stored", async () => {
    const blocks = { Site: { name: "x" } };
    const src = new KVBlockSource(makeKV({ [SNAP]: JSON.stringify(blocks) }), ID);
    await expect(src.loadSnapshot()).resolves.toEqual({
      blocks,
      revision: computeRevision(blocks),
    });
  });

  it("throws on a non-object snapshot (treated as KV-unavailable by callers)", async () => {
    const src = new KVBlockSource(makeKV({ [SNAP]: "[1,2,3]" }), ID);
    await expect(src.loadSnapshot()).rejects.toThrow();
  });

  it("throws on malformed JSON", async () => {
    const src = new KVBlockSource(makeKV({ [SNAP]: "{not json" }), ID);
    await expect(src.loadSnapshot()).rejects.toThrow();
  });
});

describe("KVBlockSource.getRevision", () => {
  it("returns the stored revision", async () => {
    const src = new KVBlockSource(makeKV({ [REV]: "r1" }), ID);
    await expect(src.getRevision()).resolves.toBe("r1");
  });

  it("returns null when absent", async () => {
    const src = new KVBlockSource(makeKV(), ID);
    await expect(src.getRevision()).resolves.toBeNull();
  });
});
