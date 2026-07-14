/**
 * Tests for the schema registry's real-over-stub precedence and the
 * definition builders' additionalProperties preservation.
 *
 * Background: registerCommerceLoaders() auto-registers a
 * `{ type: "object", additionalProperties: true }` stub for every commerce
 * loader/action key. App packages register REAL props schemas (from their
 * build-time schemas.gen.ts) via registerAppSchemas(). The published meta
 * must contain the real schema no matter which side registered first, and
 * the stub's additionalProperties flag must survive into the definition so
 * the Studio can tell "props unknown — edit as JSON" apart from "takes no
 * input".
 *
 * NOTE: the registries are module-global singletons — every test uses its own
 * unique keys instead of resetting shared state.
 */
import { describe, expect, it } from "vitest";
import {
  composeMeta,
  getRegisteredLoaders,
  type MetaResponse,
  registerActionSchema,
  registerAppSchemas,
  registerLoaderSchema,
} from "./schema";

const b64 = (s: string) => Buffer.from(s).toString("base64");

const emptySiteMeta = (): MetaResponse => ({
  major: 1,
  version: "1.0.0",
  namespace: "site",
  site: "test",
  manifest: { blocks: {} },
  schema: { definitions: {}, root: {} },
});

const STUB_SCHEMA = { type: "object" as const, additionalProperties: true };

function stubLoader(key: string) {
  registerLoaderSchema({
    key,
    title: key,
    namespace: "vtex",
    propsSchema: STUB_SCHEMA,
    isStub: true,
  });
}

const REAL_PLP_PROPS = {
  type: "object" as const,
  properties: {
    sort: {
      type: "string",
      enum: ["OrderByPriceDESC", "OrderByPriceASC", "OrderByTopSaleDESC"],
    },
    count: { type: "number" },
    fq: { type: "string" },
  },
  required: ["count"],
};

function realLoader(key: string) {
  registerAppSchemas({ namespace: "vtex", loaders: { [key]: REAL_PLP_PROPS } });
}

function definitionFor(key: string) {
  return composeMeta(emptySiteMeta()).schema.definitions[b64(key)];
}

describe("real-over-stub precedence", () => {
  it("keeps the real schema when the stub registers afterwards (loaders)", () => {
    const key = "vtex/loaders/test/realThenStub.ts";
    realLoader(key);
    stubLoader(key);

    const def = definitionFor(key);
    expect(def.properties.sort.enum).toEqual([
      "OrderByPriceDESC",
      "OrderByPriceASC",
      "OrderByTopSaleDESC",
    ]);
    expect(def.required).toEqual(["__resolveType", "count"]);
    expect(def.additionalProperties).toBeUndefined();
  });

  it("replaces the stub when the real schema registers afterwards (loaders)", () => {
    const key = "vtex/loaders/test/stubThenReal.ts";
    stubLoader(key);
    realLoader(key);

    const def = definitionFor(key);
    expect(def.properties.count).toEqual({ type: "number" });
    expect(def.additionalProperties).toBeUndefined();
  });

  it("applies the same precedence to actions", () => {
    const key = "vtex/actions/test/addCoupon.ts";
    registerAppSchemas({
      namespace: "vtex",
      actions: {
        [key]: {
          type: "object",
          properties: { coupon: { type: "string" } },
          required: ["coupon"],
        },
      },
    });
    registerActionSchema({
      key,
      title: key,
      namespace: "vtex",
      propsSchema: STUB_SCHEMA,
      isStub: true,
    });

    const def = definitionFor(key);
    expect(def.properties.coupon).toEqual({ type: "string" });
    expect(def.required).toEqual(["__resolveType", "coupon"]);
    expect(def.additionalProperties).toBeUndefined();
  });

  it("lets a later stub replace an earlier stub (hot-reload re-registration)", () => {
    const key = "vtex/loaders/test/stubTwice.ts";
    stubLoader(key);
    stubLoader(key);
    expect(definitionFor(key).additionalProperties).toBe(true);
  });

  it("lets a later real schema replace an earlier real schema", () => {
    const key = "vtex/loaders/test/realTwice.ts";
    realLoader(key);
    registerAppSchemas({
      namespace: "vtex",
      loaders: {
        [key]: { type: "object", properties: { slug: { type: "string" } } },
      },
    });
    const def = definitionFor(key);
    expect(def.properties.slug).toEqual({ type: "string" });
    expect(def.properties.sort).toBeUndefined();
  });
});

