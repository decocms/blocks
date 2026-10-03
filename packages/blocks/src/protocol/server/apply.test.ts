// @vitest-environment node
/**
 * blocks.apply edge cases: spellings under guards, the schema the commit
 * depends on, retry backoff, response budgets and storage-refused names.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SECRET_BLOCK, SECRET_FIELD, schemaFixture } from "../__tests__/fixtures";
import { createContentClient } from "../client";
import { type ContentProtocolError, ErrorCode } from "../errors";
import { serializeBlock } from "../keys";
import { type ContentStorage, StorageInvalidFileError } from "../storage";
import { createMemoryStorage, type MemoryStorageOptions } from "../storage/memory";
import type { ContentHandlerOptions } from "./core";
import { createContentHandler } from "./handler";

const NO_DELAY = { commitRetryDelayMs: { minMs: 0, maxMs: 0 } };

function setup(storageOptions: MemoryStorageOptions = {}, options: ContentHandlerOptions = {}) {
  const storage = createMemoryStorage({
    ...storageOptions,
    state: { schema: JSON.stringify(schemaFixture), ...storageOptions.state },
  });
  const handler = createContentHandler(storage, { ...NO_DELAY, ...options });
  const client = createContentClient({ endpoint: "http://test.local/rpc", fetch: handler });
  return { storage, handler, client };
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

const file = (value: unknown) => serializeBlock(value);

describe("two spellings of one name under guards", () => {
  // "a%2520b.json" holds the entry named "a%20b"; "a%20b.json" would hold "a b".
  const encodedOnly = { state: { files: { "a%2520b.json": file({ v: 1 }) } } };

  it("fails create-only on another spelling of an existing entry, and deletes nothing", async () => {
    const { client, storage } = setup(encodedOnly);
    const { versions } = await client.blocksList().then((r) => {
      if (r.notModified) throw new Error("unexpected");
      return r;
    });
    const error = await rejects(
      client.blocksApply({ set: { "a b": { v: 2 } }, ifMatch: { "a b": null } }),
      ErrorCode.Conflict,
    );
    expect(error.data).toEqual({
      entries: { "a b": { expected: null, actual: versions["a%20b"] } },
    });
    expect(storage.dump().files).toEqual({ "a%2520b.json": file({ v: 1 }) });
    expect(storage.commits).toBe(0);
  });

  it("accepts a guard on one spelling with the version listed under the other", async () => {
    const { client, storage } = setup(encodedOnly);
    const list = await client.blocksList();
    const version = !list.notModified ? list.versions["a%20b"] : "";
    const result = await client.blocksApply({
      set: { "a b": { v: 2 } },
      ifMatch: { "a b": version },
    });
    expect(storage.dump().files).toEqual({ "a%20b.json": file({ v: 2 }) });
    expect(result.versions).toEqual({ "a b": expect.any(String), "a%20b": null });
  });

  it("reports null for every other spelling a write deleted, so the client drops it", async () => {
    const { client } = setup(encodedOnly);
    const result = await client.blocksApply({ set: { "a b": { v: 2 } } });
    expect(result.versions).toEqual({ "a b": expect.any(String), "a%20b": null });
    const list = await client.blocksList();
    expect(!list.notModified && Object.keys(list.blocks)).toEqual(["a b"]);
  });

  it("deletes the entry under any spelling and reports both names as gone", async () => {
    const { client, storage } = setup(encodedOnly);
    const result = await client.blocksApply({ delete: ["a b"] });
    expect(result.versions).toEqual({ "a b": null, "a%20b": null });
    expect(storage.dump().files).toEqual({});
  });

  it("replays the same versions, deleted spellings included, for a retried request key", async () => {
    const { client } = setup(encodedOnly);
    const params = { requestKey: "k1", set: { "a b": { v: 2 } } };
    const first = await client.blocksApply(params);
    expect(first.versions["a%20b"]).toBeNull();
    expect(await client.blocksApply(params)).toEqual(first);
  });
});

describe("the schema a write depends on", () => {
  it("rejects ifSchemaMatch when the schema changes between the check and the commit", async () => {
    let changed = false;
    const { client, storage } = setup({
      beforeCommit: (_attempt, s) => {
        if (changed) return;
        changed = true;
        s.setSchema({ ...schemaFixture, changed: true });
      },
    });
    const { version } = await client.schemaGet();
    const error = await rejects(
      client.blocksApply({ set: { a: {} }, ifSchemaMatch: version }),
      ErrorCode.Conflict,
    );
    expect(error.data).toEqual({ schema: { expected: version, actual: expect.any(String) } });
    expect(storage.dump().files).toEqual({});
  });

  it("passes the schema version to the commit, so the storage checks it atomically", async () => {
    const attempts: Array<string | null | undefined> = [];
    const { client } = setup({ beforeCommit: (a) => void attempts.push(a.expectedSchemaVersion) });
    const { version } = await client.schemaGet();
    await client.blocksApply({ set: { a: {} } });
    await client.blocksApply({ delete: ["a"] });
    await client.blocksApply({ delete: ["b"], ifSchemaMatch: version });
    // A set depends on the schema (the secret guard); a plain delete doesn't.
    expect(attempts).toEqual([version, undefined]);
  });

  it("rechecks the secret guard against a schema that changed before the commit", async () => {
    const plainSchema = structuredClone(schemaFixture);
    const definitions = plainSchema.schema!.definitions as Record<string, any>;
    definitions["bmV3c2xldHRlcg=="].properties[SECRET_FIELD] = { type: "string" };
    let changed = false;
    const { client, storage } = setup({
      state: { schema: JSON.stringify(plainSchema) },
      beforeCommit: (_attempt, s) => {
        if (changed) return;
        changed = true;
        s.setSchema(schemaFixture); // the field just became a Secret
      },
    });
    const entry = { __resolveType: SECRET_BLOCK, [SECRET_FIELD]: "hunter2" };
    const error = await rejects(client.blocksApply({ set: { N: entry } }), ErrorCode.InvalidBlock);
    expect(JSON.stringify(error.data)).toContain("secret-field");
    expect(storage.commits).toBe(0);
  });

  it("treats a schema appearing where there was none as a change", async () => {
    let changed = false;
    const { client } = setup({
      state: { schema: null },
      beforeCommit: (_a, s) => {
        if (changed) return;
        changed = true;
        s.setSchema(schemaFixture);
      },
    });
    const error = await rejects(
      client.blocksApply({ set: { N: { __resolveType: SECRET_BLOCK, [SECRET_FIELD]: "x" } } }),
      ErrorCode.InvalidBlock,
    );
    expect(JSON.stringify(error.data)).toContain("secret-field");
  });
});

describe("commit retries", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function alwaysStale() {
    const memory = createMemoryStorage();
    const commitTimes: number[] = [];
    const storage: ContentStorage = {
      ...memory,
      commit: async () => {
        commitTimes.push(Date.now());
        return { status: "stale" };
      },
    };
    return { storage, commitTimes };
  }

  /** Records every wait the handler asks for, and skips it. */
  function recordWaits(): number[] {
    const waits: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      queueMicrotask(fn);
      return 0;
    }) as unknown as typeof setTimeout);
    return waits;
  }

  it("makes 3 attempts by default, with a jittered, growing backoff between them", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // 50 + 0.5 * 150 = 125 ms per attempt step
    const waits = recordWaits();
    const { storage, commitTimes } = alwaysStale();
    const client = createContentClient({
      endpoint: "http://t/rpc",
      fetch: createContentHandler(storage),
    });
    const error = await rejects(client.blocksApply({ set: { a: {} } }), ErrorCode.Unavailable);
    expect(error.data).toEqual({ retryAfterMs: expect.any(Number) });
    expect(commitTimes).toHaveLength(3);
    // The second wait is twice the first; there's none after the last attempt.
    expect(waits).toEqual([125, 250]);
  });

  it("jitters each wait between the configured bounds", async () => {
    const random = vi.spyOn(Math, "random");
    const waits = recordWaits();
    const { storage } = alwaysStale();
    const client = createContentClient({
      endpoint: "http://t/rpc",
      fetch: createContentHandler(storage, {
        maxCommitAttempts: 4,
        commitRetryDelayMs: { minMs: 10, maxMs: 20 },
      }),
    });
    random.mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(0.5);
    await rejects(client.blocksApply({ set: { a: {} } }), ErrorCode.Unavailable);
    expect(waits).toEqual([10 * 1, 20 * 2, 15 * 3]);
  });

  it("retries at once when the delay is configured to zero", async () => {
    const waits = recordWaits();
    const { storage, commitTimes } = alwaysStale();
    const client = createContentClient({
      endpoint: "http://t/rpc",
      fetch: createContentHandler(storage, NO_DELAY),
    });
    await rejects(client.blocksApply({ set: { a: {} } }), ErrorCode.Unavailable);
    expect(commitTimes).toHaveLength(3);
    expect(waits).toEqual([]);
  });
});

