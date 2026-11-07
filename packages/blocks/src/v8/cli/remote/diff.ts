/**
 * A line diff of two blocks as `.deco/blocks` stores them
 * (`serializeBlock`: two-space JSON), for `deco diff`, `deco publish` and
 * push conflicts. No dependency: common prefix and suffix, then an LCS of
 * what's left (a whole replace when that would be too large to compute).
 */
import { serializeBlock } from "../../../protocol/keys.ts";
import { paint } from "../color.ts";

/** Above this many cells the middle is shown as removed then added. */
const MAX_LCS_CELLS = 4_000_000;

export type DiffLine = { op: " " | "-" | "+"; text: string };

function lines(block: unknown): string[] {
  if (block === undefined) return [];
  return serializeBlock(block).replace(/\n$/, "").split("\n");
}

export function diffLines(a: string[], b: string[]): DiffLine[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text) => ({ op: " " as const, text }));
  const tail = a.slice(endA).map((text) => ({ op: " " as const, text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle: DiffLine[] = [];
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    for (const text of midA) middle.push({ op: "-", text });
    for (const text of midB) middle.push({ op: "+", text });
  } else {
    const n = midA.length;
    const m = midB.length;
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i]![j] =
          midA[i] === midB[j]
            ? table[i + 1]![j + 1]! + 1
            : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        middle.push({ op: " ", text: midA[i]! });
        i++;
        j++;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        middle.push({ op: "-", text: midA[i++]! });
      } else {
        middle.push({ op: "+", text: midB[j++]! });
      }
    }
    while (i < n) middle.push({ op: "-", text: midA[i++]! });
    while (j < m) middle.push({ op: "+", text: midB[j++]! });
  }
  return [...head, ...middle, ...tail];
}

/**
 * The diff of `from` to `to` as text: changed lines with up to `context`
 * unchanged lines around them, `-` for `from`, `+` for `to`. `undefined` is
 * no block (a creation or a deletion). Empty when they are equal.
 */
export function formatBlockDiff(
  from: unknown,
  to: unknown,
  options: { color?: boolean; context?: number } = {},
): string {
  const c = paint(options.color);
  const context = options.context ?? 3;
  const diff = diffLines(lines(from), lines(to));
  const show = new Array<boolean>(diff.length).fill(false);
  diff.forEach((line, index) => {
    if (line.op === " ") return;
    for (let k = Math.max(0, index - context); k <= Math.min(diff.length - 1, index + context); k++)
      show[k] = true;
  });
  const out: string[] = [];
  let skipped = false;
  diff.forEach((line, index) => {
    if (!show[index]) {
      skipped = true;
      return;
    }
    if (skipped && out.length > 0) out.push(c.dim("  …"));
    skipped = false;
    const text = `${line.op} ${line.text}`;
    out.push(line.op === "-" ? c.red(text) : line.op === "+" ? c.green(text) : text);
  });
  return out.join("\n");
}
