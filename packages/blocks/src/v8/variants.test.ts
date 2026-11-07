// @vitest-environment node
/** Forced variants applied to a body a preview reads (releases-and-drafts#preview-a-variant). */
import { describe, expect, it } from "vitest";
import { forceBody } from "./variants";

const rule = (type: string) => ({ __resolveType: type });
const aliases = { "site/flags/Variants.ts": "multivariate" };

function bodies() {
  return {
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
  };
}

describe("forceBody", () => {
  it("keeps only the forced variant, ruled true, and copies only along the path", () => {
    const before = bodies();
    const after = forceBody(
      "Home",
      before.Home,
      [{ block: "Home", path: "sections.1", index: 1 }],
      aliases,
    ) as { sections: unknown[] };
    expect(after.sections[1]).toEqual({
      __resolveType: "multivariate",
      variants: [{ rule: true, value: { __resolveType: "lazy", value: "b" } }],
    });
    expect(after.sections[0]).toBe(before.Home.sections[0]);
    expect(before).toEqual(bodies());
  });

  it("applies only the variants addressed to that block", () => {
    const before = bodies();
    const variants = [
      { block: "Legacy", path: "", index: 1 },
      { block: "Home", path: "sections.1", index: 1 },
    ];
    expect(forceBody("Aliased", before.Aliased, variants, aliases)).toBe(before.Aliased);
    expect(forceBody("Legacy", before.Legacy, variants, aliases)).toEqual({
      __resolveType: "website/flags/multivariate.ts",
      variants: [{ rule: true, value: ["y"] }],
    });
  });

  it("addresses the saved block itself with an empty path, under a legacy or content alias", () => {
    const before = bodies();
    expect(
      forceBody("Legacy", before.Legacy, [{ block: "Legacy", path: "", index: 1 }], undefined),
    ).toEqual({
      __resolveType: "website/flags/multivariate.ts",
      variants: [{ rule: true, value: ["y"] }],
    });
    const aliased = forceBody(
      "Aliased",
      before.Aliased,
      [{ block: "Aliased", path: "", index: 0 }],
      aliases,
    ) as { variants: unknown[] };
    expect(aliased.variants).toEqual([{ rule: true, value: 1 }]);
    // Without the content's alias table, the site's own flag type is no multivariate.
    expect(
      forceBody("Aliased", before.Aliased, [{ block: "Aliased", path: "", index: 0 }], undefined),
    ).toBe(before.Aliased);
  });

  it("ignores an address that reaches no multivariate with that variant", () => {
    const before = bodies();
    for (const variant of [
      { block: "Home", path: "sections.9", index: 0 },
      { block: "Home", path: "sections.01", index: 0 },
      { block: "Home", path: "sections.0", index: 0 },
      { block: "Home", path: "sections.1", index: 5 },
    ]) {
      expect(forceBody("Home", before.Home, [variant], aliases)).toBe(before.Home);
    }
    expect(
      forceBody("NotAFlag", before.NotAFlag, [{ block: "NotAFlag", path: "", index: 0 }], aliases),
    ).toBe(before.NotAFlag);
    expect(forceBody("Home", before.Home, [], aliases)).toBe(before.Home);
  });
});
