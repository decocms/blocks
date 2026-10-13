import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface Schema {
  type?: string;
  title?: string;
  description?: string;
  icon?: string;
  nullable?: boolean;
  $ref?: string;
  allOf?: Schema[];
  anyOf?: Schema[];
  enum?: string[];
  const?: string;
  properties?: Record<string, Schema>;
  required?: string[];
}

// Regressions against deco-cx/deco's admin, driven through the real CLI:
// - `Resolved<T>` (an alias of T) was offered T's loaders directly, so its
//   stored `{ __resolveType: "resolved", data }` matched no option; a flag
//   over `Resolved<T>` (a minicart's products) was one picker option among
//   loaders instead of the field's variants.
// - Site matchers (src/matchers) had no schema, so a rule using one could
//   not be listed or opened.
describe("generate-schema Resolved<T> props and site matchers", () => {
  let fixture: string;
  let meta: any;

  const FLAG = "site/flags/multivariate/products.ts";
  const MATCHER = "site/matchers/url.ts";

  beforeAll(() => {
    fixture = mkdtempSync(path.join(tmpdir(), "schema-resolved-"));
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
    write(
      "src/types.ts",
      `export type Resolved<T = any> = T;
       export interface Product { productID: string; }
       export interface Variant<T> { rule: unknown; value: T; }
       export interface MultivariateProps<T> { variants: Variant<T>[]; }
       export interface MultivariateFlag<T> { variants: Variant<T>[]; }`,
    );
    write(
      "src/loaders/productList.ts",
      `import type { Product } from "../types";
       export default function productList(): Product[] { return []; }`,
    );
    write(
      "src/flags/multivariate/products.ts",
      `import type { MultivariateFlag, MultivariateProps, Product, Resolved } from "../../types";
       /** @title Product Variants */
       export default function products(
         p: MultivariateProps<Resolved<Product[] | null>>,
       ): MultivariateFlag<Resolved<Product[] | null>> { return p; }`,
    );
    write(
      "src/sections/Shelf.tsx",
      `import type { Product, Resolved } from "../types";
       export interface Props {
         /** @title Products loader */
         productsLoader?: Resolved<Product[] | null>;
         products?: Product[] | null;
       }
       export default function Shelf(_props: Props) { return null; }`,
    );
    write(
      "src/matchers/url.ts",
      `export interface Props { includes?: string; match?: string; }
       /**
        * @title URL
        * @description Target users by URL
        * @icon world-www
        */
       const MatchUrl = ({ includes }: Props) => !!includes;
       export default MatchUrl;`,
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
  const shelfProps = () => {
    const section = def(btoa("site/sections/Shelf.tsx"));
    const ref = section.allOf!.find((part) => part.$ref)!.$ref!;
    return def(ref.replace("#/definitions/", "")).properties!;
  };
  const productLoaderPicker = [
    { $ref: "#/definitions/Resolvable" },
    { $ref: `#/definitions/${btoa("site/loaders/productList.ts")}` },
  ];

  it("emits Resolved<T> as deco-cx/deco did: { __resolveType: resolved, data: T }", () => {
    const { productsLoader } = shelfProps();
    expect(productsLoader.title).toBe("Products loader");
    expect(productsLoader.nullable).toBe(true);
    const [resolved, flag] = productsLoader.anyOf!;
    expect(resolved.required).toEqual(["data", "__resolveType"]);
    expect(resolved.properties!.__resolveType).toMatchObject({ const: "resolved" });
    // `data` is what the editor fills: a loader of T.
    expect(resolved.properties!.data.anyOf).toEqual(productLoaderPicker);
    // The only block option is the flag over Resolved<T>: the field has variants.
    expect(flag.properties!.__resolveType.enum).toEqual([FLAG]);
    expect(productsLoader.anyOf).toHaveLength(2);
  });

  it("gives a Resolved flag variants of Resolved<T>", () => {
    const value = def(`${btoa(FLAG)}@Props`).properties!.variants as any;
    expect(value.items.properties.value.properties.data.anyOf).toEqual(productLoaderPicker);
  });

  it("keeps a plain T prop a loader picker, without the Resolved flag", () => {
    expect(shelfProps().products.anyOf).toEqual(productLoaderPicker);
  });

  it("registers a site matcher with its JSDoc and props", () => {
    expect(meta.manifest.blocks.matchers[MATCHER]).toEqual({
      $ref: `#/definitions/${btoa(MATCHER)}`,
      namespace: "site",
    });
    const matcher = def(btoa(MATCHER));
    expect(matcher).toMatchObject({
      title: "URL",
      description: "Target users by URL",
      icon: "world-www",
    });
    expect(Object.keys(matcher.properties!)).toEqual(["__resolveType", "includes", "match"]);
    // composeMeta keeps it in the matcher union next to the built-ins.
    expect(meta.schema.root.matchers.anyOf).toContainEqual({
      $ref: `#/definitions/${btoa(MATCHER)}`,
    });
  });
});
