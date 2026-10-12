// @vitest-environment node
/** Forced variants applied to a snapshot (releases-and-drafts#preview-a-variant). */
import { describe, expect, it } from "vitest";
import type { Snapshot } from "./types";
import { forceVariants } from "./variants";

const rule = (type: string) => ({ __resolveType: type });

function snapshot(): Snapshot {
  return {
    revision: "r",
    aliases: { "site/flags/Variants.ts": "multivariate" },
    blocks: {
      Home: {
        __resolveType: "page",
        sections: [
          { __resolveType: "hero" },
          {
            __resolveType: "multivariate",
            variants: [
              { rule: rule("always"), value: { __resolveType: "lazy", value: "a" } },
              { rule: rule("never"), value: { __resolveType: "lazy", value: "b" } },
            ],
          },
        ],
      },
      Legacy: {
        __resolveType: "website/flags/multivariate.ts",
        variants: [
          { rule: rule("always"), value: ["x"] },
          { rule: rule("never"), value: ["y"] },
        ],
      },
      Aliased: {
        __resolveType: "site/flags/Variants.ts",
        variants: [
          { rule: rule("always"), value: 1 },
          { rule: rule("never"), value: 2 },
        ],
      },
      NotAFlag: { __resolveType: "carousel", variants: [{ rule: rule("never"), value: 1 }] },
    },
  };
}

describe("forceVariants", () => {
  it("keeps only the forced variant, ruled true, and copies only along the path", () => {
    const before = snapshot();
    const after = forceVariants(before, [{ block: "Home", path: "sections.1", index: 1 }]);
    const home = after.blocks.Home as { sections: unknown[] };
    expect(home.sections[1]).toEqual({
      __resolveType: "multivariate",
      variants: [{ rule: true, value: { __resolveType: "lazy", value: "b" } }],
    });
    expect(home.sections[0]).toBe((before.blocks.Home as { sections: unknown[] }).sections[0]);
    expect(after.blocks.Legacy).toBe(before.blocks.Legacy);
    expect(before).toEqual(snapshot());
    expect(after.revision).toBe("r");
  });

  it("addresses the saved block itself with an empty path, under a legacy or snapshot alias", () => {
    const after = forceVariants(snapshot(), [
      { block: "Legacy", path: "", index: 1 },
      { block: "Aliased", path: "", index: 0 },
    ]);
    expect(after.blocks.Legacy).toEqual({
      __resolveType: "website/flags/multivariate.ts",
      variants: [{ rule: true, value: ["y"] }],
    });
    expect((after.blocks.Aliased as { variants: unknown[] }).variants).toEqual([
      { rule: true, value: 1 },
    ]);
  });

  it("ignores an address that reaches no multivariate with that variant", () => {
    const before = snapshot();
    for (const variant of [
      { block: "Missing", path: "", index: 0 },
      { block: "Home", path: "sections.9", index: 0 },
      { block: "Home", path: "sections.01", index: 0 },
      { block: "Home", path: "sections.0", index: 0 },
      { block: "Home", path: "sections.1", index: 5 },
      { block: "NotAFlag", path: "", index: 0 },
    ]) {
      expect(forceVariants(before, [variant])).toBe(before);
    }
    expect(forceVariants(before, undefined)).toBe(before);
  });
});
