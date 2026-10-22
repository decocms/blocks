// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEMA_FORMAT } from "../../../protocol/types";
import { createFixture, type Fixture, recorder, STORE_FILES } from "../__tests__/fixture";
import { LEGACY_ALIASES } from "../builtins";
import { CliError, decoPaths } from "../root";
import { type DecoMeta, generateSchema, type SchemaDiagnostic } from "./generate";
import { schema, writeSchema } from "./index";
import { sectionRef, stableFileId, titleCase, toBase64 } from "./typeToSchema";

const b64 = toBase64;
const ref = (key: string) => ({ $ref: `#/definitions/${b64(key)}` });

let store: Fixture;
let meta: DecoMeta;
let diagnostics: SchemaDiagnostic[];

const def = (key: string) => meta.schema.definitions[b64(key)];
const heroProps = () => meta.schema.definitions[`${b64("src/hero.tsx")}@Props`];
const propsOf = (key: string) => {
  const d = def(key);
  return d.allOf ? meta.schema.definitions[d.allOf[0].$ref.split("/").pop()!] : d;
};

beforeAll(async () => {
  store = createFixture(STORE_FILES);
  ({ meta, diagnostics } = await generateSchema(decoPaths(store.root)));
}, 60_000);
afterAll(() => store?.remove());

describe("the deco-meta@1 file", () => {
  it("has the site editor's shape plus the format and the alias table", () => {
    expect(meta.major).toBe(1);
    expect(meta.namespace).toBe("site");
    expect(meta.site).toBe("fixture-site");
    expect(meta.format).toBe(SCHEMA_FORMAT);
    expect(meta.framework).toBe("deco-cli");
    expect(Object.keys(meta.manifest.blocks).sort()).toEqual(
      ["content", "loaders", "matchers", "pages", "redirects", "sections"].sort(),
    );
    for (const group of ["sections", "loaders", "matchers", "pages", "redirects", "content"]) {
      expect(meta.schema.root[group].anyOf[0]).toEqual({ $ref: "#/definitions/Resolvable" });
    }
    expect(meta.schema.definitions.Resolvable).toEqual(meta.schema.definitions[b64("Resolvable")]);
    expect(diagnostics).toEqual([]);
  });

  it("keys definitions by the padded base64 of the type name", () => {
    expect(b64("hero")).toBe("aGVybw==");
    expect(def("hero")).toBeDefined();
    expect(meta.manifest.blocks.sections.hero).toEqual({ ...ref("hero"), namespace: "site" });
  });

  it("is deterministic", async () => {
    const again = await generateSchema(decoPaths(store.root));
    expect(JSON.stringify(again.meta)).toBe(JSON.stringify(meta));
  });

  it("lists no external sources for an app whose code is all under its root", async () => {
    // react's types come from node_modules, which is never watched.
    expect((await generateSchema(decoPaths(store.root))).externalSources).toEqual([]);
  });
});

describe("groups", () => {
  it("puts JSX-returning functions and render descriptors in sections", () => {
    expect(Object.keys(meta.manifest.blocks.sections)).toEqual(
      expect.arrayContaining(["hero", "product-card", "descriptor", "footer"]),
    );
  });

  it("puts boolean-returning functions in matchers, with the built-in matchers", () => {
    expect(Object.keys(meta.manifest.blocks.matchers)).toEqual(
      expect.arrayContaining(["weekday", "always", "never", "campaign"]),
    );
  });

  it("puts data-only functions in pages (if they extend Route) or content", () => {
    expect(meta.manifest.blocks.pages.post).toBeDefined();
    expect(meta.manifest.blocks.pages.page).toBeDefined();
    expect(meta.manifest.blocks.content.menu).toBeDefined();
    expect(meta.manifest.blocks.content["cms-settings"]).toBeDefined();
  });

  it("puts every other function in loaders, multivariate and lazy included", () => {
    expect(Object.keys(meta.manifest.blocks.loaders)).toEqual(
      expect.arrayContaining([
        "catalog-product",
        "product-list",
        "greeting",
        "multivariate",
        "lazy",
        "secret",
      ]),
    );
    expect(meta.manifest.blocks.redirects.redirect).toBeDefined();
  });

  it("writes a section the way v7 did: a wrapper over a shared props definition", () => {
    expect(def("hero")).toMatchObject({
      title: "Hero",
      description: "The big banner at the top.",
      type: "object",
      allOf: [{ $ref: `#/definitions/${b64("src/hero.tsx")}@Props` }],
      required: ["__resolveType"],
      properties: { __resolveType: { type: "string", enum: ["hero"], default: "hero" } },
    });
    // Two keys bound to one function share its props definition.
    expect(def("site/sections/Hero.tsx").allOf).toEqual(def("hero").allOf);
    expect(meta.schema.root.sections.anyOf).toContainEqual({
      ...ref("hero"),
      inputSchema: `#/definitions/${b64("src/hero.tsx")}@Props`,
    });
    expect(meta.schema.definitions.__SECTION_REF__.anyOf).toEqual(meta.schema.root.sections.anyOf);
  });

  it("writes other blocks flat: __resolveType plus the props", () => {
    expect(def("catalog-product")).toEqual({
      title: "catalog-product",
      type: "object",
      required: ["__resolveType", "slug"],
      properties: {
        __resolveType: { type: "string", enum: ["catalog-product"], default: "catalog-product" },
        slug: { type: "string", title: "Slug" },
      },
    });
  });
});

