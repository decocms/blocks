/**
 * Forced variants (see /next/releases-and-drafts#preview-a-variant): the
 * variants a draft pointer's `__variant` parameters name, applied to a
 * snapshot for one preview. Each addressed multivariate keeps only the forced
 * variant, with the rule `true`, so it shows that variant's value and no other
 * rule runs. The snapshot is copied along the addressed paths only; the shared
 * one is never touched.
 *
 * An address that doesn't reach a multivariate block with that variant (a
 * renamed block, a moved section, an index past the end) is ignored, so a
 * stale preview link renders the content as saved.
 */
import { LEGACY_ALIASES } from "./builtins/legacy.ts";
import { isPlainObject, own } from "./json.ts";
import type { ForcedVariant, Snapshot } from "./types.ts";

export function forceVariants(
  snapshot: Snapshot,
  variants: readonly ForcedVariant[] | undefined,
): Snapshot {
  if (variants === undefined || variants.length === 0) return snapshot;
  let blocks: Record<string, unknown> | undefined;
  for (const { block, path, index } of variants) {
    const entry = own(blocks ?? snapshot.blocks, block);
    if (entry === undefined) continue;
    const keys = path === "" ? [] : path.split(".");
    const next = forceAt(entry, keys, index, snapshot);
    if (next === entry) continue;
    blocks ??= { ...snapshot.blocks };
    blocks[block] = next;
  }
  return blocks === undefined ? snapshot : { ...snapshot, blocks };
}

function forceAt(node: unknown, keys: string[], index: number, snapshot: Snapshot): unknown {
  if (keys.length === 0) return forceNode(node, index, snapshot);
  const [key, ...rest] = keys as [string, ...string[]];
  if (Array.isArray(node)) {
    const i = Number(key);
    if (!Number.isInteger(i) || String(i) !== key || i < 0 || i >= node.length) return node;
    const child = forceAt(node[i], rest, index, snapshot);
    if (child === node[i]) return node;
    const copy = node.slice();
    copy[i] = child;
    return copy;
  }
  if (!isPlainObject(node) || !Object.hasOwn(node, key)) return node;
  const child = forceAt(node[key], rest, index, snapshot);
  return child === node[key] ? node : { ...node, [key]: child };
}

/** A multivariate block (by its own name or an alias) with only `variants[index]`, ruled `true`. */
function forceNode(node: unknown, index: number, snapshot: Snapshot): unknown {
  if (!isPlainObject(node) || typeof node.__resolveType !== "string") return node;
  const type = node.__resolveType;
  const canonical = own(snapshot.aliases, type) ?? own(LEGACY_ALIASES, type) ?? type;
  if (canonical !== "multivariate" || !Array.isArray(node.variants)) return node;
  const variant = node.variants[index];
  if (!isPlainObject(variant)) return node;
  return { ...node, variants: [{ ...variant, rule: true }] };
}
