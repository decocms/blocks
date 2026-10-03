// @vitest-environment node
/**
 * Golden test: `deco schema` against a real storefront's types, compared with
 * the `meta.gen.json` the v7 generator wrote for the same code.
 *
 * The site is storefront-tanstack (a v7 site): set DECO_SCHEMA_GOLDEN_SITE to
 * a checkout with its dependencies installed, or keep one next to this
 * repository as `../storefront-tanstack`. Without it, the test is skipped.
 *
 * v7 had no block map; it scanned folders. The test writes the block map a
 * next-major port of that site would have: every v7 section and loader under
 * its v7 key, each bound to the file's default export. A v7 section that also
 * exported a `loader` had its form taken from the loader's input; in the next
 * major the block function is the one function, so the port binds those keys
 * to a function that takes the loader's input and renders the section.
 *
 * Intentional differences, normalized below:
 *
 * 1. A field that blocks can fill also takes a plain value (spec: schema ›
 *    From types to forms), so its union gains an "Inline data" branch next
 *    to `Resolvable` and the blocks. The blocks offered are the same: the
 *    TypeScript assignability rule reproduces v7's name match on this site.
 * 2. A section's wrapper carries its function's JSDoc description, for the
 *    site editor's gallery cards.
 * 3. Files without a default export (v7 registered every file it found:
 *    `sections/Component.tsx`, `loaders/_cookie.ts`) aren't blocks: a block
 *    map lists functions.
 * 4. The v7 generator synthesized the commerce "extension wrapper" loaders
 *    and wrote the site's app files as an `apps` group; neither is a block in
 *    the next major, which has no apps group.
 * 5. Sections whose v7 form came from an exported `loader` get their props
 *    definition keyed by block type instead of by file (they're bound to an
 *    inline function in the block map); the form itself is the same.
 *
 * Everything else, every field's type, title, description, enum, default,
 * format, nullability and required list, and every flat loader definition,
 * must match the committed file exactly.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decoPaths } from "../root";
import { type DecoMeta, generateSchema } from "./generate";
import { toBase64 } from "./typeToSchema";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE =
  process.env.DECO_SCHEMA_GOLDEN_SITE ??
  path.resolve(here, "../../../../../../../storefront-tanstack");
const available =
  fs.existsSync(path.join(SITE, ".deco/meta.gen.json")) &&
  fs.existsSync(path.join(SITE, "node_modules"));

const NOT_BLOCKS = new Set([
  "site/sections/Component.tsx",
  "site/loaders/_cookie.ts",
  "commerce/loaders/product/extensions/listingPage.ts",
  "commerce/loaders/product/extensions/detailsPage.ts",
]);

/** Remove the plain-value branch the next major adds to block-ref unions. */
function withoutInline(node: any): any {
  if (Array.isArray(node)) return node.map(withoutInline);
  if (!node || typeof node !== "object") return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] =
      k === "anyOf"
        ? (v as any[]).filter((b) => b?.title !== "Inline data").map(withoutInline)
        : withoutInline(v);
  }
  return out;
}

