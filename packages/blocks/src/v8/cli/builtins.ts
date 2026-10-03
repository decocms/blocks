/**
 * Names the CLI knows without reading any code: the ten built-in blocks and
 * the legacy alias table.
 *
 * TODO(N-02): the runtime's built-in registry (`createCMS`) owns the built-in
 * implementations. These are only their names, which the CLI needs for the
 * schema, `deco check` and the content module's alias table; keep the two
 * lists in step when rebasing on N-02.
 */

/** Spec: built-in-blocks. Every block map gets these, in this order. */
export const BUILT_IN_BLOCKS = [
  "lazy",
  "multivariate",
  "always",
  "never",
  "date",
  "page",
  "redirect",
  "telemetry",
  "analytics",
  "secret",
] as const;

export type BuiltInBlock = (typeof BUILT_IN_BLOCKS)[number];

export function isBuiltIn(name: string): name is BuiltInBlock {
  return (BUILT_IN_BLOCKS as readonly string[]).includes(name);
}

/**
 * The legacy alias table: the names the Fresh/Deno framework and v7 gave the
 * built-ins, mapped to the short names. The site editor's special screens
 * still look types up by these names (spec: studio-compatibility › Well-known
 * types and the alias table), and content saved under them must keep
 * resolving, so `deco schema` writes this table into the schema and
 * `deco content` into the content module.
 *
 * Only names whose target exists in every block map are listed. Legacy types
 * with no built-in counterpart (the v7 Lazy/Deferred section wrapper, Seo
 * sections, `site/apps/site.ts`, the device/random/multi matchers) are not
 * aliases: a site keeps them working with a block map entry of its own.
 */
export const LEGACY_ALIASES: Readonly<Record<string, BuiltInBlock>> = {
  "website/pages/Page.tsx": "page",
  "$live/pages/LivePage.tsx": "page",
  "website/flags/multivariate.ts": "multivariate",
  "website/flags/multivariate/section.ts": "multivariate",
  "website/flags/multivariate/image.ts": "multivariate",
  "website/flags/multivariate/message.ts": "multivariate",
  "website/flags/multivariate/page.ts": "multivariate",
  "$live/flags/multivariate.ts": "multivariate",
  "website/matchers/always.ts": "always",
  "$live/matchers/MatchAlways.ts": "always",
  "website/matchers/never.ts": "never",
  "website/matchers/date.ts": "date",
  "$live/matchers/MatchDate.ts": "date",
  "website/loaders/redirect.ts": "redirect",
  "website/loaders/secret.ts": "secret",
};

/**
 * Legacy multivariate names store each variant's `value` plain; the runtime's
 * alias bridge wraps it in a `lazy` block. Under the short name `multivariate`
 * every value must already carry the wrapper.
 */
export function storesPlainVariants(name: string): boolean {
  return Object.hasOwn(LEGACY_ALIASES, name) && LEGACY_ALIASES[name] === "multivariate";
}
