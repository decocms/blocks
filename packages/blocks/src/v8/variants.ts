/**
 * Forced variants (see /next/releases-and-drafts#preview-a-variant): the
 * variants a draft pointer's `__variant` parameters name, applied to each body
 * a preview request reads (see ./pin.ts). Each addressed multivariate keeps
 * only the forced variant, with the rule `true`, so it shows that variant's
 * value and no other rule runs. A body is copied along the addressed paths
 * only; the shared one is never touched.
 *
 * An address that doesn't reach a multivariate block with that variant (a
 * renamed block, a moved section, an index past the end) is ignored, so a
 * stale preview link renders the content as saved.
 */
import { LEGACY_ALIASES } from "./builtins/legacy.ts";
import { isPlainObject, own } from "./json.ts";
import type { ForcedVariant } from "./types.ts";

/**
 * One saved block's body with the variants forced on it (those whose `block`
 * is `name`), copied along the addressed paths only; the body itself when none
 * applies. How a request applies forced variants to bodies it reads lazily.
 */
export function forceBody(
  name: string,
  body: unknown,
  variants: readonly ForcedVariant[],
  aliases: Readonly<Record<string, string>> | undefined,
): unknown {
  let out = body;
  for (const { block, path, index } of variants) {
    if (block !== name) continue;
    out = forceAt(out, path === "" ? [] : path.split("."), index, aliases);
  }
  return out;
}

type Aliases = Readonly<Record<string, string>> | undefined;

function forceAt(node: unknown, keys: string[], index: number, aliases: Aliases): unknown {
  if (keys.length === 0) return forceNode(node, index, aliases);
  const [key, ...rest] = keys as [string, ...string[]];
  if (Array.isArray(node)) {
    const i = Number(key);
    if (!Number.isInteger(i) || String(i) !== key || i < 0 || i >= node.length) return node;
    const child = forceAt(node[i], rest, index, aliases);
    if (child === node[i]) return node;
    const copy = node.slice();
    copy[i] = child;
    return copy;
  }
  if (!isPlainObject(node) || !Object.hasOwn(node, key)) return node;
  const child = forceAt(node[key], rest, index, aliases);
  return child === node[key] ? node : { ...node, [key]: child };
}

/** A multivariate block (by its own name or an alias) with only `variants[index]`, ruled `true`. */
function forceNode(node: unknown, index: number, aliases: Aliases): unknown {
  if (!isPlainObject(node) || typeof node.__resolveType !== "string") return node;
  const type = node.__resolveType;
  const canonical =
    own(aliases as Record<string, string> | undefined, type) ?? own(LEGACY_ALIASES, type) ?? type;
  if (canonical !== "multivariate" || !Array.isArray(node.variants)) return node;
  const variant = node.variants[index];
  if (!isPlainObject(variant)) return node;
  return { ...node, variants: [{ ...variant, rule: true }] };
}
