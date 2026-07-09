// @vitest-environment node
//
// createSiteSetup (via @decocms/blocks/setup) only calls setBlocks() when
// `typeof document === "undefined"` — it's the server-only half of the
// Vite dual-environment split. Next.js Route Handlers run server-side with
// no DOM, which is exactly what createNextSetup targets, so this suite runs
// under vitest's "node" environment rather than the package default
// (jsdom, used by the component-rendering tests in this same package) to
// match that real invocation context.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cms from "@decocms/blocks/cms";
import { listRegisteredSections, loadBlocks, setBlocks } from "@decocms/blocks/cms";
import { getProductionOrigins } from "@decocms/blocks/sdk/normalizeUrls";

// Mirrors routeHandlers.test.ts in this same package: @decocms/blocks-admin
// is mocked (rather than exercised for real) because it's a heavier graph
// than the CMS core — see this file's `@example` JSDoc note in setup.ts.
// The mock applies to every test in this file; existing tests that pass
// `meta` don't assert on setMetaData's *internal* effects (only that the
// `meta` loader itself was invoked), so swapping the real setter for a
// stub doesn't change what they verify.
const adminMocks = vi.hoisted(() => ({
  setMetaData: vi.fn(),
  setRenderShell: vi.fn(),
  setPreviewWrapper: vi.fn(),
}));
vi.mock("@decocms/blocks-admin", () => adminMocks);

import { createNextSetup } from "./setup";

describe("createNextSetup", () => {
  beforeEach(() => {
    setBlocks({});
    vi.clearAllMocks();
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

  it("clears the memo on a rejected bootstrap so the next call retries", async () => {
    const meta = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient fetch failure"))
      .mockResolvedValueOnce({
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
      sections: { "./sections/Hero.tsx": async () => ({ default: () => null }) },
      meta,
    });

    await expect(ensureSetup()).rejects.toThrow("transient fetch failure");
    await expect(ensureSetup()).resolves.toBeUndefined();
    expect(meta).toHaveBeenCalledTimes(2);
  });

  describe("blocksDir", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "next-setup-blocksdir-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("loads a real string blocksDir path (tmp dir with one JSON decofile)", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "myBlock.json"),
        JSON.stringify({ __resolveType: "site/sections/Hero.tsx" }),
      );

      const ensureSetup = createNextSetup({
        blocksDir: tmpDir,
        sections: { "./sections/Hero.tsx": async () => ({ default: () => null }) },
      });
      await ensureSetup();

      expect(loadBlocks().myBlock).toEqual({
        __resolveType: "site/sections/Hero.tsx",
      });
    });

    it("options.blocks wins over blocksDir on an overlapping key (merge precedence)", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "shared.json"),
        JSON.stringify({ source: "dir" }),
      );

      const ensureSetup = createNextSetup({
        blocksDir: tmpDir,
        blocks: { shared: { source: "override" } },
        sections: {},
      });
      await ensureSetup();

      expect(loadBlocks().shared).toEqual({ source: "override" });
    });
  });

  it("reaches blocks-admin's setRenderShell, setPreviewWrapper, and setMetaData with the given args", async () => {
    const meta = vi.fn().mockResolvedValue({ schema: { definitions: {}, root: {} } });
    const renderShell = { css: "https://cdn.example.com/admin.css", fonts: ["Inter"] };
    const PreviewWrapper = () => null;

    const ensureSetup = createNextSetup({
      blocksDir: false,
      sections: {},
      meta,
      renderShell,
      previewWrapper: PreviewWrapper,
    });
    await ensureSetup();

    expect(adminMocks.setMetaData).toHaveBeenCalledWith(
      await meta.mock.results[0]!.value,
    );
    expect(adminMocks.setRenderShell).toHaveBeenCalledWith(renderShell);
    expect(adminMocks.setPreviewWrapper).toHaveBeenCalledWith(PreviewWrapper);
  });

  it("does not touch blocks-admin's setters when meta/renderShell/previewWrapper are all omitted", async () => {
    const ensureSetup = createNextSetup({
      blocksDir: false,
      sections: {},
    });
    await ensureSetup();

    expect(adminMocks.setMetaData).not.toHaveBeenCalled();
    expect(adminMocks.setRenderShell).not.toHaveBeenCalled();
    expect(adminMocks.setPreviewWrapper).not.toHaveBeenCalled();
  });

  it("passes productionOrigins, customMatchers, onResolveError, and onDanglingReference through to createSiteSetup", async () => {
    const matcher = vi.fn();
    const onResolveError = vi.fn();
    const onDanglingReference = vi.fn();

    // onResolveError / onDanglingReference are installed via module-scope
    // setters (setResolveErrorHandler / setDanglingReferenceHandler) with no
    // public getter to read the currently-installed handler back — spy on
    // the real setters on the @decocms/blocks/cms module namespace.
    // createSiteSetup (called by createNextSetup) imports these same two
    // names from the identical resolved module ("./cms/index" internally,
    // "@decocms/blocks/cms" here — same file per package.json's export
    // map), and Vitest's SSR module transform makes named exports mutable
    // properties on a shared namespace object, so spying here intercepts
    // the call made from inside createSiteSetup too.
    const resolveErrorSpy = vi.spyOn(cms, "setResolveErrorHandler");
    const danglingRefSpy = vi.spyOn(cms, "setDanglingReferenceHandler");

    const ensureSetup = createNextSetup({
      blocksDir: false,
      sections: {},
      productionOrigins: ["https://www.example.com"],
      customMatchers: [matcher],
      onResolveError,
      onDanglingReference,
    });
    await ensureSetup();

    // Cheapest direct observation, per the option's own doc comment: each
    // customMatchers thunk is called exactly once during setup.
    expect(matcher).toHaveBeenCalledTimes(1);
    // productionOrigins has a real, cheap getter — assert the registered
    // value directly rather than only inferring it went through.
    expect(getProductionOrigins()).toEqual(["https://www.example.com"]);
    expect(resolveErrorSpy).toHaveBeenCalledWith(onResolveError);
    expect(danglingRefSpy).toHaveBeenCalledWith(onDanglingReference);

    resolveErrorSpy.mockRestore();
    danglingRefSpy.mockRestore();
  });

  it("calls extend with the merged, loaded blocks", async () => {
    const extend = vi.fn();
    const ensureSetup = createNextSetup({
      blocksDir: false,
      blocks: { myBlock: { __resolveType: "site/sections/Hero.tsx" } },
      sections: { "./sections/Hero.tsx": async () => ({ default: () => null }) },
      extend,
    });
    await ensureSetup();

    expect(extend).toHaveBeenCalledTimes(1);
    expect(extend).toHaveBeenCalledWith(
      expect.objectContaining({
        myBlock: { __resolveType: "site/sections/Hero.tsx" },
      }),
    );
  });
});
