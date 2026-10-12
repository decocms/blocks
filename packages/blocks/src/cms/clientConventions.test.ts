import { afterEach, describe, expect, it } from "vitest";
import { applyClientSectionConventions, registerSiteSections } from "./clientConventions";
import { getSection, getSectionOptions, getSyncComponent } from "./registry";

const registry = (globalThis as any).__deco;

describe("client section conventions", () => {
  afterEach(() => {
    for (const k of Object.keys(registry.sectionRegistry)) delete registry.sectionRegistry[k];
    for (const k of Object.keys(registry.sectionOptions)) delete registry.sectionOptions[k];
    for (const k of Object.keys(registry.syncComponents)) delete registry.syncComponents[k];
  });

  it("keys the glob as site/sections/... (same transform createSiteSetup applies)", () => {
    const loader = async () => ({ default: () => null });
    registerSiteSections({ "./sections/Hero/Hero.tsx": loader });
    expect(getSection("site/sections/Hero/Hero.tsx")).toBe(loader);
  });

  it("registers clientOnly, loading fallbacks and sync components without the resolver", () => {
    const glob = {
      "./sections/A.tsx": async () => ({ default: () => null }),
      "./sections/B.tsx": async () => ({ default: () => null }),
    };
    const Fallback = () => null;
    const Sync = () => null;
    applyClientSectionConventions({
      meta: {
        "site/sections/A.tsx": { clientOnly: true },
        "site/sections/B.tsx": { hasLoadingFallback: true },
      },
      loadingFallbacks: { "site/sections/B.tsx": Fallback },
      syncComponents: { "site/sections/A.tsx": Sync },
      sectionGlob: glob,
    });
    expect(getSectionOptions("site/sections/A.tsx")?.clientOnly).toBe(true);
    expect(getSectionOptions("site/sections/B.tsx")?.loadingFallback).toBe(Fallback);
    expect(getSyncComponent("site/sections/A.tsx")).toBe(Sync);
  });
});
