import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { inferMetadata } from "./watch";

/**
 * `inferMetadata` is called from `watchFS` for every file the Vite watcher
 * reports, with no debounce and no concurrency limit. Before the guards it
 * read and `JSON.parse`d whatever changed — including `.deco/meta.gen.json`,
 * 27 MB on a 386-block site, rewritten on every save under `src/**`. That
 * churn is what drove the dev server into `JavaScript heap out of memory`.
 */
describe("inferMetadata guards", () => {
  const tmp = () => mkdtemp(join(tmpdir(), "deco-watch-"));

  it("still reads a normal block", async () => {
    const file = join(await tmp(), "block.json");
    await writeFile(file, JSON.stringify({ __resolveType: "site/sections/Hero.tsx" }));

    expect(await inferMetadata(file)).toEqual({
      kind: "block",
      blockType: "sections",
      __resolveType: "site/sections/Hero.tsx",
    });
  });

  it("skips a file that is not .json", async () => {
    const file = join(await tmp(), "Component.tsx");
    await writeFile(file, "export default function C() { return null; }");

    expect(await inferMetadata(file)).toEqual({ kind: "file" });
  });

  it("skips a .json file over the size ceiling instead of parsing it", async () => {
    const file = join(await tmp(), "meta.gen.json");
    // Valid JSON with a real __resolveType: proves the file is rejected on
    // size alone, not because parsing happened and found nothing.
    await writeFile(
      file,
      JSON.stringify({
        __resolveType: "site/sections/Hero.tsx",
        padding: "x".repeat(1_100_000),
      }),
    );

    expect(await inferMetadata(file)).toEqual({ kind: "file" });
  });
});
