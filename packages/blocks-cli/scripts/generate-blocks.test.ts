import * as cp from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBlockDelta } from "./generate-blocks";

const SCRIPT = path.resolve(__dirname, "generate-blocks.ts");

function runGenerator(
  args: string[],
  opts: { cwd?: string } = {},
): { stdout: string; stderr: string; code: number } {
  const r = cp.spawnSync("npx", ["tsx", SCRIPT, ...args], { encoding: "utf8", cwd: opts.cwd });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status ?? 0 };
}

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

describe("generate-blocks legacy artifact sync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-blocks-legacy-"));
    // Minimal .deco/blocks/ dir with one block so output is non-empty.
    fs.mkdirSync(path.join(tmpDir, ".deco", "blocks"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".deco", "blocks", "pages-Home.json"),
      JSON.stringify({ path: "/" }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("syncs .ts and .json to the old path when legacy file is detected", () => {
    const oldDir = path.join(tmpDir, "src", "server", "cms");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "blocks.gen.ts"), "// stale\n");

    const { code, stderr } = runGenerator([], { cwd: tmpDir });
    expect(code).toBe(0);

    expect(stderr).toContain("src/server/cms/blocks.gen.ts");
    expect(stderr).toContain(".deco/blocks.gen.ts");
    expect(stderr).toContain("Update importers to use the new path");

    // New path must exist.
    expect(fs.existsSync(path.join(tmpDir, ".deco", "blocks.gen.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".deco", "blocks.gen.json"))).toBe(true);

    // Old .ts must be synced (stub content, not the stale placeholder).
    const oldTs = fs.readFileSync(path.join(oldDir, "blocks.gen.ts"), "utf-8");
    expect(oldTs).not.toBe("// stale\n");

    // Old .json sibling must be synced — the Vite plugin reads it by suffix.
    const oldJson = path.join(oldDir, "blocks.gen.json");
    expect(fs.existsSync(oldJson)).toBe(true);
    const oldContent = JSON.parse(fs.readFileSync(oldJson, "utf-8"));
    const newContent = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".deco", "blocks.gen.json"), "utf-8"),
    );
    expect(oldContent).toEqual(newContent);
  }, 30_000);

  it("does not warn and does not sync when an explicit --out-file is passed", () => {
    const oldDir = path.join(tmpDir, "src", "server", "cms");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "blocks.gen.ts"), "// stale\n");

    const explicitOut = path.join(tmpDir, "custom", "blocks.gen.ts");
    const { code, stderr } = runGenerator(["--out-file", explicitOut], { cwd: tmpDir });
    expect(code).toBe(0);

    expect(stderr).not.toContain("Generator default output moved");
    expect(fs.existsSync(explicitOut)).toBe(true);
    // Old file must be untouched.
    expect(fs.readFileSync(path.join(oldDir, "blocks.gen.ts"), "utf-8")).toBe("// stale\n");
  }, 30_000);
});
