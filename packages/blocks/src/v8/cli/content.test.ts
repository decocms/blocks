// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, computeContentRevision, sha256Hex } from "../canonical";
import { createFixture, type Fixture, recorder } from "./__tests__/fixture";
import { LEGACY_ALIASES } from "./builtins";
import { content, readSavedBlocks, renderContentModule, writeContent } from "./content";
import { decoPaths } from "./root";

let fixture: Fixture;
afterEach(() => fixture?.remove());

const home = { __resolveType: "page", name: "Home", path: "/", sections: [] };

describe("reading .deco/blocks", () => {
  it("reads one entry per JSON file, named by the file-name rule", () => {
    fixture = createFixture({
      ".deco/blocks/HomePage.json": home,
      ".deco/blocks/collections%2Fblog%2Fposts%2Fabc.json": { __resolveType: "post" },
      ".deco/blocks/notes.txt": "ignored",
    });
    const saved = readSavedBlocks(decoPaths(fixture.root).blocks);
    expect(Object.keys(saved.blocks).sort()).toEqual(["HomePage", "collections/blog/posts/abc"]);
    expect(saved.files["collections/blog/posts/abc"]).toBe("collections%2Fblog%2Fposts%2Fabc.json");
    expect(saved.diagnostics).toEqual([]);
  });

  it("keeps names like constructor and toString as plain entries, and reports __proto__.json", async () => {
    fixture = createFixture({
      ".deco/blocks/constructor.json": home,
      ".deco/blocks/toString.json": { __resolveType: "x" },
      ".deco/blocks/__proto__.json": { __resolveType: "x" },
      ".deco/blocks/con.json": { __resolveType: "x" },
    });
    const saved = readSavedBlocks(decoPaths(fixture.root).blocks);
    expect(Object.keys(saved.blocks).sort()).toEqual(["constructor", "toString"]);
    expect(Object.hasOwn(saved.blocks, "hasOwnProperty")).toBe(false);
    expect(saved.diagnostics).toEqual([
      {
        file: "__proto__.json",
        severity: "error",
        message: 'not a valid entry name (the name "__proto__" is reserved); rename the file',
      },
      {
        file: "con.json",
        severity: "error",
        message: 'not a valid entry name ("CON" is a Windows device name); rename the file',
      },
    ]);
    await expect(writeContent(decoPaths(fixture.root))).rejects.toThrow(
      /__proto__\.json: not a valid/,
    );
  });

  it("writes constructor and toString into the module like any other name", async () => {
    fixture = createFixture({
      ".deco/blocks/constructor.json": home,
      ".deco/blocks/toString.json": home,
    });
    const result = await writeContent(decoPaths(fixture.root));
    const mod = await import(/* @vite-ignore */ pathToFileURL(result.file).href);
    expect(Object.keys(mod.default.blocks).sort()).toEqual(["constructor", "toString"]);
    expect(mod.default.blocks.constructor).toEqual(home);
  });

  it("is empty without a blocks folder", () => {
    fixture = createFixture();
    fs.rmSync(path.join(fixture.root, ".deco/blocks"), { recursive: true });
    expect(readSavedBlocks(decoPaths(fixture.root).blocks).blocks).toEqual({});
  });

  it("reports invalid JSON and non-object files as errors", () => {
    fixture = createFixture({
      ".deco/blocks/Broken.json": "{ nope",
      ".deco/blocks/List.json": "[1, 2]",
    });
    const saved = readSavedBlocks(decoPaths(fixture.root).blocks);
    expect(saved.blocks).toEqual({});
    expect(saved.diagnostics.map((d) => [d.file, d.severity])).toEqual([
      ["Broken.json", "error"],
      ["List.json", "error"],
    ]);
  });

  it("keeps one spelling of a name and reports the others", () => {
    fixture = createFixture({
      ".deco/blocks/pages-Home%20Page.json": { __resolveType: "page", name: "old", path: "" },
      ".deco/blocks/pages-Home%2520Page.json": {
        __resolveType: "page",
        name: "new",
        path: "/home",
      },
    });
    const saved = readSavedBlocks(decoPaths(fixture.root).blocks);
    // The entry with a path wins; its name is its file name decoded once.
    expect(Object.keys(saved.blocks)).toEqual(["pages-Home%20Page"]);
    expect(saved.blocks["pages-Home%20Page"].name).toBe("new");
    expect(saved.diagnostics).toEqual([
      {
        file: "pages-Home%20Page.json",
        severity: "warning",
        message: 'another spelling of "pages-Home%20Page"; pages-Home%2520Page.json wins',
      },
    ]);
  });

  it("reports subfolders, which aren't read", () => {
    fixture = createFixture({ ".deco/blocks/nested/A.json": home });
    const saved = readSavedBlocks(decoPaths(fixture.root).blocks);
    expect(saved.blocks).toEqual({});
    expect(saved.diagnostics[0]).toMatchObject({ file: "nested", severity: "warning" });
  });
});

