// @vitest-environment node
/**
 * The filesystem storage's base: the git HEAD of the repository the app root
 * is in, compared with git's own idea of equal content.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, gitCommitAll, gitInit } from "../../__tests__/git";
import { createContentClient } from "../../client";
import { ErrorCode } from "../../errors";
import { serializeBlock } from "../../keys";
import { createContentHandler } from "../../server";
import { StorageUnavailableError } from "../../storage";
import { checkGitWorkTree, UNBORN_REVISION } from "./git";
import { createFsStorage } from "./index";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "deco-fs-git-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** An app at `<repo>/<prefix>` with `blocks` committed to HEAD. */
async function app(blocks: Record<string, string>, prefix = "", attributes?: string) {
  const root = join(repo, prefix);
  await mkdir(join(root, ".deco", "blocks"), { recursive: true });
  if (attributes) await writeFile(join(repo, ".gitattributes"), attributes);
  for (const [file, content] of Object.entries(blocks)) {
    await writeFile(join(root, ".deco", "blocks", file), content);
  }
  gitInit(repo);
  const storage = createFsStorage({ root });
  const client = createContentClient({
    endpoint: "http://local/rpc",
    fetch: createContentHandler(storage, { commitRetryDelayMs: { minMs: 0, maxMs: 0 } }),
  });
  const write = (file: string, content: string) =>
    writeFile(join(root, ".deco", "blocks", file), content);
  const read = (file: string) => readFile(join(root, ".deco", "blocks", file));
  return { root, storage, client, write, read };
}

async function changed(client: ReturnType<typeof createContentClient>) {
  const result = await client.changesList();
  if (result.notModified) throw new Error("expected the changes");
  return result.changes;
}

const a = serializeBlock({ title: "A" });
const b = serializeBlock({ title: "B" });

