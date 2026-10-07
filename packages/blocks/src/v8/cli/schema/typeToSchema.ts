/**
 * TypeScript types to JSON Schema, in the site editor's dialect (the
 * `deco-meta@1` format, which is today's `meta.gen.json`).
 *
 * Ported from the v7 generator (`@decocms/blocks-cli`'s
 * `scripts/generate-schema.ts`: `typeToJsonSchema`, the JSDoc tag table and
 * the widget aliases), so a type produces the same field it always has. What
 * changed for the next major (spec: schema › From types to forms):
 *
 * - `ReactNode` / `ReactNode[]` are a choice of components (the section
 *   picker) instead of a hidden field.
 * - An object field takes a plain value or any block whose function's awaited
 *   return type fits it, decided by TypeScript assignability, not by type
 *   name (spec: schema › Interchangeable blocks).
 * - `Lazy<T>` is a `lazy` block whose `value` has the form of `T`.
 * - `Secret` holds a `secret` block, never a plain string.
 * - `@options` with a literal list becomes an `enum`; a function-backed list
 *   falls back to a text field, since the site editor never runs site code.
 *
 * The compiler is only imported as types here; `generate.ts` loads the
 * app's `typescript` when `deco schema` runs.
 */

import fs from "node:fs";
import path from "node:path";
import type { TsSymbol as MorphSymbol, TsType as Type } from "./tsProgram.ts";

export const RESOLVABLE_KEY = "Resolvable";
export const SECTION_REF_KEY = "__SECTION_REF__";

/** Standard padded base64, matching the browser's `btoa()`. */
export function toBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export const resolvableRef = () => ({ $ref: `#/definitions/${RESOLVABLE_KEY}` });
export const sectionRef = () => ({ $ref: `#/definitions/${SECTION_REF_KEY}` });

/** What a field position needs from the generator to link blocks into it. */
export interface SchemaContext {
  root: string;
  /**
   * The definition keys of the blocks whose function's awaited return type
   * fits an object field of this type, in block map order. Empty when none do.
   */
  fitting(type: Type): string[];
  /** A `$ref` to a shared definition of a named object type (the inline branch). */
  namedDefinition(type: Type): { $ref: string } | null;
  /**
   * Set while generating a shared definition: nested named object types are
   * refs to their own shared definitions too, so a type graph like
   * `Product → ProductGroup → Product[]` is written once, not expanded at
   * every level. `rootType` is the definition being expanded.
   */
  shareNamed?: { rootType: Type };
}

// ---------------------------------------------------------------------------
// JSDoc tags (spec: schema › Widgets)
// ---------------------------------------------------------------------------

const NUMERIC_TAGS = new Set([
  "maximum",
  "minimum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "multipleOf",
  "maxLength",
  "minLength",
  "maxItems",
  "minItems",
  "maxProperties",
  "minProperties",
]);
const BOOLEAN_TAGS = new Set(["readOnly", "writeOnly", "deprecated", "uniqueItems"]);

export function getJsDocTags(symbol: MorphSymbol): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const decl of symbol.getDeclarations()) {
    for (const doc of decl.getJsDocs()) {
      const desc = doc.getDescription().trim();
      if (desc) tags.description = desc;
      for (const tag of doc.getTags()) {
        tags[tag.getTagName()] = tag.getCommentText()?.trim() || "true";
      }
    }
  }
  return tags;
}

/**
 * Parse an `@options` value. A JSON list of strings, numbers, or
 * `{ value, label }` objects is a static list; anything else (a loader path,
 * a function name) is dynamic and can't be written into the schema.
 */
function parseOptions(raw: string): { values: (string | number)[]; labels?: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const values: (string | number)[] = [];
  const labels: string[] = [];
  let labelled = false;
  for (const item of parsed) {
    if (typeof item === "string" || typeof item === "number") {
      values.push(item);
      labels.push(String(item));
    } else if (
      item &&
      typeof item === "object" &&
      (typeof item.value === "string" || typeof item.value === "number")
    ) {
      values.push(item.value);
      labels.push(typeof item.label === "string" ? item.label : String(item.value));
      labelled ||= typeof item.label === "string";
    } else {
      return null;
    }
  }
  return labelled ? { values, labels } : { values };
}

