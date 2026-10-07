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
import { type ContentHandlerOptions, MAX_BLOCK_BYTES, MAX_OPS_PER_APPLY } from "./core";
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
    const { client } = setup({
      state: {
        files: {
          "ok.json": file({ fine: true }),
          "broken.json": "{ nope",
          "array.json": "[]",
          "null.json": "null",
          "huge.json": file({ t: "x".repeat(MAX_BLOCK_BYTES) }),
        },
      },
    });
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

  it("refuses an entry over the block size limit", async () => {
    const { client } = setup();
    const error = await rejects(
      client.blocksApply({ set: { a: { t: "x".repeat(MAX_BLOCK_BYTES) } } }),
      ErrorCode.InvalidBlock,
    );
    expect(error.data).toEqual({
      violations: [expect.objectContaining({ name: "a", rule: "too-large" })],
    });
  });

  it("refuses more names than one blocks.apply takes", async () => {
    const { client } = setup();
    const names = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    const set = Object.fromEntries(names("s", MAX_OPS_PER_APPLY / 2).map((n) => [n, {}]));
    await rejects(
      client.blocksApply({ set, delete: names("d", MAX_OPS_PER_APPLY / 2 + 1) }),
      ErrorCode.LimitExceeded,
    );
    // set-wins normalization happens first: a name in both counts once.
    await client.blocksApply({
      set,
      delete: [...Object.keys(set), ...names("d", MAX_OPS_PER_APPLY / 2)],
    });
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

    it("refuses the removed ref, requestKey and ifSchemaMatch parameters as unknown", async () => {
      const { client, storage } = setup();
      for (const param of ["ref", "requestKey", "ifSchemaMatch"]) {
        await rejects(
          client.call("blocks.apply", { set: { a: {} }, [param]: "x" } as never),
          ErrorCode.InvalidParams,
        );
      }
      for (const method of ["blocks.list", "schema.get"] as const) {
        await rejects(client.call(method, { ref: "main" } as never), ErrorCode.InvalidParams);
      }
      expect(storage.commits).toBe(0);
    });

    it("skips the commit for an empty apply", async () => {
      const { client, storage } = setup();
      const result = await client.blocksApply({});
      expect(result).toEqual({ revision: (await client.blocksList()).revision, versions: {} });
      expect(storage.commits).toBe(0);
    });
  });
});