describe("types to fields", () => {
  it("maps string, number, boolean, literal unions, enums and arrays", () => {
    const p = heroProps().properties;
    expect(p.size).toEqual({ type: "string", enum: ["sm", "md", "lg"], title: "Size" });
    expect(p.tone).toEqual({
      type: "string",
      enum: ["light", "dark"],
      nullable: true,
      title: "Tone",
    });
    expect(p.dark).toMatchObject({ type: "boolean" });
    expect(p.tags).toMatchObject({ type: "array", items: { type: "string" } });
    expect(heroProps().required).toEqual(["title", "size"]);
  });

  it("applies JSDoc tags: title, description, limits, default, format", () => {
    const p = heroProps().properties;
    expect(p.title).toEqual({ type: "string", title: "Headline", maxLength: 60 });
    expect(p.image).toMatchObject({ type: "string", format: "image-uri" });
    expect(p.count).toMatchObject({ type: "number", minimum: 1, maximum: 10, default: 3 });
    expect(heroProps().title).toBe("Hero props");
  });

  it("writes a static @options list as an enum and drops a function-backed one", () => {
    const p = heroProps().properties;
    expect(p.align).toMatchObject({ type: "string", enum: ["left", "center", "right"] });
    expect(p.icon).toEqual({ type: "string", nullable: true, title: "Icon" });
  });

  it("leaves @ignore fields out", () => {
    expect(heroProps().properties.internal).toBeUndefined();
  });

  it("makes ReactNode a choice of components, and ReactNode[] a list of them", () => {
    const p = heroProps().properties;
    expect(p.children).toEqual({
      $ref: "#/definitions/__SECTION_REF__",
      nullable: true,
      title: "Children",
    });
    expect(p.sections).toEqual({
      type: "array",
      items: { $ref: "#/definitions/__SECTION_REF__" },
      nullable: true,
      title: "Sections",
    });
  });

  it("makes a render-descriptor field a choice of sections, as JSX is", () => {
    const p = propsOf("shelf").properties;
    expect(p.heading).toEqual({ $ref: "#/definitions/__SECTION_REF__", title: "Heading" });
    expect(p.rows).toEqual({
      type: "array",
      items: { $ref: "#/definitions/__SECTION_REF__" },
      title: "Rows",
    });
  });

  it("makes Secret a write-only secret block", () => {
    expect(heroProps().properties.apiKey).toMatchObject({
      format: "secret",
      writeOnly: true,
      required: ["__resolveType", "ciphertext"],
      properties: { __resolveType: { enum: ["secret"] }, ciphertext: { type: "string" } },
    });
  });

  it("makes Lazy<T> a lazy block whose value has the form of T", () => {
    const later = heroProps().properties.later;
    expect(later.properties.__resolveType).toEqual({
      type: "string",
      enum: ["lazy"],
      default: "lazy",
    });
    expect(later.required).toEqual(["__resolveType", "value"]);
    expect(later.properties.value.anyOf).toContainEqual(ref("catalog-product"));
  });

  it("makes Secret[] a list of secret blocks, not of plain strings", () => {
    const keys = propsOf("vault").properties.keys;
    expect(keys.type).toBe("array");
    expect(keys.items).toMatchObject({
      type: "object",
      format: "secret",
      writeOnly: true,
      properties: { __resolveType: { enum: ["secret"] } },
    });
  });

  it("makes Lazy<T>[] a list of lazy blocks whose value has the form of T", () => {
    const slots = propsOf("vault").properties.slots;
    expect(slots.type).toBe("array");
    expect(slots.items.required).toEqual(["__resolveType", "value"]);
    expect(slots.items.properties.__resolveType.enum).toEqual(["lazy"]);
    expect(slots.items.properties.value.anyOf).toContainEqual(ref("catalog-product"));
  });

  it("skips methods, even ones that return a promise", () => {
    const props = propsOf("vault");
    expect(Object.keys(props.properties)).toEqual(["label", "keys", "slots"]);
    expect(props.required).toBeUndefined();
  });
});

