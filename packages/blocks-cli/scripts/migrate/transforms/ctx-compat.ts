import type { TransformResult } from "../types";

/**
 * Make ported deco.cx section loaders defensive about the compat `ctx`
 * (issue #305).
 *
 * The framework now hands section loaders a real 3rd-arg `ctx`
 * (`@decocms/blocks`'s `buildSectionLoaderContext`) with `device`, `invoke`,
 * `response` and per-app state (`ctx.vtex`, `ctx.salesforce`, …). But an app
 * that isn't configured on the target site yields `undefined`, so a
 * *non-optional* deep read like `ctx.salesforce.cartExtension[0]` still throws
 * — and `withSectionLoader`'s try/catch would swallow it, dropping the
 * section's props (blank render). The hand-fixed reference migration
 * (`granadobr-tanstack`) solves this by optional-chaining every `ctx` read.
 *
 * This codemod reproduces that: every `ctx.` member-access chain becomes an
 * optional chain (`ctx?.a?.b?.[0]`). Optional chaining short-circuits to
 * `undefined` instead of throwing, which is exactly the defensive behavior the
 * working migration relies on. `ctx.device`/`ctx.invoke` are always present so
 * the extra `?.` is a harmless no-op there.
 *
 * Scope: only files that export a `loader` (section/loader files), so an
 * unrelated `ctx` (e.g. a canvas 2D context) elsewhere isn't touched.
 * Assignment targets (`ctx.x = …`, invalid as an optional chain) are skipped.
 */

const IDENT = /[A-Za-z0-9_$]/;

const LOADER_EXPORT_RE =
  /export\s+(?:const|(?:async\s+)?function)\s+loader\b|export\s*\{\s*[^}]*\bloader\b/;

function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && IDENT.test(c);
}

/**
 * Scan a single `ctx` member-access chain starting at `start` (which must
 * point at the `c` of `ctx`). Returns the rewritten (optional) chain, the
 * original text, the index just past the chain, and whether the chain is the
 * target of an assignment (in which case it must NOT be optional-chained).
 */
function scanChain(
  code: string,
  start: number,
): { rewritten: string; original: string; end: number; isAssignTarget: boolean } {
  let i = start + 3; // past "ctx"
  const pieces: string[] = ["ctx"];

  while (i < code.length) {
    if (code.startsWith("?.", i)) {
      // already optional — keep it, then consume the identifier OR, for an
      // optional computed access (`?.[expr]`), the balanced bracket group.
      i += 2;
      if (code[i] === "[") {
        let depth = 1;
        let j = i + 1;
        while (j < code.length && depth > 0) {
          if (code[j] === "[") depth++;
          else if (code[j] === "]") depth--;
          j++;
        }
        pieces.push("?.[", code.slice(i + 1, j));
        i = j;
      } else {
        let j = i;
        while (j < code.length && isIdentChar(code[j])) j++;
        pieces.push("?.", code.slice(i, j));
        i = j;
      }
    } else if (code[i] === ".") {
      i += 1;
      let j = i;
      while (j < code.length && isIdentChar(code[j])) j++;
      pieces.push("?.", code.slice(i, j));
      i = j;
    } else if (code[i] === "[") {
      let depth = 1;
      let j = i + 1;
      while (j < code.length && depth > 0) {
        if (code[j] === "[") depth++;
        else if (code[j] === "]") depth--;
        j++;
      }
      pieces.push("?.[", code.slice(i + 1, j)); // slice includes closing "]"
      i = j;
    } else {
      break;
    }
  }

  // Peek past trailing whitespace to detect an assignment target.
  let k = i;
  while (k < code.length && (code[k] === " " || code[k] === "\t")) k++;
  const isAssignTarget = code[k] === "=" && code[k + 1] !== "=" && code[k + 1] !== ">";

  return {
    rewritten: pieces.join(""),
    original: code.slice(start, i),
    end: i,
    isAssignTarget,
  };
}

export function transformCtxCompat(content: string): TransformResult {
  // Only touch files that actually export a loader — avoids rewriting an
  // unrelated `ctx` variable (canvas context, etc.) in components.
  if (!LOADER_EXPORT_RE.test(content)) {
    return { content, changed: false, notes: [] };
  }

  let out = "";
  let i = 0;
  let count = 0;

  while (i < content.length) {
    const isCtxToken =
      content.startsWith("ctx", i) &&
      !isIdentChar(content[i - 1]) &&
      content[i - 1] !== "." &&
      (content[i + 3] === "." || content[i + 3] === "[" || content.startsWith("?.", i + 3));

    if (isCtxToken) {
      const { rewritten, original, end, isAssignTarget } = scanChain(content, i);
      if (!isAssignTarget && rewritten !== original) {
        out += rewritten;
        count++;
      } else {
        out += original;
      }
      i = end;
      continue;
    }

    out += content[i];
    i++;
  }

  if (count === 0) {
    return { content, changed: false, notes: [] };
  }

  return {
    content: out,
    changed: true,
    notes: [
      `Optional-chained ${count} ctx.* read(s) so unconfigured app state degrades to undefined instead of throwing (#305)`,
    ],
  };
}

export const _internals = { scanChain, LOADER_EXPORT_RE };
