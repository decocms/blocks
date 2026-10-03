// @vitest-environment node
import { describe, expect, it } from "vitest";
import { canonicalName, compareSpellings, fileToName, invalidNameReason, nameToFile } from "./keys";

describe("the file-name rule", () => {
  it("encodes a name with encodeURIComponent, flat in .deco/blocks", () => {
    expect(nameToFile("HomePage")).toBe("HomePage.json");
    expect(nameToFile("pages-Home%20Page-6f1e")).toBe("pages-Home%2520Page-6f1e.json");
    expect(nameToFile("collections/blog/posts/abc")).toBe("collections%2Fblog%2Fposts%2Fabc.json");
  });

  it("decodes a file name exactly once", () => {
    expect(fileToName("pages-Home%2520Page-6f1e.json")).toBe("pages-Home%20Page-6f1e");
    expect(fileToName("collections%2Fblog%2Fposts%2Fabc.json")).toBe("collections/blog/posts/abc");
  });

  it("keeps the raw name when decoding fails", () => {
    expect(fileToName("100%.json")).toBe("100%");
  });

  it("round-trips any name", () => {
    for (const name of ["a b", "x%20y", "ação", "a/b/c", "100%"]) {
      expect(fileToName(nameToFile(name))).toBe(name);
    }
  });

  it("groups spellings by repeated decoding", () => {
    expect(canonicalName("a%2520b.json")).toEqual({ name: "a b", passes: 2 });
    expect(canonicalName("a%20b.json")).toEqual({ name: "a b", passes: 1 });
  });

  it("picks the spelling with a path, then more decoding, then the lowest file name", () => {
    const withPath = { file: "a%20b.json", entry: { path: "/x" } };
    const moreDecoding = { file: "a%2520b.json", entry: {} };
    expect([moreDecoding, withPath].sort(compareSpellings)[0]).toBe(withPath);
    const lower = { file: "a%20b.json", entry: {} };
    expect([lower, moreDecoding].sort(compareSpellings)[0]).toBe(moreDecoding);
    const x = { file: "b.json", entry: {} };
    const y = { file: "a.json", entry: {} };
    expect([x, y].sort(compareSpellings)[0]).toBe(y);
  });
});

describe("names the site editor can't save", () => {
  it.each([
    ["", "empty name"],
    ["a\\b", 'name contains "\\"'],
    ["a/../b", 'name contains ".."'],
    ["a\0b", "name contains NUL"],
    ["__proto__", 'name is "__proto__"'],
    ["CON", "name is a Windows device name"],
    ["lpt1.txt", "name is a Windows device name"],
    ["hero.tsx", "name ends in a source extension"],
    ["x".repeat(251), "encoded name is over 250 bytes"],
  ])("rejects %j", (name, reason) => {
    expect(invalidNameReason(name)).toBe(reason);
  });

  it("rejects a new name that differs from another only in letter case", () => {
    expect(invalidNameReason("homepage", ["HomePage"])).toBe(
      'name differs from "HomePage" only in letter case',
    );
    expect(invalidNameReason("HomePage", ["HomePage", "homepage"])).toBeNull();
  });

  it("accepts ordinary names, slashes included", () => {
    expect(invalidNameReason("SummerCard")).toBeNull();
    expect(invalidNameReason("collections/blog/posts/abc")).toBeNull();
  });
});
