/**
 * `deco check`: validates every saved block against `.deco/schema.gen.json`,
 * as both are on disk (spec: checking; internals › How deco check works). It
 * writes nothing, generates no schema and loads no TypeScript.
 *
 * Validation is a walk over each saved block that dispatches on
 * `__resolveType`, plus a JSON Schema validator (Ajv) for the props of each
 * block it meets:
 *
 * - the walk resolves each name (block type, built-in, alias or saved block),
 *   checks that the block fits the field it sits in (by the field's list of
 *   functions whose return type fits it), and handles the structural blocks
 *   (`multivariate`, `lazy`, `secret`) and references;
 * - Ajv checks one block's props at a time. Its schema is the generated one
 *   with every field also accepting any block, so nested blocks never show up
 *   as union noise in the parent: the walk checks them on their own, against
 *   their own type's schema.
 */

import fs from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";
import { isWellFormedCiphertext } from "../../../protocol/secrets.ts";
import { isBlock, own } from "../../json.ts";
import { findRouteConflicts } from "../../matchRoute.ts";
import { isBuiltIn, storesPlainVariants } from "../builtins.ts";
import { readSavedBlocks, type SavedBlocks } from "../content.ts";
import { consoleReporter, type Reporter } from "../log.ts";
import { CliError, decoPaths, findDecoRoot } from "../root.ts";
import type { DecoMeta } from "../schema/generate.ts";
import { SECTION_REF_KEY, toBase64 } from "../schema/typeToSchema.ts";
import { BLOCK_DEF, joinPath, rewriteErrors } from "./messages.ts";

export interface Problem {
  /** The saved block's file, relative to the root: `.deco/blocks/HomePage.json`. */
  file: string;
  /** Where in the block, like `sections[2].title`; empty for the block itself. */
  path: string;
  message: string;
  severity: "error" | "warning";
}

type Json = any;
const DOC_ID = "deco";

