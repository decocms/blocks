// @vitest-environment node
//
// createSiteSetup (via @decocms/blocks/setup) only calls setBlocks() when
// `typeof document === "undefined"` — it's the server-only half of the
// Vite dual-environment split. Next.js Route Handlers run server-side with
// no DOM, which is exactly what createNextSetup targets, so this suite runs
// under vitest's "node" environment rather than the package default
// (jsdom, used by the component-rendering tests in this same package) to
// match that real invocation context.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRegisteredSections, loadBlocks, setBlocks } from "@decocms/blocks/cms";
import { createNextSetup } from "./setup";

describe("createNextSetup", () => {
  beforeEach(() => {
    setBlocks({});
  });

  it("returns a memoized ensureSetup that registers blocks, sections, meta", async () => {
    const meta = vi.fn().mockResolvedValue({
      major: 1,
      version: "test",
      namespace: "site",
      site: "test",
      manifest: { blocks: { sections: {} } },
      schema: { definitions: {}, root: {} },
      platform: "test",
      cloudProvider: "test",
    });
    const ensureSetup = createNextSetup({
      blocksDir: false,
      blocks: { myBlock: { __resolveType: "site/sections/Hero.tsx" } },
      sections: { "./sections/Hero.tsx": async () => ({ default: () => null }) },
      meta,
    });

    await ensureSetup();
    await ensureSetup(); // memoized — meta loader must run once

    expect(meta).toHaveBeenCalledTimes(1);
    expect(loadBlocks().myBlock).toBeDefined();
    expect(listRegisteredSections()).toContain("site/sections/Hero.tsx");
  });

  it("applies section conventions when provided", async () => {
    const ensureSetup = createNextSetup({
      blocksDir: false,
      sections: { "./sections/Footer.tsx": async () => ({ default: () => null }) },
      conventions: { meta: { "site/sections/Footer.tsx": { layout: true } } },
    });
    await ensureSetup();
    const { isLayoutSection } = await import("@decocms/blocks/cms");
    expect(isLayoutSection("site/sections/Footer.tsx")).toBe(true);
  });
});
