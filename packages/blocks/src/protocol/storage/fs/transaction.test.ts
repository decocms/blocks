// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFileChange } from "./transaction";

const fault = vi.hoisted(() => ({
  renameTarget: null as string | null,
  unlinkTarget: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const fail = () => Object.assign(new Error("disk full"), { code: "ENOSPC" });
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (fault.renameTarget && to.endsWith(`/blocks/${fault.renameTarget}`)) throw fail();
      return real.rename(from, to);
    },
    unlink: async (path: string) => {
      if (fault.unlinkTarget && path.endsWith(`/blocks/${fault.unlinkTarget}`)) throw fail();
      return real.unlink(path);
    },
  };
});

let root: string;
const dir = () => join(root, "blocks");
const files = async () => {
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir())).sort())
    out[name] = await readFile(join(dir(), name), "utf8");
  return out;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "deco-tx-"));
  await mkdir(dir());
  await writeFile(join(dir(), "keep.json"), "old-keep");
  await writeFile(join(dir(), "gone.json"), "old-gone");
  fault.renameTarget = null;
  fault.unlinkTarget = null;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("applyFileChange", () => {
  it("writes, replaces and deletes files together", async () => {
    await applyFileChange(dir(), root, {
      put: { "keep.json": "new-keep", "new.json": "new" },
      delete: ["gone.json", "missing.json"],
    });
    expect(await files()).toEqual({ "keep.json": "new-keep", "new.json": "new" });
    expect((await readdir(root)).filter((f) => f.startsWith(".tx-"))).toEqual([]);
  });

  it("puts every file back when a rename fails midway", async () => {
    fault.renameTarget = "new.json"; // after keep.json already landed
    await expect(
      applyFileChange(dir(), root, {
        put: { "keep.json": "new-keep", "new.json": "new" },
        delete: ["gone.json"],
      }),
    ).rejects.toThrow(/disk full/);
    expect(await files()).toEqual({ "gone.json": "old-gone", "keep.json": "old-keep" });
    expect((await readdir(root)).filter((f) => f.startsWith(".tx-"))).toEqual([]);
  });

  it("puts every file back when a delete fails after the writes landed", async () => {
    fault.unlinkTarget = "gone.json";
    await expect(
      applyFileChange(dir(), root, {
        put: { "keep.json": "new-keep", "new.json": "new" },
        delete: ["gone.json"],
      }),
    ).rejects.toThrow(/disk full/);
    expect(await files()).toEqual({ "gone.json": "old-gone", "keep.json": "old-keep" });
  });

  it("creates the folder when it doesn't exist", async () => {
    await rm(dir(), { recursive: true });
    await applyFileChange(dir(), root, { put: { "a.json": "{}" }, delete: [] });
    expect(await files()).toEqual({ "a.json": "{}" });
  });
});
