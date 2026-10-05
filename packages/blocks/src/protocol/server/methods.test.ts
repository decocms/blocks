// @vitest-environment node
/**
 * schema.get, blocks.list and blocks.apply over the memory storage.
 */
import { describe, expect, it } from "vitest";
import {
  CIPHERTEXT,
  SECRET_BLOCK,
  SECRET_FIELD,
  schemaFixture,
  secretBlock,
} from "../__tests__/fixtures";
import { createContentClient } from "../client";
import { type ContentProtocolError, ErrorCode } from "../errors";
import { serializeBlock } from "../keys";
import type { CommitAttempt, ContentStorage } from "../storage";
import { createMemoryStorage, type MemoryStorageOptions } from "../storage/memory";
import type { ContentHandlerOptions } from "./core";
import { createContentHandler } from "./handler";

function setup(
  storageOptions: MemoryStorageOptions = {},
  handlerOptions: ContentHandlerOptions = {},
) {
  const storage = createMemoryStorage({
    ...storageOptions,
    state: { schema: JSON.stringify(schemaFixture), ...storageOptions.state },
  });
  const handler = createContentHandler(storage, handlerOptions);
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

describe("schema.get", () => {
  it("returns the parsed schema and its version, and 'not modified' for that version", async () => {
    const { client } = setup();
    const first = await client.schemaGet();
    expect(first).toEqual({
      notModified: false,
      version: expect.any(String),
      resolvedRef: null,
      schema: schemaFixture,
    });
    expect(await client.schemaGet({ ifNoneMatch: first.version ?? undefined })).toEqual({
      notModified: true,
      version: first.version,
    });
  });

  it("falls back to meta.gen.json", async () => {
    const { client } = setup({ state: { schema: null, legacySchema: '{"v7":true}' } });
    const result = await client.schemaGet();
    expect(!result.notModified && result.schema).toEqual({ v7: true });
  });

  it("reports 'no schema yet' as schema: null, not an error", async () => {
    const { client } = setup({ state: { schema: null } });
    expect(await client.schemaGet()).toEqual({
      notModified: false,
      version: null,
      resolvedRef: null,
      schema: null,
    });
  });

  it("serves the schema once it appears, and null again once it's gone", async () => {
    const { client, storage } = setup({ state: { schema: null } });
    expect((await client.schemaGet()).version).toBeNull();
    storage.setSchema(schemaFixture);
    const first = await client.schemaGet();
    expect(first).toMatchObject({ notModified: false, schema: schemaFixture });
    expect(typeof first.version).toBe("string");
    storage.setSchema(null);
    expect(await client.schemaGet()).toMatchObject({ version: null, schema: null });
  });

  it("lists, reads and writes blocks without a schema", async () => {
    const { client } = setup({ state: { schema: null } });
    const block = { __resolveType: "site/sections/Hero.tsx", title: "Hi", n: 1, ok: true };
    const { versions } = await client.blocksApply({ set: { hero: block } });
    const list = await client.blocksList();
    expect(!list.notModified && list.blocks).toEqual({ hero: block });
    expect(!list.notModified && list.versions.hero).toBe(versions.hero);
  });

  it("is NotFound without a .deco folder, schema or not", async () => {
    const { client } = setup({ state: { schema: null, hasDecoFolder: false } });
    await rejects(client.schemaGet(), ErrorCode.NotFound);
  });

  it("never serves a torn file: invalid JSON is Unavailable with retry timing", async () => {
    const { client } = setup({ state: { schema: '{"manifest": {' } });
    const error = await rejects(client.schemaGet(), ErrorCode.Unavailable);
    expect(error.data).toEqual({ retryAfterMs: expect.any(Number) });
  });

  it("is LimitExceeded over maxSchemaBytes, even though gzip would make it small", async () => {
    const { client } = setup(
      { state: { schema: JSON.stringify({ pad: "x".repeat(5000) }) } },
      { limits: { maxSchemaBytes: 4096 } },
    );
    await rejects(client.schemaGet(), ErrorCode.LimitExceeded);
  });
});

describe("blocks.list", () => {
  it("returns every entry, one version each, and a revision", async () => {
    const { client } = setup({
      state: {
        files: { "Header.json": file({ a: 1 }), "pages-Home%20Page.json": file({ path: "/" }) },
      },
    });
    const result = await client.blocksList();
    if (result.notModified) throw new Error("expected the map");
    expect(result.blocks).toEqual({ Header: { a: 1 }, "pages-Home Page": { path: "/" } });
    expect(Object.keys(result.versions).sort()).toEqual(["Header", "pages-Home Page"]);
    expect(result.diagnostics).toEqual([]);
    expect(await client.blocksList({ ifNoneMatch: result.revision })).toEqual({
      notModified: true,
      revision: result.revision,
      resolvedRef: null,
    });
  });

  it("decodes each file name exactly once", async () => {
    const { client } = setup({
      state: {
        files: {
          "pages-Home%2520Page-6f1e.json": file({}),
          "collections%2Fblog%2Fposts%2Fabc.json": file({}),
        },
      },
    });
    const result = await client.blocksList();
    expect(!result.notModified && Object.keys(result.blocks).sort()).toEqual([
      "collections/blog/posts/abc",
      "pages-Home%20Page-6f1e",
    ]);
  });

  it("reports files it skips: invalid JSON, non-objects and oversized files", async () => {
    const { client } = setup(
      {
        state: {
          files: {
            "ok.json": file({ fine: true }),
            "broken.json": "{ nope",
            "array.json": "[]",
            "null.json": "null",
            "huge.json": file({ t: "x".repeat(3000) }),
          },
        },
      },
      { limits: { maxBlockBytes: 2048 } },
    );
    const result = await client.blocksList();
    if (result.notModified) throw new Error("expected the map");
    expect(result.blocks).toEqual({ ok: { fine: true } });
    expect(result.diagnostics.map((d) => [d.file, d.kind])).toEqual([
      ["array.json", "not-an-object"],
      ["broken.json", "invalid-json"],
      ["huge.json", "too-large"],
      ["null.json", "not-an-object"],
    ]);
  });

  it("resolves two spellings of one name and reports the shadowed one", async () => {
    const { client } = setup({
      state: {
        files: {
          // The bot's spelling (two decodes) beats the legacy one (one decode)...
          "pages-Home%2520Page.json": file({ from: "bot" }),
          "pages-Home%20Page.json": file({ from: "legacy" }),
          // ...but an entry with a path beats both.
          "about%2520us.json": file({ from: "bot" }),
          "about%20us.json": file({ from: "legacy", path: "/about" }),
        },
      },
    });
    const result = await client.blocksList();
    if (result.notModified) throw new Error("expected the map");
    expect(result.blocks).toEqual({
      "pages-Home%20Page": { from: "bot" },
      "about us": { from: "legacy", path: "/about" },
    });
    expect(result.diagnostics).toEqual([
      {
        file: "about%2520us.json",
        kind: "shadowed",
        name: "about us",
        winner: "about%20us.json",
        message: expect.any(String),
      },
      {
        file: "pages-Home%20Page.json",
        kind: "shadowed",
        name: "pages-Home%20Page",
        winner: "pages-Home%2520Page.json",
        message: expect.any(String),
      },
    ]);
  });

  it("ignores files that aren't saved blocks", async () => {
    const { client } = setup({
      state: { files: { "a.json": file({}), "notes.txt": "x", ".json": "{}" } },
    });
    const result = await client.blocksList();
    expect(!result.notModified && Object.keys(result.blocks)).toEqual(["a"]);
  });

  it("keeps entries named like Object.prototype members", async () => {
    const { client } = setup({
      state: { files: { "__proto__.json": file({ x: 1 }), "constructor.json": file({ y: 2 }) } },
    });
    const result = await client.blocksList();
    if (result.notModified) throw new Error("expected the map");
    expect(Object.keys(result.blocks).sort()).toEqual(["__proto__", "constructor"]);
    expect(Object.getOwnPropertyDescriptor(result.blocks, "__proto__")?.value).toEqual({ x: 1 });
  });

  it("is LimitExceeded over maxListBytes, never a partial map", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`e${i}.json`] = file({ t: "x".repeat(500) });
    const { client } = setup({ state: { files } }, { limits: { maxListBytes: 4096 } });
    await rejects(client.blocksList(), ErrorCode.LimitExceeded);
  });

  it("counts bytes even when the storage doesn't report sizes", async () => {
    const memory = createMemoryStorage({
      state: { files: { "a.json": file({ t: "x".repeat(5000) }) } },
    });
    const sizeless: ContentStorage = {
      ...memory,
      snapshot: async (o) => {
        const snap = await memory.snapshot(o);
        return { ...snap, files: snap.files.map(({ size: _size, ...f }) => f) };
      },
    };
    const client = createContentClient({
      endpoint: "http://t/rpc",
      fetch: createContentHandler(sizeless, { limits: { maxListBytes: 4096 } }),
    });
    await rejects(client.blocksList(), ErrorCode.LimitExceeded);
  });

  it("is NotFound when there's no .deco folder at all", async () => {
    const { client } = setup({ state: { hasDecoFolder: false } });
    await rejects(client.blocksList(), ErrorCode.NotFound);
  });

  it("serves a changed file, not a cached copy", async () => {
    const { client, storage } = setup({ state: { files: { "a.json": file({ v: 1 }) } } });
    const first = await client.blocksList();
    storage.setFile("a.json", file({ v: 2 }));
    const second = await client.blocksList({ ifNoneMatch: first.revision });
    expect(!second.notModified && second.blocks.a).toEqual({ v: 2 });
  });
});