/**
 * `@format` spellings that name a standard format under another name, kept
 * from v7: `@format datetime` (Eitri's vocabulary) is the `date-time` picker,
 * and `deco check` validates it as one.
 */
const FORMAT_ALIASES: Record<string, string> = { datetime: "date-time" };

function applyJsDocToSchema(schema: any, tags: Record<string, string>): void {
  for (const [tag, value] of Object.entries(tags)) {
    if (tag === "ignore") continue;
    if (tag === "format") {
      schema.format = FORMAT_ALIASES[value] ?? value;
      continue;
    }
    if (tag === "hide") {
      schema.hide = "true";
      continue;
    }
    if (tag === "default") {
      if (value === "true") schema.default = true;
      else if (value === "false") schema.default = false;
      else if (value === "null") schema.default = null;
      else if (!Number.isNaN(Number(value)) && value.trim() !== "") schema.default = Number(value);
      else {
        try {
          schema.default = JSON.parse(value);
        } catch {
          schema.default = value;
        }
      }
      continue;
    }
    if (tag === "examples") {
      const lines = value
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length > 1) schema.examples = lines;
      else {
        try {
          schema.examples = JSON.parse(value);
        } catch {
          schema.examples = [value];
        }
      }
      continue;
    }
    if (tag === "options") {
      const options = parseOptions(value);
      // Static lists become an enum the site editor shows as a select without
      // asking the site. A dynamic list falls back to a plain text field.
      if (options) {
        schema.enum = options.values;
        if (options.labels) schema.enumNames = options.labels;
      }
      continue;
    }
    if (NUMERIC_TAGS.has(tag)) {
      schema[tag] = Number(value);
      continue;
    }
    if (BOOLEAN_TAGS.has(tag)) {
      schema[tag] = value === "true";
      continue;
    }
    // Everything else passes through as-is, matching the v7 generator: title,
    // description, format, widget, icon, titleBy, mode, label, pattern, …
    schema[tag] = value;
  }
}

// ---------------------------------------------------------------------------
// Widget aliases (kept from v7: `image: ImageWidget` is an image picker)
// ---------------------------------------------------------------------------

const WIDGET_TYPE_FORMATS: Record<string, string> = {
  ImageWidget: "image-uri",
  VideoWidget: "video-uri",
  HTMLWidget: "html",
  RichText: "rich-text",
  Color: "color",
  TextArea: "textarea",
  Code: "code",
  DateTimeWidget: "date-time",
};

/** Apply the format of a widget alias named in `typeHint` to the right inner schema. */
function applyWidgetFormat(schema: any, typeHint: string): void {
  const format = Object.entries(WIDGET_TYPE_FORMATS).find(
    ([alias]) => typeHint === alias || new RegExp(`\\b${alias}\\b`).test(typeHint),
  )?.[1];
  if (!format) return;
  if (schema.type === "string") {
    schema.format ??= format;
  } else if (schema.type === "array" && schema.items?.type === "string") {
    schema.items.format ??= format;
  } else if (Array.isArray(schema.anyOf)) {
    for (const variant of schema.anyOf) {
      if (variant.type === "string") variant.format ??= format;
    }
  } else if (!schema.type && !schema.$ref && !schema.anyOf) {
    // A widget alias the checker couldn't resolve (remote import) came through as
    // `any`; every widget alias is a string, so recover the intended widget.
    schema.type = "string";
    schema.format = format;
  }
}

/**
 * `@format` written on a type alias (`/** @format color *\/ type Color = string`)
 * reaches every field of that type, a literal select included; a field's own
 * `@format` still wins, since its tags apply afterwards.
 */
function applyAliasFormat(
  schema: any,
  alias: { format: string; items: boolean } | undefined,
): void {
  if (!alias) return;
  const target = alias.items ? schema.items : schema;
  if (target?.type === "string") target.format ??= FORMAT_ALIASES[alias.format] ?? alias.format;
}

// ---------------------------------------------------------------------------
// Recognizing the framework's own types
// ---------------------------------------------------------------------------

