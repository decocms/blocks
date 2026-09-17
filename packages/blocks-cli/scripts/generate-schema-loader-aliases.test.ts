import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface Schema {
  type?: string;
  $ref?: string;
  allOf?: Schema[];
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
}

// Exercise loader discovery AND prop matching through the real CLI. A context
// pre-seeded with "Settings" would miss the bug in output-type registration.
describe("generate-schema named loader aliases", () => {
  let fixture: string;
  let props: Schema;

  beforeAll(() => {
    fixture = mkdtempSync(path.join(tmpdir(), "schema-loader-aliases-"));
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
      `export interface Config { title: string; modules: unknown; }
       export type Settings = Omit<Config, "modules">;
       export type Picked = Pick<Config, "title">;
       export type Plain = { label: string };
       export type Tree = { id: string; children?: Tree[] };
       export type Generic<T> = { value: T };
       export interface Product { productID: string; }
       export interface Collection { label: string; settings: Settings; }
       export type Unrelated = { title: string };`,
    );
    const loaders: Record<string, string> = {
      settings: "Settings",
      nullable: "Promise<Settings | null>",
      picked: "Picked",
      plain: "Plain",
      list: "Promise<Settings[] | null>",
      tree: "Tree",
      products: "Product[]",
      anonymous: "{ title: string }",
      anonymousList: "{ label: string }[]",
      strings: "string[]",
      directOmit: 'Omit<Config, "title">',
      generic: "Generic<string>",
    };
    for (const [name, output] of Object.entries(loaders)) {
      write(
        `src/loaders/${name}.ts`,
        `import type { Config, Settings, Picked, Plain, Tree, Generic, Product } from "../types";
         export default function load(): ${output} { throw new Error("fixture only"); }`,
      );
    }
    write(
      "src/sections/Example.tsx",
      `import type { Config, Settings as SiteSettings, Picked, Plain, Tree,
         Generic, Product, Collection, Unrelated } from "../types";
       export interface Props {
         settings: SiteSettings;
         picked?: Picked | null;
         plain: Plain;
         list: SiteSettings[];
         nullableList?: Array<SiteSettings> | null;
         tree: Tree;
         products: Product[];
         collections: Collection[];
         anonymous: { title: string };
         anonymousList: { other: number }[];
         strings: string[];
         unrelated: Unrelated;
         directOmit: Omit<Config, "modules">;
         generic: Generic<number>;
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
    const meta = JSON.parse(readFileSync(path.join(fixture, ".deco/meta.gen.json"), "utf8"));
    const section = meta.schema.definitions[btoa("site/sections/Example.tsx")];
    const ref = section.allOf.find((part: Schema) => part.$ref).$ref;
    props = meta.schema.definitions[ref.replace("#/definitions/", "")];
  }, 30_000);

  afterAll(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  function field(name: string): Schema {
    const schema = props.properties?.[name];
    expect(schema, name).toBeDefined();
    return schema!;
  }

  function inline(schema: Schema): Schema {
    return schema.anyOf?.find((branch) => branch.type) ?? schema;
  }

  function expectLoader(schema: Schema, name: string) {
    expect(schema.anyOf).toEqual(expect.arrayContaining([{ $ref: "#/definitions/Resolvable" }]));
    expect(schema.anyOf).toContainEqual({
      $ref: `#/definitions/${btoa(`site/loaders/${name}.ts`)}`,
    });
    expect(schema.properties).toBeUndefined();
    expect(schema.anyOf).not.toContainEqual({
      $ref: `#/definitions/${btoa("site/loaders/anonymousList.ts")}`,
    });
  }

  it("matches an imported Omit alias, including a nullable async loader", () => {
    expectLoader(field("settings"), "settings");
    expectLoader(field("settings"), "nullable");
    expect(props.required).toContain("settings");
  });

  it("matches Pick and plain object aliases without changing optionality", () => {
    expectLoader(field("picked"), "picked");
    expectLoader(field("plain"), "plain");
    expect(props.required).not.toContain("picked");
  });

  it("matches aliases through arrays, Promise and nullable wrappers", () => {
    expectLoader(field("list"), "list");
    expectLoader(field("nullableList"), "list");
    expect(props.required).not.toContain("nullableList");
  });

  it("matches a recursive alias without expanding its fields", () => {
    expectLoader(field("tree"), "tree");
  });

  it("keeps named-interface array loaders working", () => {
    expectLoader(field("products"), "products");
  });

  it("keeps unrelated object arrays editable and resolves their nested settings", () => {
    const collections = inline(field("collections"));
    expect(collections.type).toBe("array");
    expect(collections.items?.properties?.label.type).toBe("string");
    expectLoader(collections.items!.properties!.settings, "settings");
  });

  it("does not collapse unrelated anonymous arrays into an __type[] bucket", () => {
    expect(inline(field("anonymousList")).items?.properties?.other.type).toBe("number");
  });

  it("does not register generic utility types or match different instantiations", () => {
    expect(inline(field("directOmit")).properties?.title.type).toBe("string");
    expect(inline(field("generic")).properties?.value.type).toBe("number");
  });

  it("does not match primitives, anonymous objects or unrelated named aliases", () => {
    expect(inline(field("strings")).items?.type).toBe("string");
    expect(inline(field("anonymous")).properties?.title.type).toBe("string");
    expect(inline(field("unrelated")).properties?.title.type).toBe("string");
  });
});
