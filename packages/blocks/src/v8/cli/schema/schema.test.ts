// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEMA_FORMAT } from "../../../protocol/types";
import { createFixture, type Fixture, recorder, STORE_FILES } from "../__tests__/fixture";
import { LEGACY_ALIASES } from "../builtins";
import { CliError, decoPaths } from "../root";
import { type DecoMeta, generateSchema, type SchemaDiagnostic } from "./generate";
import { schema, writeSchema } from "./index";
import { toBase64 } from "./typeToSchema";

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
      [
        "actions",
        "apps",
        "content",
        "loaders",
        "matchers",
        "pages",
        "redirects",
        "sections",
      ].sort(),
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
      expect.arrayContaining(["weekday", "always", "never", "date"]),
    );
  });

  it("puts data-only functions in pages (if they extend Route) or content", () => {
    expect(meta.manifest.blocks.pages.post).toBeDefined();
    expect(meta.manifest.blocks.pages.page).toBeDefined();
    expect(meta.manifest.blocks.content.menu).toBeDefined();
    expect(meta.manifest.blocks.content.telemetry).toBeDefined();
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

describe("built-ins and aliases", () => {
  it("adds the ten built-ins", () => {
    for (const name of [
      "lazy",
      "multivariate",
      "always",
      "never",
      "date",
      "page",
      "redirect",
      "telemetry",
      "analytics",
      "secret",
    ]) {
      expect(def(name), name).toBeDefined();
    }
    expect(def("redirect").required).toEqual(["__resolveType", "from", "to", "permanent"]);
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
    expect(value("website/flags/multivariate/image.ts")).toMatchObject({
      type: "string",
      format: "image-uri",
    });
    expect(value("website/flags/multivariate/message.ts")).toMatchObject({ type: "string" });
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
