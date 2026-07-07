import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBlockDelta } from "./generate-blocks";

describe("readBlockDelta", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "deco-blocks-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, value: unknown) =>
    writeFileSync(path.join(dir, name), JSON.stringify(value), "utf-8");

  it("upserts only the changed files, keyed by single-decoded name", () => {
    write("Site.json", { __resolveType: "site" });
    write("pages-Home.json", { path: "/" });

    const delta = readBlockDelta({
      blocksDir: dir,
      files: [{ name: "pages-Home.json", isDelete: false }],
      silent: true,
    });

    // Only the changed file is present — the untouched Site block is not read.
    expect(delta).toEqual({ "pages-Home": { path: "/" } });
  });

  it("decodes the filename exactly once (matches the runtime block key)", () => {
    // Studio round-trips encodeURIComponent(blockKey) -> filename, so a key
    // with a space lands on disk single-encoded.
    write("pages-Home%20-%20LB.json", { path: "/lb" });

    const delta = readBlockDelta({
      blocksDir: dir,
      files: [{ name: "pages-Home%20-%20LB.json", isDelete: false }],
      silent: true,
    });

    expect(delta).toEqual({ "pages-Home - LB": { path: "/lb" } });
  });

  it("maps deletes to null so applyDelta removes the block", () => {
    const delta = readBlockDelta({
      blocksDir: dir,
      files: [{ name: "pages-Gone.json", isDelete: true }],
      silent: true,
    });

    expect(delta).toEqual({ "pages-Gone": null });
  });

  it("skips files that fail to parse (partial write in progress)", () => {
    writeFileSync(path.join(dir, "pages-Half.json"), "{ not valid json", "utf-8");
    write("pages-Good.json", { path: "/good" });

    const delta = readBlockDelta({
      blocksDir: dir,
      files: [
        { name: "pages-Half.json", isDelete: false },
        { name: "pages-Good.json", isDelete: false },
      ],
      silent: true,
    });

    // The unparseable file is dropped; the valid one still comes through.
    expect(delta).toEqual({ "pages-Good": { path: "/good" } });
  });

  it("skips a missing upsert target without throwing", () => {
    const delta = readBlockDelta({
      blocksDir: dir,
      files: [{ name: "pages-Missing.json", isDelete: false }],
      silent: true,
    });

    expect(delta).toEqual({});
  });

  it("ignores non-json entries", () => {
    const delta = readBlockDelta({
      blocksDir: dir,
      files: [{ name: "notes.txt", isDelete: false }],
      silent: true,
    });

    expect(delta).toEqual({});
  });
});
