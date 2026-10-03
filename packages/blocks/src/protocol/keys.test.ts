import { describe, expect, it } from "vitest";
import {
  blockFileName,
  blockNameFromFile,
  checkBlockName,
  checkDeletedName,
  compareSpellings,
  entryHasPath,
  fullyDecodeFileName,
  isBlockFileName,
  MAX_ENCODED_NAME_BYTES,
  resolveSpellings,
  serializeBlock,
  spellingKey,
} from "./keys";

describe("name to file", () => {
  it.each([
    // The spec's examples.
    ["pages-Home%20Page-6f1e", "pages-Home%2520Page-6f1e.json"],
    ["collections/blog/posts/abc", "collections%2Fblog%2Fposts%2Fabc.json"],
    ["Header", "Header.json"],
    ["pages-Home Page", "pages-Home%20Page.json"],
    ["Cores dos preços", "Cores%20dos%20pre%C3%A7os.json"],
    ["50% off", "50%25%20off.json"],
  ])("%j is stored as %j", (name, file) => {
    expect(blockFileName(name)).toBe(file);
  });

  it("stores every name directly in .deco/blocks (no subfolders)", () => {
    expect(blockFileName("a/b/c")).not.toContain("/");
    expect(blockFileName("a\\b")).not.toContain("\\");
  });
});

describe("file to name: decode exactly once", () => {
  it.each([
    ["pages-Home%2520Page-6f1e.json", "pages-Home%20Page-6f1e"],
    ["collections%2Fblog%2Fposts%2Fabc.json", "collections/blog/posts/abc"],
    ["pages-Home%20Page.json", "pages-Home Page"],
    ["Header.json", "Header"],
  ])("%j holds %j", (file, name) => {
    expect(blockNameFromFile(file)).toBe(name);
  });

  it("keeps the raw name when decoding fails", () => {
    expect(blockNameFromFile("50% off.json")).toBe("50% off");
    expect(blockNameFromFile("bad%E0%A4%A.json")).toBe("bad%E0%A4%A");
  });

  it("round-trips every name through its file", () => {
    for (const name of ["a", "pages-Home%20Page-6f1e", "x/y", "50% off", "é ü 世界", "%", "%%25"]) {
      expect(blockNameFromFile(blockFileName(name))).toBe(name);
    }
  });
});

describe("spellings", () => {
  it("decodes repeatedly to find the spelling key and counts the decodes", () => {
    expect(fullyDecodeFileName("pages-Home%2520Page.json")).toEqual({
      name: "pages-Home Page",
      passes: 2,
    });
    expect(fullyDecodeFileName("pages-Home%20Page.json")).toEqual({
      name: "pages-Home Page",
      passes: 1,
    });
    expect(fullyDecodeFileName("Header.json")).toEqual({ name: "Header", passes: 0 });
    expect(fullyDecodeFileName("50% off.json")).toEqual({ name: "50% off", passes: 0 });
  });

  it("gives every spelling of one name the same key", () => {
    expect(spellingKey("pages-Home%20Page")).toBe(spellingKey("pages-Home Page"));
    expect(spellingKey("A%2520B")).toBe("A B");
  });

  it("prefers the file whose entry has a path", () => {
    const a = { file: "pages-Home%2520Page.json", hasPath: false };
    const b = { file: "pages-Home%20Page.json", hasPath: true };
    expect(compareSpellings(b, a)).toBeLessThan(0);
    expect(resolveSpellings([a, b]).get("pages-Home Page")?.winner).toBe(b);
  });

  it("then the one that took more decoding", () => {
    const bot = { file: "pages-Home%2520Page.json", hasPath: true };
    const legacy = { file: "pages-Home%20Page.json", hasPath: true };
    const resolved = resolveSpellings([legacy, bot]);
    expect([...resolved.keys()]).toEqual(["pages-Home%20Page"]);
    const group = resolved.get("pages-Home%20Page")!;
    expect(group.winner).toBe(bot);
    expect(group.shadowed).toEqual([legacy]);
  });

  it("then the lowest file name", () => {
    // Same passes, same path-ness: "A%20B" vs "A%20b"? Those are different names; use a
    // pair that decodes to the same key in the same number of passes.
    const upper = { file: "A%2FB.json", hasPath: false };
    const lower = { file: "A%2fB.json", hasPath: false };
    const group = resolveSpellings([lower, upper]).values().next().value!;
    expect(group.winner).toBe(upper); // "A%2FB.json" < "A%2fB.json"
    expect(group.name).toBe("A/B");
  });

  it("names the entry after the winner, decoded once", () => {
    const groups = resolveSpellings([
      { file: "x%2520y.json", hasPath: false },
      { file: "x%20y.json", hasPath: false },
      { file: "x y.json", hasPath: false },
    ]);
    expect([...groups.keys()]).toEqual(["x%20y"]);
    expect(groups.get("x%20y")!.shadowed.map((c) => c.file)).toEqual(["x%20y.json", "x y.json"]);
  });

  it("keeps distinct names apart", () => {
    const groups = resolveSpellings([
      { file: "b.json", hasPath: false },
      { file: "a.json", hasPath: false },
    ]);
    expect([...groups.keys()]).toEqual(["a", "b"]);
  });
});