const JSX_SYMBOLS = new Set([
  "ReactNode",
  "ReactElement",
  "ReactPortal",
  "VNode",
  "ComponentChildren",
]);

function typeNames(type: Type): string[] {
  const names: string[] = [];
  const alias = type.getAliasSymbol()?.getName();
  if (alias) names.push(alias);
  const sym = type.getSymbol()?.getName();
  if (sym) names.push(sym);
  return names;
}

/** `ReactNode`, `ReactElement`, `JSX.Element` and friends. */
/** A render descriptor (spec: rendering): `{ component: string; props: … }`. */
export function isDescriptorType(type: Type): boolean {
  const check = (t: Type) => {
    const component = t.getProperty("component");
    return component !== undefined && t.getProperty("props") !== undefined;
  };
  if (type.isUnion()) return type.getUnionTypes().every((t) => check(t));
  return type.isObject() && check(type);
}

/**
 * What a section renders to: JSX, or a render descriptor in data mode. A field
 * of either type is a section picker.
 */
function isSectionType(type: Type): boolean {
  return isJsxType(type) || isDescriptorType(type);
}

export function isJsxType(type: Type): boolean {
  if (typeNames(type).some((n) => JSX_SYMBOLS.has(n))) return true;
  const text = type.getText();
  if (/(^|\.)Element$/.test(text) && /\bJSX\b/.test(text)) return true;
  // A flattened `ReactNode` (it lost its alias): a union with an element member.
  return (
    type.isUnion() &&
    type
      .getUnionTypes()
      .some((member) => typeNames(member).some((n) => n === "ReactElement" || n === "ReactPortal"))
  );
}

/**
 * `Lazy<T>`: the `T`, or null for any other type. Only the `Lazy` alias
 * counts, so a method like `onLoad: () => Promise<void>` stays a method
 * (skipped) instead of becoming a lazy field. `typeHint`, the annotation as
 * written, covers a checker that printed the alias away; the type must still
 * have `Lazy`'s shape, a call with no parameters returning a promise of data.
 */
function lazyInner(type: Type, typeHint = ""): Type | null {
  const alias = type.getAliasSymbol();
  if (alias?.getName() === "Lazy") {
    const [arg] = type.getAliasTypeArguments();
    if (arg) return arg;
  }
  if (!/^(\w+\.)?Lazy\s*</.test(typeHint.trim())) return null;
  const signatures = type.getCallSignatures();
  if (signatures.length !== 1 || type.getProperties().length > 0) return null;
  const [signature] = signatures;
  if (signature.getParameters().length > 0) return null;
  const inner = awaitedOf(signature.getReturnType(), true);
  if (!inner || inner.isVoid() || inner.isUndefined() || inner.isNever()) return null;
  return inner;
}

/** `Secret`, from `@decocms/blocks` (`string & { readonly __secret: true }`). */
function isSecretType(type: Type, typeHint = ""): boolean {
  if (type.getAliasSymbol()?.getName() === "Secret") return true;
  if (/^(\w+\.)?Secret$/.test(typeHint.trim())) return true;
  return (
    type.isIntersection() &&
    type.getIntersectionTypes().some((t) => t.getProperty("__secret") !== undefined)
  );
}

/**
 * The awaited type: `Promise<T>` is `T`. With `strict`, anything that isn't a
 * promise returns null (used to recognize `() => Promise<T>`).
 */
export function awaitedOf(type: Type, strict = false): Type | null {
  if (type.getSymbol()?.getName() === "Promise" || type.getAliasSymbol()?.getName() === "Promise") {
    const [arg] = type.getTypeArguments();
    return arg ?? null;
  }
  return strict ? null : type;
}

export function nonNullable(type: Type): Type {
  if (!type.isUnion()) return type;
  const parts = type.getUnionTypes().filter((t) => !t.isNull() && !t.isUndefined());
  return parts.length === 1 ? parts[0] : type.getNonNullableType();
}

/**
 * `Record<string, any>` and friends: a map of anything, which every block's
 * output fits. It's a free-form value, not a place for a block, so the field
 * doesn't offer the saved-block picker or list every block as a choice.
 */