/** JSON-parsed objects only, so any non-array object is a plain one. */
function isObject(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveTypeEnum(schema: Json): string[] | null {
  const prop = schema?.properties?.__resolveType;
  return Array.isArray(prop?.enum) ? prop.enum : null;
}

/** A `lazy` block's shape inline in a field: the field is `Lazy<T>`. */
function isLazyShape(schema: Json): boolean {
  const e = resolveTypeEnum(schema);
  return !!e && e.length === 1 && e[0] === "lazy" && !!schema.properties.value;
}

/** A `secret` block's shape inline in a field: the field is `Secret`. */
function isSecretShape(schema: Json): boolean {
  const e = resolveTypeEnum(schema);
  return !!e && e.length === 1 && e[0] === "secret" && schema.format === "secret";
}

/** The definition key of a block type, if `schema` is a block type's definition. */
function blockDefinitionName(schema: Json): string | null {
  const e = resolveTypeEnum(schema);
  return e && e.length === 1 && typeof schema.title === "string" && !schema.format ? e[0] : null;
}

// ---------------------------------------------------------------------------
// The validation document: the schema, with every field also accepting a block
// ---------------------------------------------------------------------------

const BLOCK_REF = { $ref: `${DOC_ID}#/definitions/${BLOCK_DEF}` };

function absoluteRef(ref: string): string {
  return ref.startsWith("#") ? `${DOC_ID}${ref}` : ref;
}

class ValidationDocument {
  readonly doc: Json;
  private readonly map = new WeakMap<object, object>();

  /** Block types' definition keys: a ref to one only ever holds a block. */
  private readonly blockKeys: Set<string>;

  constructor(meta: DecoMeta) {
    this.blockKeys = new Set(
      Object.entries(meta.schema.definitions)
        .filter(([, def]) => blockDefinitionName(def) !== null)
        .map(([key]) => key),
    );
    const definitions: Record<string, Json> = {};
    for (const [key, def] of Object.entries(meta.schema.definitions)) {
      definitions[key] = this.transform(def, false, true);
    }
    definitions[BLOCK_DEF] = {
      type: "object",
      required: ["__resolveType"],
      properties: { __resolveType: { type: "string" } },
    };
    const root: Record<string, Json> = {};
    for (const [key, union] of Object.entries(meta.schema.root ?? {})) {
      root[key] = this.transform(union, false, true);
    }
    this.doc = { $id: DOC_ID, definitions, root };
  }

  /** The transformed counterpart of a schema node of the generated schema. */
  counterpart(node: object): object | undefined {
    return this.map.get(node);
  }

  private transform(node: Json, wrap: boolean, top = false): Json {
    if (!isObject(node)) return node;
    // Fields that hold a structural block (Lazy<T>, Secret), as a field or a
    // list item, are entirely the walk's job: it reports a plain value there
    // and checks a block on its own. Ajv accepts anything in them.
    if (!top && (isLazyShape(node) || isSecretShape(node))) {
      // Still register the lazy value's form: the walk validates it.
      if (isLazyShape(node)) this.transform(node.properties.value, true);
      return {};
    }
    const copy: Record<string, Json> = {};
    for (const [k, v] of Object.entries(node)) {
      switch (k) {
        case "$ref": {
          // Only a block can fill a ref to a block type or a root union, and
          // the walk checks blocks itself: here it's just "any block".
          const ref = String(v);
          const toBlock =
            ref.startsWith("#/root/") ||
            (ref.startsWith("#/definitions/") &&
              this.blockKeys.has(ref.slice("#/definitions/".length)));
          copy.$ref = toBlock ? BLOCK_REF.$ref : absoluteRef(ref);
          break;
        }
        case "properties":
        case "patternProperties":
          copy[k] = Object.fromEntries(
            Object.entries(v as Record<string, Json>).map(([p, s]) => [p, this.transform(s, true)]),
          );
          break;
        case "items":
          copy.items = Array.isArray(v)
            ? v.map((s) => this.transform(s, true))
            : this.transform(v, true);
          break;
        case "additionalProperties":
          copy.additionalProperties = isObject(v) ? this.transform(v, true) : v;
          break;
        case "anyOf":
        case "allOf":
        case "oneOf":
          copy[k] = (v as Json[]).map((s) => this.transform(s, false));
          break;
        case "not":
        case "if":
        case "then":
        case "else":
          copy[k] = this.transform(v, false);
          break;
        case "nullable":
        case "inputSchema":
          break;
        default:
          copy[k] = v;
      }
    }
    // A field the code doesn't declare is an error: the site editor drops it
    // on the next save. Keys starting with _, $ or @ are never fields.
    if (
      copy.properties &&
      copy.additionalProperties === undefined &&
      !copy.allOf &&
      !copy.patternProperties
    ) {
      copy.additionalProperties = false;
      copy.patternProperties = { "^[_$@]": {} };
    }
    this.map.set(node, copy);
    let result: Json = copy;
    if (node.nullable === true) result = { anyOf: [copy, { type: "null" }] };
    if (wrap) result = { anyOf: [result, BLOCK_REF] };
    return result;
  }
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

function isDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * The formats `deco check` enforces: the standard ones the schema's widgets
 * write (`@format date`, `date-time`, `uri`). A date-time is a date, `T` (or a
 * space) and a time whose seconds and zone are optional, since that is what
 * the site editor's date-time picker saves. Every other format names a
 * site-editor widget (`image-uri`, `color`, `rich-text`, …), not a rule, so it
 * accepts any string.
 */
const STANDARD_FORMATS: Record<string, (value: string) => boolean> = {
  date: isDate,
  "date-time": (value) => {
    const at = value.search(/[Tt ]/);
    return at === 10 && isDate(value.slice(0, 10)) && TIME.test(value.slice(11));
  },
  uri: (value) => /^[a-z][a-z0-9+.-]*:/i.test(value) && URL.canParse(value),
};

function formatsFor(doc: Json): Record<string, true | ((value: string) => boolean)> {
  const formats: Record<string, true | ((value: string) => boolean)> = { ...STANDARD_FORMATS };
  const seen = new Set<object>();
  const visit = (node: Json) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (
      !Array.isArray(node) &&
      typeof node.format === "string" &&
      !Object.hasOwn(formats, node.format)
    ) {
      formats[node.format] = true;
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(doc);
  return formats;
}

const CIPHERTEXT_PROBLEM = "not a well-formed ciphertext (v1.<wrappedKey>.<iv>.<ciphertext>)";

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

interface Context {
  file: string;
  problems: Problem[];
}

class Checker {
  private readonly ajv: Ajv;
  private readonly validation: ValidationDocument;
  private readonly validators = new WeakMap<object, ValidateFunction>();
  private readonly groupOf = new Map<string, string>();
  private readonly aliases: Record<string, string>;
  private readonly definitions: Record<string, Json>;

  constructor(
    private readonly meta: DecoMeta,
    private readonly saved: SavedBlocks,
  ) {
    this.definitions = meta.schema?.definitions ?? {};
    this.aliases = meta.aliases ?? {};
    for (const [group, entries] of Object.entries(meta.manifest?.blocks ?? {})) {
      for (const key of Object.keys(entries)) {
        if (!this.groupOf.has(key)) this.groupOf.set(key, group);
      }
    }
    this.validation = new ValidationDocument(meta);
    this.ajv = new Ajv({
      strict: false,
      allErrors: true,
      allowUnionTypes: true,
      formats: formatsFor(this.validation.doc),
    });
    this.ajv.addSchema(this.validation.doc);
  }

  /** The block type a name calls, after the alias table; null if it isn't one. */
  private canonicalType(name: string): string | null {
    const target = own(this.aliases, name) ?? name;
    if (this.groupOf.has(target) || this.groupOf.has(name)) return target;
    return isBuiltIn(target) ? target : null;
  }

  private definitionOf(name: string): Json | undefined {
    return (
      own(this.definitions, toBase64(name)) ??
      own(this.definitions, toBase64(own(this.aliases, name) ?? name))
    );
  }

  private validatorFor(node: object): ValidateFunction | null {
    const cached = this.validators.get(node);
    if (cached) return cached;
    const counterpart = this.validation.counterpart(node);
    if (!counterpart) return null;
    const validate = this.ajv.compile(counterpart);
    this.validators.set(node, validate);
    return validate;
  }

  private deref(schema: Json): Json {
    let cur = schema;
    for (let i = 0; i < 32 && isObject(cur) && typeof cur.$ref === "string"; i++) {
      const ref: string = cur.$ref;
      if (ref.startsWith("#/definitions/"))
        cur = own(this.definitions, ref.slice("#/definitions/".length));
      else if (ref.startsWith("#/root/"))
        cur = own(this.meta.schema.root, ref.slice("#/root/".length));
      else return cur;
    }
    return cur;
  }

  /** The block types a field takes, by name (canonical), or null for "any". */
  private allowedTypes(field: Json, seen = new Set<Json>()): Set<string> {
    const out = new Set<string>();
    const visit = (node: Json) => {
      if (!isObject(node) || seen.has(node)) return;
      seen.add(node);
      if (typeof node.$ref === "string") {
        const ref: string = node.$ref;
        if (ref.startsWith("#/root/")) {
          const group = ref.slice("#/root/".length);
          for (const key of Object.keys(own(this.meta.manifest.blocks, group) ?? {})) {
            out.add(own(this.aliases, key) ?? key);
          }
          return;
        }
        if (ref === `#/definitions/${SECTION_REF_KEY}`) {
          for (const key of Object.keys(this.meta.manifest.blocks.sections ?? {})) {
            out.add(own(this.aliases, key) ?? key);
          }
          return;
        }
        const target = this.deref(node);
        const name = blockDefinitionName(target);
        if (name) out.add(own(this.aliases, name) ?? name);
        return;
      }
      for (const branch of node.anyOf ?? []) visit(branch);
      for (const branch of node.oneOf ?? []) visit(branch);
    };
    visit(field);
    return out;
  }

  /** Follow saved references to the block type they end at. */
  private underlyingType(
    name: string,
    chain: string[] = [],
  ): { type: string | null; cycle?: string[] } {
    if (chain.includes(name)) return { type: null, cycle: [...chain, name] };
    const canonical = this.canonicalType(name);
    if (canonical) return { type: canonical };
    const entry = own(this.saved.blocks, name);
    if (!entry || typeof entry.__resolveType !== "string") return { type: null };
    return this.underlyingType(entry.__resolveType, [...chain, name]);
  }

  private report(
    ctx: Context,
    path: string,
    message: string,
    severity: Problem["severity"] = "error",
  ) {
    ctx.problems.push({ file: ctx.file, path, message, severity });
  }

  /** Does a block of type `type` fit `field`? Returns why not, or null. */
  private fitProblem(type: string, field: Json | null): string | null {
    if (field === null) return null;
    if (type === "multivariate") return null; // any field can have variants
    const resolved = this.deref(field);
    if (type === "lazy") {
      return isLazyShape(resolved) ? null : "a lazy block only fits a Lazy<T> field";
    }
    if (isLazyShape(resolved)) return "this field is Lazy<T>: wrap the value in a lazy block";
    if (isSecretShape(resolved)) {
      return type === "secret" ? null : "this field is a Secret: it takes a secret block";
    }
    const allowed = this.allowedTypes(field);
    if (allowed.has(type)) return null;
    if (allowed.size === 0) return "this field takes a plain value";
    return "its function doesn't return this field's type";
  }

  /** Check one value that sits in `field` (null: anywhere, as a whole saved block). */
  private checkValue(ctx: Context, value: Json, path: string, field: Json | null) {
    if (isBlock(value)) {
      this.checkBlock(ctx, value, path, field);
      return;
    }
    if (field === null) return;
    if (this.structuralProblem(ctx, value, path, field)) return;
    const validate = this.validatorFor(field);
    if (validate && !validate(value)) {
      for (const e of rewriteErrors(validate.errors, value, path))
        this.report(ctx, e.path, e.message);
    }
    this.walkNested(ctx, value, path, field);
  }

  /**
   * A plain value in a field that only takes a structural block: `Lazy<T>`
   * needs a `lazy` block and `Secret` a `secret` block, in a list item or a
   * union member as much as in a field of its own. Reports it and returns
   * true when the field is one of those (nothing else to check then).
   */
  private structuralProblem(ctx: Context, value: Json, path: string, field: Json): boolean {
    const resolved = this.deref(field);
    if (isLazyShape(resolved)) {
      if (value !== undefined && value !== null) {
        this.report(ctx, path, "this field is Lazy<T>: wrap the value in a lazy block");
      }
      return true;
    }
    if (isSecretShape(resolved)) {
      if (value !== undefined && value !== null) {
        this.report(ctx, path, "plain text in a Secret field: save it as a secret block");
      }
      return true;
    }
    return false;
  }

  /** Find the blocks nested in a plain value, with the field each one sits in. */
  private walkNested(ctx: Context, value: Json, path: string, field: Json, depth = 0) {
    if (depth > 64 || value === null || typeof value !== "object") return;
    const schema = this.deref(field);
    if (!isObject(schema)) return;
    const branches: Json[] = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
    if (branches.length > 0) {
      const branch = branches
        .map((b: Json) => this.deref(b))
        .find(
          (b: Json) =>
            isObject(b) &&
            !blockDefinitionName(b) &&
            (Array.isArray(value) ? b.type === "array" : b.type === "object" || !!b.properties),
        );
      if (branch) this.walkNested(ctx, value, path, branch, depth + 1);
      return;
    }
    if (Array.isArray(value)) {
      if (isObject(schema.items)) {
        value.forEach((item, i) => {
          if (isBlock(item)) this.checkBlock(ctx, item, `${path}[${i}]`, schema.items);
          else if (!this.structuralProblem(ctx, item, `${path}[${i}]`, schema.items)) {
            this.walkNested(ctx, item, `${path}[${i}]`, schema.items, depth + 1);
          }
        });
      }
      return;
    }
    const props: Record<string, Json> = { ...(schema.properties ?? {}) };
    for (const part of schema.allOf ?? []) Object.assign(props, this.deref(part)?.properties ?? {});
    for (const [key, child] of Object.entries(value)) {
      if (key === "__resolveType") continue;
      const childField =
        props[key] ??
        (isObject(schema.additionalProperties) ? schema.additionalProperties : undefined);
      if (!childField) continue;
      const childPath = joinPath(path, `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
      if (isBlock(child)) this.checkBlock(ctx, child, childPath, childField);
      else if (!this.structuralProblem(ctx, child, childPath, childField)) {
        this.walkNested(ctx, child, childPath, childField, depth + 1);
      }
    }
  }

  /** Check a block that sits in `field`, dispatching on its `__resolveType`. */
  checkBlock(ctx: Context, block: Record<string, Json>, path: string, field: Json | null) {
    const name: string = block.__resolveType;
    const type = this.canonicalType(name);

    if (type === null) {
      if (!Object.hasOwn(this.saved.blocks, name)) {
        this.report(ctx, path, `unknown block type "${name}"`);
        return;
      }
      // A reference to a saved block: check what it resolves to against the field.
      const { type: underlying, cycle } = this.underlyingType(name);
      if (cycle) {
        this.report(ctx, path, `references form a cycle: ${cycle.join(" → ")}`);
        return;
      }
      if (underlying === null) return; // the saved block reports its own problem
      const fit = this.fitProblem(underlying, field);
      if (fit) {
        this.report(
          ctx,
          path,
          `saved block "${name}" (a "${underlying}") doesn't fit here: ${fit}`,
        );
        return;
      }
      // Overrides are merged over the saved arguments for this use.
      const overrides = Object.keys(block).filter((k) => k !== "__resolveType");
      if (overrides.length > 0) {
        const target = this.saved.blocks[name];
        const targetType = String(target.__resolveType);
        const merged = { ...target, ...block, __resolveType: targetType };
        if (this.canonicalType(targetType)) this.checkProps(ctx, merged, path, true);
      }
      return;
    }

    const fit = this.fitProblem(type, field);
    if (fit) {
      this.report(
        ctx,
        path,
        type === "lazy" || fit.startsWith("this field is Lazy")
          ? fit
          : `"${type}" doesn't fit here: ${fit}`,
      );
      return;
    }

    switch (type) {
      case "multivariate":
        this.checkVariants(ctx, block, path, field);
        return;
      case "lazy": {
        this.checkProps(ctx, block, path, false);
        const inner = field === null ? null : (this.deref(field)?.properties?.value ?? null);
        if ("value" in block) this.checkValue(ctx, block.value, joinPath(path, "/value"), inner);
        return;
      }
      case "secret": {
        this.checkProps(ctx, block, path, false);
        if ("ciphertext" in block && !isWellFormedCiphertext(block.ciphertext)) {
          this.report(ctx, joinPath(path, "/ciphertext"), CIPHERTEXT_PROBLEM);
        }
        return;
      }
      default:
        this.checkProps(ctx, block, path, true);
    }
  }

  /** Ajv over one block's own props, then the walk into the blocks nested in them. */
  private checkProps(ctx: Context, block: Record<string, Json>, path: string, nested: boolean) {
    const def = this.definitionOf(block.__resolveType);
    if (!def) return;
    const validate = this.validatorFor(def);
    if (validate && !validate(block)) {
      for (const e of rewriteErrors(validate.errors, block, path))
        this.report(ctx, e.path, e.message);
    }
    if (nested) this.walkNested(ctx, block, path, def);
  }

  private checkVariants(
    ctx: Context,
    block: Record<string, Json>,
    path: string,
    field: Json | null,
  ) {
    const name: string = block.__resolveType;
    const def = this.definitionOf(name);
    // The block's own shape (a variants list, an experiment id), not its values.
    if (def) {
      const validate = this.validatorFor(def);
      if (validate && !validate(block)) {
        for (const e of rewriteErrors(validate.errors, block, path)) {
          // Rules and values are checked below, each against its own field.
          const variantPart = /(^|\.)variants\[\d+\]\.(rule|value)\b/.test(e.path);
          const variantUnion =
            /(^|\.)variants\[\d+\]$/.test(e.path) && e.message === "doesn't match any allowed form";
          if (!variantPart && !variantUnion) this.report(ctx, e.path, e.message);
        }
      }
    }
    if (!Array.isArray(block.variants)) return;
    const plainValues = storesPlainVariants(name);
    // The field the variants stand in for; a saved multivariate block on its
    // own takes its type's value form (under `multivariate`, a lazy block's).
    let valueField: Json | null = field;
    if (valueField === null) {
      const declared = def?.properties?.variants?.items?.properties?.value ?? null;
      const resolved = declared === null ? null : this.deref(declared);
      valueField = !plainValues && isLazyShape(resolved) ? resolved.properties.value : declared;
    }
    const rule = { $ref: "#/root/matchers" };
    let alwaysAt = -1;
    block.variants.forEach((variant: Json, i: number) => {
      const at = joinPath(path, `/variants/${i}`);
      if (!isObject(variant)) return;
      if (alwaysAt >= 0) {
        this.report(
          ctx,
          at,
          `can never be picked: variants[${alwaysAt}] has an always rule`,
          "warning",
        );
      }
      if ("rule" in variant) {
        if (isBlock(variant.rule)) {
          this.checkBlock(ctx, variant.rule, joinPath(at, "/rule"), rule);
          if (alwaysAt < 0 && this.underlyingType(variant.rule.__resolveType).type === "always") {
            alwaysAt = i;
          }
        } else {
          this.report(
            ctx,
            joinPath(at, "/rule"),
            "a rule must be a block whose function returns a boolean",
          );
        }
      }
      if (!("value" in variant)) return;
      const valuePath = joinPath(at, "/value");
      if (plainValues) {
        this.checkValue(ctx, variant.value, valuePath, valueField);
      } else if (isBlock(variant.value) && variant.value.__resolveType === "lazy") {
        if ("value" in variant.value) {
          this.checkValue(ctx, variant.value.value, joinPath(valuePath, "/value"), valueField);
        }
      } else {
        this.report(ctx, valuePath, "a variant's value must be a lazy block");
      }
    });
  }

  /** Check every saved block, the names and the routes. */
  run(): Problem[] {
    const problems: Problem[] = [];
    const names = Object.keys(this.saved.blocks).sort();
    for (const name of names) {
      const ctx: Context = { file: `.deco/blocks/${this.saved.files[name]}`, problems };
      const entry = this.saved.blocks[name];

      // Names share one registry with block types (spec: saved-blocks › Names).
      if (own(this.aliases, name) !== undefined) {
        this.report(ctx, "", `saved block "${name}" has the name of an alias`);
      } else if (isBuiltIn(name)) {
        this.report(ctx, "", `saved block "${name}" has the name of a built-in block`);
      } else if (this.groupOf.has(name)) {
        this.report(ctx, "", `saved block "${name}" has the name of a block type`);
      }

      if (!isBlock(entry)) {
        this.report(ctx, "", "missing __resolveType: a saved block names the function it calls");
        continue;
      }
      this.checkBlock(ctx, entry, "", null);
    }
    problems.push(...this.routeProblems());
    return problems;
  }

  private routeProblems(): Problem[] {
    type RouteEntry = { name: string; path: string };
    const routes: RouteEntry[] = [];
    const redirects: RouteEntry[] = [];
    for (const name of Object.keys(this.saved.blocks).sort()) {
      const entry = this.saved.blocks[name];
      if (!isBlock(entry)) continue;
      const { type } = this.underlyingType(entry.__resolveType);
      if (type === null) continue;
      const group = this.groupOf.get(type);
      if (group === "redirects") {
        const legacy = isObject(entry.redirect) ? entry.redirect.from : undefined;
        const from = typeof entry.from === "string" ? entry.from : legacy;
        if (typeof from === "string") redirects.push({ name, path: from });
      } else if (group === "pages" && typeof entry.path === "string") {
        routes.push({ name, path: entry.path });
      }
    }
    const problems: Problem[] = [];
    for (const [entries, what] of [
      [routes, "path"],
      [redirects, "from"],
    ] as const) {
      for (const { entry, other } of findRouteConflicts(entries)) {
        problems.push({
          file: `.deco/blocks/${this.saved.files[entry.name]}`,
          path: what,
          severity: "error",
          message:
            entry.path === other.path
              ? `"${entry.path}" is also the ${what} of "${other.name}"`
              : `"${entry.path}" matches the same URLs as "${other.path}" in "${other.name}"`,
        });
      }
    }
    return problems;
  }
}

/** Check saved blocks against a schema. Pure: no filesystem. */
export function checkContent(meta: DecoMeta, saved: SavedBlocks): Problem[] {
  const problems: Problem[] = saved.diagnostics.map((d) => ({
    file: `.deco/blocks/${d.file}`,
    path: "",
    message: d.message,
    severity: d.severity,
  }));
  problems.push(...new Checker(meta, saved).run());
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.file}\0${p.path}\0${p.message}\0${p.severity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Print problems grouped per file, the format the docs show. */
export function formatProblems(problems: Problem[]): string {
  const byFile = new Map<string, Problem[]>();
  for (const p of problems) {
    const list = byFile.get(p.file) ?? [];
    list.push(p);
    byFile.set(p.file, list);
  }
  const lines: string[] = [];
  for (const file of [...byFile.keys()].sort()) {
    lines.push(file);
    for (const p of byFile.get(file)!) {
      const prefix = p.severity === "warning" ? "warning: " : "";
      lines.push(`  ${prefix}${p.path ? `${p.path}: ` : ""}${p.message}`);
    }
  }
  return lines.join("\n");
}

export interface CheckOptions {
  root?: string;
  cwd?: string;
  reporter?: Reporter;
}

function readSchemaFile(file: string): DecoMeta {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new CliError(`no ${file}; run deco schema first`);
  }
  try {
    return JSON.parse(text) as DecoMeta;
  } catch (error) {
    throw new CliError(`${file}: invalid JSON: ${(error as Error).message}`);
  }
}

/** `deco check`. Returns the exit code: 0 when everything fits (warnings aside), 1 otherwise. */
export function check(options: CheckOptions = {}): number {
  const reporter = options.reporter ?? consoleReporter;
  const paths = decoPaths(findDecoRoot(options));
  const meta = readSchemaFile(paths.schema);
  const saved = readSavedBlocks(paths.blocks);
  const problems = checkContent(meta, saved);
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.length - errors;
  if (problems.length > 0) {
    const text = formatProblems(problems);
    if (errors > 0) reporter.error(text);
    else reporter.warn(text);
  }
  const count = Object.keys(saved.blocks).length;
  const summary = `${count} saved block${count === 1 ? "" : "s"} checked: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
  if (errors > 0) reporter.error(summary);
  else reporter.info(summary);
  return errors > 0 ? 1 : 0;
}
