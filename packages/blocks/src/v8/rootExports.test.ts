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
    expect(root.parseDraftPointer).toBe(v8.parseDraftPointer);
    expect(root.formatDraftPointer).toBe(v8.formatDraftPointer);
  });

  it("has no free draft helpers: draftPointer and draftCookie are CMS methods that check the host", () => {
    const names = Object.keys(root);
    for (const name of ["draftPointer", "draftCookie", "readDraftPointer", "draftCookieFor"]) {
      expect(names).not.toContain(name);
    }
  });

  it("exports the draft names and Studio's origins the bindings share", () => {
    expect(root.DRAFT_PARAM).toBe("__draft");
    expect(root.DRAFT_COOKIE).toBe("__deco_draft");
    expect(root.DRAFT_HEADER).toBe("x-deco-draft");
    expect(root.draftResponseHeaders).toBe(v8.draftResponseHeaders);
    expect(root.STUDIO_ORIGINS).toBe(v8.STUDIO_ORIGINS);
    expect(root.STUDIO_FRAME_ANCESTORS).toBe(v8.STUDIO_FRAME_ANCESTORS);
    expect(root.isStudioOrigin).toBe(v8.isStudioOrigin);
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