export function isFreeFormMap(type: Type): boolean {
  const t = nonNullable(type);
  if (!t.isObject() || t.getProperties().length > 0 || t.getCallSignatures().length > 0)
    return false;
  const value = t.getStringIndexType() ?? t.getNumberIndexType();
  return value !== undefined && (value.isAny() || value.isUnknown());
}

/** Types a block can fill: objects, arrays and intersections of objects, not primitives. */
function isObjectLike(type: Type): boolean {
  const t = nonNullable(type);
  if (t.isAny() || t.isUnknown() || t.isNever()) return false;
  if (t.isString() || t.isNumber() || t.isBoolean() || t.isLiteral() || t.isBooleanLiteral()) {
    return false;
  }
  if (t.isUnion()) {
    // A union of objects (`A | B`) can be filled; a union with a primitive can't.
    return t.getUnionTypes().every((u) => isObjectLike(u) || u.isNull() || u.isUndefined());
  }
  if (t.isIntersection()) {
    return !t.getIntersectionTypes().some((p) => p.isString() || p.isNumber() || p.isBoolean());
  }
  return t.isArray() || t.isObject() || t.isInterface();
}

// ---------------------------------------------------------------------------
// The converter
// ---------------------------------------------------------------------------

const REACT_INTERNAL_PROPS = new Set([
  "ref",
  "then",
  "catch",
  "finally",
  "$$typeof",
  "_owner",
  "_store",
]);

// Platform types never configured in a form; collapsed to a hidden object.
const RUNTIME_INJECTED_TYPES = new Set([
  "URL",
  "URLSearchParams",
  "Request",
  "Response",
  "Headers",
  "AbortSignal",
  "ReadableStream",
  "WritableStream",
  "Blob",
  "File",
  "FormData",
]);

const titleCase = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** `Secret | undefined` → `Secret`: the annotation without its nullish members. */
function stripNullish(typeHint: string): string {
  return typeHint.replace(/\s*\|\s*(null|undefined)\b/g, "").trim();
}

function isNullableHint(optional: boolean, typeHint: string): boolean {
  return optional || /\bnull\b|\bundefined\b/.test(typeHint);
}

/** The schema of a `lazy` block whose value has the form `value`. */
export function lazySchema(value: any): any {
  return {
    type: "object",
    required: ["__resolveType", "value"],
    properties: {
      __resolveType: { type: "string", enum: ["lazy"], default: "lazy" },
      value,
    },
  };
}

/** The schema of a `secret` block: a write-only field saved encrypted. */
function secretSchema(): any {
  return {
    type: "object",
    format: "secret",
    writeOnly: true,
    required: ["__resolveType", "ciphertext"],
    properties: {
      __resolveType: { type: "string", enum: ["secret"], default: "secret" },
      ciphertext: { type: "string" },
    },
  };
}

/**
 * The schema of one field: everything a type means at a property position,
 * before the property's own JSDoc and title are applied.
 */
function fieldSchema(
  propType: Type,
  typeHint: string,
  ctx?: SchemaContext,
  visited: Set<string> = new Set(),
): any {
  const lazy = lazyInner(nonNullable(propType), stripNullish(typeHint));
  if (lazy) return lazySchema(fieldSchema(lazy, lazy.getText(), ctx, visited));

  if (isSecretType(nonNullable(propType), stripNullish(typeHint))) return secretSchema();

  if (ctx && isObjectLike(propType) && !isSectionType(nonNullable(propType))) {
    const fits = ctx.fitting(propType);
    if (fits.length > 0) {
      const inner = nonNullable(propType);
      const inline = inlineSchema(inner, ctx, visited);
      return {
        anyOf: [resolvableRef(), inline, ...fits.map((key) => ({ $ref: `#/definitions/${key}` }))],
      };
    }
  }

  const schema = typeToJsonSchema(propType, new Set(visited), ctx);
  orderEnumByHint(schema, typeHint);
  applyWidgetFormat(schema, typeHint);
  return schema;
}

/**
 * Literal values in the order `text` (the declaration as written) spells them.
 * The checker orders a union's members by when it first met each literal,
 * which another file can change, so `"a" | "b"` could come out as `["b", "a"]`.
 * Values `text` doesn't spell all of keep the checker's order.
 */
