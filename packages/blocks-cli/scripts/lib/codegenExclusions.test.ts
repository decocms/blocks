import { describe, expect, it } from "vitest";
import { isExcludedCodegenFile } from "./codegenExclusions";

describe("isExcludedCodegenFile", () => {
  it.each([
    "Hero.test.tsx",
    "Hero.test.ts",
    "Hero.spec.tsx",
    "Hero.stories.tsx",
    "sections.gen.ts",
    "meta.gen.json",
    // Bare names (no prefix before the dot) must be excluded too.
    "test.ts",
    "test.tsx",
    "spec.tsx",
    "stories.ts",
    "gen.ts",
  ])("excludes %s", (name) => {
    expect(isExcludedCodegenFile(name)).toBe(true);
  });

  it.each([
    "Hero.tsx",
    "Product/SearchResult.tsx",
    // Marker word embedded mid-identifier (not its own dot-delimited
    // segment) must stay INCLUDED, even with the bare-name matching above.
    "testimonials.tsx",
    "generic.ts",
  ])("keeps %s", (name) => {
    expect(isExcludedCodegenFile(name)).toBe(false);
  });
});
