// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SavedBlocks } from "../content";
import { decoPaths } from "../root";
import { type DecoMeta, generateSchema } from "../schema/generate";
import { writeSchema } from "../schema/index";
import { createFixture, type Fixture, recorder, STORE_FILES, sealSecret } from "../__tests__/fixture";
import { check, checkContent, formatProblems, type Problem, secretViolations } from "./index";

let store: Fixture;
let meta: DecoMeta;

beforeAll(async () => {
  store = createFixture(STORE_FILES);
  ({ meta } = await generateSchema(decoPaths(store.root)));
}, 60_000);
afterAll(() => store?.remove());

function saved(blocks: Record<string, Record<string, unknown>>): SavedBlocks {
  return {
    blocks,
    files: Object.fromEntries(
      Object.keys(blocks).map((name) => [name, `${encodeURIComponent(name)}.json`]),
    ),
    diagnostics: [],
  };
}

const run = (blocks: Record<string, Record<string, unknown>>) => checkContent(meta, saved(blocks));
const lines = (problems: Problem[]) =>
  problems.map(
    (p) =>
      `${p.file.replace(".deco/blocks/", "")} ${p.severity === "warning" ? "warning " : ""}${p.path ? `${p.path}: ` : ""}${p.message}`,
  );

const hero = { __resolveType: "hero", title: "Summer", size: "md" };
const page = (sections: unknown[], extra: Record<string, unknown> = {}) => ({
  __resolveType: "page",
  name: "Home",
  path: "/",
  sections,
  ...extra,
});

describe("props match the block type's schema", () => {
  it("passes content that fits", () => {
    expect(run({ HomePage: page([hero]) })).toEqual([]);
  });

  it("reports required fields, enums and limits with plain wording", () => {
    const problems = run({
      HomePage: page([
        { __resolveType: "hero", size: "xl", count: 11 },
        { __resolveType: "hero", title: "x".repeat(214), size: "sm" },
      ]),
    });
    expect(lines(problems)).toEqual([
      "HomePage.json sections[0].title: required",
      'HomePage.json sections[0].size: "xl" isn\'t one of "sm", "md", "lg"',
      "HomePage.json sections[0].count: 11, max 10",
      "HomePage.json sections[1].title: 214 characters, max 60",
    ]);
  });

  it("reports fields the code doesn't declare (a renamed prop)", () => {
    expect(lines(run({ HomePage: page([{ ...hero, headline: "old name" }]) }))).toEqual([
      "HomePage.json sections[0].headline: unknown field",
    ]);
  });

  it("reports type mismatches", () => {
    expect(lines(run({ Card: { __resolveType: "catalog-product", slug: 42 } }))).toEqual([
      "Card.json slug: expected a string, got a number",
    ]);
  });

  it("accepts null for an optional field and a plain value for a field blocks can fill", () => {
    expect(
      run({
        Card: { __resolveType: "product-card", title: "t", product: { name: "Shirt", price: 10 } },
        Hero: { ...hero, image: null },
      }),
    ).toEqual([]);
  });

  it("explains a plain value that doesn't fit the field's plain form", () => {
    expect(
      lines(
        run({ Card: { __resolveType: "product-card", title: "t", product: { name: "Shirt" } } }),
      ),
    ).toEqual(["Card.json product.price: required"]);
  });
});

describe("__resolveType", () => {
  it("reports an unknown block type once, at the top or nested", () => {
    expect(
      lines(
        run({
          Promo: { __resolveType: "promo-banner" },
          HomePage: page([{ __resolveType: "nope" }]),
        }),
      ),
    ).toEqual([
      'HomePage.json sections[0]: unknown block type "nope"',
      'Promo.json unknown block type "promo-banner"',
    ]);
  });

  it("accepts built-ins, aliases and saved blocks", () => {
    expect(
      run({
        Legacy: {
          __resolveType: "website/pages/Page.tsx",
          name: "Old",
          path: "/old",
          sections: [],
        },
        Summer: hero,
        HomePage: page([{ __resolveType: "Summer" }]),
      }),
    ).toEqual([]);
  });

  it("reports a missing __resolveType on a saved block", () => {
    expect(lines(run({ Bare: { title: "x" } }))).toEqual([
      "Bare.json missing __resolveType: a saved block names the function it calls",
    ]);
  });

  it("reports a reference cycle", () => {
    expect(
      lines(
        run({
          A: { __resolveType: "B" },
          B: { __resolveType: "A" },
          P: page([{ __resolveType: "A" }]),
        }),
      ),
    ).toContain("P.json sections[0]: references form a cycle: A → B → A");
  });
});