describe("response budgets", () => {
  const names = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`entry-${i}`, {}]));

  it("never replaces a single write's response, even over maxBatchResponseBytes", async () => {
    const { client, storage } = setup({}, { limits: { maxBatchResponseBytes: 64 } });
    const result = await client.blocksApply({ set: names });
    expect(Object.keys(result.versions)).toHaveLength(20);
    expect(storage.commits).toBe(1);
  });

  it("still answers a single read over maxBatchResponseBytes with LimitExceeded", async () => {
    const { client } = setup({}, { limits: { maxBatchResponseBytes: 64 } });
    const error = await rejects(client.schemaGet(), ErrorCode.LimitExceeded);
    expect(error.data).toEqual({ limit: "maxBatchResponseBytes" });
  });
});

describe("names a storage can't hold", () => {
  it("refuses a leading-dot name before any storage sees it", async () => {
    const { client, storage } = setup();
    const error = await rejects(
      client.blocksApply({ set: { ".env": {} } }),
      ErrorCode.InvalidBlock,
    );
    expect(JSON.stringify(error.data)).toContain("leading-dot");
    expect(storage.commits).toBe(0);
  });

  it("ignores a guard on a name no file can hold: it can't exist", async () => {
    const { client } = setup();
    const result = await client.blocksApply({ set: { a: {} }, ifMatch: { ".env": null } });
    expect(result.versions.a).toEqual(expect.any(String));
  });

  it("maps a storage's StorageInvalidFileError to InvalidBlock, not an internal error", async () => {
    const memory = createMemoryStorage();
    const onError = vi.fn();
    const storage: ContentStorage = {
      ...memory,
      commit: async () => {
        throw new StorageInvalidFileError("a%2Fb.json");
      },
    };
    const client = createContentClient({
      endpoint: "http://t/rpc",
      fetch: createContentHandler(storage, { onError }),
    });
    const error = await rejects(client.blocksApply({ set: { "a/b": {} } }), ErrorCode.InvalidBlock);
    expect(error.data).toEqual({
      violations: [{ name: "a/b", rule: "unsupported-name", message: expect.any(String) }],
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
