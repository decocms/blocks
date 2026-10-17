/**
 * Per-request matcher override — port of the Deno runtime's
 * `x-deco-matchers-override` flag (deco/blocks/matcher.ts).
 *
 * Forces matcher results without running them, keyed by the Deno-style
 * uniqueId derived from the matcher's position in the decofile:
 *
 * - Saved matcher block referenced by name → the block name
 *   (`Segmento Mobile=1`), mirroring Deno's resolve chain stopping at the
 *   first resolvable.
 * - Inline matcher → `<blockId>@<prop.path.to.rule>`
 *   (`pages-home-c4bcbfb771e9@sections.2.variants.0.rule=0`).
 *
 * Carried by:
 * - Header: `x-deco-matchers-override: SegmentA=1 SegmentB=0`
 *   (space-separated pairs; `=1` forces true, anything else forces false)
 * - Query string: `?x-deco-matchers-override=Segment%20A%3D1` (repeatable)
 *
 * Header takes precedence over query string when both are present.
 */

import type { MatcherContext } from "../cms/resolve";

export const DECO_MATCHERS_OVERRIDE_PARAM = "x-deco-matchers-override";

/** Splits on the FIRST "=" so block names containing "=" still work. */
function addPair(values: Record<string, boolean>, pair: string): void {
  const idx = pair.indexOf("=");
  if (idx <= 0) return;
  values[pair.slice(0, idx)] = pair.slice(idx + 1) === "1";
}

function parseFromHeaders(ctx: MatcherContext): Record<string, boolean> | undefined {
  const val =
    ctx.request?.headers.get(DECO_MATCHERS_OVERRIDE_PARAM) ??
    ctx.headers?.[DECO_MATCHERS_OVERRIDE_PARAM];
  if (!val) return undefined;
  const values: Record<string, boolean> = {};
  for (const pair of val.split(" ")) addPair(values, pair);
  return values;
}

function parseFromQS(ctx: MatcherContext): Record<string, boolean> | undefined {
  if (!ctx.url) return undefined;
  let url: URL;
  try {
    url = new URL(ctx.url);
  } catch {
    return undefined;
  }
  if (!url.searchParams.has(DECO_MATCHERS_OVERRIDE_PARAM)) return undefined;
  const values: Record<string, boolean> = {};
  for (const pair of url.searchParams.getAll(DECO_MATCHERS_OVERRIDE_PARAM)) {
    addPair(values, pair);
  }
  return values;
}

const EMPTY: Record<string, boolean> = {};

// Memoized per Request so a page with many matchers parses once.
const overridesByRequest = new WeakMap<Request, Record<string, boolean>>();

/**
 * Parse the matcher overrides for this request (header first, then query
 * string). Returns an empty object when no override is present.
 */
export function getMatchersOverride(ctx: MatcherContext): Record<string, boolean> {
  const request = ctx.request;
  if (request) {
    const cached = overridesByRequest.get(request);
    if (cached) return cached;
  }
  const values = parseFromHeaders(ctx) ?? parseFromQS(ctx) ?? EMPTY;
  if (request) overridesByRequest.set(request, values);
  return values;
}

export function hasMatchersOverride(ctx: MatcherContext): boolean {
  const overrides = getMatchersOverride(ctx);
  for (const _ in overrides) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Rule uniqueId index — Deno resolveChain semantics
// ---------------------------------------------------------------------------

type RuleIdIndex = WeakMap<object, string>;

// Keyed by the blocks map identity, so the index is rebuilt on decofile
// hot-reload / KV swap (setBlocks replaces the map) and admin preview
// (withBlocksOverride returns a fresh merged map).
const indexByBlocks = new WeakMap<Record<string, unknown>, RuleIdIndex>();

function walkBlock(node: unknown, blockId: string, path: string, index: RuleIdIndex): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walkBlock(node[i], blockId, path ? `${path}.${i}` : `${i}`, index);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  if (path && typeof obj.__resolveType === "string") {
    index.set(obj, `${blockId}@${path}`);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === "__resolveType") continue;
    walkBlock(value, blockId, path ? `${path}.${key}` : key, index);
  }
}

/**
 * Resolve the Deno-style uniqueId (`<blockId>@<prop.path>`) for an inline
 * rule object by its identity in the blocks map. Returns undefined for
 * objects created during resolution (spreads/merges) — those are addressed
 * by their saved-block name instead.
 *
 * The index is built lazily (only when a request carries an override) and
 * cached per blocks map, so override-free traffic pays nothing.
 */
export function getRuleOverrideId(
  blocks: Record<string, unknown>,
  rule: object,
): string | undefined {
  let index = indexByBlocks.get(blocks);
  if (!index) {
    index = new WeakMap();
    for (const [blockId, block] of Object.entries(blocks)) {
      walkBlock(block, blockId, "", index);
    }
    indexByBlocks.set(blocks, index);
  }
  return index.get(rule);
}
