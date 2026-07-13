import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("URL-decodes the filename stem once to produce the block key", async () => {
    // Classic deco stores blocks as encodeURIComponent(<block id>).json and
    // derives the id back with one decodeURIComponent (parseBlockId). Content
    // references saved blocks by the DECODED id ("Cores dos preços"), so the
    // map must be keyed by it or every such reference dangles.
    writeFileSync(
      join(dir, "Cores%20dos%20pre%C3%A7os.json"),
      JSON.stringify({ __resolveType: "site/loaders/priceColors.ts" }),
    );
    // Double-encoded page snapshot (deco.cx corpus shape): decodes ONCE.
    writeFileSync(
      join(dir, "pages-Acess%25C3%25B3rios-421596.json"),
      JSON.stringify({ __resolveType: "website/pages/Page.tsx" }),
    );
    // Encoded slash becomes a real slash in the id — ids are plain map keys.
    writeFileSync(join(dir, "collections%2Fblog%2Fauthors.json"), JSON.stringify({ authors: [] }));

    const blocks = await loadDecofileDirectory(dir);

    expect(blocks["Cores dos preços"]).toEqual({
      __resolveType: "site/loaders/priceColors.ts",
    });
    expect(blocks["pages-Acess%C3%B3rios-421596"]).toEqual({
      __resolveType: "website/pages/Page.tsx",
    });
    expect(blocks["collections/blog/authors"]).toEqual({ authors: [] });
    // The raw stems must NOT appear as keys.
    expect(blocks["Cores%20dos%20pre%C3%A7os"]).toBeUndefined();
    expect(blocks["pages-Acess%25C3%25B3rios-421596"]).toBeUndefined();
  });

  it("keeps a stem verbatim when it is not valid percent-encoding", async () => {
    // A lone % (e.g. a page literally named "50% off") throws in
    // decodeURIComponent — the stem is already the id, keep it.
    writeFileSync(join(dir, "pages-50% off-7.json"), JSON.stringify({ x: 1 }));

    const blocks = await loadDecofileDirectory(dir);
    expect(blocks["pages-50% off-7"]).toEqual({ x: 1 });
  });

  it("resolves decoded-key collisions deterministically (last sorted filename wins) and warns", async () => {
    writeFileSync(join(dir, "A B.json"), JSON.stringify({ raw: true }));
    writeFileSync(join(dir, "A%20B.json"), JSON.stringify({ encoded: true }));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const blocks = await loadDecofileDirectory(dir);
      // Code-unit sort: " " (0x20) < "%" (0x25), so "A B.json" comes first
      // and "A%20B.json" is processed last — the encoded file wins.
      expect(blocks["A B"]).toEqual({ encoded: true });
      expect(Object.keys(blocks)).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("A%20B.json"));
    } finally {
      warn.mockRestore();
    }
  });
});