/**
 * The schemaHash test vector Studio's publish shares: the same file must give
 * the same hash on both sides (sha256Hex(canonicalJson(JSON.parse(text)))).
 */
const SCHEMA_TEXT =
  '{\n  "version": "8.1.0-next.7",\n  "blocksMajor": 8,\n  "definitions": { "seo": { "type": "object", "title": "Seo" } },\n  "root": {}\n}\n';
const SCHEMA_HASH = "00b083655ee7af02aa92dbff85e402857bb1e50c253a579dbab23498a7842c98";

describe("schemaHash", () => {
  it("is written into the module from .deco/schema.gen.json, as sha256Hex(canonicalJson(schema))", async () => {
    fixture = createFixture({
      ".deco/blocks/HomePage.json": home,
      ".deco/schema.gen.json": SCHEMA_TEXT,
    });
    expect(await sha256Hex(canonicalJson(JSON.parse(SCHEMA_TEXT)))).toBe(SCHEMA_HASH);
    const result = await writeContent(decoPaths(fixture.root));
    expect(result.schemaHash).toBe(SCHEMA_HASH);
    const source = fixture.read(".deco/blocks.gen.ts");
    expect(source).toContain(`  schemaHash: "${SCHEMA_HASH}",`);
    expect(source).toContain("  schemaHash: string;");
    const mod = await import(/* @vite-ignore */ pathToFileURL(result.file).href);
    expect(mod.default.schemaHash).toBe(SCHEMA_HASH);
  });

  it("ignores formatting and key order: the parsed JSON is hashed", async () => {
    fixture = createFixture({
      ".deco/blocks/HomePage.json": home,
      ".deco/schema.gen.json": JSON.stringify(JSON.parse(SCHEMA_TEXT)),
    });
    expect((await writeContent(decoPaths(fixture.root))).schemaHash).toBe(SCHEMA_HASH);
  });

  it("is left out without a schema file, so hosted releases never swap", async () => {
    fixture = createFixture({ ".deco/blocks/HomePage.json": home });
    const result = await writeContent(decoPaths(fixture.root));
    expect(result.schemaHash).toBeUndefined();
    expect(fixture.read(".deco/blocks.gen.ts")).not.toContain("schemaHash");
  });

  it("a schema file that isn't JSON fails deco content", async () => {
    fixture = createFixture({
      ".deco/blocks/HomePage.json": home,
      ".deco/schema.gen.json": "{",
    });
    await expect(writeContent(decoPaths(fixture.root))).rejects.toThrow(
      /schema\.gen\.json: not valid JSON/,
    );
  });

  it("a schema change rewrites the module", async () => {
    fixture = createFixture({
      ".deco/blocks/HomePage.json": home,
      ".deco/schema.gen.json": SCHEMA_TEXT,
    });
    const paths = decoPaths(fixture.root);
    expect((await writeContent(paths)).changed).toBe(true);
    fixture.write(".deco/schema.gen.json", { blocksMajor: 8, version: "other" });
    const next = await writeContent(paths);
    expect(next.changed).toBe(true);
    expect(next.schemaHash).not.toBe(SCHEMA_HASH);
  });
});