describe("interchangeable blocks", () => {
  it("offers a plain value or any block whose awaited return type fits an object field", () => {
    const product = propsOf("product-card").properties.product;
    expect(product.anyOf[0]).toEqual({ $ref: "#/definitions/Resolvable" });
    expect(product.anyOf[1]).toMatchObject({ title: "Inline data" });
    // catalogProduct returns Promise<Product>: awaited, it fits.
    expect(product.anyOf.slice(2)).toEqual([ref("catalog-product")]);
    // The shared plain-value form is the Product type, written once.
    const inline = meta.schema.definitions[product.anyOf[1].$ref.split("/").pop()];
    expect(inline).toMatchObject({ type: "object", required: ["name", "price"] });
  });

  it("matches arrays by return type too", () => {
    const related = propsOf("product-card").properties.related;
    expect(related.anyOf.slice(2)).toEqual([ref("product-list")]);
    expect(related.anyOf[1]).toMatchObject({ type: "array", title: "Inline data" });
  });

  it("lets a data-only block fill a field of its own type", () => {
    expect(propsOf("post").properties.featured.anyOf).toContainEqual(ref("post"));
    expect(propsOf("footer").properties.menu.anyOf).toContainEqual(ref("menu"));
  });

  it("keeps simple types plain inputs: no string function for a string, no matcher for a boolean", () => {
    const footer = propsOf("footer").properties;
    expect(footer.label).toEqual({ type: "string", title: "Label" });
    expect(footer.enabled).toEqual({ type: "boolean", title: "Enabled" });
  });

  it("offers only JSX-returning functions for ReactNode fields", () => {
    const sections = meta.schema.root.sections.anyOf.map((r: any) => r.$ref);
    expect(sections).toContain(ref("hero").$ref);
    expect(sections).not.toContain(ref("weekday").$ref);
    expect(sections).not.toContain(ref("greeting").$ref);
  });

  it("offers the page's seo field the blocks that return a Seo", async () => {
    const fixture = createFixture({
      "src/seo.ts": `export const seo = (props: { title: string; description: string; image?: string }) => props;`,
      ".deco/index.ts": `import { seo } from "../src/seo"; export default { seo };`,
    });
    try {
      const { meta: m } = await generateSchema(decoPaths(fixture.root));
      expect(m.schema.definitions[b64("page")].properties.seo.anyOf).toContainEqual(ref("seo"));
    } finally {
      fixture.remove();
    }
  }, 30_000);
});

