import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Schema {
  type?: string;
  $ref?: string;
  allOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
}

interface Meta {
  manifest: { blocks: { loaders: Record<string, Schema>; apps: Record<string, Schema> } };
  schema: { definitions: Record<string, Schema> };
}

describe("generate-schema workspace app packages", () => {
  let workspace: string;
  let site: string;

  function write(relative: string, contents: string) {
    const file = path.join(workspace, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }

  function installApp(base: string, field: string) {
    const directory = `${base}/node_modules/@decocms/apps-catalog`;
    write(
      `${directory}/package.json`,
      JSON.stringify({
        name: "@decocms/apps-catalog",
        version: "1.0.0",
        type: "module",
        exports: { "./mod": "./src/mod.ts" },
      }),
    );
    write(
      `${directory}/src/mod.ts`,
      `export interface Props { account: string; }
       export default function app(_props: Props) { return {}; }`,
    );
    write(
      `${directory}/src/loaders/product.ts`,
      `export interface Props {
         ${field}: string;
         limit?: number;
       }
       export interface Product { sku: string; }
       export default function loader(_props: Props): Product {
         throw new Error("Fixture loaders must never execute during generation");
       }`,
    );
  }

  function runGenerator(script: string, args: string[] = []): string {
    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), path.resolve(__dirname, script), ...args],
      { cwd: site, encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    return result.stdout;
  }

  function readMeta(): Meta {
    return JSON.parse(readFileSync(path.join(site, ".deco/meta.gen.json"), "utf8"));
  }

  function generate(): Meta {
    runGenerator("generate-schema.ts");
    return readMeta();
  }

  function definition(meta: Meta, reference: Schema): Schema {
    expect(reference?.$ref).toBeDefined();
    return meta.schema.definitions[reference.$ref!.replace("#/definitions/", "")];
  }

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "schema-workspaces-"));
    site = path.join(workspace, "apps/website");
    write("package.json", JSON.stringify({ private: true, workspaces: ["apps/*"] }));
    write(
      "apps/website/package.json",
      JSON.stringify({
        name: "@example/website",
        private: true,
        dependencies: { "@decocms/apps-catalog": "1.0.0" },
      }),
    );
    write(
      "apps/website/tsconfig.json",
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
      "apps/website/src/apps/catalog.ts",
      'export { default } from "@decocms/apps-catalog/mod";',
    );
    mkdirSync(path.join(site, "src/sections"), { recursive: true });
  });

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it("emits loaders and their Props from an app hoisted above the website", () => {
    installApp(".", "productId");

    const meta = generate();
    const loader = definition(meta, meta.manifest.blocks.loaders["catalog/loaders/product.ts"]);
    expect(loader.properties).toMatchObject({
      productId: { type: "string" },
      limit: { type: "number" },
    });
    expect(loader.required).toEqual(["__resolveType", "productId"]);

    const app = definition(meta, meta.manifest.blocks.apps["site/apps/catalog.ts"]);
    const props = definition(meta, app.allOf!.find((part) => part.$ref)!);
    expect(props.properties?.account).toMatchObject({ type: "string" });
    expect(props.required).toEqual(["account"]);
  }, 30_000);

  it("uses the nearest app package without merging loaders from the hoisted copy", () => {
    installApp(".", "parentProductId");
    write(
      "node_modules/@decocms/apps-catalog/src/loaders/parentOnly.ts",
      "export default function loader(): string { return 'parent'; }",
    );
    installApp("apps/website", "localProductId");

    const meta = generate();
    const loader = definition(meta, meta.manifest.blocks.loaders["catalog/loaders/product.ts"]);
    expect(loader.properties?.localProductId).toMatchObject({ type: "string" });
    expect(loader.properties?.parentProductId).toBeUndefined();
    expect(loader.required).toEqual(["__resolveType", "localProductId"]);
    expect(meta.manifest.blocks.loaders["catalog/loaders/parentOnly.ts"]).toBeUndefined();
  }, 30_000);

  it("invalidates a warm schema cache when hoisted loader Props change at the same version", () => {
    installApp(".", "productId");
    const args = ["--only", "schema"];
    const key = "catalog/loaders/product.ts";
    const first = runGenerator("generate.ts", args);
    expect(first).toMatch(/\[generate\] schema \d+ms \(fresh\)/);
    const before = readMeta();
    expect(
      definition(before, before.manifest.blocks.loaders[key]).properties?.productId,
    ).toMatchObject({ type: "string" });

    const warm = runGenerator("generate.ts", args);
    expect(warm).toMatch(/\[generate\] schema \d+ms \(cached(?:, content-verified)?\)/);

    // A linked/workspace app can change its source without a version bump.
    // Only the hoisted loader changes; the site and package manifest stay put.
    const relative = "node_modules/@decocms/apps-catalog/src/loaders/product.ts";
    const source = readFileSync(path.join(workspace, relative), "utf8");
    write(relative, source.replace("productId: string;", "productId: number; category?: string;"));

    const updated = runGenerator("generate.ts", args);
    expect(updated).toMatch(/\[generate\] schema \d+ms \(fresh\)/);
    const after = readMeta();
    const loader = definition(after, after.manifest.blocks.loaders[key]);
    expect(loader.properties).toMatchObject({
      productId: { type: "number" },
      category: { type: "string" },
    });
    expect(loader.required).toEqual(["__resolveType", "productId"]);
  }, 30_000);
});
