/**
 * `blockMeta` / `indexEntry` (contract §2.1, §2.9): the index metadata Studio,
 * the SDK and the CLI compute the same way, checked against the shared vectors.
 */
import { describe, expect, it } from "vitest";
import { indexEntry as entryFromProtocol, blockMeta as fromProtocol } from "../protocol";
import { blockMetaVectors } from "../protocol/conformance";
import { blockMeta, indexEntry } from "./blockMeta";
import { blockVersion } from "./canonical";

describe("blockMeta vectors", () => {
  const { names, cases } = blockMetaVectors;

  it("has the ten cases of the contract", () => {
    expect(cases.map((c) => c.name)).toEqual([
      "home",
      "footer",
      "footer-a",
      "plain",
      "variants",
      "extends",
      "redirects",
      "CMS",
      "ab-test",
      "summer-rule",
    ]);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s: version, meta and entry", async (_, c) => {
    expect(await blockVersion(c.body)).toBe(c.version);
    expect(blockMeta(c.body, names)).toEqual(c.meta);
    expect(blockMeta(c.body, new Set(names))).toEqual(c.meta);
    expect(await indexEntry(c.name, c.body, names)).toEqual(c.entry);
  });

  it("is what @decocms/blocks/protocol re-exports", async () => {
    expect(fromProtocol).toBe(blockMeta);
    expect(entryFromProtocol).toBe(indexEntry);
  });

  it("leaves meta out of a plain block's entry and inlines only CMS's body", () => {
    const plain = cases.find((c) => c.name === "plain")!;
    expect(Object.keys(plain.entry)).toEqual(["version"]);
    const cms = cases.find((c) => c.name === "CMS")!;
    expect(cms.entry.data).toEqual(cms.body);
    for (const c of cases) if (c.name !== "CMS") expect(c.entry).not.toHaveProperty("data");
  });
});

describe("blockMeta", () => {
  it("dedupes and sorts refs in code-unit order", () => {
    const body = {
      __resolveType: "x",
      a: [{ __resolveType: "b" }, { __resolveType: "B" }, { __resolveType: "a" }],
      nested: { deep: { __resolveType: "b" } },
    };
    expect(blockMeta(body, ["a", "b", "B"]).refs).toEqual(["B", "a", "b"]);
  });

  it("counts the top-level type when it names a block", () => {
    expect(blockMeta({ __resolveType: "header", title: "t" }, ["header"])).toEqual({
      type: "header",
      refs: ["header"],
    });
  });

  it("follows every variant, never and lazy included", () => {
    const body = {
      __resolveType: "multivariate",
      variants: [
        { rule: { __resolveType: "never" }, value: { __resolveType: "hidden" } },
        {
          rule: { __resolveType: "always" },
          value: { __resolveType: "lazy", value: { __resolveType: "shown" } },
        },
      ],
    };
    expect(blockMeta(body, ["hidden", "shown", "never", "lazy"]).refs).toEqual([
      "hidden",
      "lazy",
      "never",
      "shown",
    ]);
  });

  it("keeps a path of any type, the empty one included, and only strings", () => {
    expect(blockMeta({ __resolveType: "x", path: "" }, [])).toEqual({ type: "x", path: "" });
    expect(blockMeta({ path: 3 }, [])).toEqual({});
  });

  it("lists the tests and campaigns its rules name, at any depth, deduped and sorted", () => {
    const body = {
      __resolveType: "multivariate",
      variants: [
        {
          rule: {
            __resolveType: "multi",
            matchers: [
              { __resolveType: "experiment", name: "b" },
              { __resolveType: "campaign", name: "B" },
            ],
          },
          value: {
            __resolveType: "lazy",
            value: { nested: [{ rule: { __resolveType: "experiment", name: "b" } }] },
          },
        },
        { rule: { __resolveType: "never" }, value: { __resolveType: "campaign", name: "a" } },
      ],
    };
    // Names needn't be blocks of the index: they are entries of `experiments`/`campaigns`.
    expect(blockMeta(body, [])).toEqual({ type: "multivariate", rules: ["B", "a", "b"] });
  });

  it("counts a rule only with a string name, the empty one included", () => {
    const rules = (rule: unknown) => blockMeta({ __resolveType: "x", rule }, []).rules;
    expect(rules({ __resolveType: "experiment", name: "" })).toEqual([""]);
    expect(rules({ __resolveType: "campaign" })).toBeUndefined();
    expect(rules({ __resolveType: "experiment", name: 1 })).toBeUndefined();
    // An inline date rule, a whole map and another type's `name` name no rule.
    expect(rules({ __resolveType: "date", start: "2026-01-01T00:00:00Z" })).toBeUndefined();
    expect(rules({ __resolveType: "experiments" })).toBeUndefined();
    expect(rules({ __resolveType: "site/sections/Text.tsx", name: "x" })).toBeUndefined();
    // Raw types, as `type`: no alias mapping.
    expect(rules({ __resolveType: "deco/experiment", name: "x" })).toBeUndefined();
  });

  it("counts a saved rule's own top level", () => {
    expect(blockMeta({ __resolveType: "campaign", name: "summer" }, [])).toEqual({
      type: "campaign",
      rules: ["summer"],
    });
  });

  it("gives {} for a body that isn't an object", () => {
    for (const body of [null, 1, "x", [{ __resolveType: "a" }], undefined]) {
      expect(blockMeta(body, ["a"])).toEqual({});
    }
  });
});