describe("file content", () => {
  it("is JSON.stringify(entry, null, 2) plus a newline", () => {
    expect(serializeBlock({ a: 1, b: [true] })).toBe('{\n  "a": 1,\n  "b": [\n    true\n  ]\n}\n');
  });

  it("detects page-like entries", () => {
    expect(entryHasPath({ path: "/" })).toBe(true);
    expect(entryHasPath({ path: "" })).toBe(false);
    expect(entryHasPath({ path: 1 })).toBe(false);
    expect(entryHasPath(null)).toBe(false);
    expect(entryHasPath([])).toBe(false);
  });

  it("recognizes saved-block file names", () => {
    expect(isBlockFileName("a.json")).toBe(true);
    expect(isBlockFileName(".json")).toBe(false);
    expect(isBlockFileName("a.ts")).toBe(false);
    expect(isBlockFileName("a/b.json")).toBe(false);
  });

  it("never treats a dotfile as a saved block", () => {
    expect(isBlockFileName(".env.json")).toBe(false);
    expect(isBlockFileName("..json")).toBe(false);
    expect(isBlockFileName(".DS_Store.json")).toBe(false);
  });
});

describe("names the site editor can't save", () => {
  const reasons = (name: string, existingNames?: string[]) =>
    checkBlockName(name, { existingNames }).map((v) => v.reason);

  it.each([
    ["", "empty"],
    ["a\\b", "invalid-character"],
    ["a\0b", "invalid-character"],
    ["a..b", "dot-dot"],
    ["..", "dot-dot"],
    [".env", "leading-dot"],
    [".", "leading-dot"],
    [".hidden page", "leading-dot"],
    ["__proto__", "reserved"],
    ["CON", "device-name"],
    ["con", "device-name"],
    ["nul.backup", "device-name"],
    ["COM1", "device-name"],
    ["lpt9", "device-name"],
    ["widget.ts", "source-extension"],
    ["Widget.TSX", "source-extension"],
    ["helper.js", "source-extension"],
  ])("%j: %s", (name, reason) => {
    expect(reasons(name)).toContain(reason);
  });

  it("refuses names whose encoded form is over 250 bytes", () => {
    expect(reasons("a".repeat(MAX_ENCODED_NAME_BYTES))).toEqual([]);
    expect(reasons("a".repeat(MAX_ENCODED_NAME_BYTES + 1))).toEqual(["too-long"]);
    // "é" encodes as %C3%A9: 6 bytes.
    expect(reasons("é".repeat(41))).toEqual([]);
    expect(reasons("é".repeat(42))).toEqual(["too-long"]);
  });

  it("refuses a new name that differs from another entry's only in letter case", () => {
    expect(reasons("header", ["Header"])).toEqual(["case-collision"]);
    expect(reasons("Header", ["Header"])).toEqual([]); // an update, not a new name
    expect(reasons("Footer", ["Header"])).toEqual([]);
  });

  it("accepts ordinary names", () => {
    for (const name of [
      "Header",
      "pages-Home Page-6f1e",
      "collections/blog/posts/abc",
      "COM",
      "CONsole",
      "a.json",
      "a.b",
      "end.",
    ]) {
      expect(reasons(name)).toEqual([]);
    }
  });

  it("reports every rule a name breaks", () => {
    expect(reasons("x..y\\z.ts")).toEqual(["invalid-character", "dot-dot", "source-extension"]);
  });

  it("lets anything non-empty be deleted, source extensions included", () => {
    expect(checkDeletedName("widget.ts")).toEqual([]);
    expect(checkDeletedName("CON")).toEqual([]);
    expect(checkDeletedName("").map((v) => v.reason)).toEqual(["empty"]);
  });
});