describe("the content module", () => {
  it("imports each JSON file and exports { revision, blocks, aliases }", async () => {
    fixture = createFixture({ ".deco/blocks/HomePage.json": home });
    const source = await renderContentModule(readSavedBlocks(decoPaths(fixture.root).blocks));
    expect(source.startsWith("// Generated by deco content; don't edit.\n")).toBe(true);
    expect(source).toContain(
      'import HomePage from "./blocks/HomePage.json" with { type: "json" };',
    );
    expect(source).toContain(`revision: "${await computeContentRevision({ HomePage: home })}"`);
    expect(source).toContain('"HomePage": HomePage,');
    expect(source).toContain('"website/pages/Page.tsx": "page",');
    expect(source).toContain("export default content;");
  });

  it("inlines files whose names aren't portable import paths", async () => {
    fixture = createFixture({
      ".deco/blocks/pages-Home%2520Page.json": home,
      ".deco/blocks/default.json": { __resolveType: "x" },
      ".deco/blocks/1st.json": { __resolveType: "x" },
    });
    const source = await renderContentModule(readSavedBlocks(decoPaths(fixture.root).blocks));
    expect(source).not.toContain('pages-Home%2520Page.json" with');
    expect(source).toContain(`"pages-Home%20Page": ${JSON.stringify(home)},`);
    // Reserved words and leading digits get safe identifiers.
    expect(source).toContain('import _default from "./blocks/default.json"');
    expect(source).toContain('import _1st from "./blocks/1st.json"');
  });

  it("says which files it inlined, and that hand edits to them need a rerun", async () => {
    fixture = createFixture({
      ".deco/blocks/HomePage.json": home,
      ".deco/blocks/pages-Home%2520Page.json": home,
    });
    expect((await writeContent(decoPaths(fixture.root))).inlined).toEqual([
      "pages-Home%2520Page.json",
    ]);
    const out = recorder();
    await content({ cwd: fixture.root, reporter: out });
    expect(out.lines.at(-1)?.message).toBe(
      "1 file with % in the name is inlined, not imported: after editing one by hand, run deco content again (or keep deco content --watch running)",
    );
    const watching = recorder();
    await content({ cwd: fixture.root, reporter: watching, watching: true });
    expect(watching.text()).not.toContain("inlined");
  });

  it("loads in a real module system with the same content and revision", async () => {
    fixture = createFixture({
      ".deco/blocks/HomePage.json": home,
      ".deco/blocks/pages-Home%2520Page.json": home,
    });
    const result = await writeContent(decoPaths(fixture.root));
    const mod = await import(/* @vite-ignore */ pathToFileURL(result.file).href);
    expect(mod.default.blocks).toEqual({ HomePage: home, "pages-Home%20Page": home });
    expect(mod.default.revision).toBe(await computeContentRevision(mod.default.blocks));
    expect(mod.default.aliases).toEqual(LEGACY_ALIASES);
  });

  it("only rewrites the file when it changes", async () => {
    fixture = createFixture({ ".deco/blocks/HomePage.json": home });
    const paths = decoPaths(fixture.root);
    expect((await writeContent(paths)).changed).toBe(true);
    expect((await writeContent(paths)).changed).toBe(false);
    fixture.write(".deco/blocks/Other.json", {
      __resolveType: "page",
      name: "O",
      path: "/o",
      sections: [],
    });
    expect((await writeContent(paths)).changed).toBe(true);
  });

  it("refuses to write a module from unreadable content", async () => {
    fixture = createFixture({ ".deco/blocks/Broken.json": "{" });
    await expect(writeContent(decoPaths(fixture.root))).rejects.toThrow(
      /Broken\.json: invalid JSON/,
    );
  });

  it("deco content prints what it wrote, and never reads the block map", async () => {
    fixture = createFixture({
      ".deco/blocks/HomePage.json": home,
      ".deco/index.ts": "this is not valid TypeScript (",
    });
    const out = recorder();
    expect(await content({ cwd: path.join(fixture.root, "src"), reporter: out })).toBe(0);
    expect(out.text()).toMatch(
      /^wrote \.deco\/blocks\.gen\.ts \(1 blocks, revision [0-9a-f]{12}\)$/,
    );
    expect(fixture.exists(".deco/blocks.gen.ts")).toBe(true);
  });
});
