/**
 * The legacy alias bridge: the well-known Fresh/Deno and v7 type names the
 * site editor still writes, mapped to the built-ins, so v7 content resolves
 * without a block-map entry (see /next/studio-compatibility#well-known-types-and-the-alias-table
 * and /next/renames-and-migrations#rename-a-type-with-an-alias).
 *
 * A snapshot's own `aliases` (the table `deco content` writes) win over these, and a key in the block map wins over
 * both, so a site can still register a legacy name itself.
 *
 * - Redirects keep v7's nested shape: `redirect` returns its arguments as
 *   saved, and `matchRoute` accepts both shapes.
 * - `website/loaders/secret.ts` resolves as `secret`, which needs the
 *   `ciphertext` the one-time re-encryption writes (see
 *   /next/renames-and-migrations#secrets); a v7 `encrypted` value fails that
 *   block with `BLOCK_FAILED`.
 * - Legacy variants are saved as plain values; on the way to `multivariate`
 *   each one is wrapped in a `lazy` block, so only the chosen one runs.
 */
import { isPlainObject, type JsonObject } from "../json";

/**
 * Legacy type name → built-in. The one table: the runtime falls back to it,
 * and `deco schema` / `deco content` write it into the schema and the content
 * module. Exactly the names the site editor's special screens look for
 * (/next/studio-compatibility#well-known-types-and-the-alias-table); other
 * legacy names (`$live/…`, the per-kind multivariate files, the date
 * matcher) are rewritten to these by the one-time migration
 * (`@decocms/blocks-migrate`), and types with no built-in counterpart are
 * left to the site's block map.
 */
export const LEGACY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "website/pages/Page.tsx": "page",
  "$live/pages/LivePage.tsx": "page",
  "website/flags/multivariate.ts": "multivariate",
  "website/flags/multivariate/section.ts": "multivariate",
  "website/matchers/always.ts": "always",
  "website/matchers/never.ts": "never",
  "website/loaders/redirect.ts": "redirect",
  "website/loaders/secret.ts": "secret",
});

/**
 * Whether a legacy name stores its variants' values plain (every legacy name
 * for `multivariate`); under the short name each value carries a `lazy`.
 */
export function storesPlainVariants(type: string): boolean {
  return Object.hasOwn(LEGACY_ALIASES, type) && LEGACY_ALIASES[type] === "multivariate";
}

/**
 * A legacy variants block with each plain `value` wrapped in `lazy`; any
 * other block as is. A value that already is a `lazy` block stays one.
 */
export function wrapLegacyVariants(type: string, node: JsonObject): JsonObject {
  if (!storesPlainVariants(type) || !Array.isArray(node.variants)) return node;
  return {
    ...node,
    variants: node.variants.map((variant) =>
      isPlainObject(variant) &&
      !(isPlainObject(variant.value) && variant.value.__resolveType === "lazy")
        ? { ...variant, value: { __resolveType: "lazy", value: variant.value } }
        : variant,
    ),
  };
}