describe("typed references", () => {
  it("accepts a block whose function returns the field's type", () => {
    expect(
      run({
        Card: {
          __resolveType: "product-card",
          title: "t",
          product: { __resolveType: "catalog-product", slug: "shirt" },
          related: { __resolveType: "product-list", count: 3 },
        },
      }),
    ).toEqual([]);
  });

  it("rejects a block that returns something else", () => {
    expect(
      lines(
        run({
          Card: {
            __resolveType: "product-card",
            title: "t",
            product: { __resolveType: "product-list", count: 3 },
          },
        }),
      ),
    ).toEqual([
      "Card.json product: \"product-list\" doesn't fit here: its function doesn't return this field's type",
    ]);
  });

  it("rejects a block in a plain field, and a non-JSX block in sections", () => {
    expect(
      lines(
        run({
          Footer: {
            __resolveType: "footer",
            menu: { items: [] },
            enabled: { __resolveType: "weekday", days: [] },
            label: "x",
          },
          HomePage: page([{ __resolveType: "weekday", days: ["Sat"] }]),
        }),
      ),
    ).toEqual([
      'Footer.json enabled: "weekday" doesn\'t fit here: this field takes a plain value',
      "HomePage.json sections[0]: \"weekday\" doesn't fit here: its function doesn't return this field's type",
    ]);
  });

  it("checks a saved block reference by the type it resolves to", () => {
    expect(
      lines(
        run({
          MyProduct: { __resolveType: "catalog-product", slug: "s" },
          MyList: { __resolveType: "product-list", count: 1 },
          Good: {
            __resolveType: "product-card",
            title: "t",
            product: { __resolveType: "MyProduct" },
          },
          Bad: { __resolveType: "product-card", title: "t", product: { __resolveType: "MyList" } },
        }),
      ),
    ).toEqual([
      'Bad.json product: saved block "MyList" (a "product-list") doesn\'t fit here: its function doesn\'t return this field\'s type',
    ]);
  });

  it("checks a reference's overrides against the saved block's type", () => {
    expect(
      lines(run({ Summer: hero, HomePage: page([{ __resolveType: "Summer", size: "huge" }]) })),
    ).toEqual(['HomePage.json sections[0].size: "huge" isn\'t one of "sm", "md", "lg"']);
  });
});

describe("lazy blocks", () => {
  it("accepts a lazy block in a Lazy<T> field and checks its value as a T", () => {
    expect(
      run({
        Hero: {
          ...hero,
          later: { __resolveType: "lazy", value: { __resolveType: "catalog-product", slug: "x" } },
        },
      }),
    ).toEqual([]);
    expect(
      lines(run({ Hero: { ...hero, later: { __resolveType: "lazy", value: { name: "x" } } } })),
    ).toEqual(["Hero.json later.value.price: required"]);
  });

  it("rejects anything else in a Lazy<T> field", () => {
    expect(lines(run({ Hero: { ...hero, later: { name: "x", price: 1 } } }))).toEqual([
      "Hero.json later: this field is Lazy<T>: wrap the value in a lazy block",
    ]);
    expect(
      lines(run({ Hero: { ...hero, later: { __resolveType: "catalog-product", slug: "x" } } })),
    ).toEqual(["Hero.json later: this field is Lazy<T>: wrap the value in a lazy block"]);
  });

  it("rejects a lazy block outside a Lazy<T> field", () => {
    expect(
      lines(
        run({
          Card: {
            __resolveType: "product-card",
            title: "t",
            product: { __resolveType: "lazy", value: {} },
          },
        }),
      ),
    ).toEqual(["Card.json product: a lazy block only fits a Lazy<T> field"]);
  });
});

