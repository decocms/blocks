/**
 * Validator errors rewritten into short plain lines (spec: internals › How
 * deco check works): `title: required`, `title: 214 characters, max 60`,
 * `size: "xl" isn't one of "sm", "md", "lg"`.
 */
import type { ErrorObject } from "ajv";

export const BLOCK_DEF = "__deco_block__";

/** `sections[2].title` from a base path and a JSON pointer. */
export function joinPath(base: string, pointer: string): string {
  let out = base;
  for (const raw of pointer.split("/").slice(1)) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (/^\d+$/.test(seg)) out += `[${seg}]`;
    else if (/^[A-Za-z_$][\w$-]*$/.test(seg)) out += out ? `.${seg}` : seg;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

const show = (value: unknown) => JSON.stringify(value) ?? String(value);

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  switch (typeof value) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}

function expected(type: unknown): string {
  const types = Array.isArray(type) ? type : [type];
  return types
    .map((t) =>
      t === "array"
        ? "a list"
        : t === "object"
          ? "an object"
          : t === "integer"
            ? "an integer"
            : `a ${t}`,
    )
    .join(" or ");
}

function valueAt(data: unknown, pointer: string): unknown {
  let cur: any = data;
  for (const raw of pointer.split("/").slice(1)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[raw.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return cur;
}

export interface PlainError {
  path: string;
  message: string;
}

function plain(error: ErrorObject, data: unknown, base: string): PlainError {
  const value = valueAt(data, error.instancePath);
  const at = joinPath(base, error.instancePath);
  const p = error.params as Record<string, any>;
  switch (error.keyword) {
    case "required":
      return { path: joinPath(at, `/${p.missingProperty}`), message: "required" };
    case "additionalProperties":
      return { path: joinPath(at, `/${p.additionalProperty}`), message: "unknown field" };
    // Characters as the validator counts them: code points, not UTF-16 units.
    case "maxLength":
      return { path: at, message: `${[...String(value)].length} characters, max ${p.limit}` };
    case "minLength":
      return { path: at, message: `${[...String(value)].length} characters, min ${p.limit}` };
    case "maximum":
      return { path: at, message: `${show(value)}, max ${p.limit}` };
    case "minimum":
      return { path: at, message: `${show(value)}, min ${p.limit}` };
    case "exclusiveMaximum":
      return { path: at, message: `${show(value)}, must be under ${p.limit}` };
    case "exclusiveMinimum":
      return { path: at, message: `${show(value)}, must be over ${p.limit}` };
    case "maxItems":
      return { path: at, message: `${(value as unknown[]).length} items, max ${p.limit}` };
    case "minItems":
      return { path: at, message: `${(value as unknown[]).length} items, min ${p.limit}` };
    case "enum": {
      const allowed = (p.allowedValues as unknown[]).map(show).join(", ");
      return { path: at, message: `${show(value)} isn't one of ${allowed}` };
    }
    case "const":
      return { path: at, message: `${show(value)} isn't ${show(p.allowedValue)}` };
    case "type":
      return { path: at, message: `expected ${expected(p.type)}, got ${typeName(value)}` };
    case "format":
      return { path: at, message: `${show(value)} isn't a valid ${p.format}` };
    case "pattern":
      return { path: at, message: `doesn't match the pattern ${p.pattern}` };
    case "anyOf":
    case "oneOf":
      return { path: at, message: "doesn't match any allowed form" };
    default:
      return { path: at, message: error.message ?? error.keyword };
  }
}

const COMBINATORS = new Set(["anyOf", "oneOf", "if", "not", "allOf"]);

/**
 * Turn one validation's errors into the few lines that explain it.
 *
 * Every field in the validation schema also accepts a block (the walker checks
 * blocks separately), and fields that blocks can fill are unions, so a plain
 * mistake fails several branches at once. Keep the errors of the branch that
 * got furthest: drop the "it's not a block" branch errors, and drop a branch's
 * type mismatch when another branch reported something deeper at that spot.
 */
export function rewriteErrors(
  errors: ErrorObject[] | null | undefined,
  data: unknown,
  base = "",
): PlainError[] {
  if (!errors?.length) return [];
  const kept = errors.filter((e) => {
    if (e.schemaPath.includes(BLOCK_DEF)) return false;
    if (e.keyword === "required" && (e.params as any).missingProperty === "__resolveType")
      return false;
    return true;
  });
  const specific = kept.filter((e) => !COMBINATORS.has(e.keyword));
  const chosen = specific.filter((e) => {
    if (e.keyword !== "type" && e.keyword !== "const" && e.keyword !== "enum") return true;
    // A union branch's mismatch, when another branch said more about this spot.
    return !specific.some(
      (o) =>
        o !== e &&
        (o.instancePath.startsWith(`${e.instancePath}/`) ||
          (o.instancePath === e.instancePath && e.keyword === "type" && o.keyword !== "type")),
    );
  });
  // A union nobody explained: say so once.
  for (const e of kept) {
    if (e.keyword !== "anyOf" && e.keyword !== "oneOf") continue;
    const explained = chosen.some(
      (o) => o.instancePath === e.instancePath || o.instancePath.startsWith(`${e.instancePath}/`),
    );
    if (!explained) chosen.push(e);
  }
  const seen = new Set<string>();
  const out: PlainError[] = [];
  for (const e of chosen) {
    const line = plain(e, data, base);
    const key = `${line.path}\0${line.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}