export function inDeclaredOrder<T extends string | number>(values: T[], text: string): T[] {
  const at = values.map((value) => {
    const spelled =
      typeof value === "string"
        ? [`"${value}"`, `'${value}'`, `\`${value}\``]
            .map((q) => text.indexOf(q))
            .filter((i) => i >= 0)
        : [
            ...text.matchAll(
              new RegExp(`(?<![\\w.])${String(value).replace(".", "\\.")}(?![\\w.])`, "g"),
            ),
          ].map((m) => m.index ?? -1);
    return spelled.length > 0 ? Math.min(...spelled) : -1;
  });
  if (at.some((i) => i < 0)) return values;
  return values
    .map((value, i) => ({ value, at: at[i] }))
    .sort((a, b) => a.at - b.at)
    .map((e) => e.value);
}

/** Reorder a literal select (or a list of them) by the field's annotation. */
function orderEnumByHint(schema: any, typeHint: string): void {
  if (Array.isArray(schema?.enum)) schema.enum = inDeclaredOrder(schema.enum, typeHint);
  else if (Array.isArray(schema?.items?.enum)) {
    schema.items.enum = inDeclaredOrder(schema.items.enum, typeHint);
  }
}

/** The declaration text of a type alias, for ordering its literal members. */
function aliasDeclarationText(type: Type): string {
  return type.getAliasSymbol()?.getDeclarations()[0]?.getText() ?? "";
}

/** The "plain value" branch of a field that blocks can fill. */
function inlineSchema(type: Type, ctx: SchemaContext, visited: Set<string>): any {
  if (type.isArray()) {
    const element = type.getArrayElementType();
    const items = element
      ? (ctx.namedDefinition(element) ?? typeToJsonSchema(element, new Set(visited), ctx))
      : {};
    return { type: "array", items, title: "Inline data" };
  }
  const named = ctx.namedDefinition(type);
  return named
    ? { ...named, title: "Inline data" }
    : { ...typeToJsonSchema(type, new Set(visited), ctx), title: "Inline data" };
}

/**
 * Whether a prop annotated `Section` / `Section[]` is v7's opaque Section type
 * (`type Section = any`), a "pick any section" field, rather than a site type
 * that happens to be called `Section`.
 */
function isOpaqueSectionType(propType: Type): boolean {
  let type = nonNullable(propType);
  if (type.isArray()) type = type.getArrayElementType() ?? type;
  return type.isAny() || type.isUnknown();
}

