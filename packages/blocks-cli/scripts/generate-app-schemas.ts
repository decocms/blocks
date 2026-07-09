#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * App Schema Generator — real loader/action props schemas for app packages.
 *
 * The admin builds a block's props form from `/deco/meta`'s
 * `schema.definitions[b64(key)]`. Site loaders get real schemas from
 * generate-schema.ts, but app loaders/actions (@decocms/apps-vtex, ...) were
 * only ever auto-registered as `__resolveType`-only stubs by
 * registerCommerceLoaders() — the admin couldn't render any form for them.
 *
 * This script runs at app-package build time (Props are TS types, erased at
 * runtime — this CANNOT run in the site) and emits a committed
 * `src/schemas.gen.ts` artifact mapping every CMS-reachable key to its real
 * props schema. The app's entrypoints feed it to registerAppSchemas()
 * (@decocms/blocks/cms), which beats the runtime stubs by key.
 *
 * Two key universes are covered, matching how keys reach the CMS at runtime:
 *
 * 1. File-path keys — `<ns>/loaders/<relpath>.ts` (+ bare alias): what
 *    commerceLoaders maps and site decofiles reference. Every file under
 *    src/loaders/ with a default export.
 * 2. Manifest-flattened keys — what setupApps() registers from
 *    src/manifest.gen.ts: `<moduleKey>` for a module's default export,
 *    `<moduleKey>/<fnName>` for named function exports (+ `.ts` siblings).
 *    e.g. "vtex/loaders/legacy" × `productListingPage` →
 *    "vtex/loaders/legacy/productListingPage". Covers actions too.
 *
 * Usage (from the app package root):
 *   bun ../blocks-cli/scripts/generate-app-schemas.ts [options]
 *
 * Options:
 *   --namespace   CMS namespace (default: derived from package.json name,
 *                 "@decocms/apps-<ns>" → "<ns>")
 *   --pkg         App package root (default: cwd)
 *   --out         Output file (default: src/schemas.gen.ts, relative to --pkg)
 */
import { type Symbol as MorphSymbol, Node, Project, type SourceFile, type Type } from "ts-morph";
import { getJsDocTags, typeToJsonSchema } from "./generate-schema";
import { isExcludedCodegenFile } from "./lib/codegenExclusions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors BlockPropsSchema in @decocms/blocks/cms — kept structural so this
 * script has no runtime dependency on the blocks package. */
export interface AppBlockPropsSchema {
  type?: "object";
  title?: string;
  description?: string;
  properties?: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
  /** Any other JSON Schema keyword or JSDoc passthrough tag (nullable, …). */
  [keyword: string]: any;
}

export interface AppSchemasResult {
  loaders: Record<string, AppBlockPropsSchema>;
  actions: Record<string, AppBlockPropsSchema>;
}

// ---------------------------------------------------------------------------
// Schema extraction helpers
// ---------------------------------------------------------------------------

/** Props whose declared type is any/unknown — the block DOES take input, we
 * just can't describe it. The stub shape keeps the admin's JSON editor. */
const UNKNOWN_PROPS: AppBlockPropsSchema = { type: "object", additionalProperties: true };
/** The block takes no input at all. Deliberately WITHOUT additionalProperties
 * so the admin can say "takes no input". */
const NO_PROPS: AppBlockPropsSchema = { type: "object", properties: {} };

/**
 * Normalize whatever typeToJsonSchema produced into a props-object schema.
 * Handlers are invoked with a single props object; a first parameter that
 * isn't object-shaped (e.g. `getCategoryTree(levels: number)`) can't be
 * described as a props form — fall back to the JSON-editor shape.
 */
function toPropsSchema(schema: any): AppBlockPropsSchema {
  if (!schema || typeof schema !== "object") return UNKNOWN_PROPS;
  // any/unknown → {} from typeToJsonSchema
  if (Object.keys(schema).length === 0) return UNKNOWN_PROPS;
  if (schema.type === "object" && schema.properties) return schema;
  // Record<string, T> → { type: "object", additionalProperties: <T> }
  if (schema.type === "object" && schema.additionalProperties !== undefined) {
    return { type: "object", additionalProperties: true };
  }
  if (schema.type === "object") return { ...schema, properties: schema.properties ?? {} };
  return UNKNOWN_PROPS;
}

/** Schema for a function's first parameter (a loader/action handler). */
function functionInputSchema(fnType: Type, location: Node): AppBlockPropsSchema | null {
  const callSigs = fnType.getCallSignatures();
  if (callSigs.length === 0) return null;
  const params = callSigs[0].getParameters();
  if (params.length === 0) return NO_PROPS;
  const paramType = params[0].getTypeAtLocation(location);
  if (paramType.isAny() || paramType.isUnknown()) return UNKNOWN_PROPS;
  return toPropsSchema(typeToJsonSchema(paramType));
}

/** Apply a symbol's JSDoc @title (slash-free only) and description. */
function applyDocMeta(schema: AppBlockPropsSchema, symbol: MorphSymbol): AppBlockPropsSchema {
  const tags = getJsDocTags(symbol);
  const title = tags.title && !tags.title.includes("/") ? tags.title : undefined;
  const description = tags.description;
  if (!title && !description) return schema;
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...schema,
  };
}