describe("the built-in page with a descriptor site's blocks", () => {
  it("takes descriptor sections and SEO blocks with only optional fields, and stays Studio's page", async () => {
    const fixture = createFixture({
      "src/blocks.ts": [
        "export interface BlockDescriptor { component: string; props: Record<string, unknown> }",
        "export interface PageSeo { title?: string; description?: string; canonical?: string }",
        'export const hero = (props: { title: string }): BlockDescriptor => ({ component: "Hero", props });',
        "export const seo = (props: PageSeo): PageSeo => props;",
        "export const price = (props: { sku: string }): { amount: number } => ({ amount: 1 });",
        "export const titled = (props: { n: number }): { title: number } => ({ title: props.n });",
        // A blog's loaders: content with a title or a description, and required fields.
        "export interface BlogPost { title: string; excerpt: string; image?: string; slug: string }",
        "export interface Category { name: string; slug: string; description?: string }",
        "export const blogPost = async (props: { slug: string }): Promise<BlogPost | null> => null;",
        "export const blogCategory = async (props: { slug: string }): Promise<Category | null> => null;",
      ].join("\n"),
      ".deco/index.ts": `import { blogCategory, blogPost, hero, price, seo, titled } from "../src/blocks"; export default { hero, price, seo, titled, "blog-post": blogPost, "blog/loaders/Category.ts": blogCategory };`,
    });
    try {
      const { meta: m } = await generateSchema(decoPaths(fixture.root));
      const page = m.schema.definitions[b64("page")];
      const refs = (schema: any): string[] =>
        JSON.stringify(schema).match(/#\/definitions\/[^"]+/g) ?? [];
      expect(m.schema.root.sections.anyOf).toContainEqual(expect.objectContaining(ref("hero")));
      expect(refs(page.properties.sections)).toContain(sectionRef().$ref);
      expect(page.properties.seo.anyOf).toContainEqual(ref("seo"));
      expect(page.properties.seo.anyOf).not.toContainEqual(ref("price"));
      expect(page.properties.seo.anyOf).not.toContainEqual(ref("titled"));
      expect(page.properties.seo.anyOf).not.toContainEqual(ref("blog-post"));
      expect(page.properties.seo.anyOf).not.toContainEqual(ref("blog/loaders/Category.ts"));
      expect(m.manifest.blocks.pages.page).toMatchObject({ namespace: "deco" });
    } finally {
      fixture.remove();
    }
  }, 30_000);
});

describe("a field of names to true/false", () => {
  it("can hold the saved experiments or campaigns block: split-traffic and calendar fit it", async () => {
    const fixture = createFixture({
      "src/hero.tsx": `
export interface Props {
  experiments?: Record<string, boolean>;
  labels?: Record<string, string>;
  extra?: Record<string, unknown>;
}
export default function Hero(_props: Props) { return <div />; }`,
      ".deco/index.ts": `import Hero from "../src/hero"; export default { hero: Hero };`,
    });
    try {
      const { meta: m } = await generateSchema(decoPaths(fixture.root));
      const props = m.schema.definitions[`${b64("src/hero.tsx")}@Props`].properties;
      expect(props.experiments.anyOf).toEqual([
        { $ref: "#/definitions/Resolvable" },
        expect.objectContaining({ type: "object", additionalProperties: { type: "boolean" } }),
        ref("split-traffic"),
        ref("calendar"),
      ]);
      // Other maps stay plain: a string map isn't true/false, a free-form one fits anything.
      expect(props.labels.anyOf).toBeUndefined();
      expect(props.extra.anyOf).toBeUndefined();
    } finally {
      fixture.remove();
    }
  }, 30_000);

  it("offers the block map's own split-traffic instead, when it declares one", async () => {
    const fixture = createFixture({
      "src/hero.tsx": `
export interface Props { experiments?: Record<string, boolean> }
export default function Hero(_props: Props) { return <div />; }`,
      "src/split.ts": `export const split = (props: { on: boolean }) => ({ a: props.on });`,
      ".deco/index.ts": `import Hero from "../src/hero"; import { split } from "../src/split";
export default { hero: Hero, "split-traffic": split };`,
    });
    try {
      const { meta: m } = await generateSchema(decoPaths(fixture.root));
      const props = m.schema.definitions[`${b64("src/hero.tsx")}@Props`].properties;
      expect(props.experiments.anyOf.slice(2)).toEqual([ref("split-traffic"), ref("calendar")]);
      expect(m.manifest.blocks.content["split-traffic"]).toBeUndefined();
    } finally {
      fixture.remove();
    }
  }, 30_000);
});

describe("built-ins and aliases", () => {
  it("adds the eleven built-ins", () => {
    for (const name of [
      "lazy",
      "multivariate",
      "always",
      "never",
      "experiment",
      "campaign",
      "page",
      "redirect",
      "cms-settings",
      "split-traffic",
      "secret",
    ]) {
      expect(def(name), name).toBeDefined();
    }
    expect(def("redirect").required).toEqual(["__resolveType", "from", "to", "permanent"]);
    // Every key of a split-traffic block but __resolveType is a test: a whole percentage.
    expect(def("split-traffic").additionalProperties).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 100,
    });
    expect(def("experiment").required).toEqual(["__resolveType", "name"]);
    expect(meta.manifest.blocks.content["split-traffic"]).toBeDefined();
    expect(meta.manifest.blocks.matchers.experiment).toBeDefined();
    expect(def("page").properties.sections.anyOf[0]).toEqual({
      type: "array",
      title: "Sections",
      items: { $ref: "#/definitions/__SECTION_REF__" },
    });
  });

  it("writes the alias table, with a definition and a manifest entry per legacy name", () => {
    expect(meta.aliases).toEqual(LEGACY_ALIASES);
    expect(def("website/pages/Page.tsx").properties.__resolveType.enum).toEqual([
      "website/pages/Page.tsx",
    ]);
    expect(meta.manifest.blocks.pages["website/pages/Page.tsx"]).toBeDefined();
    expect(meta.manifest.blocks.matchers["website/matchers/always.ts"]).toBeDefined();
    // Not in the pickers twice.
    expect(meta.schema.root.pages.anyOf).not.toContainEqual(ref("website/pages/Page.tsx"));
  });

  it("wraps each variant's value in a lazy block under multivariate, but not under legacy names", () => {
    const value = (name: string) => def(name).properties.variants.items.properties.value;
    expect(value("multivariate")).toEqual({
      type: "object",
      required: ["__resolveType", "value"],
      properties: {
        __resolveType: { type: "string", enum: ["lazy"], default: "lazy" },
        value: { title: "Value" },
      },
    });
    expect(value("website/flags/multivariate.ts")).toEqual({ title: "Value" });

    const [, short, legacy] = def("page").properties.sections.anyOf;
    expect(short.properties.__resolveType.enum).toEqual(["multivariate"]);
    expect(short.properties.variants.items.properties.value).toMatchObject({
      properties: {
        __resolveType: { enum: ["lazy"] },
        value: { type: "array", items: { $ref: "#/definitions/__SECTION_REF__" } },
      },
    });
    expect(legacy.properties.__resolveType.enum).toEqual([
      "website/flags/multivariate.ts",
      "website/flags/multivariate/section.ts",
    ]);
    expect(legacy.properties.variants.items.properties.value).toMatchObject({
      type: "array",
      items: { $ref: "#/definitions/__SECTION_REF__" },
    });
  });

  it("gives each legacy multivariate kind the form of the field it varies", () => {
    const value = (alias: string) => def(alias).properties.variants.items.properties.value;
    expect(value("website/flags/multivariate/section.ts")).toMatchObject({
      $ref: "#/definitions/__SECTION_REF__",
    });
    expect(value("website/flags/multivariate.ts")).toMatchObject({ title: "Value" });
  });

  it("writes the legacy redirect alias in the nested shape the old screen saves", () => {
    expect(def("website/loaders/redirect.ts").properties.redirect.properties.type.enum).toEqual([
      "permanent",
      "temporary",
    ]);
  });

  it("lets the block map replace a built-in, and adds fields to page", async () => {
    const fixture = createFixture({
      "src/page.ts": `
import type { Page } from "./deco";
export interface StorePage extends Page { theme: "light" | "dark" }
export const page = (props: StorePage) => props;`,
      ".deco/index.ts": `import { page } from "../src/page"; export default { page };`,
    });
    try {
      const { meta: m } = await generateSchema(decoPaths(fixture.root));
      const page = m.schema.definitions[b64("page")];
      expect(page.properties.theme).toMatchObject({ enum: ["light", "dark"] });
      expect(page.properties.sections).toEqual({
        type: "array",
        items: { $ref: "#/definitions/__SECTION_REF__" },
        title: "Sections",
      });
      expect(m.manifest.blocks.pages.page.namespace).toBe("site");
      // The legacy page name now names the override.
      expect(m.schema.definitions[b64("website/pages/Page.tsx")].properties.theme).toBeDefined();
    } finally {
      fixture.remove();
    }
  }, 30_000);
});

