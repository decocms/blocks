import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDecofileDirectory } from "./loadDecofileDirectory";

describe("loadDecofileDirectory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "decofile-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads every .json file in the directory into a keyed map", async () => {
    writeFileSync(
      join(dir, "pages-home-123.json"),
      JSON.stringify({ __resolveType: "website/pages/Page.tsx", path: "/" }),
    );
    writeFileSync(
      join(dir, "Banner Grid - 01.json"),
      JSON.stringify({ __resolveType: "site/sections/BannerGrid.tsx" }),
    );

    const blocks = await loadDecofileDirectory(dir);

    expect(Object.keys(blocks)).toHaveLength(2);
    expect(blocks["pages-home-123"]).toEqual({
      __resolveType: "website/pages/Page.tsx",
      path: "/",
    });
    expect(blocks["Banner Grid - 01"]).toEqual({
      __resolveType: "site/sections/BannerGrid.tsx",
    });
  });

  it("ignores non-.json files", async () => {
    writeFileSync(join(dir, "readme.md"), "not a block");
    writeFileSync(join(dir, "a.json"), JSON.stringify({ x: 1 }));

    const blocks = await loadDecofileDirectory(dir);
    expect(Object.keys(blocks)).toEqual(["a"]);
  });

  it("throws with the filename on invalid JSON", async () => {
    writeFileSync(join(dir, "broken.json"), "{not valid json");
    await expect(loadDecofileDirectory(dir)).rejects.toThrow(/broken\.json/);
  });
});
