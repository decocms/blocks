/**
 * `deco schema`: reads the default export of `.deco/index.ts` (the block map)
 * and writes `.deco/schema.gen.json` in the site editor's format,
 * `deco-meta@1` (spec: schema; studio-compatibility › What the site editor
 * reads from the schema).
 *
 * The file has the shape of today's `meta.gen.json`, so the site editor reads
 * it unchanged: `manifest.blocks` groups every block type by kind,
 * `schema.definitions` holds one JSON Schema per type keyed by the padded
 * base64 of its name, and `schema.root` holds the per-group unions. It adds
 * `format` and the legacy alias table.
 */
import fs from "node:fs";
import path from "node:path";
import { createTsProject, type TsNode as Node, type TsType as Type } from "./tsProgram";
import { BUILT_IN_BLOCKS, type BuiltInBlock, LEGACY_ALIASES } from "../builtins";
import { CliError, type DecoPaths } from "../root";
import {
  BUILT_IN_GROUPS,
  builtInDefinition,
  flatDefinition,
  legacyMultivariateValue,
  type ManifestGroup,
} from "./builtinSchemas";
import {
  awaitedOf,
  getJsDocTags,
  isJsxType,
  nonNullable,
  RESOLVABLE_KEY,
  type SchemaContext,
  SECTION_REF_KEY,
  stableFileId,
  toBase64,
  typeToJsonSchema,
} from "./typeToSchema";

export const SCHEMA_FORMAT = "deco-meta@1";

const MANIFEST_GROUPS: ManifestGroup[] = [
  "sections",
  "loaders",
  "matchers",
  "pages",
  "redirects",
  "content",
];

type ManifestEntry = { $ref: string; namespace: string };

export interface DecoMeta {
  major: 1;
  version: string;
  namespace: string;
  site: string;
  manifest: { blocks: Record<string, Record<string, ManifestEntry>> };
  schema: {
    definitions: Record<string, any>;
    root: Record<string, { anyOf: any[] }>;
  };
  /** The format name; the content protocol's `describe` reports the same. */
  format: typeof SCHEMA_FORMAT;
  /**
   * Set so v7's runtime `composeMeta()` treats the file as already composed
   * and serves it unchanged.
   */
  framework: string;
  /** The alias table: legacy type name → the block type it names. */
  aliases: Record<string, string>;
}

export interface SchemaDiagnostic {
  severity: "error" | "warning";
  message: string;
}

export interface SchemaResult {
  meta: DecoMeta;
  diagnostics: SchemaDiagnostic[];
  /** The block map file that was read. */
  blockMap: string;
}

interface BlockInfo {
  key: string;
  group: ManifestGroup;
  propsType: Type | undefined;
  /** The awaited return type. */
  returnType: Type;
  /** The `@Props` definition key, shared by every key bound to one function. */
  propsKey: string;
  docs: Record<string, string>;
}

const BUILT_IN_TYPES_SOURCE = `
export interface Seo { title: string; description: string }
export interface Route { name: string; path: string }
`;