export function typeToJsonSchema(
  type: Type,
  visited = new Set<string>(),
  ctx?: SchemaContext,
): any {
  const typeText = type.getText();
  if (visited.has(typeText)) return { type: "object" };
  visited.add(typeText);

  try {
    if (type.isAny() || type.isUnknown()) return {};

    // Structural blocks wherever the type appears, not only as a whole field:
    // `Secret[]` is a list of secret blocks, `Lazy<T>[]` a list of lazy ones.
    if (isSecretType(type)) return secretSchema();
    const lazy = lazyInner(type);
    if (lazy) return lazySchema(fieldSchema(lazy, lazy.getText(), ctx, visited));

    if (type.isArray()) {
      const el = type.getArrayElementType();
      return el
        ? { type: "array", items: typeToJsonSchema(el, new Set(visited), ctx) }
        : { type: "array" };
    }

    if (isSectionType(type)) return sectionRef();

    if (type.isString() || type.isStringLiteral()) {
      return type.isStringLiteral()
        ? { type: "string", const: type.getLiteralValue() }
        : { type: "string" };
    }
    if (type.isNumber() || type.isNumberLiteral()) return { type: "number" };
    if (type.isBoolean() || type.isBooleanLiteral()) return { type: "boolean" };
    if (type.isNull() || type.isUndefined()) return { type: "null" };

    if (type.isUnion()) {
      const parts = type.getUnionTypes();
      const nonNull = parts.filter((t) => !t.isNull() && !t.isUndefined());
      const isNullable = nonNull.length < parts.length;

      if (nonNull.length === 1) {
        const inner = typeToJsonSchema(nonNull[0], new Set(visited), ctx);
        return isNullable ? { ...inner, nullable: true } : inner;
      }
      if (nonNull.every((t) => t.isBooleanLiteral())) {
        return isNullable ? { type: "boolean", nullable: true } : { type: "boolean" };
      }
      // String-literal unions and string enums: a select, written into the schema.
      if (nonNull.every((t) => t.isStringLiteral())) {
        const values = nonNull.map((t) => t.getLiteralValue() as string);
        const result: any = {
          type: "string",
          enum: inDeclaredOrder(values, aliasDeclarationText(type)),
        };
        if (isNullable) result.nullable = true;
        return result;
      }
      if (nonNull.every((t) => t.isNumberLiteral())) {
        const values = nonNull.map((t) => t.getLiteralValue() as number);
        const result: any = {
          type: "number",
          enum: inDeclaredOrder(values, aliasDeclarationText(type)),
        };
        if (isNullable) result.nullable = true;
        return result;
      }

      const anyOf = nonNull.map((t) => {
        const schema = typeToJsonSchema(t, new Set(visited), ctx);
        if (!schema.title && schema.type === "object") {
          const symName = (t.getAliasSymbol() ?? t.getSymbol())?.getName();
          if (symName && symName !== "__type" && symName !== "default" && symName !== "__object") {
            schema.title = symName;
          }
          if (!schema.title && schema.properties) {
            for (const v of Object.values(schema.properties) as any[]) {
              if (v?.const !== undefined) {
                schema.title = String(v.const);
                break;
              }
            }
          }
        }
        return schema;
      });
      const result: any = { anyOf };
      if (isNullable) result.nullable = true;
      return result;
    }

    if (type.isIntersection()) {
      const parts = type.getIntersectionTypes();
      const primitive = parts.find((t) => t.isString() || t.isNumber() || t.isBoolean());
      if (primitive) return typeToJsonSchema(primitive, new Set(visited), ctx);

      const merged: any = { type: "object", properties: {} };
      const required = new Set<string>();
      for (const part of parts) {
        const sub = typeToJsonSchema(part, new Set(visited), ctx);
        if (sub?.type !== "object" || !sub.properties) continue;
        Object.assign(merged.properties, sub.properties);
        for (const r of sub.required ?? []) required.add(r);
        for (const [k, v] of Object.entries(sub)) {
          if (k === "type" || k === "properties" || k === "required") continue;
          if (!(k in merged)) merged[k] = v;
        }
      }
      if (required.size > 0) merged.required = [...required];
      return merged;
    }

    if (type.isObject() || type.isInterface()) {
      if (ctx?.shareNamed && type.compilerType !== ctx.shareNamed.rootType.compilerType) {
        const shared = ctx.namedDefinition(type);
        if (shared) return shared;
      }
      const symName = type.getSymbol()?.getName();
      if (symName && RUNTIME_INJECTED_TYPES.has(symName)) {
        const declFile = type.getSymbol()?.getDeclarations()?.[0]?.getSourceFile().getFilePath();
        if (declFile?.includes("typescript/lib/") || declFile?.includes("@types/")) {
          return { type: "object", hide: "true" };
        }
      }

      const stringIdx = type.getStringIndexType();
      const numberIdx = type.getNumberIndexType();
      if ((stringIdx || numberIdx) && type.getProperties().length === 0) {
        return {
          type: "object",
          additionalProperties: typeToJsonSchema((stringIdx || numberIdx)!, new Set(visited), ctx),
        };
      }

      const properties: Record<string, any> = {};
      const required: string[] = [];

      for (const prop of type.getProperties()) {
        const name = prop.getName();
        if (name.startsWith("_") || name.startsWith("$") || name === "@type") continue;
        if (REACT_INTERNAL_PROPS.has(name)) continue;

        const decl = prop.getValueDeclaration() ?? prop.getDeclarations()[0];
        if (!decl) continue;
        const propType = prop.getTypeAtLocation(decl);
        const tags = getJsDocTags(prop);
        if (tags.ignore) continue;

        // The annotation as written (`ImageWidget`, `Section[]`, `Secret`),
        // before the checker resolves aliases away.
        const typeNode = decl.getTypeNode();
        const typeHint: string = typeNode ? typeNode.getText() : propType.getText();
        const optional = prop.isOptional();

        // Methods aren't data, but `Lazy<T>` (a function prop) is a field.
        const callable = nonNullable(propType);
        const isFunction =
          callable.getCallSignatures().length > 0 && callable.getProperties().length === 0;
        if (isFunction && !lazyInner(nonNullable(propType), stripNullish(typeHint))) continue;

        // v7's opaque `Section` type: a section picker.
        const baseHint = typeHint.replace(/\s*\|\s*(null|undefined)/g, "").trim();
        if ((baseHint === "Section" || baseHint === "Section[]") && isOpaqueSectionType(propType)) {
          const schema: any = baseHint.endsWith("[]")
            ? { type: "array", items: sectionRef(), title: titleCase(name) }
            : { ...sectionRef(), title: titleCase(name) };
          if (isNullableHint(optional, typeHint)) schema.nullable = true;
          applyJsDocToSchema(schema, tags);
          properties[name] = schema;
          if (!optional) required.push(name);
          continue;
        }

        const schema = fieldSchema(propType, typeHint, ctx, visited);
        if (typeNode) {
          orderEnumByHint(schema, typeNode.getAliasDeclarationTexts().join("\n"));
          applyAliasFormat(schema, typeNode.getAliasFormat());
        }
        if (schema.anyOf && schema.anyOf[0]?.$ref === resolvableRef().$ref) {
          // A block-ref field: nullability lives on the wrapper.
          if (isNullableHint(optional, typeHint)) schema.nullable = true;
        }
        if (schema.$ref === sectionRef().$ref && isNullableHint(optional, typeHint)) {
          schema.nullable = true;
        }
        applyJsDocToSchema(schema, tags);
        schema.title ??= titleCase(name);
        properties[name] = schema;
        // A hidden prop can't be filled in by an editor; requiring it would
        // deadlock the form.
        if (!optional && schema.hide !== "true") required.push(name);
      }

      const result: any = { type: "object", properties };
      if (required.length > 0) result.required = required;
      const ifaceSym = type.getAliasSymbol() ?? type.getSymbol();
      if (ifaceSym) applyJsDocToSchema(result, getJsDocTags(ifaceSym));
      return result;
    }

    return { type: "string" };
  } finally {
    visited.delete(typeText);
  }
}