describe("v7 field fidelity", () => {
  it("keeps literal selects in declared order, maps @format datetime, and keeps free-form maps plain", async () => {
    const fixture = createFixture({
      "src/card.ts": `
// Literals the checker meets first get lower ids; a union of them would
// otherwise come out in that order instead of the order written below.
export type Earlier = "page" | "product";
export type Kind = "search" | "collection" | "page" | "product";
export interface Badge { label: string }
export interface Props {
  earlier?: Earlier;
  kind: "search" | "collection" | "page" | "product";
  aliased?: Kind;
  /** @format datetime */
  endsAt?: string;
  entities?: Record<string, any>;
}
export const card = (props: Props) => ({ component: "card", props });
export const badge = (): Badge => ({ label: "" });`,
      ".deco/index.ts": `import { badge, card } from "../src/card"; export default { badge, card };`,
    });
    try {
      const { meta: m } = await generateSchema(decoPaths(fixture.root));
      const p = m.schema.definitions[`${b64("card")}@Props`]?.properties;
      expect(p, Object.keys(m.schema.definitions).join(" ")).toBeDefined();
      expect(p.kind.enum).toEqual(["search", "collection", "page", "product"]);
      expect(p.aliased.enum).toEqual(["search", "collection", "page", "product"]);
      expect(p.endsAt.format).toBe("date-time");
      expect(p.entities).toEqual({
        type: "object",
        additionalProperties: {},
        nullable: true,
        title: "Entities",
      });
    } finally {
      fixture.remove();
    }
  }, 30_000);
});

