// @vitest-environment node
/**
 * changes.list / changes.get / changes.discard over the memory storage:
 * spelling groups on both sides, unreadable files, the guards and retries of
 * a discard, and the server-side memo of the storage's answer.
 */
import { describe, expect, it, vi } from "vitest";
import { createContentClient } from "../client";
import { type ContentProtocolError, ErrorCode } from "../errors";
import { serializeBlock } from "../keys";
import { createMemoryStorage, type MemoryStorageOptions } from "../storage/memory";
import { MAX_BLOCK_BYTES } from "./core";
import { createContentHandler } from "./handler";

const file = (value: unknown) => serializeBlock(value);

function setup(storageOptions: MemoryStorageOptions = {}) {
  const storage = createMemoryStorage(storageOptions);
  const handler = createContentHandler(storage, { commitRetryDelayMs: { minMs: 0, maxMs: 0 } });
  const client = createContentClient({ endpoint: "http://test.local/rpc", fetch: handler });
  return { storage, client };
}

/** A storage whose base and current files are both `files`. */
function committed(files: Record<string, string>, options: MemoryStorageOptions = {}) {
  return setup({ ...options, state: { files, base: files, ...options.state } });
}

async function rejects(promise: Promise<unknown>, code: number): Promise<ContentProtocolError> {
  const error = (await promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (e) => e,
  )) as ContentProtocolError;
  expect(error.code).toBe(code);
  return error;
}

async function listed(client: ReturnType<typeof setup>["client"]) {
  const result = await client.changesList();
  if (result.notModified) throw new Error("expected the changes");
  return result.changes;
}

