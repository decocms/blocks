/**
 * Per-request matcher override — port of the Deno runtime's
 * `x-deco-matchers-override` flag (deco/blocks/matcher.ts).
 *
 * Forces the result of saved matcher blocks without running them, keyed by
 * the block name as stored in the decofile:
 *
 * - Header: `x-deco-matchers-override: Segment A=1 Segment B=0`
 *   (space-separated pairs; `=1` forces true, anything else forces false)
 * - Query string: `?x-deco-matchers-override=Segment%20A=1` (repeatable)
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