describe("blocks.apply", () => {
  it("writes encodeURIComponent(name).json with JSON.stringify(entry, null, 2) and a newline", async () => {
    const { client, storage } = setup();
    await client.blocksApply({
      set: { "pages-Home%20Page-6f1e": { path: "/" }, "a/b": { x: "é" } },
    });
    expect(storage.dump().files).toEqual({
      "pages-Home%2520Page-6f1e.json": '{\n  "path": "/"\n}\n',
      "a%2Fb.json": '{\n  "x": "é"\n}\n',
    });
  });

  it("returns the new versions and revision, which blocks.list then reports", async () => {
    const { client } = setup();
    const result = await client.blocksApply({ set: { a: { v: 1 } }, delete: ["gone"] });
    expect(result.versions).toEqual({ a: expect.any(String), gone: null });
    const list = await client.blocksList();
    expect(list.revision).toBe(result.revision);
    expect(!list.notModified && list.versions.a).toBe(result.versions.a);
  });

  it("lands set and delete in one commit", async () => {
    const { client, storage } = setup({ state: { files: { "old.json": file({}) } } });
    await client.blocksApply({ set: { a: {}, b: {} }, delete: ["old"] });
    expect(storage.commits).toBe(1);
    expect(Object.keys(storage.dump().files).sort()).toEqual(["a.json", "b.json"]);
  });

  it("lets set win when a name is also deleted", async () => {
    const { client, storage } = setup();
    const result = await client.blocksApply({ set: { a: { v: 1 } }, delete: ["a", "a"] });
    expect(result.versions.a).toEqual(expect.any(String));
    expect(storage.dump().files["a.json"]).toBeDefined();
  });

  it("validates everything first and reports every violation at once", async () => {
    const { client, storage } = setup();
    const error = await rejects(
      client.blocksApply({
        set: {
          good: {},
          "": {},
          "bad..name": {},
          "x.ts": {},
          arr: [] as never,
          nil: null as never,
          str: "s" as never,
          [SECRET_BLOCK]: { __resolveType: SECRET_BLOCK, [SECRET_FIELD]: "plain" },
        },
        delete: ["", "also-gone", ""],
      }),
      ErrorCode.InvalidBlock,
    );
    const violations = (error.data as { violations: { name: string; rule: string }[] }).violations;
    expect(violations.map((v) => `${v.name}:${v.rule}`).sort()).toEqual(
      [
        ":empty",
        "arr:not-an-object",
        "bad..name:dot-dot",
        `${SECRET_BLOCK}:secret-field`,
        "nil:not-an-object",
        "str:not-an-object",
        "x.ts:source-extension",
      ].sort(),
    );
    expect(storage.commits).toBe(0);
  });

  it("refuses an entry over maxBlockBytes", async () => {
    const { client } = setup({}, { limits: { maxBlockBytes: 64 } });
    const error = await rejects(
      client.blocksApply({ set: { a: { t: "x".repeat(100) } } }),
      ErrorCode.InvalidBlock,
    );
    expect(error.data).toEqual({
      violations: [expect.objectContaining({ name: "a", rule: "too-large" })],
    });
  });

  it("refuses more names than maxOpsPerApply", async () => {
    const { client } = setup({}, { limits: { maxOpsPerApply: 3 } });
    await rejects(
      client.blocksApply({ set: { a: {}, b: {} }, delete: ["c", "d"] }),
      ErrorCode.LimitExceeded,
    );
    // set-wins normalization happens first: a name in both counts once.
    await client.blocksApply({ set: { a: {}, b: {} }, delete: ["a", "c"] });
  });

  it("refuses a new name that differs from an existing entry's, or another new name's, only in case", async () => {
    const { client } = setup({ state: { files: { "Header.json": file({}) } } });
    await rejects(client.blocksApply({ set: { header: {} } }), ErrorCode.InvalidBlock);
    await rejects(client.blocksApply({ set: { Footer: {}, footer: {} } }), ErrorCode.InvalidBlock);
    // Renaming by case would delete the new file on a case-insensitive disk: refused too.
    await rejects(
      client.blocksApply({ set: { header: {} }, delete: ["Header"] }),
      ErrorCode.InvalidBlock,
    );
    await client.blocksApply({ set: { Header: { v: 2 } } });
  });

  it("overwrites the winning spelling and deletes the others in the same commit", async () => {
    const { client, storage } = setup({
      state: {
        files: {
          "pages-Home%2520Page.json": file({ from: "bot" }),
          "pages-Home%20Page.json": file({ from: "legacy" }),
          "pages-Home Page.json": "{ broken",
        },
      },
    });
    await client.blocksApply({ set: { "pages-Home%20Page": { from: "editor" } } });
    expect(storage.dump().files).toEqual({ "pages-Home%2520Page.json": file({ from: "editor" }) });
    expect(storage.commits).toBe(1);
  });

  it("deletes every spelling of a deleted entry", async () => {
    const { client, storage } = setup({
      state: { files: { "a%2520b.json": file({}), "a%20b.json": file({}), "keep.json": file({}) } },
    });
    await client.blocksApply({ delete: ["a%20b"] });
    expect(Object.keys(storage.dump().files)).toEqual(["keep.json"]);
  });

  it("refuses two spellings of one name in one write", async () => {
    const { client } = setup();
    const error = await rejects(
      client.blocksApply({ set: { "a%20b": {}, "a b": {} } }),
      ErrorCode.InvalidBlock,
    );
    expect(JSON.stringify(error.data)).toContain("spelling-collision");
  });

  it("can delete a name ending in a source extension", async () => {
    const { client, storage } = setup({ state: { files: { "widget.ts.json": file({}) } } });
    await client.blocksApply({ delete: ["widget.ts"] });
    expect(storage.dump().files).toEqual({});
  });

  describe("preconditions", () => {
    it("writes nothing when an ifMatch fails, and reports expected and actual versions", async () => {
      const { client, storage } = setup();
      const { versions } = await client.blocksApply({ set: { a: { v: 1 } } });
      const error = await rejects(
        client.blocksApply({
          set: { a: { v: 2 }, b: {} },
          ifMatch: { a: "stale", missing: "v0", b: null },
        }),
        ErrorCode.Conflict,
      );
      expect(error.data).toEqual({
        entries: {
          a: { expected: "stale", actual: versions.a },
          missing: { expected: "v0", actual: null },
        },
      });
      expect(Object.keys(storage.dump().files)).toEqual(["a.json"]);
    });

    it("null means the entry must not exist (create-only)", async () => {
      const { client } = setup();
      await client.blocksApply({ set: { a: {} }, ifMatch: { a: null } });
      await rejects(
        client.blocksApply({ set: { a: {} }, ifMatch: { a: null } }),
        ErrorCode.Conflict,
      );
    });

    it("without ifMatch, the last writer wins", async () => {
      const { client, storage } = setup();
      await client.blocksApply({ set: { a: { v: 1 } } });
      await client.blocksApply({ set: { a: { v: 2 } } });
      expect(storage.dump().files["a.json"]).toBe(file({ v: 2 }));
    });

    it("rejects a write when the schema changed (ifSchemaMatch)", async () => {
      const { client, storage } = setup();
      const { version } = await client.schemaGet();
      storage.setSchema({ ...schemaFixture, changed: true });
      const error = await rejects(
        client.blocksApply({ set: { a: {} }, ifSchemaMatch: version ?? undefined }),
        ErrorCode.Conflict,
      );
      expect(error.data).toEqual({ schema: { expected: version, actual: expect.any(String) } });
      const fresh = await client.schemaGet();
      await client.blocksApply({ set: { a: {} }, ifSchemaMatch: fresh.version ?? undefined });
    });

    it("rechecks every guard after storage moved under a commit attempt", async () => {
      let raced = false;
      const { client, storage } = setup({
        beforeCommit: (_attempt: CommitAttempt, s) => {
          if (!raced) {
            raced = true;
            s.setFile("a.json", file({ v: "someone else" }));
          }
        },
      });
      const { versions } = await client.blocksApply({ set: { a: { v: 1 } } });
      // The first apply raced with an outside edit to its own file, retried and won (last writer).
      expect(storage.dump().files["a.json"]).toBe(file({ v: 1 }));
      expect(versions.a).toEqual(expect.any(String));
      raced = false;
      await rejects(
        client.blocksApply({ set: { a: { v: 2 } }, ifMatch: { a: versions.a } }),
        ErrorCode.Conflict,
      );
      expect(storage.dump().files["a.json"]).toBe(file({ v: "someone else" }));
    });

    it("retries a stale commit against the new snapshot, then gives up with Unavailable", async () => {
      const memory = createMemoryStorage();
      let attempts = 0;
      const alwaysStale: ContentStorage = {
        ...memory,
        commit: async () => {
          attempts++;
          return { status: "stale" };
        },
      };
      const client = createContentClient({
        endpoint: "http://t/rpc",
        fetch: createContentHandler(alwaysStale, { maxCommitAttempts: 3 }),
      });
      const error = await rejects(client.blocksApply({ set: { a: {} } }), ErrorCode.Unavailable);
      expect(error.data).toEqual({ retryAfterMs: expect.any(Number) });
      expect(attempts).toBe(3);
    });

    it("lets an unguarded save win over a concurrent edit instead of retrying forever", async () => {
      let n = 0;
      const { client, storage } = setup({
        beforeCommit: (_a, s) => s.setFile("a.json", file({ n: n++ })),
      });
      await client.blocksApply({ set: { a: { mine: true } } });
      expect(storage.dump().files["a.json"]).toBe(file({ mine: true }));
    });
  });

  describe("the secret guard", () => {
    const newsletter = (apiKey: unknown) => ({
      __resolveType: SECRET_BLOCK,
      [SECRET_FIELD]: apiKey,
    });

    it("refuses plain text in a Secret field, with a pointer to it", async () => {
      const { client, storage } = setup();
      const error = await rejects(
        client.blocksApply({ set: { N: newsletter("hunter2") } }),
        ErrorCode.InvalidBlock,
      );
      expect(error.data).toEqual({
        violations: [
          {
            name: "N",
            pointer: `/${SECRET_FIELD}`,
            rule: "secret-field",
            message: expect.any(String),
          },
        ],
      });
      expect(storage.commits).toBe(0);
    });

    it("accepts a secret block with a well-formed ciphertext", async () => {
      const { client, storage } = setup();
      await client.blocksApply({ set: { N: newsletter(secretBlock()) } });
      expect(storage.dump().files["N.json"]).toContain(CIPHERTEXT);
    });

    it("still checks ciphertexts when the endpoint has no schema", async () => {
      const { client } = setup({ state: { schema: null } });
      await rejects(
        client.blocksApply({ set: { S: secretBlock("plain") } }),
        ErrorCode.InvalidBlock,
      );
      await client.blocksApply({ set: { S: secretBlock() } });
    });
  });

  describe("features the endpoint doesn't offer", () => {
    it("refuses a write to a read-only endpoint", async () => {
      const { client } = setup({ description: { readOnly: true } });
      await rejects(client.blocksApply({ set: { a: {} } }), ErrorCode.ReadOnly);
    });

    it("refuses a ref without branches", async () => {
      const { client } = setup();
      await rejects(client.blocksApply({ ref: "draft", set: { a: {} } }), ErrorCode.Unsupported);
    });

    it("refuses a request key the endpoint doesn't advertise", async () => {
      const { client } = setup({ description: { idempotency: null } });
      await rejects(client.blocksApply({ requestKey: "k", set: { a: {} } }), ErrorCode.Unsupported);
    });

    it("skips the commit for an empty apply", async () => {
      const { client, storage } = setup();
      const result = await client.blocksApply({});
      expect(result).toEqual({ revision: (await client.blocksList()).revision, versions: {} });
      expect(storage.commits).toBe(0);
    });
  });

  describe("request keys", () => {
    it("replay the original result, even after the content moved", async () => {
      const { client, storage } = setup();
      const params = { requestKey: "save-1", set: { a: { v: 1 } } };
      const first = await client.blocksApply(params);
      await client.blocksApply({ set: { b: {} } });
      expect(await client.blocksApply(params)).toEqual(first);
      expect(storage.commits).toBe(2);
    });

    it("bind the key to every parameter", async () => {
      const { client } = setup();
      await client.blocksApply({ requestKey: "k", set: { a: { v: 1 } } });
      await rejects(
        client.blocksApply({ requestKey: "k", set: { a: { v: 2 } } }),
        ErrorCode.InvalidParams,
      );
      await rejects(
        client.blocksApply({ requestKey: "k", set: { a: { v: 1 } }, ifMatch: { a: null } }),
        ErrorCode.InvalidParams,
      );
    });

    it("resolve before guards are rechecked", async () => {
      const { client } = setup();
      const params = { requestKey: "create", set: { a: {} }, ifMatch: { a: null } };
      const first = await client.blocksApply(params);
      // The guard would now fail, but the receipt answers first.
      expect(await client.blocksApply(params)).toEqual(first);
    });

    it("commit simultaneous duplicates once", async () => {
      const { client, storage } = setup();
      const params = { requestKey: "dup", set: { a: { v: 1 } } };
      const results = await Promise.all([
        client.blocksApply(params),
        client.blocksApply(params),
        client.blocksApply(params),
      ]);
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      expect(storage.commits).toBe(1);
    });

    it("survive a restart", async () => {
      const first = setup();
      const params = { requestKey: "r", set: { a: { v: 1 } } };
      const result = await first.client.blocksApply(params);
      const restarted = createMemoryStorage({ state: first.storage.dump() });
      const client = createContentClient({
        endpoint: "http://t/rpc",
        fetch: createContentHandler(restarted),
      });
      expect(await client.blocksApply(params)).toEqual(result);
      expect(restarted.commits).toBe(0);
    });

    it("expire after the retention window", async () => {
      let now = 0;
      const { client, storage } = setup({
        now: () => now,
        description: { idempotency: { retentionMs: 1000 } },
      });
      const params = { requestKey: "old", set: { a: { v: 1 } } };
      await client.blocksApply(params);
      now = 5000;
      await client.blocksApply(params);
      expect(storage.commits).toBe(2);
    });

    it("are scoped to the tenant", async () => {
      const storage = createMemoryStorage();
      const handler = createContentHandler(storage, {
        authorize: (r) => ({ scope: r.headers.get("x-tenant") ?? "" }),
      });
      const as = (tenant: string) =>
        createContentClient({
          endpoint: "http://t/rpc",
          fetch: handler,
          headers: { "x-tenant": tenant },
        });
      await as("a").blocksApply({ requestKey: "k", set: { a: {} } });
      await as("b").blocksApply({ requestKey: "k", set: { b: {} } });
      expect(storage.commits).toBe(2);
      await rejects(
        as("a").blocksApply({ requestKey: "k", set: { b: {} } }),
        ErrorCode.InvalidParams,
      );
    });
  });
});
