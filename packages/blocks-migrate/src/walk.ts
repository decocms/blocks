/** Saved-block helpers shared by the steps. */

import path from "node:path";
import { readSavedBlocks, type SavedBlocks } from "@decocms/blocks/cli";

export type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Calls `visit` on every object inside `value` that has a string `__resolveType`, outermost first. */
export function forEachBlock(
  value: unknown,
  visit: (block: JsonObject & { __resolveType: string }) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) forEachBlock(item, visit);
    return;
  }
  if (!isPlainObject(value)) return;
  if (typeof value.__resolveType === "string")
    visit(value as JsonObject & { __resolveType: string });
  for (const child of Object.values(value)) forEachBlock(child, visit);
}

/** The site's saved blocks, read by the same rule `deco content` uses. */
export function readContent(root: string): SavedBlocks {
  return readSavedBlocks(path.join(root, ".deco", "blocks"));
}