// ---------------------------------------------------------------------------
// Discovery 1: file-path-keyed loaders (src/loaders/**)
// ---------------------------------------------------------------------------

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__test__") continue;
      results.push(...walkTsFiles(full));
    } else if (
      !isExcludedCodegenFile(entry.name) &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      entry.name !== "index.ts" &&
      !entry.name.startsWith("_")
    ) {
      results.push(full);
    }
  }
  return results;
}

function extractFileLoaderSchema(sourceFile: SourceFile): AppBlockPropsSchema | null {
  const defaultSym = sourceFile.getDefaultExportSymbol();
  if (!defaultSym) return null; // barrel/utility module, not a loader file

  // Same extraction order as generate-schema.ts's app-loaders pass: a named
  // Props interface/alias wins over the default export's first parameter.
  let schema: any = null;
  const propsInterface = sourceFile.getInterface("Props");
  if (propsInterface) schema = typeToJsonSchema(propsInterface.getType());

  if (!schema) {
    const propsAlias = sourceFile.getTypeAlias("Props");
    if (propsAlias) schema = typeToJsonSchema(propsAlias.getType());
  }

  if (schema) return applyDocMeta(toPropsSchema(schema), defaultSym);

  const fnSchema = functionInputSchema(defaultSym.getTypeAtLocation(sourceFile), sourceFile);
  return fnSchema ? applyDocMeta(fnSchema, defaultSym) : NO_PROPS;
}

// ---------------------------------------------------------------------------
// Discovery 2: manifest-flattened keys (src/manifest.gen.ts)
// ---------------------------------------------------------------------------

/** moduleKey → absolute module file path, per manifest category. */
function parseManifestModules(manifestFile: SourceFile): {
  loaders: Map<string, string>;
  actions: Map<string, string>;
} {
  const result = { loaders: new Map<string, string>(), actions: new Map<string, string>() };

  // identifier → module specifier, from `import * as loaders_x from "./loaders/x"`
  const importMap = new Map<string, string>();
  for (const imp of manifestFile.getImportDeclarations()) {
    const ns = imp.getNamespaceImport();
    if (ns) importMap.set(ns.getText(), imp.getModuleSpecifierValue());
  }

  const manifestVar = manifestFile.getVariableDeclaration("manifest");
  let init = manifestVar?.getInitializer();
  while (init && Node.isAsExpression(init)) init = init.getExpression();
  if (!init || !Node.isObjectLiteralExpression(init)) return result;

  const manifestDir = path.dirname(manifestFile.getFilePath());
  for (const category of ["loaders", "actions"] as const) {
    const prop = init.getProperty(category);
    if (!prop || !Node.isPropertyAssignment(prop)) continue;
    const value = prop.getInitializer();
    if (!value || !Node.isObjectLiteralExpression(value)) continue;

    for (const entry of value.getProperties()) {
      if (!Node.isPropertyAssignment(entry)) continue;
      const keyNode = entry.getNameNode();
      const moduleKey = Node.isStringLiteral(keyNode) ? keyNode.getLiteralValue() : entry.getName();
      const ident = entry.getInitializer()?.getText();
      const spec = ident ? importMap.get(ident) : undefined;
      if (!spec?.startsWith(".")) continue;

      const base = path.resolve(manifestDir, spec);
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          result[category].set(moduleKey, candidate);
          break;
        }
      }
    }
  }
  return result;
}

/** Flatten a manifest module's function exports, mirroring setupApps():
 * default → moduleKey; named fn → `${moduleKey}/${fnName}`. */
function flattenModuleSchemas(
  moduleKey: string,
  sourceFile: SourceFile,
  into: Record<string, AppBlockPropsSchema>,
) {
  for (const sym of sourceFile.getExportSymbols()) {
    const name = sym.getName();
    const fnType = sym.getTypeAtLocation(sourceFile);
    const schema = functionInputSchema(fnType, sourceFile);
    if (!schema) continue; // type/constant export, not a handler

    const key = name === "default" ? moduleKey : `${moduleKey}/${name}`;
    into[key] = applyDocMeta(schema, sym);
  }
}

// ---------------------------------------------------------------------------
// Main generation
// ---------------------------------------------------------------------------

/** Add the `.ts` sibling for every bare key and vice versa, both pointing at
 * the same schema object — mirrors runtime alias registration. */
function withKeyAliases(
  schemas: Record<string, AppBlockPropsSchema>,
): Record<string, AppBlockPropsSchema> {
  const out: Record<string, AppBlockPropsSchema> = {};
  for (const [key, schema] of Object.entries(schemas)) {
    const bare = key.endsWith(".ts") ? key.slice(0, -3) : key;
    // Bare-key entry wins ties with a .ts entry for the same block — both
    // describe the same file, so any difference is extraction noise.
    out[bare] = out[bare] ?? schema;
    out[`${bare}.ts`] = out[`${bare}.ts`] ?? schema;
  }
  return out;
}

