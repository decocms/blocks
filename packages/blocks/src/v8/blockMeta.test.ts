/**
 * `blockMeta` / `indexEntry` (contract §2.1, §2.9): the index metadata Studio,
 * the SDK and the CLI compute the same way, checked against the shared vectors.
 */
import { describe, expect, it } from "vitest";
import { indexEntry as entryFromProtocol, blockMeta as fromProtocol } from "../protocol";
import { blockMetaVectors } from "../protocol/conformance";
import { blockMeta, indexEntry, META_VERSION, pageNoIndex, seoNoIndex } from "./blockMeta";
import { blockVersion } from "./canonical";

describe("blockMeta vectors", () => {
  const { names, cases } = blockMetaVectors;
  // A page's saved SEO block is looked up among the cases.
  const bodyOf = (name: string) => cases.find((c) => c.name === name)?.body;

  it("has the eleven cases of the contract", () => {
    expect(cases.map((c) => c.name)).toEqual([
      "home",
      "footer",
      "footer-a",
      "plain",
      "variants",
      "extends",
      "redirects",
      "CMS",
      "hidden-seo",
      "noindex-inline",
      "noindex-saved",
    ]);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s: version, meta and entry", async (_, c) => {
    expect(await blockVersion(c.body)).toBe(c.version);
    expect(blockMeta(c.body, names, bodyOf)).toEqual(c.meta);
    expect(blockMeta(c.body, new Set(names), bodyOf)).toEqual(c.meta);
    expect(await indexEntry(c.name, c.body, names, bodyOf)).toEqual(c.entry);
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

describe("noIndex (meta version 2)", () => {
  it("is version 2", () => {
    expect(META_VERSION).toBe(2);
  });

  it("is true for a page whose inline seo says noIndexing, and left out otherwise", () => {
    const page = (seo: unknown) => ({ __resolveType: "page", path: "/p", seo });
    expect(blockMeta(page({ noIndexing: true }), []).noIndex).toBe(true);
    for (const seo of [undefined, null, {}, { noIndexing: false }, { noIndexing: "true" }, []]) {
      expect(blockMeta(page(seo), [])).not.toHaveProperty("noIndex");
    }
  });

  it("only a body with a path is a page", () => {
    expect(blockMeta({ __resolveType: "post", seo: { noIndexing: true } }, [])).toEqual({
      type: "post",
    });
    expect(pageNoIndex({ path: "", seo: { noIndexing: true } })).toBe(true);
  });

  it("follows a referenced saved SEO block through bodyOf; without it, a reference is false", () => {
    const bodies: Record<string, unknown> = {
      DefaultSeo: { __resolveType: "website/sections/Seo/SeoV2.tsx", noIndexing: true },
      Alias: { __resolveType: "DefaultSeo" },
      A: { __resolveType: "B" },
      B: { __resolveType: "A" },
    };
    const bodyOf = (name: string) => bodies[name];
    expect(seoNoIndex({ __resolveType: "DefaultSeo" }, bodyOf)).toBe(true);
    expect(seoNoIndex({ __resolveType: "Alias" }, bodyOf)).toBe(true);
    expect(seoNoIndex({ __resolveType: "DefaultSeo" })).toBe(false);
    expect(seoNoIndex({ __resolveType: "DefaultSeo", noIndexing: false }, bodyOf)).toBe(false);
    expect(seoNoIndex({ __resolveType: "A" }, bodyOf)).toBe(false); // a cycle
    expect(seoNoIndex({ __resolveType: "Missing" }, bodyOf)).toBe(false);
    const page = { __resolveType: "page", path: "/", seo: { __resolveType: "DefaultSeo" } };
    expect(blockMeta(page, Object.keys(bodies), bodyOf)).toEqual({
      type: "page",
      path: "/",
      refs: ["DefaultSeo"],
      noIndex: true,
    });
    expect(blockMeta(page, Object.keys(bodies))).not.toHaveProperty("noIndex");
  });

  it("stops after 8 saved blocks", () => {
    // seo → S1 → … → S8 (8 saved blocks) says it; seo → S0 → … → S8 is 9.
    const bodies: Record<string, unknown> = { S8: { noIndexing: true } };
    for (let i = 0; i < 8; i++) bodies[`S${i}`] = { __resolveType: `S${i + 1}` };
    const bodyOf = (name: string) => bodies[name];
    expect(seoNoIndex({ __resolveType: "S1" }, bodyOf)).toBe(true);
    expect(seoNoIndex({ __resolveType: "S0" }, bodyOf)).toBe(false);
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

  it("gives {} for a body that isn't an object", () => {
    for (const body of [null, 1, "x", [{ __resolveType: "a" }], undefined]) {
      expect(blockMeta(body, ["a"])).toEqual({});
    }
  });
});
