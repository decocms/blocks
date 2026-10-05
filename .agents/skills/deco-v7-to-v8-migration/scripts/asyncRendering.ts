/**
 * Async rendering: v7 could defer a section behind a wrapper block, rendered
 * after the page (`website/sections/Rendering/Lazy.tsx`, its re-export
 * `SingleDeferred.tsx`, both `{ section }`) or on a trigger
 * (`Deferred.tsx`, `{ sections: [...] }`). The next major has no async
 * rendering (spec: renames-and-migrations › Migrating from v7), so the
 * migration unwraps them in saved content: each wrapper is replaced by the
 * section(s) it held, props untouched, and the wrapper's own options
 * (`loading`, `display`, `behavior`) go. In a list, a `Deferred` gives way to
 * all its sections in place. Running it again changes nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { serializeBlock } from "@decocms/blocks/protocol/keys";
import type { Report } from "./report";
import { isPlainObject, type JsonObject, readContent } from "./walk";

const WRAPPER = /^website\/sections\/Rendering\/(Lazy|SingleDeferred|Deferred)\.tsx?$/;

/** The sections a wrapper held, or `null` when `value` isn't a wrapper. */
function wrapped(value: unknown): unknown[] | null {
  if (!isPlainObject(value) || typeof value.__resolveType !== "string") return null;
  const kind = WRAPPER.exec(value.__resolveType)?.[1];
  if (kind === undefined) return null;
  const inner = kind === "Deferred" ? value.sections : [value.section];
  return Array.isArray(inner) ? inner.filter(isPlainObject) : [];
}

/**
 * `value` with every wrapper unwrapped. Outside a list, a wrapper that doesn't
 * hold exactly one section stays, and its type goes in `stuck`.
 */
function unwrap(value: unknown, stuck: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const inner = wrapped(item);
      return inner === null ? [unwrap(item, stuck)] : (unwrap(inner, stuck) as unknown[]);
    });
  }
  if (!isPlainObject(value)) return value;
  const inner = wrapped(value);
  if (inner?.length === 1) return unwrap(inner[0], stuck);
  if (inner !== null) stuck.add(value.__resolveType as string); // kept; its sections still unwrap
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) out[key] = unwrap(child, stuck);
  return out;
}

export function unwrapAsyncRendering(root: string, report: Report): void {
  const { blocks, files } = readContent(root);
  for (const [entry, block] of Object.entries(blocks)) {
    const stuck = new Set<string>();
    const next = unwrap(block, stuck);
    const before = serializeBlock(block);
    const after = serializeBlock(next);
    if (after !== before) {
      fs.writeFileSync(path.join(root, ".deco", "blocks", files[entry]!), after);
      report.done.push({
        step: "content",
        subject: files[entry]!,
        message: "unwrapped v7 async-rendering wrappers (Lazy/Deferred) to the sections they held",
      });
    }
    for (const type of stuck) {
      report.manual.push({
        step: "content",
        subject: `${type} (in ${files[entry]})`,
        message:
          "a v7 async-rendering wrapper holding no section or several where one block goes; the next major has no async rendering: replace it with its section(s) by hand",
      });
    }
  }
}
