import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface Schema {
  type?: string;
  title?: string;
  $ref?: string;
  allOf?: Schema[];
  anyOf?: Schema[];
  enum?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
}

// Regressions, compared with deco-cx/deco's admin:
// - A section's `page: ProductListingPage` never offered the commerce
//   `listingPage.ts` extension wrapper (every PLP's stored value), because the
//   wrapper was emitted but not registered as returning what it wraps.
// - The wrapper's `extensions` list offered nothing: the site's extension
//   loaders (`ExtensionOf<ProductListingPage>`) were never collected.
// - A loader's own props never got loader pickers: loader input schemas were
//   built before the loader output map existed, so an extension's
//   `products: Product[]` was a bare array with no way to pick a product loader.
describe("generate-schema loader props and commerce extension wrappers", () => {
  let fixture: string;
  let meta: any;

  const WRAPPER = "commerce/loaders/product/extensions/listingPage.ts";
  const EXTENSION = "site/loaders/extensions/injectProducts.ts";

  beforeAll(() => {
    fixture = mkdtempSync(path.join(tmpdir(), "schema-loader-props-"));
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
      `export interface Product { productID: string; name: string; }
       export interface ProductListingPage { products: Product[]; }
       export type ExtensionOf<T> = (data: T) => T | Promise<T>;
       export interface Settings { ids: string[]; }`,
    );
    write(
      "src/loaders/plp.ts",
      `import type { ProductListingPage } from "../types";
       export interface Props { query: string; }
       export default async function plp(_p: Props): Promise<ProductListingPage | null> { return null; }`,
    );
    write(
      "src/loaders/productList.ts",
      `import type { Product } from "../types";
       /** @title Product list */
       export default function productList(): Product[] { return []; }`,
    );
    write(
      "src/loaders/settings.ts",
      `import type { Settings } from "../types";
       export interface Props { fallback?: Settings; }
       /** @title Global settings */
       export default function settings(_p: Props): Settings { return { ids: [] }; }`,
    );
    write(
      "src/loaders/extensions/injectProducts.ts",
      `import type { ExtensionOf, Product, ProductListingPage, Settings } from "../../types";
       export interface Props {
         products: Product[] | null;
         settings?: Settings | null;
         /** @title Add to the end */
         append?: boolean;
       }
       /** @title Inject products */
       export default async function injectProducts(
         _p: Props,
       ): Promise<ExtensionOf<ProductListingPage | null>> { return (page) => page; }`,
    );
    write(
      "src/sections/Search.tsx",
      `import type { ProductListingPage } from "../types";
       export interface Props { page: ProductListingPage | null; }
       export default function Search(_props: Props) { return null; }`,
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
  const ref = (key: string) => ({ $ref: `#/definitions/${btoa(key)}` });
  const loaderBranch = (key: string, title: string) => ({
    title,
    type: "object",
    allOf: [ref(key)],
    required: ["__resolveType"],
    properties: { __resolveType: { type: "string", enum: [key], default: key } },
  });

  it("offers the listingPage wrapper on a section's ProductListingPage prop", () => {
    const section = def(btoa("site/sections/Search.tsx"));
    const propsRef = section.allOf!.find((part) => part.$ref)!.$ref!;
    const page = def(propsRef.replace("#/definitions/", "")).properties!.page;
    expect(page.anyOf).toEqual([
      { $ref: "#/definitions/Resolvable" },
      ref("site/loaders/plp.ts"),
      ref(WRAPPER),
    ]);
  });

  it("lists the site's extension loaders in the wrapper's extensions", () => {
    const wrapper = def(btoa(WRAPPER));
    expect(wrapper.properties!.extensions.items!.anyOf).toEqual([
      { $ref: "#/definitions/Resolvable" },
      ref(EXTENSION),
    ]);
    // `data` still offers only the base loaders, never the wrapper itself.
    expect(wrapper.properties!.data.anyOf).toEqual([
      { $ref: "#/definitions/Resolvable" },
      ref("site/loaders/plp.ts"),
    ]);
  });

  it("titles a site loader by its @title", () => {
    expect(def(btoa(EXTENSION)).title).toBe("Inject products");
    expect(def(btoa("site/loaders/plp.ts")).title).toBe("site/loaders/plp.ts");
  });

  it("keeps a loader prop inline and offers the loaders of its type beside it", () => {
    const props = def(btoa(EXTENSION)).properties!;
    const [inline, ...loaders] = props.products.anyOf!;
    expect(inline.type).toBe("array");
    expect(inline.items?.properties?.productID.type).toBe("string");
    expect(loaders).toEqual([loaderBranch("site/loaders/productList.ts", "Product list")]);

    const [inlineSettings, ...settingsLoaders] = props.settings.anyOf!;
    expect(inlineSettings.properties?.ids.type).toBe("array");
    expect(settingsLoaders).toEqual([loaderBranch("site/loaders/settings.ts", "Global settings")]);

    expect(props.append).toMatchObject({ type: "boolean", title: "Add to the end" });
  });

  it("never offers a loader in its own props", () => {
    const fallback = def(btoa("site/loaders/settings.ts")).properties!.fallback;
    expect(fallback.anyOf).toBeUndefined();
    expect(fallback.properties?.ids.type).toBe("array");
  });
});
