/**
 * `let x: number = setTimeout(...)` typing fix.
 *
 * Deco-fresh (Deno DOM types) had `setTimeout`/`setInterval` return `number`, so
 * sites typed their handles `let hideTimeout: number`. Under Node/TanStack types
 * they return `NodeJS.Timeout`, so the assignment fails ("Type 'Timeout' is not
 * assignable to type 'number'"). Rather than `window.setTimeout` (unsafe in
 * server `.ts`), retype the DECLARATION to `ReturnType<typeof setTimeout>` — the
 * portable handle type, correct in both browser and worker/node.
 *
 * Only a `let|const|var NAME: number` declaration whose NAME is assigned a
 * `setTimeout(` / `setInterval(` elsewhere in the file is retyped; a plain
 * numeric variable is never touched.
 */

import type { TransformResult } from "../types";

export function transformTimerTypes(content: string): TransformResult {
  const notes: string[] = [];
  let changed = false;
  let result = content;

  for (const kind of ["setTimeout", "setInterval"] as const) {
    // Names assigned this timer: `NAME = setTimeout(` (and `= window.setTimeout(`).
    const assigned = new Set<string>();
    for (const m of content.matchAll(
      new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*(?:window\\.)?${kind}\\s*\\(`, "g"),
    )) {
      assigned.add(m[1]!);
    }

    for (const name of assigned) {
      // Retype only the declaration's `: number` (allowing `| undefined`/`| null`).
      const declRe = new RegExp(
        `\\b(let|const|var)(\\s+${name}\\s*:\\s*)number\\b`,
        "g",
      );
      const next = result.replace(declRe, `$1$2ReturnType<typeof ${kind}>`);
      if (next !== result) {
        result = next;
        changed = true;
        notes.push(`Timer type: ${name}: number → ReturnType<typeof ${kind}>`);
      }
    }
  }

  return { content: result, changed, notes };
}
