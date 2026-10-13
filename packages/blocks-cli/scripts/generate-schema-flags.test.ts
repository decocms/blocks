import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface Schema {
  type?: string;
  title?: string;
  description?: string;
  nullable?: boolean;
  $ref?: string;
  allOf?: Schema[];
  anyOf?: Schema[];
  enum?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
}

// Regression: site multivariate flags (`src/flags/**`, e.g. a
// `MultivariateFlag<BannerContent>`) were never scanned, so `root.flags`
// was empty and a prop holding `{ __resolveType: "site/flags/…", variants }`
// had no schema branch for it. The admin then drew the bare object form over
// the flag: no variants, every field empty. Driven through the real CLI so the
// flag pass runs before the loader/section passes that consume it.
describe("generate-schema site multivariate flags", () => {
  let fixture: string;
  let meta: any;

  const FLAG = "site/flags/multivariate/content.ts";
  const LIST_FLAG = "site/flags/multivariate/products.ts";

  beforeAll(() => {
    fixture = mkdtempSync(path.join(tmpdir(), "schema-flags-"));
    const write = (relative: string, contents: string) => {
      const file = path.join(fixture, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
    };
    write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
        },
      }),
    );
    // Same shape as @decocms/apps-website's types, declared locally so the
    // fixture has no package to resolve.
    write(
      "src/flags/types.ts",
      `export interface Variant<T> { rule: unknown; value: T; }
       export interface MultivariateProps<T> { variants: Variant<T>[]; }
       export interface MultivariateFlag<T> { variants: Variant<T>[]; }`,
    );
    write(
      "src/types.ts",
      `export interface Content { matcher?: string[]; label: string; }
       export interface Kit { name: string; content: Content; }
       export interface Product { productID: string; }`,
    );
    write(
      "src/flags/multivariate/content.ts",
      `import type { MultivariateFlag, MultivariateProps } from "../types";
       import type { Content } from "../../types";
       /** @title Content Variants */
       export default function content(p: MultivariateProps<Content>): MultivariateFlag<Content> { return p; }`,
    );
    write(
      "src/flags/multivariate/products.ts",
      `import type { MultivariateFlag, MultivariateProps } from "../types";
       import type { Product } from "../../types";
       export default function products(
         p: MultivariateProps<Product[] | null>,
       ): MultivariateFlag<Product[] | null> { return p; }`,
    );
    write("src/flags/helpers.ts", "export const notAFlag = 1;");
    write(
      "src/loaders/kits.ts",
      `import type { Kit } from "../types";
       interface Props { kits: Kit[]; }
       export default function kits({ kits }: Props): Kit[] { return kits; }`,
    );
    write(
      "src/loaders/products.ts",
      `import type { Product } from "../types";
       export default function load(): Product[] { throw new Error("fixture only"); }`,
    );
    write(
      "src/sections/Example.tsx",
      `import type { Content, Product } from "../types";
       export interface Props {
         /**
          * @title Main content
          * @description Shown on top
          */
         content: Content;
         optional?: Content | null;
         products: Product[] | null;
         /** @hide */
         hidden?: Content;
       }
       export default function Example(_props: Props) { return null; }`,
    );

    const run = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        path.resolve(__dirname, "generate-schema.ts"),
        "--skip-apps",
      ],
      { cwd: fixture, encoding: "utf8", timeout: 30_000 },
    );
    expect(run.status, run.error?.message ?? run.stderr).toBe(0);
    meta = JSON.parse(readFileSync(path.join(fixture, ".deco/meta.gen.json"), "utf8"));
  }, 30_000);

  afterAll(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  const def = (key: string): Schema => meta.schema.definitions[key];

  function sectionProps(): Record<string, Schema> {
    const section = def(btoa("site/sections/Example.tsx"));
    const ref = section.allOf!.find((part) => part.$ref)!.$ref!;
    return def(ref.replace("#/definitions/", "")).properties!;
  }

  function expectFlagged(schema: Schema, flagKey: string, title: string) {
    expect(schema.anyOf).toHaveLength(2);
    const [inline, flag] = schema.anyOf!;
    expect(inline.type).toBe("object");
    expect(inline.properties?.label.type).toBe("string");
    // Inline, with its own __resolveType: how the admin tells a block option
    // from the plain branch and renders the field with variants.
    expect(flag).toEqual({
      title,
      type: "object",
      allOf: [{ $ref: `#/definitions/${btoa(flagKey)}@Props` }],
      required: ["__resolveType"],
      properties: { __resolveType: { type: "string", enum: [flagKey], default: flagKey } },
    });
  }

  it("registers each flag in the manifest and in root.flags", () => {
    expect(meta.manifest.blocks.flags).toEqual({
      [FLAG]: { $ref: `#/definitions/${btoa(FLAG)}`, namespace: "site" },
      [LIST_FLAG]: { $ref: `#/definitions/${btoa(LIST_FLAG)}`, namespace: "site" },
    });
    expect(meta.schema.root.flags.anyOf).toContainEqual({
      $ref: `#/definitions/${btoa(FLAG)}`,
      inputSchema: `#/definitions/${btoa(FLAG)}@Props`,
    });
    expect(def(btoa(FLAG)).title).toBe("Content Variants");
    // No @title → the key, as for loaders.
    expect(def(btoa(LIST_FLAG)).title).toBe(LIST_FLAG);
  });

  it("emits the variants schema over the flag's value type", () => {
    const variant = def(`${btoa(FLAG)}@Props`).properties!.variants.items!;
    expect(variant.required).toEqual(["rule", "value"]);
    expect(variant.properties!.rule.required).toEqual(["__resolveType"]);
    expect(variant.properties!.value.properties!.label.type).toBe("string");
  });

  it("skips files under src/flags that are not multivariate flags", () => {
    expect(Object.keys(meta.manifest.blocks.flags)).not.toContain("site/flags/helpers.ts");
    expect(Object.keys(meta.manifest.blocks.flags)).not.toContain("site/flags/types.ts");
  });

  it("offers the flag on a section prop of the flag's type, keeping its annotations", () => {
    const content = sectionProps().content;
    expectFlagged(content, FLAG, "Content Variants");
    expect(content.title).toBe("Main content");
    expect(content.description).toBe("Shown on top");
    expect(sectionProps().optional.nullable).toBe(true);
    expectFlagged(sectionProps().optional, FLAG, "Content Variants");
  });

  it("offers the flag on a nested prop of a loader's props (a list of items with flagged content)", () => {
    const loader = def(btoa("site/loaders/kits.ts"));
    // A list prop of a type a loader returns also offers that loader (here,
    // the loader itself); its inline branch is the list.
    const kits = loader.properties!.kits;
    const kit = (kits.anyOf?.[0] ?? kits).items!;
    expect(kit.properties!.name.type).toBe("string");
    expectFlagged(kit.properties!.content, FLAG, "Content Variants");
  });

  it("adds the flag to a loader block-ref picker over the same type", () => {
    const loaderPicker = [
      { $ref: "#/definitions/Resolvable" },
      { $ref: `#/definitions/${btoa("site/loaders/products.ts")}` },
    ];
    expect(sectionProps().products.anyOf).toEqual([
      ...loaderPicker,
      { $ref: `#/definitions/${btoa(LIST_FLAG)}` },
    ]);
    // Each variant is itself a loader pick, not the whole inlined Product type.
    const variant = def(`${btoa(LIST_FLAG)}@Props`).properties!.variants.items!;
    expect(variant.properties!.value.anyOf).toEqual(loaderPicker);
  });

  it("leaves a hidden prop alone", () => {
    const hidden = sectionProps().hidden;
    expect(hidden.anyOf).toBeUndefined();
    expect(hidden.type).toBe("object");
  });
});
