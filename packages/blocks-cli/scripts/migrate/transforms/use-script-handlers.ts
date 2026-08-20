/**
 * `useScript` in React event handlers → a plain arrow.
 *
 * Deco-fresh's `useScript(fn, ...args)` serialized `fn` to a client-side script
 * STRING (hydration-free interactivity), so `onClick={useScript(onClick, -1)}`
 * passed a string to `onClick`. React wants a FUNCTION and the stricter TanStack
 * typecheck fails ("Type 'string' is not assignable to MouseEventHandler").
 * Hydrated React just calls the function directly:
 *
 *   onClick={useScript(onClick, -1)}   →   onClick={() => onClick(-1)}
 *
 * Only the SIMPLE, unambiguous shape is rewritten — an identifier callback plus
 * literal args (no nested parens/braces). An INLINE arrow
 * (`useScript(({x}) => {…})`) depends on how the closure was serialized and is a
 * per-site call, so it's left for the `htmx-residue` audit + manual rewrite.
 */

import type { TransformResult } from "../types";

export function transformUseScriptHandlers(content: string): TransformResult {
  const notes: string[] = [];
  let changed = false;

  // onEvent={useScript(IDENT[, simple args])} — IDENT is a bare identifier /
  // member expr; args contain no nested parens or braces (keeps it safe).
  const re = /\b(on[A-Z]\w+)=\{useScript\(\s*([A-Za-z_$][\w$.]*)\s*((?:,[^{}()]*)?)\)\}/g;

  const result = content.replace(re, (_whole, event: string, fn: string, argsRaw: string) => {
    const args = argsRaw.replace(/^\s*,\s*/, "").trim();
    changed = true;
    notes.push(`useScript handler: ${event}={useScript(${fn}…)} → () => ${fn}(…)`);
    return `${event}={() => ${fn}(${args})}`;
  });

  return { content: result, changed, notes };
}
