// @vitest-environment node
/**
 * The package loaded twice (two bundles, a dev reload): each copy has its own
 * module state, yet createCMS returns one instance with one content cache.
 * This is the module-duplication bug the package split exists to prevent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { docsBlocks, docsSnapshot } from "./testFixtures";

type CMSModule = typeof import("./index");

async function freshCopy(): Promise<CMSModule> {
  vi.resetModules();
  return import("./index");
}

afterEach(async () => {
  (await import("./index")).resetForTests();
});

describe("two copies of the module", () => {
  it("are really two copies", async () => {
    const a = await freshCopy();
    const b = await freshCopy();
    expect(a.createCMS).not.toBe(b.createCMS);
  });

  it("share one CMS instance for the same content module", async () => {
    const a = await freshCopy();
    const b = await freshCopy();
    const content = docsSnapshot();
    const fromA = a.createCMS({ blocks: docsBlocks(), content });
    const fromB = b.createCMS({ blocks: docsBlocks(), content });
    expect(fromB).toBe(fromA);
  });

  it("share one instance and one content cache for the same loader", async () => {
    const a = await freshCopy();
    const b = await freshCopy();
    const load = vi.fn(async () => docsSnapshot());
    const loader = { load, update: async () => ({ updated: false }) };
    const cmsA = a.createCMS({ blocks: docsBlocks(), content: loader });
    const cmsB = b.createCMS({ blocks: docsBlocks(), content: loader });
    expect(cmsB).toBe(cmsA);
    await cmsA.forRelease().resolve("SummerSEO");
    await cmsB.forRelease().resolve("SummerSEO");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("resetForTests from either copy clears instances created by the other", async () => {
    const a = await freshCopy();
    const b = await freshCopy();
    const content = docsSnapshot();
    const first = a.createCMS({ blocks: {}, content });
    b.resetForTests();
    expect(a.createCMS({ blocks: {}, content })).not.toBe(first);
  });

  it("a resolution error from either copy has the documented shape", async () => {
    const a = await freshCopy();
    const b = await freshCopy();
    const content = docsSnapshot();
    a.createCMS({ blocks: {}, content });
    const [, error] = await b.createCMS({ blocks: {}, content }).forRelease().resolve("Nope");
    expect(error).toMatchObject({ code: "NOT_FOUND", path: [] });
  });
});
