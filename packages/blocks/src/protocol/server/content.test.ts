// @vitest-environment node
/**
 * Reading content that changes underneath: bodies always match the versions
 * and revision they're served with, and the body cache is never poisoned.
 */
import { describe, expect, it } from "vitest";
import { createContentClient } from "../client";
import { ErrorCode } from "../errors";
import { serializeBlock } from "../keys";
import type { ContentStorage } from "../storage";
import { createMemoryStorage } from "../storage/memory";
import { createContentHandler } from "./handler";

const file = (value: unknown) => serializeBlock(value);

function clientFor(storage: ContentStorage) {
  return createContentClient({
    endpoint: "http://test.local/rpc",
    fetch: createContentHandler(storage),
  });
}

async function list(storage: ContentStorage) {
  const result = await clientFor(storage).blocksList();
  if (result.notModified) throw new Error("expected a full list");
  return result;
}

describe("a file that changes while bodies are read", () => {
  it("takes a new snapshot, so bodies, versions and the revision agree", async () => {
    let edited = false;
    const storage = createMemoryStorage({
      state: { files: { "a.json": file({ v: 1 }), "b.json": file({ v: 1 }) } },
      // Right after a.json is read, someone edits b.json, before it's read.
      afterRead: (read, s) => {
        if (read !== "a.json" || edited) return;
        edited = true;
        s.setFile("b.json", file({ v: 2 }));
      },
    });
    const result = await list(storage);
    expect(result.blocks.b).toEqual({ v: 2 });
    const fresh = await storage.snapshot();
    expect(result.revision).toBe(fresh.revision);
    expect(result.versions.b).toBe(fresh.files.find((f) => f.file === "b.json")!.version);
  });

  it("never caches a body under a version it doesn't have", async () => {
    const v1 = file({ v: 1 });
    let edits = 0;
    const storage = createMemoryStorage({
      state: { files: { "a.json": v1, "b.json": v1 } },
      afterRead: (read, s) => {
        if (read === "a.json" && edits++ === 0) s.setFile("b.json", file({ v: 2 }));
      },
    });
    const client = clientFor(storage);
    const first = await client.blocksList();
    expect(!first.notModified && first.blocks.b).toEqual({ v: 2 });
    // Revert b.json to the bytes of the first snapshot: the old body must come back.
    storage.setFile("b.json", v1);
    const second = await client.blocksList();
    expect(!second.notModified && second.blocks.b).toEqual({ v: 1 });
  });

  it("answers Unavailable with retry timing when files keep changing", async () => {
    const memory = createMemoryStorage({ state: { files: { "a.json": file({ v: 0 }) } } });
    let n = 0;
    // Every read sees bytes newer than the snapshot it was asked for.
    const storage: ContentStorage = {
      ...memory,
      readFiles: async (_snapshot, files) =>
        Object.fromEntries(files.map((f) => [f, { text: file({ v: ++n }), version: `v${n}` }])),
    };
    const error = await clientFor(storage)
      .blocksList()
      .catch((e) => e);
    expect(error.code).toBe(ErrorCode.Unavailable);
    expect(error.data).toEqual({ retryAfterMs: expect.any(Number) });
  });

  it("treats a file that vanished before its read as a change", async () => {
    let removed = false;
    const storage = createMemoryStorage({
      state: { files: { "a.json": file({ v: 1 }), "b.json": file({ v: 1 }) } },
      afterRead: (read, s) => {
        if (read !== "a.json" || removed) return;
        removed = true;
        s.setFile("b.json", null);
      },
    });
    const result = await list(storage);
    expect(Object.keys(result.blocks)).toEqual(["a"]);
    expect(result.revision).toBe((await storage.snapshot()).revision);
  });

  it("detects the race with a storage whose readFiles returns changed content", async () => {
    const memory = createMemoryStorage({ state: { files: { "a.json": file({ v: 1 }) } } });
    let reads = 0;
    const racy: ContentStorage = {
      ...memory,
      async readFiles(snapshot, files) {
        const out = await memory.readFiles(snapshot, files);
        // The first read sees bytes newer than its snapshot.
        if (reads++ === 0) out["a.json"] = { text: file({ v: 9 }), version: "newer" };
        return out;
      },
    };
    const result = await list(racy);
    expect(result.blocks.a).toEqual({ v: 1 });
    expect(reads).toBe(2);
  });
});