describe("default field titles", () => {
  // The v7 site editor split a prop name at capitals; this generator only
  // uppercased the first letter, so a migrated site's camelCase fields read
  // "MarginTop" instead of "Margin Top".
  it.each([
    ["marginTop", "Margin Top"],
    ["hideUnavailableItems", "Hide Unavailable Items"],
    ["title", "Title"],
    ["CTA", "CTA"],
    ["titleCTA", "Title CTA"],
    ["taxID", "Tax ID"],
    ["RangePriceProps", "Range Price Props"],
  ])("%s → %s", (name, title) => {
    expect(titleCase(name)).toBe(title);
  });

  it("titles a field without @title, keeps an explicit one", async () => {
    const definitions = await barDefinitions(`export interface Props {
  marginTop?: number;
  /** @title Custom */
  noFlex?: boolean;
}`);
    const p = definitions[`${b64("bar")}@Props`].properties;
    expect(p.marginTop.title).toBe("Margin Top");
    expect(p.noFlex.title).toBe("Custom");
  }, 30_000);
});

// Ported from main's generate-schema.test.ts (25c2e134, 6cb3bfa2): fixes the
// v7 generator got in 7.77.2, which this generator was copied from.
/** The definitions written for a section `bar` whose props are `Props` in `source`. */
async function barDefinitions(source: string) {
  const fixture = createFixture({
    "src/bar.ts": `${source}
export const bar = (props: Props) => ({ component: "bar", props });`,
    ".deco/index.ts": `import { bar } from "../src/bar"; export default { bar };`,
  });
  try {
    const { meta: m } = await generateSchema(decoPaths(fixture.root));
    const definitions = m.schema.definitions;
    expect(definitions[`${b64("bar")}@Props`], Object.keys(definitions).join(" ")).toBeDefined();
    return definitions;
  } finally {
    fixture.remove();
  }
}

describe("underscore-prefixed props and hidden literals", () => {
  const propsOf = async (source: string) => (await barDefinitions(source))[`${b64("bar")}@Props`];

  it("keeps __title and _id (editor label, dynamic-options key) but not __resolveType", async () => {
    const props = await propsOf(`
/** @title {{__title}} */
export interface Rule {
  /**
   * @title Título (opcional)
   * @description Título do CMS.
   */
  __title?: string;
  /**
   * @title Regulamento
   * @format dynamic-options
   * @options site/loaders/admin/regulation.ts
   */
  _id?: string;
  __resolveType?: string;
  pathname: string;
}
export interface Props { rules: Rule[] }`);
    const item = props.properties.rules.items;
    expect(Object.keys(item.properties)).toEqual(["__title", "_id", "pathname"]);
    expect(item.properties.__title).toEqual({
      type: "string",
      nullable: true,
      title: "Título (opcional)",
      description: "Título do CMS.",
    });
    // The field is kept; its loader-backed `@options` is dropped as for any
    // other field (the site editor never runs site code).
    expect(item.properties._id).toMatchObject({ type: "string", format: "dynamic-options" });
    expect(item.required).toEqual(["pathname"]);
  }, 30_000);

  it("emits a hidden literal discriminator with const and an equal default", async () => {
    const props = await propsOf(`
export interface Props {
  /** @hide true */
  __type: "image";
  src: string;
}`);
    expect(props.properties.__type).toEqual({
      type: "string",
      const: "image",
      default: "image",
      hide: "true",
      title: "__type",
    });
    // Hidden but defaulted: the editor writes the literal, so it stays
    // required (as in deco-cx/deco).
    expect(props.required).toEqual(["__type", "src"]);
  }, 30_000);

  it("still leaves a hidden prop without a default out of required", async () => {
    const props = await propsOf(`
export interface Props {
  /** @hide true */
  internal: string;
  src: string;
}`);
    expect(props.properties.internal.hide).toBe("true");
    expect(props.required).toEqual(["src"]);
  }, 30_000);
});

describe("symbol-keyed props", () => {
  const propsOf = async (source: string) => (await barDefinitions(source))[`${b64("bar")}@Props`];

  // A `Promise` (React 19's `ReactNode` has one) carries `[Symbol.toStringTag]`,
  // which the compiler names `__@toStringTag@<id>`: it once leaked into a
  // site's schema as a field.
  it("leaves out well-known and unique symbol keys, and changes nothing else", async () => {
    const shared = `
/** @title {{__title}} */
export interface Item {
  __title?: string;
  "__@literal"?: string;
  label: string;
}`;
    const withSymbols = await propsOf(`
declare const brand: unique symbol;
${shared}
export interface Tagged extends Item {
  readonly [Symbol.toStringTag]: string;
  [brand]: true;
}
export interface Props {
  items: Tagged[];
  pending?: Promise<string> | string;
}`);
    const without = await propsOf(`
${shared}
export interface Tagged extends Item {}
export interface Props { items: Tagged[] }`);
    const json = JSON.stringify(withSymbols);
    expect(json).not.toContain("__@toStringTag");
    expect(json).not.toContain("__@brand");
    const item = withSymbols.properties.items.items;
    // String keys starting with "__" are untouched, even "__@…".
    expect(Object.keys(item.properties)).toEqual(["__title", "__@literal", "label"]);
    expect(item.required).toEqual(["label"]);
    expect(withSymbols.properties.items).toEqual(without.properties.items);
    // The promise is an object with no fields (none required), not one with a junk field.
    const promise = withSymbols.properties.pending.anyOf.find((s: any) => s.title === "Promise");
    expect(promise).toMatchObject({ type: "object", properties: {} });
    expect(promise.required).toBeUndefined();
  }, 30_000);
});