describe.skipIf(!available)("schema golden: storefront-tanstack", () => {
  let v7: any;
  let v8: DecoMeta;
  let dir: string;
  const b64 = toBase64;

  beforeAll(async () => {
    v7 = JSON.parse(fs.readFileSync(path.join(SITE, ".deco/meta.gen.json"), "utf8"));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "deco-golden-"));
    const imports: string[] = [];
    const entries: string[] = [];
    let i = 0;
    const bind = (key: string, modulePath: string) => {
      const id = `m${i++}`;
      const file = [".tsx", ".ts"].map((ext) => modulePath + ext).find((f) => fs.existsSync(f));
      const source = file ? fs.readFileSync(file, "utf8") : "";
      const exportsLoader =
        /export (\{[^}]*\bloader\b|async function loader|function loader|const loader)/.test(
          source,
        );
      if (key.startsWith("site/sections/") && exportsLoader) {
        imports.push(`import * as ${id} from ${JSON.stringify(modulePath)};`);
        entries.push(
          `  ${JSON.stringify(key)}: (props: Parameters<typeof ${id}.loader>[0]) => ${id}.default(null as any),`,
        );
      } else {
        imports.push(`import ${id} from ${JSON.stringify(modulePath)};`);
        entries.push(`  ${JSON.stringify(key)}: ${id},`);
      }
    };
    const strip = (p: string) => p.replace(/\.tsx?$/, "");
    for (const key of Object.keys(v7.manifest.blocks.sections)) {
      if (!NOT_BLOCKS.has(key)) bind(key, strip(path.join(SITE, "src", key.slice("site/".length))));
    }
    for (const key of Object.keys(v7.manifest.blocks.loaders)) {
      if (NOT_BLOCKS.has(key)) continue;
      if (key.startsWith("site/"))
        bind(key, strip(path.join(SITE, "src", key.slice("site/".length))));
      else {
        const [app, ...rest] = key.split("/");
        bind(
          key,
          strip(path.join(SITE, "node_modules/@decocms", `apps-${app}`, "src", rest.join("/"))),
        );
      }
    }
    const blockMap = path.join(dir, "index.tsx");
    fs.writeFileSync(
      blockMap,
      `${imports.join("\n")}\n\nexport default {\n${entries.join("\n")}\n};\n`,
    );
    // The site's own root and tsconfig, with this block map instead of its .deco/index.ts.
    const paths = { ...decoPaths(SITE), deco: dir, blockMapCandidates: [blockMap] };
    ({ meta: v8 } = await generateSchema(paths));
  }, 120_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("registers every v7 section and loader under the same key and group", () => {
    for (const group of ["sections", "loaders"]) {
      const expected = Object.keys(v7.manifest.blocks[group]).filter((k) => !NOT_BLOCKS.has(k));
      expect(Object.keys(v8.manifest.blocks[group])).toEqual(expect.arrayContaining(expected));
      for (const key of expected) {
        expect(v8.manifest.blocks[group][key]).toEqual(v7.manifest.blocks[group][key]);
      }
    }
  });

  it("writes every section's form as v7 did", () => {
    const d7 = v7.schema.definitions;
    const d8 = v8.schema.definitions;
    for (const key of Object.keys(v7.manifest.blocks.sections)) {
      if (NOT_BLOCKS.has(key)) continue;
      const w7 = d7[b64(key)];
      const w8 = d8[b64(key)];
      const { allOf: a7, ...rest7 } = w7;
      const { allOf: a8, description: _description, icon: _icon, image: _image, ...rest8 } = w8;
      expect(rest8, key).toEqual(rest7);
      const props7 = d7[a7[0].$ref.split("/").pop()];
      const props8 = d8[a8[0].$ref.split("/").pop()];
      expect(withoutInline(props8), key).toEqual(props7);
    }
  });

  it("keys a section's props by its file, as v7 did, when the block is the file's default export", () => {
    const key = "site/sections/Content/Hero.tsx";
    expect(v8.schema.definitions[b64(key)].allOf).toEqual(v7.schema.definitions[b64(key)].allOf);
  });

  it("writes every loader's flat definition as v7 did", () => {
    for (const key of Object.keys(v7.manifest.blocks.loaders)) {
      if (NOT_BLOCKS.has(key)) continue;
      expect(withoutInline(v8.schema.definitions[b64(key)]), key).toEqual(
        v7.schema.definitions[b64(key)],
      );
    }
  });

  it("offers the same blocks for each block-ref field as v7's name match did", () => {
    const refs = (node: any, out: string[] = []): string[] => {
      if (Array.isArray(node)) for (const n of node) refs(n, out);
      else if (node && typeof node === "object") {
        if (Array.isArray(node.anyOf) && node.anyOf[0]?.$ref === "#/definitions/Resolvable") {
          out.push(
            node.anyOf
              .filter((b: any) => b.title !== "Inline data")
              .map((b: any) => b.$ref)
              .join(","),
          );
        }
        for (const v of Object.values(node)) refs(v, out);
      }
      return out;
    };
    const productShelf = `${b64("src/sections/Product/ProductShelf.tsx")}@Props`;
    expect(refs(v8.schema.definitions[productShelf])).toEqual(
      refs(v7.schema.definitions[productShelf]),
    );
    expect(refs(v8.schema.definitions[productShelf])[0]).toContain(
      b64("shopify/loaders/ProductList.ts"),
    );
  });
});