/**
 * A machine-independent id for a source file: relative to the app root, or
 * `<package name>/<path in package>` for a file in a dependency (including a
 * workspace package the checker reached through a symlink).
 *
 * A declaration file with a declaration map (`x.d.ts` + `x.d.ts.map`, as
 * `tsc` emits into a package's dist/) is named after the source it was
 * compiled from, so a type keeps one id whether the checker read the
 * package's compiled `.d.ts` or its `.ts` source (the "source" condition).
 */
export function stableFileId(filePath: string, root: string): string {
  const file = sourceOfDeclaration(filePath.replace(/^file:\/+/, "/"));
  const nm = file.lastIndexOf("/node_modules/");
  if (nm >= 0) return file.slice(nm + "/node_modules/".length);
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (!rel.startsWith("..")) return rel;
  let dir = path.dirname(file);
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const name = JSON.parse(fs.readFileSync(manifest, "utf8")).name;
        if (typeof name === "string") {
          return `${name}/${path.relative(dir, file).split(path.sep).join("/")}`;
        }
      } catch {
        // unreadable manifest: keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.basename(file);
    dir = parent;
  }
}

/** The `.ts` file a `.d.ts` was emitted from, per its declaration map; else the file itself. */
function sourceOfDeclaration(file: string): string {
  if (!/\.d\.[cm]?ts$/.test(file)) return file;
  try {
    const map = JSON.parse(fs.readFileSync(`${file}.map`, "utf8")) as {
      sources?: unknown;
      sourceRoot?: unknown;
    };
    const source = Array.isArray(map.sources) ? map.sources[0] : undefined;
    if (typeof source !== "string") return file;
    const sourceRoot = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
    return path.resolve(path.dirname(file), sourceRoot, source);
  } catch {
    return file;
  }
}
