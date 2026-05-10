/**
 * Load all `.deco/blocks/*.json` files from a directory into a map keyed by
 * the filename (without `.json` extension), URL-decoded.
 *
 * Node-only — uses `node:fs/promises` and `node:path` lazily so the symbol
 * can appear in the framework-agnostic core barrel without breaking client
 * bundles (the function body is never reached at parse time on the client).
 *
 * Pair with `setBlocks(blocks)` to populate the CMS at app boot:
 *
 * ```ts
 * import { setBlocks, loadAllDecofileBlocks } from "@decocms/start/core";
 * setBlocks(await loadAllDecofileBlocks());
 * ```
 *
 * @param dir Directory containing the JSON files. Defaults to `.deco/blocks` relative to cwd.
 * @returns A map of `{ [decodedFilename]: parsedJson }`. Malformed JSONs are
 *          skipped with a `console.warn`.
 */
export async function loadAllDecofileBlocks(
  dir: string = ".deco/blocks",
): Promise<Record<string, unknown>> {
  const { readdir, readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const out: Record<string, unknown> = {};

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }

  for (const filename of entries) {
    if (!filename.endsWith(".json")) continue;
    const fullPath = path.join(dir, filename);
    let raw: string;
    try {
      raw = await readFile(fullPath, "utf8");
    } catch (err) {
      console.warn(`[loadAllDecofileBlocks] could not read ${fullPath}:`, err);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(`[loadAllDecofileBlocks] malformed JSON in ${fullPath}:`, err);
      continue;
    }
    const key = decodeURIComponent(filename.slice(0, -".json".length));
    out[key] = parsed;
  }

  return out;
}