describe("variants", () => {
  const variant = (rule: unknown, value: unknown) => ({ rule, value });
  const lazy = (value: unknown) => ({ __resolveType: "lazy", value });

  it("checks each variant's value against the field it varies", () => {
    const title = {
      __resolveType: "multivariate",
      variants: [
        variant({ __resolveType: "weekday", days: ["Sat"] }, lazy("Weekend")),
        variant({ __resolveType: "always" }, lazy(42)),
      ],
    };
    expect(lines(run({ Hero: { ...hero, title } }))).toEqual([
      "Hero.json title.variants[1].value.value: expected a string, got a number",
    ]);
  });

  it("requires the lazy wrapper under multivariate, but not under a legacy name", () => {
    expect(
      lines(
        run({
          Hero: {
            ...hero,
            title: {
              __resolveType: "multivariate",
              variants: [variant({ __resolveType: "always" }, "plain")],
            },
          },
        }),
      ),
    ).toEqual(["Hero.json title.variants[0].value: a variant's value must be a lazy block"]);
    expect(
      run({
        Hero: {
          ...hero,
          title: {
            __resolveType: "website/flags/multivariate.ts",
            variants: [variant({ __resolveType: "website/matchers/always.ts" }, "plain")],
          },
        },
      }),
    ).toEqual([]);
  });

  it("varies a whole sections list", () => {
    const sections = {
      __resolveType: "multivariate",
      variants: [variant({ __resolveType: "always" }, lazy([hero]))],
    };
    expect(run({ HomePage: page([], { sections }) })).toEqual([]);
  });

  it("requires a matcher as each rule", () => {
    expect(
      lines(
        run({
          Hero: {
            ...hero,
            title: {
              __resolveType: "multivariate",
              variants: [
                variant({ __resolveType: "catalog-product", slug: "x" }, lazy("a")),
                variant(true, lazy("b")),
              ],
            },
          },
        }),
      ),
    ).toEqual([
      "Hero.json title.variants[0].rule: \"catalog-product\" doesn't fit here: its function doesn't return this field's type",
      "Hero.json title.variants[1].rule: a rule must be a block whose function returns a boolean",
    ]);
  });

  it("warns, without failing, about a variant after an always rule", () => {
    const title = {
      __resolveType: "multivariate",
      variants: [
        variant({ __resolveType: "always" }, lazy("a")),
        variant({ __resolveType: "never" }, lazy("b")),
      ],
    };
    const problems = run({ Hero: { ...hero, title } });
    expect(lines(problems)).toEqual([
      "Hero.json warning title.variants[1]: can never be picked: variants[0] has an always rule",
    ]);
    expect(problems.every((p) => p.severity === "warning")).toBe(true);
  });
});

describe("names", () => {
  it("rejects a saved block named like a block type, a built-in or an alias", () => {
    expect(
      lines(
        run({
          hero,
          page: page([], { path: "/a" }),
          "website/pages/Page.tsx": page([], { path: "/b" }),
        }),
      ),
    ).toEqual([
      'hero.json saved block "hero" has the name of a block type',
      'page.json saved block "page" has the name of a built-in block',
      'website%2Fpages%2FPage.tsx.json saved block "website/pages/Page.tsx" has the name of an alias',
    ]);
  });
});

describe("routes", () => {
  it("rejects two entries at the same path, and templates of the same shape", () => {
    const post = (path: string) => ({ __resolveType: "post", name: "p", path, body: "b" });
    expect(
      lines(
        run({
          A: page([], { path: "/summer" }),
          B: page([], { path: "/summer/" }),
          C: post("/:slug/p"),
          D: post("/:id/p"),
          E: post("/blog/:slug"),
          F: post("/blog/archive"),
        }),
      ),
    ).toEqual([
      'B.json path: "/summer/" matches the same URLs as "/summer" in "A"',
      'D.json path: "/:id/p" matches the same URLs as "/:slug/p" in "C"',
    ]);
  });

  it("checks redirects as their own group, both shapes", () => {
    expect(
      lines(
        run({
          A: { __resolveType: "redirect", from: "/old", to: "/new", permanent: true },
          B: {
            __resolveType: "website/loaders/redirect.ts",
            redirect: { from: "/old", to: "/x", type: "temporary" },
          },
          C: page([], { path: "/old" }),
        }),
      ),
    ).toEqual(['B.json from: "/old" is also the from of "A"']);
  });
});