/** The package version, written into the schema's `version`. */
function packageVersion(): string {
  try {
    const manifest = new URL("../../../../package.json", import.meta.url);
    return JSON.parse(fs.readFileSync(manifest, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function siteName(root: string): string {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name;
    if (typeof name === "string" && name) return name;
  } catch {
    // no package.json: use the folder name
  }
  return path.basename(root);
}

/** JSDoc on a block function: its declaration, or the `const` an arrow is assigned to. */
function functionDocs(declaration: Node | undefined): Record<string, string> {
  const tags: Record<string, string> = {};
  let node: Node | undefined = declaration;
  for (let depth = 0; node && depth < 3; depth++, node = node.getParent()) {
    for (const doc of node.getJsDocs()) {
      const desc = doc.getDescription().trim();
      if (desc && !tags.description) tags.description = desc;
      for (const tag of doc.getTags()) {
        tags[tag.getTagName()] ??= tag.getCommentText()?.trim() || "true";
      }
    }
  }
  return tags;
}

/** The block-level JSDoc the site editor shows on gallery cards. */
function blockExtras(docs: Record<string, string>): Record<string, string> {
  const extras: Record<string, string> = {};
  for (const tag of ["description", "icon", "image"] as const) {
    if (docs[tag]) extras[tag] = docs[tag];
  }
  return extras;
}

function isBooleanType(type: Type): boolean {
  if (type.isBoolean() || type.isBooleanLiteral()) return true;
  return type.isUnion() && type.getUnionTypes().every((t) => t.isBooleanLiteral());
}

/** A render descriptor (spec: rendering): `{ component: string; props: … }`. */
function isDescriptorType(type: Type): boolean {
  const check = (t: Type) => {
    const component = t.getProperty("component");
    return component !== undefined && t.getProperty("props") !== undefined;
  };
  if (type.isUnion()) return type.getUnionTypes().every((t) => check(t));
  return type.isObject() && check(type);
}

function sameType(a: Type, b: Type): boolean {
  return a === b || a.compilerType === b.compilerType || a.getText() === b.getText();
}

function findBlockMap(paths: DecoPaths): string {
  const file = paths.blockMapCandidates.find((candidate) => fs.existsSync(candidate));
  if (!file) {
    throw new CliError(
      `no .deco/index.ts (or .deco/index.tsx) in ${paths.root}; it holds your block map`,
    );
  }
  return file;
}

/** Generate the schema for a root. Throws `CliError` when the block map can't be read. */
export async function generateSchema(paths: DecoPaths): Promise<SchemaResult> {
  const blockMap = findBlockMap(paths);
  const root = paths.root;
  const builtInTypesFile = path.join(paths.deco, "__deco_builtin_types__.ts");
  const project = await createTsProject(root, [blockMap], {
    [builtInTypesFile]: BUILT_IN_TYPES_SOURCE,
  });
  const builtInTypes = project.sourceFile(builtInTypesFile);
  const seoType = builtInTypes.getInterfaceType("Seo");
  const routeType = builtInTypes.getInterfaceType("Route");
  const source = project.sourceFile(blockMap);
  const diagnostics: SchemaDiagnostic[] = [];
  const relMap = path.relative(root, blockMap).split(path.sep).join("/");

  const defaultExport = source.getDefaultExportSymbol();
  if (!defaultExport) {
    throw new CliError(`${relMap}: no default export; export your block map as the default`);
  }
  const mapType = defaultExport.getTypeAtLocation(source);

  // -------------------------------------------------------------------------
  // 1. Read every key: its props, its awaited return type and its group.
  // -------------------------------------------------------------------------
  const infos: BlockInfo[] = [];
  for (const prop of mapType.getProperties()) {
    const key = prop.getName();
    const valueType = prop.getTypeAtLocation(source);
    const [signature] = valueType.getCallSignatures();
    if (!signature) {
      diagnostics.push({ severity: "error", message: `${relMap}: "${key}" isn't a function` });
      continue;
    }
    const [param] = signature.getParameters();
    const propsType = param ? param.getTypeAtLocation(source) : undefined;
    const returnType = awaitedOf(signature.getReturnType()) ?? signature.getReturnType();
    const declaration = signature.getDeclaration();

    if (propsType?.isAny()) {
      diagnostics.push({
        severity: "warning",
        message: `"${key}": its props are typed any, so its form is empty`,
      });
    }
    const usableReturn = !returnType.isAny() && !returnType.isUnknown();
    if (!usableReturn) {
      diagnostics.push({
        severity: "warning",
        message: `"${key}": returns any, so it isn't offered for any field`,
      });
    }

    const ret = nonNullable(returnType);
    let group: ManifestGroup;
    if (key === "page") group = "pages";
    else if (key === "redirect") group = "redirects";
    else if (usableReturn && (isJsxType(ret) || isDescriptorType(ret))) group = "sections";
    else if (usableReturn && isBooleanType(ret)) group = "matchers";
    else if (propsType && usableReturn && sameType(returnType, propsType)) {
      group = propsType.isAssignableTo(routeType) ? "pages" : "content";
    } else group = "loaders";

    // Spec: routing. `path` makes an entry routable, so it must be intentional.
    if (
      propsType?.getProperty("path") &&
      key !== "redirect" &&
      !propsType.isAssignableTo(routeType)
    ) {
      diagnostics.push({
        severity: "error",
        message: `"${key}": has a "path" field but its type doesn't extend Route (name: string; path: string)`,
      });
    }

    // Keys bound to one function (aliases) share its props definition. A
    // function that is the default export of its own file is keyed by that
    // file, as the v7 generator did.
    const declFile = declaration?.getSourceFile();
    let propsKey = `${toBase64(key)}@Props`;
    if (declFile && declFile !== source) {
      const fileDefault = declFile.getDefaultExportSymbol();
      const target = fileDefault?.isAlias() ? fileDefault.getAliasedSymbol() : fileDefault;
      const declNodes = target?.getDeclarations() ?? [];
      const isDefault = declaration
        ? declNodes.some((n) => n === declaration || n.contains(declaration))
        : false;
      if (isDefault) propsKey = `${toBase64(stableFileId(declFile.getFilePath(), root))}@Props`;
    }

    infos.push({
      key,
      group,
      propsType,
      returnType,
      propsKey,
      docs: { ...functionDocs(declaration), ...getJsDocTags(prop) },
    });
  }

  // -------------------------------------------------------------------------
  // 2. Fields → blocks: which functions' return types fit an object field.
  // -------------------------------------------------------------------------
  const STRUCTURAL = new Set<string>(["lazy", "multivariate", "secret", "always", "never", "date"]);
  const candidates = infos.filter(
    (info) =>
      info.group !== "sections" &&
      info.group !== "matchers" &&
      !STRUCTURAL.has(info.key) &&
      !info.returnType.isAny() &&
      !info.returnType.isUnknown() &&
      !nonNullable(info.returnType).isNever(),
  );
  const fitCache = new Map<unknown, string[]>();
  const definitions: Record<string, any> = {};

  const ctx: SchemaContext = {
    root,
    fitting(type) {
      const target = nonNullable(type);
      if (target.isAny() || target.isUnknown()) return [];
      const cached = fitCache.get(target.compilerType);
      if (cached) return cached;
      const keys = candidates
        .filter((c) => returnFits(c.returnType, target))
        .map((c) => toBase64(c.key));
      fitCache.set(target.compilerType, keys);
      return keys;
    },
    namedDefinition(type) {
      const t = nonNullable(type);
      if (t.isArray() || t.getAliasTypeArguments().length > 0 || t.getTypeArguments().length > 0) {
        return null;
      }
      const symbol = t.getAliasSymbol() ?? t.getSymbol();
      const name = symbol?.getName();
      const file = symbol?.getDeclarations()[0]?.getSourceFile().getFilePath();
      if (!name || !file || name.startsWith("__") || !(t.isObject() || t.isInterface()))
        return null;
      const key = `${toBase64(stableFileId(file, root))}@${name}`;
      if (!(key in definitions)) {
        definitions[key] = { type: "object" }; // placeholder for recursive types
        definitions[key] = typeToJsonSchema(t, new Set(), { ...ctx, shareNamed: { rootType: t } });
      }
      return { $ref: `#/definitions/${key}` };
    },
  };

  // -------------------------------------------------------------------------
  // 3. Definitions, manifest and root unions.
  // -------------------------------------------------------------------------
  const resolvable = {
    title: "Select from saved",
    type: "object",
    required: ["__resolveType"],
    additionalProperties: true,
    properties: { __resolveType: { type: "string" } },
  };
  definitions[RESOLVABLE_KEY] = resolvable;
  definitions[toBase64(RESOLVABLE_KEY)] = resolvable;

  const manifest: Record<string, Record<string, ManifestEntry>> = {};
  const unions: Record<string, { anyOf: any[] }> = {};
  for (const group of MANIFEST_GROUPS) {
    manifest[group] = {};
    unions[group] = { anyOf: [{ $ref: `#/definitions/${RESOLVABLE_KEY}` }] };
  }

  const declared = new Set(infos.map((i) => i.key));
  for (const info of infos) {
    const defKey = toBase64(info.key);
    const props =
      info.propsType && !info.propsType.isAny()
        ? typeToJsonSchema(info.propsType, new Set(), ctx)
        : { type: "object", properties: {} };
    if (props.type !== "object") {
      diagnostics.push({
        severity: "warning",
        message: `"${info.key}": its first parameter isn't an object of props, so its form is empty`,
      });
      props.type = "object";
      props.properties = {};
      delete props.anyOf;
      delete props.items;
      delete props.enum;
      delete props.nullable;
    }
    const extras = blockExtras(info.docs);
    if (info.group === "sections") {
      definitions[info.propsKey] ??= props;
      definitions[defKey] = {
        title: info.docs.title && !info.docs.title.includes("/") ? info.docs.title : info.key,
        ...extras,
        type: "object",
        allOf: [{ $ref: `#/definitions/${info.propsKey}` }],
        required: ["__resolveType"],
        properties: { __resolveType: { type: "string", enum: [info.key], default: info.key } },
      };
      unions.sections.anyOf.push({
        $ref: `#/definitions/${defKey}`,
        inputSchema: `#/definitions/${info.propsKey}`,
      });
    } else {
      const title = info.docs.title && !info.docs.title.includes("/") ? info.docs.title : undefined;
      definitions[defKey] = flatDefinition(info.key, props, extras);
      if (title) definitions[defKey].title = title;
      unions[info.group].anyOf.push({ $ref: `#/definitions/${defKey}` });
    }
    manifest[info.group][info.key] = {
      $ref: `#/definitions/${defKey}`,
      namespace: namespaceOf(info.key),
    };
  }

  const seoRefs = ctx.fitting(seoType).map((key) => ({ $ref: `#/definitions/${key}` }));
  for (const name of BUILT_IN_BLOCKS) {
    if (declared.has(name)) continue;
    const group = BUILT_IN_GROUPS[name];
    const defKey = toBase64(name);
    definitions[defKey] = builtInDefinition(name, { seoRefs });
    manifest[group][name] = { $ref: `#/definitions/${defKey}`, namespace: "deco" };
    unions[group].anyOf.push({ $ref: `#/definitions/${defKey}` });
  }

  // The alias table: each legacy name gets a definition (the site editor
  // builds refs with btoa(name)) and a manifest entry (it tells a block type
  // from a saved block by manifest lookup), but no place in the root unions,
  // so pickers don't list a type twice.
  const aliases: Record<string, string> = {};
  for (const [alias, target] of Object.entries(LEGACY_ALIASES)) {
    if (declared.has(alias)) continue; // the block map's own key wins
    const targetDef = definitions[toBase64(target)];
    if (!targetDef) continue;
    const group = groupOf(target as BuiltInBlock, infos);
    const aliasDef = structuredClone(targetDef);
    aliasDef.title = alias;
    aliasDef.properties = {
      ...aliasDef.properties,
      __resolveType: { type: "string", enum: [alias], default: alias },
    };
    if (target === "multivariate" && aliasDef.properties.variants?.items?.properties) {
      aliasDef.properties.variants.items.properties.value = legacyMultivariateValue(alias);
    }
    if (alias === LEGACY_REDIRECT && !declared.has("redirect")) {
      // The site editor's legacy redirect screen saves the nested shape.
      aliasDef.required = ["__resolveType", "redirect"];
      aliasDef.properties = {
        __resolveType: aliasDef.properties.__resolveType,
        redirect: legacyRedirectSchema(),
      };
    }
    definitions[toBase64(alias)] = aliasDef;
    manifest[group][alias] = { $ref: `#/definitions/${toBase64(alias)}`, namespace: "website" };
    aliases[alias] = target;
  }

  definitions[SECTION_REF_KEY] = { title: "Section", anyOf: [...unions.sections.anyOf] };

  const meta: DecoMeta = {
    major: 1,
    version: packageVersion(),
    namespace: "site",
    site: siteName(paths.root),
    manifest: { blocks: { ...manifest, apps: {}, actions: {} } },
    schema: {
      definitions,
      root: {
        ...unions,
        actions: { anyOf: [] },
        handlers: { anyOf: [] },
        flags: { anyOf: [] },
        functions: { anyOf: [] },
        apps: { anyOf: [] },
      },
    },
    format: SCHEMA_FORMAT,
    framework: "deco-cli",
    aliases,
  };
  return { meta, diagnostics, blockMap };
}

/**
 * An object type whose properties are all optional: nearly any object is
 * assignable to it, so assignability alone would offer unrelated functions.
 */
function isWeakType(type: Type): boolean {
  if (!(type.isObject() || type.isInterface()) || type.isArray()) return false;
  if (
    type.getStringIndexType() ||
    type.getNumberIndexType() ||
    type.getCallSignatures().length > 0
  ) {
    return false;
  }
  const props = type.getProperties();
  return props.length > 0 && props.every((p) => p.isOptional());
}

function sameNamedType(a: Type, b: Type): boolean {
  const sa = (a.getAliasSymbol() ?? a.getSymbol())?.compilerSymbol;
  const sb = (b.getAliasSymbol() ?? b.getSymbol())?.compilerSymbol;
  return sa !== undefined && sa === sb;
}

/**
 * Does a function returning `returnType` fit a field of type `field`? The
 * TypeScript rule (assignability of the awaited, non-null types), except for
 * weak target types, which need the same named type.
 */
function returnFits(returnType: Type, field: Type): boolean {
  const source = nonNullable(returnType);
  const target = nonNullable(field);
  if (!source.isAssignableTo(target)) return false;
  const element = (t: Type) => (t.isArray() ? (t.getArrayElementType() ?? t) : t);
  const targetElement = element(target);
  return isWeakType(targetElement) ? sameNamedType(element(source), targetElement) : true;
}

/**
 * The site editor groups blocks by namespace. A path-like key keeps the one
 * v7 gave it (`shopify/loaders/ProductList.ts` is "shopify"); short keys are
 * the site's.
 */
function namespaceOf(key: string): string {
  const slash = key.indexOf("/");
  return slash > 0 ? key.slice(0, slash) : "site";
}

const LEGACY_REDIRECT = "website/loaders/redirect.ts";

/** `{ redirect: { from, to, type } }`, as v7's redirect screen saves it. */
function legacyRedirectSchema() {
  return {
    type: "object",
    title: "Redirect",
    required: ["from", "to"],
    properties: {
      from: { type: "string", title: "From" },
      to: { type: "string", title: "To" },
      type: { type: "string", enum: ["permanent", "temporary"], title: "Type" },
      discardQueryParameters: { type: "boolean", title: "Discard query parameters" },
    },
  };
}

function groupOf(name: BuiltInBlock, infos: BlockInfo[]): ManifestGroup {
  return infos.find((i) => i.key === name)?.group ?? BUILT_IN_GROUPS[name];
}