// Ported from main's generate-schema.test.ts (25a7ffb9).
describe("recursive named types", () => {
  // A navigation tree written as `interface Link { submenu?: Link[] }`. The
  // cycle used to collapse to `{ type: "object" }`, so the editor edited the
  // submenu as an object instead of a list of links. deco-cx/deco emits the
  // type once as a definition and references it from inside the cycle.
  it("references the type from inside the cycle, and its definition is the full type", async () => {
    const definitions = await barDefinitions(`
/** @title {{name}} */
export interface Link {
  /** @title Name */
  name: string;
  /** @title Submenu */
  submenu?: Link[];
}
export interface Props { links: Link[] }`);
    const refId = `${b64("src/bar.ts")}@Link`;
    const item = definitions[`${b64("bar")}@Props`].properties.links.items;
    expect(item.title).toBe("{{name}}");
    expect(item.properties.submenu).toEqual({
      type: "array",
      items: { $ref: `#/definitions/${refId}` },
      nullable: true,
      title: "Submenu",
    });
    expect(definitions[refId].title).toBe("{{name}}");
    expect(definitions[refId].required).toEqual(["name"]);
    expect(definitions[refId].properties.submenu.items).toEqual({
      $ref: `#/definitions/${refId}`,
    });
  }, 30_000);

  it("keeps the bare object for an anonymous or generic cycle", async () => {
    const definitions = await barDefinitions(`
export interface Tree<T> { value: T; children?: Tree<T>[] }
export interface Props { tree: Tree<string> }`);
    const tree = definitions[`${b64("bar")}@Props`].properties.tree;
    expect(tree.properties.children.items).toEqual({ type: "object" });
  }, 30_000);
});

describe("JSDoc tag parsing", () => {
  it("ignores a tag written with a colon (`@description: text`), as deco-cx/deco does", async () => {
    const definitions = await barDefinitions(`
export interface Props {
  /**
   * @title Título
   * @description: Nome que irá aparecer na pílula.
   */
  name: string;
  /** @description Kept. */
  path: string;
}`);
    const props = definitions[`${b64("bar")}@Props`].properties;
    expect(props.name).toEqual({ type: "string", title: "Título" });
    expect(props.path.description).toBe("Kept.");
  }, 30_000);
});

describe("@format on a type alias", () => {
  it("gives every field of an imported alias its format: plain, optional, nullable, listed, a select", async () => {
    const fixture = createFixture({
      "src/widgets.ts": `
/** @format color */
export type Paint = string;
/** @format color */
export type TextTone = "black" | "white";
export type Plain = string;`,
      "src/banner.ts": `
import type { Paint, Plain, TextTone } from "./widgets";
export interface Props {
  background: Paint;
  border?: Paint | null;
  stripes?: Paint[];
  titleTone?: TextTone;
  /** @format textarea */
  note?: Paint;
  plain?: Plain;
}
export const banner = (props: Props) => ({ component: "banner", props });`,
      ".deco/index.ts": `import { banner } from "../src/banner"; export default { banner };`,
    });
    try {
      const { meta: m } = await generateSchema(decoPaths(fixture.root));
      const p = m.schema.definitions[`${b64("banner")}@Props`]?.properties;
      expect(p, Object.keys(m.schema.definitions).join(" ")).toBeDefined();
      expect(p.background).toEqual({ type: "string", format: "color", title: "Background" });
      expect(p.border).toMatchObject({ type: "string", format: "color", nullable: true });
      expect(p.stripes.items).toEqual({ type: "string", format: "color" });
      expect(p.titleTone).toMatchObject({ enum: ["black", "white"], format: "color" });
      expect(p.note.format).toBe("textarea");
      expect(p.plain.format).toBeUndefined();
    } finally {
      fixture.remove();
    }
  }, 30_000);
});

