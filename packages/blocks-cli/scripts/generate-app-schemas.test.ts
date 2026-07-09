/**
 * Tests for generate-app-schemas.ts — the build-time extractor that gives app
 * packages (apps-vtex, …) real loader/action props schemas in the admin meta,
 * replacing the `__resolveType`-only stubs auto-registered at runtime.
 *
 * Drives generateAppSchemas() directly (the script is import-safe, guarded by
 * isMainModule()) against a tmp fixture app package covering both key
 * universes: file-path loader keys and manifest-flattened module keys.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AppSchemasResult,
  generateAppSchemas,
  renderSchemasModule,
} from "./generate-app-schemas";

let tmpDir: string;
let result: AppSchemasResult;

function write(rel: string, content: string) {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-app-schemas-"));

  write(
    "package.json",
    JSON.stringify({ name: "@decocms/apps-fixture", version: "0.0.0", type: "module" }),
  );
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022", "DOM"],
        strict: true,
      },
    }),
  );

  // File-path-keyed loader with a Props interface + JSDoc metadata.
  write(
    "src/loaders/detail/page.ts",
    `export interface Props {
  /** @title Slug */
  slug?: string;
  /** @description How many variants to fetch */
  variantCount: number;
}
export default async function loader(props: Props): Promise<string | null> {
  return props.slug ?? null;
}
`,
  );

  // Loader that takes no input at all.
  write(
    "src/loaders/noProps.ts",
    `export default async function loader(): Promise<number> {
  return 1;
}
`,
  );

  // Loader whose props are untyped — input exists but can't be described.
  write(
    "src/loaders/anyProps.ts",
    `export default async function loader(props: any): Promise<unknown> {
  return props;
}
`,
  );

  // Runtime-injected platform types (url: URL) must be hidden, not expanded,
  // and must not stay required.
  write(
    "src/loaders/listing.ts",
    `export interface Props {
  url: URL;
  sort?: "asc" | "desc";
  count: number;
}
export default async function loader(props: Props): Promise<unknown[]> {
  return [props];
}
`,
  );

  // Barrel — must not become a loader key.
  write("src/loaders/index.ts", `export { default as page } from "./detail/page";\n`);

  // Manifest module with named exports → flattened keys.
  write(
    "src/actions/cart.ts",
    `export interface AddItemProps {
  id: string;
  qty?: number;
}
/** @title Add item to cart */
export async function addItem(props: AddItemProps): Promise<string> {
  return props.id;
}
export async function clearCart(): Promise<void> {}
export type IgnoredType = { nope: true };
export const IGNORED_CONST = 42;
`,
  );
  write(
    "src/loaders/things.ts",
    `export async function listThings(props: { filter?: string }): Promise<string[]> {
  return [props.filter ?? ""];
}
export default async function defaultThings(props: { limit: number }): Promise<string[]> {
  return [String(props.limit)];
}
`,
  );
  write(
    "src/manifest.gen.ts",
    `import * as actions_cart from "./actions/cart";
import * as loaders_things from "./loaders/things";

const manifest = {
\tname: "fixture",
\tloaders: {
\t\t"fixture/loaders/things": loaders_things,
\t},
\tactions: {
\t\t"fixture/actions/cart": actions_cart,
\t},
\tsections: {},
} as const;

export default manifest;
`,
  );

  result = generateAppSchemas(tmpDir, "fixture");
}, 120_000);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("file-path-keyed loaders", () => {
  it("emits real props from the Props interface, under both bare and .ts keys", () => {
    const withTs = result.loaders["fixture/loaders/detail/page.ts"];
    const bare = result.loaders["fixture/loaders/detail/page"];
    expect(withTs).toBeDefined();
    expect(bare).toBe(withTs);

    expect(withTs.properties?.slug).toMatchObject({ type: "string", title: "Slug" });
    expect(withTs.properties?.variantCount).toMatchObject({
      type: "number",
      description: "How many variants to fetch",
    });
    expect(withTs.required).toEqual(["variantCount"]);
    expect(withTs.additionalProperties).toBeUndefined();
  });

  it("emits an empty-props schema WITHOUT additionalProperties for no-input loaders", () => {
    const schema = result.loaders["fixture/loaders/noProps.ts"];
    expect(schema).toEqual({ type: "object", properties: {} });
  });

  it("falls back to the JSON-editor shape (additionalProperties) for untyped props", () => {
    const schema = result.loaders["fixture/loaders/anyProps.ts"];
    expect(schema).toEqual({ type: "object", additionalProperties: true });
  });

  it("hides runtime-injected platform types and drops them from required", () => {
    const schema = result.loaders["fixture/loaders/listing.ts"];
    expect(schema.properties?.url).toMatchObject({ type: "object", hide: "true" });
    expect(schema.properties?.url.properties).toBeUndefined();
    expect(schema.properties?.sort).toMatchObject({ type: "string", enum: ["asc", "desc"] });
    expect(schema.required).toEqual(["count"]);
  });

  it("skips barrel index files", () => {
    expect(result.loaders["fixture/loaders/index.ts"]).toBeUndefined();
    expect(result.loaders["fixture/loaders/index"]).toBeUndefined();
  });
});

describe("manifest-flattened keys", () => {
  it("flattens named function exports to <moduleKey>/<fnName>", () => {
    const addItem = result.actions["fixture/actions/cart/addItem"];
    expect(addItem).toBeDefined();
    expect(result.actions["fixture/actions/cart/addItem.ts"]).toBe(addItem);
    expect(addItem.title).toBe("Add item to cart");
    expect(addItem.properties?.id).toMatchObject({ type: "string" });
    expect(addItem.required).toEqual(["id"]);
  });

  it("emits no-props actions without additionalProperties", () => {
    expect(result.actions["fixture/actions/cart/clearCart"]).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("ignores type and constant exports", () => {
    const keys = Object.keys(result.actions);
    expect(keys.filter((k) => k.includes("IgnoredType"))).toEqual([]);
    expect(keys.filter((k) => k.includes("IGNORED_CONST"))).toEqual([]);
  });

  it("registers a module's default export at the moduleKey itself", () => {
    const def = result.loaders["fixture/loaders/things"];
    expect(def.properties?.limit).toMatchObject({ type: "number" });
    expect(result.loaders["fixture/loaders/things/listThings"].properties?.filter).toMatchObject({
      type: "string",
    });
  });
});

describe("renderSchemasModule", () => {
  it("emits a typed module with deduplicated schema consts shared across alias keys", () => {
    const out = renderSchemasModule(result);
    expect(out).toContain('import type { BlockPropsSchema } from "@decocms/blocks/cms/client";');
    expect(out).toContain("export const loaderSchemas: Record<string, BlockPropsSchema>");
    expect(out).toContain("export const actionSchemas: Record<string, BlockPropsSchema>");

    // Alias keys must point at the same const (dedup by content).
    const bare = out.match(/"fixture\/loaders\/detail\/page": (s\d+),/)?.[1];
    const withTs = out.match(/"fixture\/loaders\/detail\/page\.ts": (s\d+),/)?.[1];
    expect(bare).toBeDefined();
    expect(bare).toBe(withTs);
  });
});
