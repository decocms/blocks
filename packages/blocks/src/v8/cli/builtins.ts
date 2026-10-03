/**
 * Names the CLI knows without reading any code: the built-in blocks (the
 * core's reserved names) and the legacy alias table.
 */
import { RESERVED_NAMES } from "../builtins/index.ts";

/** Spec: built-in-blocks. Every block map gets these, in this order. */
export const BUILT_IN_BLOCKS: readonly string[] = [...RESERVED_NAMES];

export function isBuiltIn(name: string): boolean {
  return RESERVED_NAMES.has(name);
}

/**
 * The legacy alias table lives with the runtime's alias bridge, so the
 * schema, the content module and resolution share one list. The site
 * editor's special screens still look types up by these names (spec:
 * studio-compatibility › Well-known types and the alias table).
 */
export { LEGACY_ALIASES, storesPlainVariants } from "../builtins/legacy.ts";