describe("imported maps", () => {
  it("follows a spread app map, the later key winning", async () => {
    const fixture = createFixture({
      "src/app.tsx": `
export const app = {
  "app/loaders/one.ts": (props: { a: string }) => props.a.length,
  shared: (props: { fromApp: string }) => <i />,
};`,
      ".deco/index.ts": `
import { app } from "../src/app";
export default { ...app, shared: (props: { fromSite: string }) => props };`,
    });
    try {
      const { meta: m } = await generateSchema(decoPaths(fixture.root));
      expect(m.manifest.blocks.loaders["app/loaders/one.ts"].namespace).toBe("app");
      expect(m.manifest.blocks.content.shared).toBeDefined();
      expect(m.schema.definitions[b64("shared")].properties.fromSite).toBeDefined();
    } finally {
      fixture.remove();
    }
  }, 30_000);
});

describe("errors and warnings", () => {
  async function run(files: Record<string, string>) {
    const fixture = createFixture(files);
    try {
      return await generateSchema(decoPaths(fixture.root));
    } finally {
      fixture.remove();
    }
  }

  it("rejects a path field on a type that doesn't extend Route", async () => {
    const { diagnostics: d } = await run({
      ".deco/index.ts": `export default { stray: (props: { path: string }) => props };`,
    });
    expect(d).toContainEqual({
      severity: "error",
      message:
        '"stray": has a "path" field but its type doesn\'t extend Route (name: string; path: string)',
    });
  }, 30_000);

  it("reports a key that isn't a function", async () => {
    const { diagnostics: d } = await run({ ".deco/index.ts": `export default { nope: 1 };` });
    expect(d[0]).toMatchObject({
      severity: "error",
      message: expect.stringContaining('"nope" isn\'t a function'),
    });
  }, 30_000);

  it("warns on any", async () => {
    const { diagnostics: d } = await run({
      ".deco/index.ts": `export default { loose: (props: any): any => props };`,
    });
    expect(d.map((x) => x.severity)).toEqual(["warning", "warning"]);
  }, 30_000);

  it("fails without a block map or a default export", async () => {
    const empty = createFixture();
    try {
      await expect(generateSchema(decoPaths(empty.root))).rejects.toThrow(CliError);
      empty.write(".deco/index.ts", "export const x = 1;");
      await expect(generateSchema(decoPaths(empty.root))).rejects.toThrow(/no default export/);
    } finally {
      empty.remove();
    }
  }, 30_000);

  it("doesn't write the schema when there are errors, and deco schema exits 1", async () => {
    const fixture = createFixture({
      ".deco/index.ts": `export default { stray: (props: { path: string }) => props };`,
    });
    try {
      const result = await writeSchema(decoPaths(fixture.root));
      expect(result.written).toBe(false);
      expect(fixture.exists(".deco/schema.gen.json")).toBe(false);
      const out = recorder();
      expect(await schema({ cwd: fixture.root, reporter: out })).toBe(1);
      expect(out.text()).toContain("not written");
    } finally {
      fixture.remove();
    }
  }, 30_000);

  it("deco schema writes .deco/schema.gen.json and reports what it found", async () => {
    const out = recorder();
    expect(await schema({ cwd: store.root, reporter: out })).toBe(0);
    expect(JSON.parse(store.read(".deco/schema.gen.json")).format).toBe("deco-meta@1");
    expect(out.text()).toMatch(/schema\.gen\.json from index\.ts \(\d+ sections/);
  }, 30_000);
});

describe("stableFileId", () => {
  it("names a package's compiled .d.ts after its source, so dist and the source condition agree", () => {
    const f = createFixture();
    try {
      const pkg = "node_modules/@acme/kit";
      f.write(`${pkg}/package.json`, { name: "@acme/kit" });
      f.write(`${pkg}/dist/v8/types.d.ts`, "export interface Seo { title: string }\n");
      f.write(
        `${pkg}/dist/v8/types.d.ts.map`,
        JSON.stringify({ version: 3, file: "types.d.ts", sources: ["../../src/v8/types.ts"] }),
      );
      f.write(`${pkg}/dist/v8/plain.d.ts`, "export {};\n");
      expect(stableFileId(`${f.root}/${pkg}/dist/v8/types.d.ts`, f.root)).toBe(
        "@acme/kit/src/v8/types.ts",
      );
      expect(stableFileId(`${f.root}/${pkg}/src/v8/types.ts`, f.root)).toBe(
        "@acme/kit/src/v8/types.ts",
      );
      // No declaration map: the file keeps its own name.
      expect(stableFileId(`${f.root}/${pkg}/dist/v8/plain.d.ts`, f.root)).toBe(
        "@acme/kit/dist/v8/plain.d.ts",
      );
    } finally {
      f.remove();
    }
  });
});