describe("secrets", () => {
  it("accepts a well-formed secret block in a Secret field", async () => {
    const { ciphertext } = await sealSecret("re_123");
    expect(run({ Hero: { ...hero, apiKey: { __resolveType: "secret", ciphertext } } })).toEqual([]);
  });

  it("rejects malformed ciphertext and plain text", () => {
    expect(
      lines(
        run({
          A: { ...hero, apiKey: { __resolveType: "secret", ciphertext: "v1.AbX3" } },
          B: { ...hero, apiKey: "sk_live_123" },
          C: { __resolveType: "secret", ciphertext: "nope" },
        }),
      ),
    ).toEqual([
      "A.json apiKey.ciphertext: ciphertext must have four dot-separated parts",
      "B.json apiKey: plain text in a Secret field: save it as a secret block",
      'C.json ciphertext: ciphertext must start with "v1."',
    ]);
  });

  it("exposes the secret guard for the content protocol", () => {
    const violations = secretViolations(
      meta,
      { A: { ...hero, apiKey: "plain" }, B: { ...hero, size: "xl" } },
      ["A", "B"],
    );
    expect(violations.map((v) => [v.file, v.path])).toEqual([["A", "apiKey"]]);
  });
});

describe("deco check", () => {
  it("prints problems per file and exits 1, or 0 when only warnings remain", async () => {
    const fixture = createFixture(STORE_FILES);
    try {
      await writeSchema(decoPaths(fixture.root));
      fixture.write(".deco/blocks/HomePage.json", page([{ __resolveType: "hero", size: "md" }]));
      fixture.write(".deco/blocks/Promo.json", { __resolveType: "promo-banner" });
      const out = recorder();
      expect(check({ cwd: fixture.root, reporter: out })).toBe(1);
      expect(out.text()).toBe(
        [
          ".deco/blocks/HomePage.json",
          "  sections[0].title: required",
          ".deco/blocks/Promo.json",
          '  unknown block type "promo-banner"',
          "2 saved blocks checked: 2 errors, 0 warnings",
        ].join("\n"),
      );

      fixture.write(".deco/blocks/HomePage.json", page([hero]));
      fixture.write(".deco/blocks/Promo.json", {
        ...hero,
        title: {
          __resolveType: "multivariate",
          variants: [
            { rule: { __resolveType: "always" }, value: { __resolveType: "lazy", value: "a" } },
            { rule: { __resolveType: "always" }, value: { __resolveType: "lazy", value: "b" } },
          ],
        },
      });
      const ok = recorder();
      expect(check({ cwd: fixture.root, reporter: ok })).toBe(0);
      expect(ok.lines.at(-1)?.message).toBe("2 saved blocks checked: 0 errors, 1 warning");
    } finally {
      fixture.remove();
    }
  }, 60_000);

  it("fails on unreadable files and without a schema", () => {
    const fixture = createFixture({ ".deco/blocks/Broken.json": "{" });
    try {
      expect(() => check({ cwd: fixture.root, reporter: recorder() })).toThrow(
        /run deco schema first/,
      );
      fixture.write(".deco/schema.gen.json", meta);
      const out = recorder();
      expect(check({ cwd: fixture.root, reporter: out })).toBe(1);
      expect(out.text()).toContain(".deco/blocks/Broken.json\n  invalid JSON");
    } finally {
      fixture.remove();
    }
  });

  it("formats warnings with a prefix", () => {
    expect(
      formatProblems([
        { file: ".deco/blocks/A.json", path: "x", message: "m", severity: "warning" },
      ]),
    ).toBe(".deco/blocks/A.json\n  warning: x: m");
  });
});
