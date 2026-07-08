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
  ])("excludes %s", (name) => {
    expect(isExcludedCodegenFile(name)).toBe(true);
  });

  it.each(["Hero.tsx", "Product/SearchResult.tsx", "testimonials.tsx", "generic.ts"])(
    "keeps %s",
    (name) => {
      expect(isExcludedCodegenFile(name)).toBe(false);
    },
  );
});
