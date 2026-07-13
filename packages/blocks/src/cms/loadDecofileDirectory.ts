import * as fs from "node:fs/promises";
import { join } from "node:path";

/**
 * Derive a block id (decofile map key) from a `.deco/blocks` filename.
 *
 * Classic deco stores each block as `encodeURIComponent(<block id>).json`
 * and derives the id back with exactly one decodeURIComponent — this is
 * upstream `parseBlockId` (deco-cx/deco, engine/decofile/fsFolder). Block
 * CONTENT references saved blocks by the DECODED id (`"__resolveType":
 * "Cores dos preços"`), and the Studio editor derives the write-back
 * filename as `encodeURIComponent(<key>)`, so keying the map by the raw
 * stem breaks both: references dangle at resolve time and editor saves
 * land in a freshly-created double-encoded file.
 *
 * A stem that is not valid percent-encoding (e.g. a page literally named
 * "50% off") throws in decodeURIComponent — such a stem IS the id already
 * (classic deco would have stored it encoded), so it is kept verbatim,
 * matching upstream behavior for pre-encoding-era files.
 */
export function parseBlockId(filename: string): string {
  const stem = filename.endsWith(".json") ? filename.slice(0, -".json".length) : filename;
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
}

/**
 * Loads a directory of legacy per-block JSON snapshot files (the format
 * produced by the pre-v2 Deco admin, e.g. `.deco/blocks/<name>.json`) into
 * a single blocks map suitable for setBlocks(). Each file becomes one
 * entry keyed by `parseBlockId(<filename>)` — the filename stem URL-decoded
 * once, matching the classic deco runtime's key convention.
 *
 * Beyond that single decode the key is not renamed or normalized: whatever
 * prefix convention a block's filename already carries (e.g. real page
 * block snapshots are named `pages-<slug>-<id>.json`) is preserved, because
 * getAllPages() in loader.ts filters blocks by `key.startsWith("pages-")`
 * before findPageByPath() matches on each page's own `.path` field. So the
 * key format IS load-bearing for page blocks — decoding never touches the
 * `pages-` prefix itself, only the percent-escapes after it.
 *
 * Two filenames can decode to the same id (`A B.json` + `A%20B.json`).
 * Files are processed in sorted filename order and the last one wins, so
 * the outcome is deterministic; a console.warn names the shadowed file.
 *
 * Replaces the abandoned @decocms/start/node tier's loadAllDecofileBlocks,
 * which no longer exists on any reachable blocks version — ported
 * fresh rather than resurrected. Namespace-imported node:fs/promises to
 * match this codebase's existing pattern for Node-only code that must not
 * break Vite/webpack client bundle analysis (see cms/loader.ts's
 * AsyncLocalStorage import for the established precedent).
 */
export async function loadDecofileDirectory(dir: string): Promise<Record<string, unknown>> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const blocks: Record<string, unknown> = {};

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const parsed = await Promise.all(
    files.map(async (name) => {
      const content = await fs.readFile(join(dir, name), "utf8");
      try {
        return { name, value: JSON.parse(content) as unknown };
      } catch (error) {
        throw new Error(
          `loadDecofileDirectory: failed to parse ${name}: ${(error as Error).message}`,
        );
      }
    }),
  );

  for (const { name, value } of parsed) {
    const key = parseBlockId(name);
    if (key in blocks) {
      console.warn(
        `loadDecofileDirectory: block id ${JSON.stringify(key)} maps to multiple files; ${JSON.stringify(name)} wins`,
      );
    }
    blocks[key] = value;
  }

  return blocks;
}
