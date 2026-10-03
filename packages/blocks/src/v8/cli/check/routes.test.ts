// @vitest-environment node
import { describe, expect, it } from "vitest";
import { findConflicts, normalizePath } from "./routes";

describe("normalizing paths like matchRoute", () => {
  it.each([
    ["/summer/", "/summer"],
    ["/", "/"],
    ["", "/"],
    ["summer", "/summer"],
    ["/a%20b?x=1#top", "/a b"],
  ])("%j → %j", (input, output) => {
    expect(normalizePath(input)).toBe(output);
  });
});

describe("route conflicts", () => {
  it("keeps the first entry at a leaf and reports the later ones", () => {
    expect(
      findConflicts([
        { name: "A", path: "/x" },
        { name: "B", path: "/x/" },
        { name: "C", path: "/x" },
      ]).map((c) => [c.name, c.other]),
    ).toEqual([
      ["B", "A"],
      ["C", "A"],
    ]);
  });

  it("treats templates of the same shape as one leaf, whatever the parameter names", () => {
    expect(
      findConflicts([
        { name: "A", path: "/:slug/p" },
        { name: "B", path: "/:id/p" },
      ]),
    ).toHaveLength(1);
    expect(
      findConflicts([
        { name: "A", path: "/:slug/p" },
        { name: "B", path: "/:slug/q" },
      ]),
    ).toEqual([]);
  });

  it("lets an exact path and a template coexist (exact wins per segment)", () => {
    expect(
      findConflicts([
        { name: "A", path: "/blog/:slug" },
        { name: "B", path: "/blog/archive" },
      ]),
    ).toEqual([]);
  });

  it("treats two splats at the same place as a conflict", () => {
    expect(
      findConflicts([
        { name: "A", path: "/c/*" },
        { name: "B", path: "/c/*rest" },
      ]),
    ).toHaveLength(1);
  });
});
