/**
 * Integration test for `generate-blocks-manifest.ts`.
 *
 * Drives the programmatic entry against a tmp fixture of hostile-but-real
 * block filenames (the shapes found in production `.deco/blocks` corpora:
 * double-encoded `%2520`, single-encoded `%20`, parentheses, encoded slashes
 * `%2F`, raw UTF-8), then verifies the emitted module the way a site would
 * consume it: keys verbatim, `tsc` accepts it, and importing it (via a tsx
 * child process from the fixture dir, resolving the raw-filename JSON import
 * specifiers against the real files on disk) yields the parsed contents.
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateBlocksManifest } from "./generate-blocks-manifest";

const SCRIPT = path.resolve(__dirname, "generate-blocks-manifest.ts");

const HOSTILE_FIXTURE: Record<string, unknown> = {
  "pages-PDP%2520Box-102215": { path: "/pdp-box", encoded: "double" },
  "pages-Home%20(principal)-287364": { path: "/", parens: true },
  "collections%2Fblog%2Fauthors%2Fx": { nested: "encoded-slash" },
  "pages-Calçados-42": { utf8: "çãé" },
};

describe("generate-blocks-manifest", () => {
  let tmpDir: string;
  let blocksDir: string;
  let outFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-blocks-manifest-"));
    blocksDir = path.join(tmpDir, ".deco", "blocks");
    outFile = path.join(tmpDir, ".deco", "blocksManifest.gen.ts");
    fs.mkdirSync(blocksDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeFixture = (fixture: Record<string, unknown> = HOSTILE_FIXTURE) => {
    for (const [key, value] of Object.entries(fixture)) {
      fs.writeFileSync(path.join(blocksDir, `${key}.json`), JSON.stringify(value));
    }
  };

  it("emits verbatim keys and raw-filename import specifiers for hostile names", async () => {
    writeFixture();
    const result = await generateBlocksManifest({ blocksDir, outFile, silent: true });
    expect(result.count).toBe(4);
    expect(result.empty).toBe(false);
    expect(result.written).toBe(true);

    const emitted = fs.readFileSync(outFile, "utf-8");
    for (const key of Object.keys(HOSTILE_FIXTURE)) {
      // Key: filename minus .json, verbatim — no decoding of %2520/%20/%2F.
      expect(emitted).toContain(`${JSON.stringify(key)}: `);
      // Specifier: the raw on-disk filename, relative to the emitted module.
      expect(emitted).toContain(`from ${JSON.stringify(`./blocks/${key}.json`)};`);
    }
    // Never URL-decoded anywhere in the module.
    expect(emitted).not.toContain("pages-PDP%20Box");
    expect(emitted).not.toContain("pages-Home (principal)");
    expect(emitted).not.toContain("collections/blog");
  });

  it("compiles under tsc (module esnext, bundler resolution, resolveJsonModule)", async () => {
    writeFixture();
    await generateBlocksManifest({ blocksDir, outFile, silent: true });

    const r = cp.spawnSync(
      "npx",
      [
        "tsc",
        "--noEmit",
        "--strict",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--target",
        "es2022",
        "--resolveJsonModule",
        "--skipLibCheck",
        outFile,
      ],
      { encoding: "utf8" },
    );
    expect(r.stdout + r.stderr).not.toMatch(/error TS/);
    expect(r.status).toBe(0);
  }, 30_000);

  it("importing the emitted module (tsx, from the fixture dir) yields the parsed contents", async () => {
    writeFixture();
    await generateBlocksManifest({ blocksDir, outFile, silent: true });

    const runner = path.join(tmpDir, ".deco", "runner.ts");
    fs.writeFileSync(
      runner,
      'import blocks from "./blocksManifest.gen";\nconsole.log(JSON.stringify(blocks));\n',
    );
    const r = cp.spawnSync("npx", ["tsx", runner], { encoding: "utf8", cwd: tmpDir });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(HOSTILE_FIXTURE);
  }, 30_000);

  it("is idempotent: regeneration over an unchanged block set writes nothing", async () => {
    writeFixture();
    const first = await generateBlocksManifest({ blocksDir, outFile, silent: true });
    expect(first.written).toBe(true);
    const emittedFirst = fs.readFileSync(outFile, "utf-8");

    const second = await generateBlocksManifest({ blocksDir, outFile, silent: true });
    expect(second.written).toBe(false);
    expect(fs.readFileSync(outFile, "utf-8")).toBe(emittedFirst);
  });

  it("orders imports deterministically regardless of readdir order (sorted filenames)", async () => {
    writeFixture({ "z-last": { z: 1 }, "a-first": { a: 1 }, "m-mid": { m: 1 } });
    await generateBlocksManifest({ blocksDir, outFile, silent: true });

    const emitted = fs.readFileSync(outFile, "utf-8");
    const importOrder = [...emitted.matchAll(/from "\.\/blocks\/([^"]+)\.json";/g)].map(
      (m) => m[1],
    );
    expect(importOrder).toEqual(["a-first", "m-mid", "z-last"]);
  });

  it("ignores non-json entries and subdirectories (top-level *.json only)", async () => {
    writeFixture({ real: { ok: true } });
    fs.writeFileSync(path.join(blocksDir, "notes.txt"), "not a block");
    fs.mkdirSync(path.join(blocksDir, "nested"));
    fs.writeFileSync(path.join(blocksDir, "nested", "deep.json"), "{}");

    const result = await generateBlocksManifest({ blocksDir, outFile, silent: true });
    expect(result.count).toBe(1);
    const emitted = fs.readFileSync(outFile, "utf-8");
    expect(emitted).toContain('"real": _b0');
    expect(emitted).not.toContain("notes.txt");
    expect(emitted).not.toContain("deep.json");
  });

  it("emits an empty manifest when the blocks dir is missing", async () => {
    fs.rmSync(blocksDir, { recursive: true, force: true });
    const result = await generateBlocksManifest({ blocksDir, outFile, silent: true });
    expect(result.count).toBe(0);
    expect(result.empty).toBe(true);

    const emitted = fs.readFileSync(outFile, "utf-8");
    expect(emitted).toContain("const blocks: Record<string, unknown> = {");
    expect(emitted).toContain("export default blocks;");
    expect(emitted).not.toContain("import _b");
  });

  it("never lets a generated comment contain the block-comment terminator", async () => {
    // Filenames land ONLY inside JSON.stringify-quoted string literals — a
    // name containing `*` + `/` must not be able to truncate any comment in
    // the emitted module (past incident with interpolated doc comments).
    writeFixture({ "weird-*∕name": { ok: true }, "star*": { s: 1 } });
    await generateBlocksManifest({ blocksDir, outFile, silent: true });

    const emitted = fs.readFileSync(outFile, "utf-8");
    const commentLines = emitted.split("\n").filter((l) => l.startsWith("//"));
    for (const line of commentLines) {
      expect(line).not.toContain("*/");
      expect(line).not.toContain("weird");
    }
  });

  it("runs as a CLI with --blocks-dir/--out-file overrides", () => {
    writeFixture({ "cli-block": { via: "cli" } });
    const cliOut = path.join(tmpDir, "custom", "manifest.gen.ts");

    const r = cp.spawnSync(
      "npx",
      ["tsx", SCRIPT, "--blocks-dir", blocksDir, "--out-file", cliOut],
      { encoding: "utf8", cwd: tmpDir },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Generated static-import manifest for 1 blocks");

    const emitted = fs.readFileSync(cliOut, "utf-8");
    expect(emitted).toContain('"cli-block": _b0');
    // Specifier is relative to the out file's own directory.
    expect(emitted).toContain('from "../.deco/blocks/cli-block.json";');
  }, 30_000);
});
