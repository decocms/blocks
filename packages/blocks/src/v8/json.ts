/** Small JSON-shape helpers shared by the resolver and the CMS. */

export type JsonObject = Record<string, unknown>;

/** A plain `{}` object (JSON-like), not an array, a class instance, a Date… */
export function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A stored block: a plain object whose `__resolveType` is a string. */
export function isBlock(value: unknown): value is JsonObject & { __resolveType: string } {
  return isPlainObject(value) && typeof value.__resolveType === "string";
}

/** Own-property lookup that ignores the prototype chain (`"constructor"`, `"__proto__"`…). */
export function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * A canonical string for a JSON-like value: object keys sorted, so two equal
 * blocks written in a different key order share a key. Returns `null` for
 * anything that isn't JSON-like (functions, Dates, class instances…), which
 * callers treat as "don't memoize". Object results are cached per object, so a
 * subtree's key is computed once even when its parents are keyed too.
 */
export function canonicalKey(value: unknown, cache: WeakMap<object, string | null>): string | null {
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "undefined":
      return "~";
    case "object":
      break;
    default:
      return null;
  }
  if (value === null) return "null";
  const cached = cache.get(value);
  if (cached !== undefined) return cached;

  let key: string | null;
  if (Array.isArray(value)) {
    key = joinKeys(
      value.map((item) => canonicalKey(item, cache)),
      "[",
      "]",
    );
  } else if (isPlainObject(value)) {
    const names = Object.keys(value).sort();
    key = joinKeys(
      names.map((name) => {
        const child = canonicalKey(value[name], cache);
        return child === null ? null : `${JSON.stringify(name)}:${child}`;
      }),
      "{",
      "}",
    );
  } else {
    key = null;
  }
  cache.set(value, key);
  return key;
}

function joinKeys(parts: (string | null)[], open: string, close: string): string | null {
  if (parts.some((part) => part === null)) return null;
  return `${open}${parts.join(",")}${close}`;
}
