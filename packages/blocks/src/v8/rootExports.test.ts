// @vitest-environment node
/**
 * The package root serves the v8 API per the docs (`import { createCMS } from
 * "@decocms/blocks"`), and nothing else.
 */
import { describe, expect, it } from "vitest";
import * as root from "../index";
import * as v8 from "./index";

describe("@decocms/blocks root", () => {
  it("exports the documented v8 runtime API", () => {
    expect(root.createCMS).toBe(v8.createCMS);
    expect(root.resetForTests).toBe(v8.resetForTests);
    expect(root.matchRoute).toBe(v8.matchRoute);
    expect(root.remoteLoader).toBe(v8.remoteLoader);
    expect(root.draftPointer).toBe(v8.draftPointer);
    expect(root.draftCookie).toBe(v8.draftCookie);
    expect(root.DRAFT_COOKIE).toBe(v8.DRAFT_COOKIE);
    expect(root.parseDraftPointer).toBe(v8.parseDraftPointer);
    expect(root.formatDraftPointer).toBe(v8.formatDraftPointer);
  });

  it("exports nothing outside the v8 API", () => {
    const extra = Object.keys(root).filter((name) => !(name in v8));
    expect(extra).toEqual([]);
  });

  it("the documented quickstart compiles and runs from the root", async () => {
    const blocks = { seo: (p: { title: string }) => p } satisfies root.Blocks;
    const content: root.Snapshot = {
      revision: "r",
      blocks: { S: { __resolveType: "seo", title: "x" } },
    };
    root.resetForTests();
    const cms = root.createCMS({ blocks, content });
    const result: root.Result<{ title: string }> = await cms.forRelease().resolve("S");
    expect(result).toEqual([{ title: "x" }, null]);
    root.resetForTests();
  });
});
