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
 * What relies on each built-in, in Studio and in the runtime: `deco check`
 * names it when a block map replaces one (a site may mean to; it is told
 * what it takes over, not that it's wrong).
 */
export const BUILT_IN_USES: Readonly<Record<string, string>> = Object.freeze({
  lazy: "every Lazy<T> field relies on it, such as a variant's value, which runs only when chosen",
  multivariate: "Studio's variants, the fields whose value changes by rule, rely on it",
  always: "the default variant Studio adds to each list of variants relies on it",
  never: "a variant Studio turns off relies on it",
  experiment:
    "Studio's A/B test rules rely on it, each naming a test of the saved block experiments",
  campaign:
    "Studio's campaign rules rely on it, each naming a campaign of the saved block campaigns",
  page: "Studio's page list and page editor rely on it",
  redirect: "Studio's redirect list relies on it",
  "cms-settings": "the saved block CMS relies on it, and Studio's settings edit that block",
  secret: "Studio's secret fields rely on it to keep their values encrypted",
  "split-traffic":
    "the saved block experiments relies on it, and Studio's Experiments view edits its percentages",
  calendar: "the saved block campaigns relies on it, and Studio's Campaigns view edits its dates",
});

/**
 * The legacy alias table lives with the runtime's alias bridge, so the
 * schema, the content module and resolution share one list. The site
 * editor's special screens still look types up by these names (spec:
 * studio-compatibility › Well-known types and the alias table).
 */
export { LEGACY_ALIASES, storesPlainVariants } from "../builtins/legacy.ts";
