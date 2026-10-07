// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContentClient } from "../../client";
import { ErrorCode } from "../../errors";
import { serializeBlock } from "../../keys";
import { createContentHandler } from "../../server";
import { StorageInvalidFileError, StorageNotFoundError } from "../../storage";
import { gitBlobHash } from "./hash";
import { createFsStorage } from "./index";
import { createFsStorage as createUnsupported } from "./unsupported";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "deco-fs-storage-"));
  await mkdir(join(root, ".deco", "blocks"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const blocksDir = () => join(root, ".deco", "blocks");
const list = async () => (await readdir(blocksDir())).sort();

function clientFor(storage = createFsStorage({ root })) {
  return createContentClient({
    endpoint: "http://local/rpc",
    fetch: createContentHandler(storage),
  });
}

describe("versions", () => {
  it("are git blob hashes, as git hash-object prints them", async () => {
    const content = serializeBlock({ title: "Olá" });
    const expected = execFileSync("git", ["hash-object", "--stdin"], {
      input: content,
      encoding: "utf8",
    }).trim();
    expect(gitBlobHash(content)).toBe(expected);
    await writeFile(join(blocksDir(), "a.json"), content);
    const snapshot = await createFsStorage({ root }).snapshot();
    expect(snapshot.files).toEqual([
      { file: "a.json", version: expected, size: Buffer.byteLength(content) },
    ]);
  });

  it("change with the content, and the revision with any file", async () => {
    const storage = createFsStorage({ root });
    await writeFile(join(blocksDir(), "a.json"), "{}\n");
    const first = await storage.snapshot();
    expect((await storage.snapshot()).revision).toBe(first.revision);
    await writeFile(join(blocksDir(), "a.json"), '{"v":2}\n');
    const second = await storage.snapshot();
    expect(second.revision).not.toBe(first.revision);
    expect(second.files[0].version).not.toBe(first.files[0].version);
  });
});

describe("snapshot", () => {
  it("lists only saved-block files, not folders, dotfiles or other files", async () => {
    await writeFile(join(blocksDir(), "b.json"), "{}");
    await writeFile(join(blocksDir(), "a.json"), "{}");
    await writeFile(join(blocksDir(), "notes.md"), "x");
    await writeFile(join(blocksDir(), ".hidden.json"), "{}");
    await mkdir(join(blocksDir(), "sub.json"));
    const snapshot = await createFsStorage({ root }).snapshot();
    expect(snapshot.files.map((f) => f.file)).toEqual(["a.json", "b.json"]);
    expect(snapshot.resolvedRef).toBeNull();
  });

  it("is empty when .deco has no blocks folder yet", async () => {
    await rm(blocksDir(), { recursive: true });
    expect((await createFsStorage({ root }).snapshot()).files).toEqual([]);
  });

  it("fails with NotFound without a .deco folder", async () => {
    await rm(join(root, ".deco"), { recursive: true });
    await expect(createFsStorage({ root }).snapshot()).rejects.toBeInstanceOf(StorageNotFoundError);
    await expect(clientFor().blocksList()).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });
});

describe("schema and secrets", () => {
  it("reads schema.gen.json, falling back to meta.gen.json", async () => {
    const storage = createFsStorage({ root });
    expect(await storage.readSchema()).toBeNull();
    await writeFile(join(root, ".deco", "meta.gen.json"), '{"v7":true}');
    expect((await storage.readSchema())?.text).toBe('{"v7":true}');
    await writeFile(join(root, ".deco", "schema.gen.json"), '{"v8":true}');
    const stored = await storage.readSchema();
    expect(stored).toEqual({
      text: '{"v8":true}',
      version: gitBlobHash('{"v8":true}'),
      resolvedRef: null,
    });
  });

  it("reads .deco/secrets.pub as is", async () => {
    const storage = createFsStorage({ root });
    expect(await storage.readSecretsPublicKey()).toBeNull();
    await writeFile(
      join(root, ".deco", "secrets.pub"),
      "-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----\n",
    );
    expect(await storage.readSecretsPublicKey()).toBe(
      "-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----\n",
    );
    expect((await clientFor(storage).describe()).secrets?.publicKey).toContain("BEGIN PUBLIC KEY");
  });
});

describe("describe", () => {
  it("reports a working tree with the app root and the asset folder relative to the repository root", async () => {
    const app = join(root, "apps", "storefront");
    await mkdir(join(app, ".deco"), { recursive: true });
    await mkdir(join(root, ".git"));
    const description = await createFsStorage({ root: app }).describe();
    expect(description).toMatchObject({
      kind: "working-tree",
      root: "apps/storefront",
      readOnly: false,
      pollIntervalMs: 2000,
      assets: { dir: "apps/storefront/public/assets", maxBytes: 25 * 1024 * 1024 },
    });
  });

  it("reports '.' when the app root is the repository root, and honors options", async () => {
    const description = await createFsStorage({
      root,
      repoRoot: root,
      assetsDir: "static/uploads",
      assetsMaxBytes: 1024,
    }).describe();
    expect(description.root).toBe(".");
    expect(description.assets).toEqual({ dir: "static/uploads", maxBytes: 1024 });
  });

  it("has no assets when read-only", async () => {
    expect((await createFsStorage({ root, readOnly: true }).describe()).assets).toBeNull();
  });
});

describe("commits", () => {
  it("write files atomically, durable when the call returns", async () => {
    const client = clientFor();
    const result = await client.blocksApply({
      set: { "pages-Home Page": { path: "/" }, Header: { a: 1 } },
    });
    expect(await list()).toEqual(["Header.json", "pages-Home%20Page.json"]);
    expect(await readFile(join(blocksDir(), "Header.json"), "utf8")).toBe('{\n  "a": 1\n}\n');
    expect(result.versions.Header).toBe(gitBlobHash('{\n  "a": 1\n}\n'));
    // No transaction leftovers.
    expect((await readdir(join(root, ".deco"))).sort()).toEqual(["blocks"]);
  });

  it("never write .deco/index.ts or anything outside .deco/blocks", async () => {
    await writeFile(join(root, ".deco", "index.ts"), "export default {};\n");
    const client = clientFor();
    await client.blocksApply({ set: { index: {} } });
    await expect(client.blocksApply({ set: { "../index": { x: 1 } } })).rejects.toMatchObject({
      code: ErrorCode.InvalidBlock,
    });
    await expect(client.blocksApply({ set: { "index.ts": {} } })).rejects.toMatchObject({
      code: ErrorCode.InvalidBlock,
    });
    expect(await readFile(join(root, ".deco", "index.ts"), "utf8")).toBe("export default {};\n");
    expect(await list()).toEqual(["index.json"]);
  });

  it("refuse file names that would escape the folder or be hidden, with a typed error", async () => {
    const storage = createFsStorage({ root });
    const base = await storage.snapshot();
    for (const file of ["../x.json", "a/b.json", ".lock.json", "..json"]) {
      await expect(
        storage.commit({ base, put: { [file]: "{}" }, delete: [], expected: {} }),
      ).rejects.toBeInstanceOf(StorageInvalidFileError);
      await expect(
        storage.commit({ base, put: {}, delete: [], expected: { [file]: null } }),
      ).rejects.toBeInstanceOf(StorageInvalidFileError);
    }
  });

  it("refuse leading-dot names as InvalidBlock, never an internal error", async () => {
    const client = clientFor();
    for (const name of [".env", "."]) {
      await expect(client.blocksApply({ set: { [name]: {} } })).rejects.toMatchObject({
        code: ErrorCode.InvalidBlock,
      });
    }
    // A guard on such a name can't match a file, so it doesn't reach the storage.
    await client.blocksApply({ set: { a: {} }, ifMatch: { ".env": null } });
    expect(await list()).toEqual(["a.json"]);
  });

  it("are stale when the schema changed since the core read it", async () => {
    await writeFile(join(root, ".deco", "schema.gen.json"), '{"v":1}');
    const storage = createFsStorage({ root });
    const base = await storage.snapshot();
    const schema = await storage.readSchema();
    await writeFile(join(root, ".deco", "schema.gen.json"), '{"v":2}');
    const attempt = { base, put: { "a.json": "{}\n" }, delete: [], expected: {} };
    expect(await storage.commit({ ...attempt, expectedSchemaVersion: schema!.version })).toEqual({
      status: "stale",
    });
    expect(await storage.commit({ ...attempt, expectedSchemaVersion: null })).toEqual({
      status: "stale",
    });
    expect(await list()).toEqual([]);
    const current = await storage.readSchema();
    expect(
      (await storage.commit({ ...attempt, expectedSchemaVersion: current!.version })).status,
    ).toBe("committed");
  });

  it("compare the meta.gen.json fallback when there's no schema.gen.json", async () => {
    await writeFile(join(root, ".deco", "meta.gen.json"), '{"v":1}');
    const storage = createFsStorage({ root });
    const base = await storage.snapshot();
    const legacy = await storage.readSchema();
    await writeFile(join(root, ".deco", "schema.gen.json"), '{"v":2}');
    const result = await storage.commit({
      base,
      put: { "a.json": "{}\n" },
      delete: [],
      expected: {},
      expectedSchemaVersion: legacy!.version,
    });
    expect(result).toEqual({ status: "stale" });
  });

  it("read bodies with the version of the bytes actually read", async () => {
    const storage = createFsStorage({ root });
    await writeFile(join(blocksDir(), "a.json"), "{}\n");
    const snapshot = await storage.snapshot();
    await writeFile(join(blocksDir(), "a.json"), '{"edited":true}\n');
    const bodies = await storage.readFiles(snapshot, ["a.json", "gone.json"]);
    expect(bodies).toEqual({
      "a.json": { text: '{"edited":true}\n', version: gitBlobHash('{"edited":true}\n') },
    });
    expect(bodies["a.json"].version).not.toBe(snapshot.files[0].version);
  });

  it("sweep transaction folders a crashed commit left behind", async () => {
    await mkdir(join(root, ".deco", ".tx-crashed", "old"), { recursive: true });
    await writeFile(join(root, ".deco", ".tx-crashed", "old", "0"), "stale");
    await clientFor().blocksApply({ set: { a: {} } });
    expect((await readdir(join(root, ".deco"))).sort()).toEqual(["blocks"]);
  });

  it("save an entry whose file uses a lowercase escape, whatever the filesystem's case rules", async () => {
    // A hand-made file: "%2f" decodes like "%2F", so it lists as "foo/bar".
    await writeFile(join(blocksDir(), "foo%2fbar.json"), '{"v":1}');
    const client = clientFor();
    const before = await client.blocksList();
    expect(!before.notModified && before.blocks).toEqual({ "foo/bar": { v: 1 } });
    const result = await client.blocksApply({ set: { "foo/bar": { v: 2 } } });
    expect(result.versions["foo/bar"]).toEqual(expect.any(String));
    const after = await client.blocksList();
    expect(!after.notModified && after.blocks).toEqual({ "foo/bar": { v: 2 } });
    expect(!after.notModified && after.diagnostics).toEqual([]);
    const files = await list();
    expect(files).toHaveLength(1);
    expect(files[0].toLowerCase()).toBe("foo%2fbar.json");
    // Updating it again works too (the case-insensitive rename must not unlink the new file).
    await client.blocksApply({ set: { "foo/bar": { v: 3 } } });
    const last = await client.blocksList();
    expect(!last.notModified && last.blocks).toEqual({ "foo/bar": { v: 3 } });
  });

  it("are stale when an expected version changed, and write nothing", async () => {
    const storage = createFsStorage({ root });
    await writeFile(join(blocksDir(), "a.json"), "{}\n");
    const base = await storage.snapshot();
    await writeFile(join(blocksDir(), "a.json"), '{"edited":true}\n');
    const result = await storage.commit({
      base,
      put: { "a.json": '{"mine":true}\n', "b.json": "{}\n" },
      delete: [],
      expected: { "a.json": base.files[0].version, "b.json": null },
    });
    expect(result).toEqual({ status: "stale" });
    expect(await list()).toEqual(["a.json"]);
    expect(await readFile(join(blocksDir(), "a.json"), "utf8")).toBe('{"edited":true}\n');
  });

  it("serialize concurrent writers so every apply lands whole", async () => {
    const client = clientFor();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        client.blocksApply({ set: { [`e${i}`]: { i }, shared: { by: i } } }),
      ),
    );
    expect(await list()).toEqual(
      [...Array.from({ length: 8 }, (_, i) => `e${i}.json`), "shared.json"].sort(),
    );
    const shared = JSON.parse(await readFile(join(blocksDir(), "shared.json"), "utf8"));
    expect(shared.by).toBeGreaterThanOrEqual(0);
  });

  it("wait for another process's lock, and break a stale one", async () => {
    const lock = join(root, ".deco", ".blocks.lock");
    await writeFile(lock, "999999\n");
    const storage = createFsStorage({ root, lockTimeoutMs: 100 });
    await expect(clientFor(storage).blocksApply({ set: { a: {} } })).rejects.toMatchObject({
      code: ErrorCode.Unavailable,
    });
    // A lock older than the stale window is from a crashed writer.
    const old = new Date(Date.now() - 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(lock, old, old);
    await clientFor(storage).blocksApply({ set: { a: {} } });
    await expect(stat(lock)).rejects.toThrow();
  });

  it("refuse writes when read-only", async () => {
    const storage = createFsStorage({ root, readOnly: true });
    await expect(clientFor(storage).blocksApply({ set: { a: {} } })).rejects.toMatchObject({
      code: ErrorCode.ReadOnly,
    });
    await expect(storage.putAsset!("a.png", new Uint8Array([1]))).rejects.toThrow();
  });

  it("delete every spelling of an entry in the commit that writes it", async () => {
    await writeFile(join(blocksDir(), "pages-Home%2520Page.json"), '{"from":"bot"}');
    await writeFile(join(blocksDir(), "pages-Home%20Page.json"), '{"from":"legacy"}');
    await clientFor().blocksApply({ set: { "pages-Home Page": { from: "editor" } } });
    expect(await list()).toEqual(["pages-Home%20Page.json"]);
  });
});

describe("assets", () => {
  it("write uploads to public/assets, never overwriting a file", async () => {
    const storage = createFsStorage({ root });
    expect(await storage.putAsset!("banner.jpg", new Uint8Array([1, 2]))).toEqual({
      name: "banner.jpg",
    });
    const second = await storage.putAsset!("banner.jpg", new Uint8Array([3]));
    expect(second.name).toMatch(/^banner-[0-9a-f]{6}\.jpg$/);
    const dir = join(root, "public", "assets");
    expect(await readFile(join(dir, "banner.jpg"))).toEqual(Buffer.from([1, 2]));
    expect(await readFile(join(dir, second.name))).toEqual(Buffer.from([3]));
  });

  it("honor assetsDir and refuse names with folders", async () => {
    const storage = createFsStorage({ root, assetsDir: "static" });
    await storage.putAsset!("a.png", new Uint8Array([1]));
    expect(await readdir(join(root, "static"))).toEqual(["a.png"]);
    await expect(storage.putAsset!("../a.png", new Uint8Array([1]))).rejects.toThrow();
    await expect(storage.putAsset!(".env", new Uint8Array([1]))).rejects.toThrow();
  });
});

describe("outside Node", () => {
  it("the default export condition fails on use", () => {
    expect(() => createUnsupported({ root: "/" })).toThrow(/needs Node/);
  });
});