describe("changes.list", () => {
  it("lists set and delete changes against the base, by entry name", async () => {
    const { storage, client } = committed({
      "home.json": file({ title: "Home" }),
      "footer.json": file({ links: [] }),
    });
    expect(await listed(client)).toEqual({});
    storage.setFile("home.json", file({ title: "New home" }));
    storage.setFile("footer.json", null);
    storage.setFile("new.json", file({ v: 1 }));
    const changes = await listed(client);
    expect(Object.keys(changes)).toEqual(["footer", "home", "new"]);
    expect(changes.footer).toMatchObject({ kind: "delete", version: null });
    expect(changes.home).toMatchObject({ kind: "set", baseVersion: expect.any(String) });
    expect(changes.new).toMatchObject({ kind: "set", baseVersion: null });
    const blocks = await client.blocksList();
    expect(!blocks.notModified && blocks.versions.home).toBe(changes.home!.version);
  });

  it("answers notModified with the base, and moves when only the base moves", async () => {
    const { storage, client } = committed({ "a.json": file({ v: 1 }) });
    const first = await client.changesList();
    const poll = await client.changesList({ ifNoneMatch: first.revision });
    expect(poll).toEqual({ notModified: true, revision: first.revision, base: first.base });
    storage.setBase({});
    const moved = await client.changesList({ ifNoneMatch: first.revision });
    expect(moved.notModified).toBe(false);
    expect(!moved.notModified && Object.keys(moved.changes)).toEqual(["a"]);
  });

  it("asks the storage once per content and base (memo)", async () => {
    const { storage, client } = committed({ "a.json": file({ v: 1 }) });
    const spy = vi.spyOn(storage, "changes");
    await client.changesList();
    await client.changesList();
    await client.changesGet({ names: ["a"] });
    expect(spy).toHaveBeenCalledTimes(1);
    storage.setFile("a.json", file({ v: 2 }));
    await client.changesList();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("treats every spelling of a name as one entry, on both sides", async () => {
    const { storage, client } = committed({ "a%20b.json": file({ v: 1 }) });
    // A second spelling appears: the entry differs (a stray spelling), the winner is the same.
    storage.setFile("a%2520b.json", file({ v: 1 }));
    // Listed under the name blocks.list reports for the entry now (the winning spelling).
    const blocks = await client.blocksList();
    const changes = await listed(client);
    expect(Object.keys(changes)).toEqual(!blocks.notModified ? Object.keys(blocks.blocks) : []);
    const result = await client.changesDiscard({ names: ["a b"] });
    expect(storage.dump().files).toEqual({ "a%20b.json": file({ v: 1 }) });
    expect(result.versions["a b"]).toEqual(expect.any(String));
    // The stray spelling the discard deleted is reported as gone.
    expect(result.versions["a%20b"]).toBeNull();
    expect(await listed(client)).toEqual({});
  });

  it("lists an unreadable file that differs from the base, and a discard fixes it", async () => {
    const { storage, client } = committed({ "a.json": file({ v: 1 }) });
    storage.setFile("a.json", "{ broken");
    expect((await listed(client)).a).toMatchObject({ kind: "set" });
    const detail = await client.changesGet({ names: ["a"] });
    expect(detail.entries.a).toMatchObject({ kind: "set", before: { v: 1 }, after: null });
    expect(detail.diagnostics).toEqual([
      expect.objectContaining({ file: "a.json", kind: "invalid-json", side: "after" }),
    ]);
    await client.changesDiscard({ names: ["a"] });
    expect(storage.dump().files["a.json"]).toBe(file({ v: 1 }));
  });
});

describe("changes.get", () => {
  it("reports a too-large base side as a diagnostic", async () => {
    const big = file({ text: "x".repeat(MAX_BLOCK_BYTES) });
    const { storage, client } = committed({ "a.json": big });
    storage.setFile("a.json", file({ v: 1 }));
    const detail = await client.changesGet({ names: ["a"] });
    expect(detail.entries.a).toMatchObject({ kind: "set", before: null, after: { v: 1 } });
    expect(detail.diagnostics).toEqual([
      expect.objectContaining({ file: "a.json", kind: "too-large", side: "before" }),
    ]);
  });

  it("answers under the requested spelling, and leaves out names in neither side", async () => {
    const { storage, client } = committed({ "a%20b.json": file({ v: 1 }) });
    storage.setFile("a%20b.json", file({ v: 2 }));
    const detail = await client.changesGet({ names: ["a b", "a%20b", "zzz"] });
    expect(Object.keys(detail.entries).sort()).toEqual(["a b", "a%20b"]);
    expect(detail.entries["a%20b"]).toEqual(detail.entries["a b"]);
  });
});

describe("changes.discard", () => {
  it("restores a base entry and deletes a new one in one commit", async () => {
    const { storage, client } = committed({ "a.json": file({ v: 1 }) });
    storage.setFile("a.json", file({ v: 2 }));
    storage.setFile("b.json", file({ v: 3 }));
    const commits = storage.commits;
    const result = await client.changesDiscard({ names: ["a", "b"] });
    expect(storage.commits).toBe(commits + 1);
    expect(storage.dump().files).toEqual({ "a.json": file({ v: 1 }) });
    const blocks = await client.blocksList();
    expect(!blocks.notModified && blocks.versions).toEqual({ a: result.versions.a });
    expect(result.versions.b).toBeNull();
    expect(result.revision).toBe(!blocks.notModified && blocks.revision);
  });

  it("retries when the base moves before the commit, restoring the new base", async () => {
    let moved = false;
    const { storage, client } = committed(
      { "a.json": file({ v: 1 }) },
      {
        beforeCommit: (_attempt, s) => {
          if (moved) return;
          moved = true;
          s.setBase({ "a.json": file({ v: "published" }) });
        },
      },
    );
    storage.setFile("a.json", file({ v: 2 }));
    await client.changesDiscard({ names: ["a"] });
    expect(storage.dump().files["a.json"]).toBe(file({ v: "published" }));
  });

  it("without ifMatch, a concurrent save of another entry doesn't make it retry", async () => {
    let calls = 0;
    const { storage, client } = committed(
      { "a.json": file({ v: 1 }) },
      {
        beforeCommit: (_attempt, s) => {
          calls++;
          s.setFile("other.json", file({ at: calls }));
        },
      },
    );
    storage.setFile("a.json", file({ v: 2 }));
    await client.changesDiscard({ names: ["a"] });
    expect(calls).toBe(1);
  });

  it("guards with ifMatch: an edit made after the guard was read is a Conflict on retry", async () => {
    const { storage, client } = committed(
      { "a.json": file({ v: 1 }) },
      {
        beforeCommit: (_attempt, s) => s.setFile("a.json", file({ v: "late edit" })),
      },
    );
    storage.setFile("a.json", file({ v: 2 }));
    const blocks = await client.blocksList();
    const version = !blocks.notModified ? blocks.versions.a! : "";
    const error = await rejects(
      client.changesDiscard({ names: ["a"], ifMatch: { a: version } }),
      ErrorCode.Conflict,
    );
    expect(error.data).toEqual({
      entries: { a: { expected: version, actual: expect.any(String) } },
    });
    expect(storage.dump().files["a.json"]).toBe(file({ v: "late edit" }));
  });

  it("refuses an empty name and too many names", async () => {
    const { client } = setup();
    await rejects(client.changesDiscard({ names: [""] }), ErrorCode.InvalidBlock);
    const names = Array.from({ length: 501 }, (_, i) => `n${i}`);
    const error = await rejects(client.changesDiscard({ names }), ErrorCode.LimitExceeded);
    expect(error.data).toEqual({ limit: "maxOpsPerDiscard" });
  });

  it("is ReadOnly on a read-only storage, while list and get still work", async () => {
    const { client } = setup({ description: { readOnly: true } });
    await client.changesList();
    await client.changesGet({ names: ["a"] });
    await rejects(client.changesDiscard({ names: ["a"] }), ErrorCode.ReadOnly);
  });
});