describe("the base is HEAD", () => {
  it("reports the commit and branch, a detached HEAD, and an unborn HEAD", async () => {
    const { storage } = await app({ "a.json": a });
    const head = git(repo, "rev-parse", "HEAD");
    expect(await storage.base()).toEqual({ revision: head, resolvedRef: "main" });
    git(repo, "checkout", "-q", "--detach");
    expect(await storage.base()).toEqual({ revision: head, resolvedRef: null });

    const fresh = await mkdtemp(join(tmpdir(), "deco-fs-git-unborn-"));
    try {
      await mkdir(join(fresh, ".deco", "blocks"), { recursive: true });
      await writeFile(join(fresh, ".deco", "blocks", "a.json"), a);
      gitInit(fresh, { commit: false });
      const unborn = createFsStorage({ root: fresh });
      const base = await unborn.base();
      expect(base).toEqual({ revision: UNBORN_REVISION, resolvedRef: "main" });
      expect((await unborn.changes(base, await unborn.snapshot())).files).toEqual(["a.json"]);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("lists modified, new (ignored ones too) and deleted files, never unchanged ones", async () => {
    const { client, write, root } = await app({ "a.json": a, "b.json": b, "c.json": a });
    await write("a.json", serializeBlock({ title: "A2" }));
    await rm(join(root, ".deco", "blocks", "b.json"));
    await write("n.json", b);
    await writeFile(join(repo, ".gitignore"), ".deco/blocks/ignored.json\n");
    await write("ignored.json", b);
    const changes = await changed(client);
    expect(Object.keys(changes).sort()).toEqual(["a", "b", "ignored", "n"]);
    expect(changes.b).toMatchObject({ kind: "delete", version: null });
    expect(changes.n).toMatchObject({ kind: "set", baseVersion: null });
  });

  it("ignores the index: a staged-only change and a `git rm --cached` file with HEAD bytes aren't changes", async () => {
    const { client, write } = await app({ "a.json": a, "b.json": b });
    git(repo, "rm", "-q", "--cached", ".deco/blocks/a.json");
    await write("b.json", serializeBlock({ title: "B2" }));
    git(repo, "add", ".deco/blocks/b.json");
    expect(Object.keys(await changed(client))).toEqual(["b"]);
    await write("b.json", b);
    expect(await changed(client)).toEqual({});
  });

  it("honours eol=crlf: a CRLF checkout isn't a change, and a discard restores CRLF bytes", async () => {
    const { client, write, read, root } = await app(
      { "a.json": a },
      "",
      ".deco/blocks/*.json text eol=crlf\n",
    );
    // A real checkout under eol=crlf writes CRLF bytes.
    await rm(join(root, ".deco", "blocks", "a.json"));
    git(repo, "checkout", "--", ".deco/blocks/a.json");
    const crlf = a.replaceAll("\n", "\r\n");
    expect((await read("a.json")).toString("utf8")).toBe(crlf);
    expect(await changed(client)).toEqual({});
    await write("a.json", serializeBlock({ title: "A2" }));
    expect(Object.keys(await changed(client))).toEqual(["a"]);
    const detail = await client.changesGet({ names: ["a"] });
    expect(detail.entries.a?.before).toEqual({ title: "A" });
    await client.changesDiscard({ names: ["a"] });
    expect((await read("a.json")).toString("utf8")).toBe(crlf);
    expect(await changed(client)).toEqual({});
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("keeps a base file's BOM: a discard restores its exact bytes, and both sides still parse", async () => {
    const bom = `﻿${a}`;
    const { client, write, read } = await app({ "a.json": bom });
    expect(await changed(client)).toEqual({});
    await write("a.json", serializeBlock({ title: "A2" }));
    const detail = await client.changesGet({ names: ["a"] });
    expect(detail.entries.a?.before).toEqual({ title: "A" });
    expect(detail.diagnostics).toEqual([]);
    await client.changesDiscard({ names: ["a"] });
    expect((await read("a.json")).toString("utf8")).toBe(bom);
    expect(await changed(client)).toEqual({});
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("works for an app in a monorepo folder", async () => {
    const { client, write, root } = await app({ "a.json": a }, "apps/web");
    expect((await createFsStorage({ root }).describe()).root).toBe("apps/web");
    await write("a.json", b);
    await write("x.json", b);
    git(repo, "add", "-A");
    expect(Object.keys(await changed(client)).sort()).toEqual(["a", "x"]);
    await client.changesDiscard({ names: ["a", "x"] });
    expect(await changed(client)).toEqual({});
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("follows commits made outside: a committed change is no longer listed", async () => {
    const { client, write } = await app({ "a.json": a });
    await write("a.json", b);
    expect(Object.keys(await changed(client))).toEqual(["a"]);
    gitCommitAll(repo);
    expect(await changed(client)).toEqual({});
  });

  it("refuses a discard computed against a base that moved (expectedBase), atomically", async () => {
    const { storage, write } = await app({ "a.json": a });
    const base = await storage.base();
    await write("a.json", b);
    gitCommitAll(repo);
    const result = await storage.commit({
      base: await storage.snapshot(),
      put: { "a.json": a },
      delete: [],
      expected: {},
      expectedBase: base.revision,
      reason: "discard",
    });
    expect(result).toEqual({ status: "stale" });
  });

  it("ignores GIT_DIR and friends inherited from the environment", async () => {
    const { storage } = await app({ "a.json": a });
    const other = await mkdtemp(join(tmpdir(), "deco-fs-git-other-"));
    const saved = process.env.GIT_DIR;
    try {
      gitInit(other);
      process.env.GIT_DIR = join(other, ".git");
      expect((await storage.base()).revision).toBe(git(repo, "rev-parse", "HEAD"));
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("a discard unstages what it restores", () => {
  /** `git status --porcelain` for these paths (repo-relative), or all with none. */
  const status = (...paths: string[]) =>
    git(repo, "status", "--porcelain", "--untracked-files=all", "--", ...paths);
  const block = (name: string) => `.deco/blocks/${name}.json`;

  it("a staged modification: the index is back to HEAD", async () => {
    const { client, write } = await app({ "a.json": a });
    await write("a.json", b);
    git(repo, "add", block("a"));
    expect(status(block("a"))).toBe("M  .deco/blocks/a.json");
    await client.changesDiscard({ names: ["a"] });
    expect(status(block("a"))).toBe("");
    expect(status()).toBe("");
  });

  it("a partially staged file (staged, then edited again): both are dropped", async () => {
    const { client, write, read } = await app({ "a.json": a });
    await write("a.json", b);
    git(repo, "add", block("a"));
    await write("a.json", serializeBlock({ title: "A3" }));
    expect(status(block("a"))).toBe("MM .deco/blocks/a.json");
    await client.changesDiscard({ names: ["a"] });
    expect(status(block("a"))).toBe("");
    expect((await read("a.json")).toString("utf8")).toBe(a);
  });

  it("a staged new file: out of the index and off the disk", async () => {
    const { client, write, root } = await app({ "a.json": a });
    await write("n.json", b);
    git(repo, "add", block("n"));
    expect(status(block("n"))).toBe("A  .deco/blocks/n.json");
    await client.changesDiscard({ names: ["n"] });
    expect(status(block("n"))).toBe("");
    expect(git(repo, "ls-files", "--", block("n"))).toBe("");
    await expect(readFile(join(root, ".deco", "blocks", "n.json"))).rejects.toThrow();
  });

  it("a staged new file edited again: out of the index too", async () => {
    const { client, write } = await app({ "a.json": a });
    await write("n.json", b);
    git(repo, "add", block("n"));
    await write("n.json", a);
    expect(status(block("n"))).toBe("AM .deco/blocks/n.json");
    await client.changesDiscard({ names: ["n"] });
    expect(status()).toBe("");
  });

  it("a staged deletion (`git rm`): restored in the index and on disk", async () => {
    // Another block keeps the folder: `git rm` of a last file removes it.
    const { client, read } = await app({ "a.json": a, "c.json": b });
    git(repo, "rm", "-q", block("a"));
    expect(status(block("a"))).toBe("D  .deco/blocks/a.json");
    await client.changesDiscard({ names: ["a"] });
    expect(status(block("a"))).toBe("");
    expect((await read("a.json")).toString("utf8")).toBe(a);
  });

  it("a `git mv` rename: discarding either side unstages both sides", async () => {
    const { client, read } = await app({ "a.json": a });
    git(repo, "mv", block("a"), block("r"));
    expect(status()).toBe("R  .deco/blocks/a.json -> .deco/blocks/r.json");
    // Discard the new side only: the old side's staged deletion goes too.
    await client.changesDiscard({ names: ["r"] });
    expect(status(block("r"))).toBe("");
    // a.json is back in the index; on disk it is still missing (not discarded).
    expect(git(repo, "ls-files", "--", block("a"))).toBe(block("a"));
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    expect(git(repo, "diff", "--name-only")).toBe(block("a"));
    await client.changesDiscard({ names: ["a"] });
    expect(status()).toBe("");
    expect((await read("a.json")).toString("utf8")).toBe(a);
  });

  it("a `git mv` rename discarded by its old side, and both sides at once", async () => {
    const { client } = await app({ "a.json": a, "c.json": b });
    git(repo, "mv", block("a"), block("r"));
    await client.changesDiscard({ names: ["a"] });
    expect(status(block("a"))).toBe("");
    // The new side is no longer staged: just an untracked file, still a change.
    expect(status(block("r"))).toBe("?? .deco/blocks/r.json");
    git(repo, "mv", block("c"), block("s"));
    await client.changesDiscard({ names: ["c", "s", "r"] });
    expect(status()).toBe("");
  });

  it("leaves every other path's staging alone", async () => {
    const { client, write, root } = await app({ "a.json": a, "b.json": b });
    await writeFile(join(root, "README.md"), "hello\n");
    await write("a.json", b);
    await write("b.json", a);
    git(repo, "add", "-A");
    await client.changesDiscard({ names: ["a"] });
    expect(status()).toBe("M  .deco/blocks/b.json\nA  README.md");
  });

  it("works in a repository with no commits yet: everything discarded leaves the index", async () => {
    await mkdir(join(repo, ".deco", "blocks"), { recursive: true });
    await writeFile(join(repo, ".deco", "blocks", "a.json"), a);
    await writeFile(join(repo, ".deco", "blocks", "b.json"), b);
    await writeFile(join(repo, "README.md"), "hello\n");
    gitInit(repo, { commit: false });
    git(repo, "add", "-A");
    await writeFile(join(repo, ".deco", "blocks", "a.json"), serializeBlock({ title: "A2" }));
    const client = createContentClient({
      endpoint: "http://local/rpc",
      fetch: createContentHandler(createFsStorage({ root: repo })),
    });
    await client.changesDiscard({ names: ["a"] });
    expect(status(block("a"))).toBe("");
    expect(status()).toBe("A  .deco/blocks/b.json\nA  README.md");
  });

  it("puts the index back when the file write fails", async () => {
    const { storage, write, root } = await app({ "a.json": a });
    await write("a.json", b);
    git(repo, "add", block("a"));
    // A folder where a file would be renamed into place fails the write.
    await mkdir(join(root, ".deco", "blocks", "x.json"));
    const result = storage.commit({
      base: await storage.snapshot(),
      put: { "a.json": a, "x.json": a },
      delete: [],
      expected: {},
      reason: "discard",
    });
    await expect(result).rejects.toThrow();
    expect(status(block("a"))).toBe("M  .deco/blocks/a.json");
  });
});

describe("outside a git work tree", () => {
  it("serves the content, but the changes methods are Unavailable", async () => {
    await mkdir(join(repo, ".deco", "blocks"), { recursive: true });
    await writeFile(join(repo, ".deco", "blocks", "a.json"), a);
    const storage = createFsStorage({ root: repo });
    await expect(storage.base()).rejects.toBeInstanceOf(StorageUnavailableError);
    const client = createContentClient({
      endpoint: "http://local/rpc",
      fetch: createContentHandler(storage),
    });
    expect((await client.blocksList()).notModified).toBe(false);
    const error = await client.changesList().catch((e) => e);
    expect(error.code).toBe(ErrorCode.Unavailable);
  });

  it("checkGitWorkTree tells a folder outside a repository and a missing git apart", async () => {
    expect(await checkGitWorkTree(repo)).toEqual({ status: "not-a-repository" });
    expect(await checkGitWorkTree(repo, { git: join(repo, "no-such-git") })).toEqual({
      status: "missing",
    });
    gitInit(repo);
    expect(await checkGitWorkTree(repo)).toEqual({ status: "ok" });
    expect(await checkGitWorkTree(join(repo, ".git"))).toEqual({ status: "not-a-repository" });
  });
});