describe("additionalProperties preservation in definitions", () => {
  it("emits additionalProperties: true for stub-only keys (props unknown → JSON editor)", () => {
    const key = "vtex/loaders/test/stubOnly.ts";
    stubLoader(key);

    const def = definitionFor(key);
    expect(def.additionalProperties).toBe(true);
    expect(Object.keys(def.properties)).toEqual(["__resolveType"]);
  });

  it("emits NO additionalProperties for a real schema without props (takes no input)", () => {
    const key = "vtex/loaders/test/noInput.ts";
    registerAppSchemas({
      namespace: "vtex",
      loaders: { [key]: { type: "object", properties: {} } },
    });

    const def = definitionFor(key);
    expect(def.additionalProperties).toBeUndefined();
    expect(Object.keys(def.properties)).toEqual(["__resolveType"]);
  });
});

describe("registerAppSchemas", () => {
  it("registers every key form present in the artifact (bare and .ts)", () => {
    const bare = "vtex/loaders/test/aliased";
    registerAppSchemas({
      namespace: "vtex",
      loaders: {
        [bare]: REAL_PLP_PROPS,
        [`${bare}.ts`]: REAL_PLP_PROPS,
      },
    });

    const meta = composeMeta(emptySiteMeta());
    for (const key of [bare, `${bare}.ts`]) {
      const def = meta.schema.definitions[b64(key)];
      expect(def.properties.sort.enum).toContain("OrderByPriceDESC");
      expect(def.properties.__resolveType.enum).toEqual([key]);
      expect(meta.manifest.blocks.loaders[key]).toEqual({
        $ref: `#/definitions/${b64(key)}`,
        namespace: "vtex",
      });
    }
  });

  it("propagates schema title/description into the definition", () => {
    const key = "vtex/loaders/test/titled.ts";
    registerAppSchemas({
      namespace: "vtex",
      loaders: {
        [key]: {
          type: "object",
          title: "Product Listing Page",
          description: "Fetches a PLP",
          properties: { term: { type: "string" } },
        },
      },
    });

    const def = definitionFor(key);
    expect(def.title).toBe("Product Listing Page");
    expect(def.description).toBe("Fetches a PLP");
  });

  it("infers the product-list tag for loader keys, matching the stub inference", () => {
    const key = "vtex/loaders/test/productListShelf.ts";
    registerAppSchemas({
      namespace: "vtex",
      loaders: { [key]: { type: "object", properties: {} } },
    });

    const registered = getRegisteredLoaders().find((l) => l.key === key);
    expect(registered?.tags).toEqual(["product-list"]);
  });
});

describe("composeMeta framework option", () => {
  it("defaults the framework field to tanstack-start", () => {
    expect(composeMeta(emptySiteMeta()).framework).toBe("tanstack-start");
  });

  it("honors an explicit framework override (e.g. eitri)", () => {
    expect(composeMeta(emptySiteMeta(), { framework: "eitri" }).framework).toBe("eitri");
  });

  it("still bakes in the framework block types regardless of framework name", () => {
    const meta = composeMeta(emptySiteMeta(), { framework: "eitri" });
    // The whole point of composing at generation time: Page + section-picker +
    // Resolvable land in definitions so an FS-only consumer is self-contained.
    expect(meta.schema.definitions).toHaveProperty("__SECTION_REF__");
    expect(meta.schema.definitions).toHaveProperty("Resolvable");
    expect(meta.manifest.blocks.pages).toHaveProperty("website/pages/Page.tsx");
  });
});