export function generateAppSchemas(pkgDir: string, namespace: string): AppSchemasResult {
  const project = new Project({
    tsConfigFilePath: path.join(pkgDir, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });

  const loaders: Record<string, AppBlockPropsSchema> = {};
  const actions: Record<string, AppBlockPropsSchema> = {};

  // Manifest-flattened keys first; file-path keys second so the more
  // path-accurate extraction wins any (same-file) collision.
  const manifestPath = path.join(pkgDir, "src", "manifest.gen.ts");
  if (fs.existsSync(manifestPath)) {
    const manifestFile = project.addSourceFileAtPath(manifestPath);
    const modules = parseManifestModules(manifestFile);
    for (const [category, into] of [
      ["loaders", loaders],
      ["actions", actions],
    ] as const) {
      for (const [moduleKey, filePath] of modules[category]) {
        try {
          flattenModuleSchemas(moduleKey, project.addSourceFileAtPath(filePath), into);
        } catch (e) {
          console.warn(`  ✗ manifest module ${moduleKey}: ${(e as Error).message}`);
        }
      }
    }
  }

  const loadersDir = path.join(pkgDir, "src", "loaders");
  for (const filePath of walkTsFiles(loadersDir)) {
    const rel = path.relative(loadersDir, filePath).replaceAll("\\", "/");
    const cmsKey = `${namespace}/loaders/${rel}`;
    try {
      const schema = extractFileLoaderSchema(project.addSourceFileAtPath(filePath));
      if (schema) loaders[cmsKey] = schema;
    } catch (e) {
      console.warn(`  ✗ loader ${cmsKey}: ${(e as Error).message}`);
    }
  }

  return {
    loaders: withKeyAliases(loaders),
    actions: withKeyAliases(actions),
  };
}

// ---------------------------------------------------------------------------
// Module rendering
// ---------------------------------------------------------------------------

/** Render the schemas.gen.ts module. Schemas are deduplicated: each unique
 * schema is emitted once and shared by all keys aliasing it. */
export function renderSchemasModule(result: AppSchemasResult): string {
  const constByJson = new Map<string, string>();
  const constDecls: string[] = [];

  const constFor = (schema: AppBlockPropsSchema): string => {
    const json = JSON.stringify(schema);
    let name = constByJson.get(json);
    if (!name) {
      name = `s${constByJson.size}`;
      constByJson.set(json, name);
      constDecls.push(`const ${name}: BlockPropsSchema = ${JSON.stringify(schema, null, "\t")};`);
    }
    return name;
  };

  const renderRecord = (schemas: Record<string, AppBlockPropsSchema>): string => {
    const entries = Object.keys(schemas)
      .sort()
      .map((key) => `\t${JSON.stringify(key)}: ${constFor(schemas[key])},`);
    return `{\n${entries.join("\n")}\n}`;
  };

  // Records must render before constDecls is final, but constDecls prints first.
  const loadersRecord = renderRecord(result.loaders);
  const actionsRecord = renderRecord(result.actions);

  return [
    "// AUTO-GENERATED by @decocms/blocks-cli scripts/generate-app-schemas.ts — DO NOT EDIT",
    "// Regenerate from this package's root: bun run generate:schemas",
    "//",
    "// Real props schemas for this app's loaders/actions, keyed by CMS key",
    "// (both bare and `.ts` forms). Registered into the admin meta via",
    "// registerAppSchemas() so the Studio can render real props forms instead",
    "// of the __resolveType-only stubs from registerCommerceLoaders().",
    'import type { BlockPropsSchema } from "@decocms/blocks/cms/client";',
    "",
    ...constDecls,
    "",
    `export const loaderSchemas: Record<string, BlockPropsSchema> = ${loadersRecord};`,
    "",
    `export const actionSchemas: Record<string, BlockPropsSchema> = ${actionsRecord};`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  const arg = (name: string, fallback: string): string => {
    const idx = argv.indexOf(`--${name}`);
    return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : fallback;
  };

  const pkgDir = path.resolve(arg("pkg", process.cwd()));
  const pkgJsonPath = path.join(pkgDir, "package.json");
  const pkgName: string = fs.existsSync(pkgJsonPath)
    ? (JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")).name ?? "")
    : "";
  const defaultNamespace = pkgName.match(/^@decocms\/apps-(.+)$/)?.[1] ?? "";
  const namespace = arg("namespace", defaultNamespace);
  if (!namespace) {
    console.error(
      "Could not derive --namespace from package.json (expected @decocms/apps-<ns>); pass --namespace explicitly.",
    );
    process.exit(1);
  }

  const outPath = path.resolve(pkgDir, arg("out", "src/schemas.gen.ts"));
  const result = generateAppSchemas(pkgDir, namespace);
  fs.writeFileSync(outPath, renderSchemasModule(result));

  const count = (r: Record<string, unknown>) => Object.keys(r).length;
  console.log(
    `Generated ${count(result.loaders)} loader keys, ${count(result.actions)} action keys → ${path.relative(pkgDir, outPath)}`,
  );
}
