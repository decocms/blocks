import * as fs from "node:fs/promises";
import { join } from "node:path";

/**
 * Loads a directory of legacy per-block JSON snapshot files (the format
 * produced by the pre-v2 Deco admin, e.g. `.deco/blocks/<name>.json`) into
 * a single blocks map suitable for setBlocks(). Each file becomes one
 * entry keyed by its filename minus the .json extension.
 *
 * The key is not renamed or normalized beyond stripping the extension:
 * whatever prefix convention a block's filename already carries (e.g. real
 * page block snapshots are named `pages-<slug>-<id>.json`) is preserved
 * verbatim, because getAllPages() in loader.ts filters blocks by
 * `key.startsWith("pages-")` before findPageByPath() matches on each page's
 * own `.path` field. So the key format IS load-bearing for page blocks —
 * it must keep whatever prefix its source filename had — but this loader
 * never needs to invent or choose that prefix itself, since it simply
 * passes the on-disk filename through.
 *
 * Replaces the abandoned @decocms/start/node tier's loadAllDecofileBlocks,
 * which no longer exists on any reachable deco-start version — ported
 * fresh rather than resurrected. Namespace-imported node:fs/promises to
 * match this codebase's existing pattern for Node-only code that must not
 * break Vite/webpack client bundle analysis (see cms/loader.ts's
 * AsyncLocalStorage import for the established precedent).
 */
export async function loadDecofileDirectory(dir: string): Promise<Record<string, unknown>> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const blocks: Record<string, unknown> = {};

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const key = entry.name.slice(0, -".json".length);
        const content = await fs.readFile(join(dir, entry.name), "utf8");
        try {
          blocks[key] = JSON.parse(content);
        } catch (error) {
          throw new Error(
            `loadDecofileDirectory: failed to parse ${entry.name}: ${(error as Error).message}`,
          );
        }
      }),
  );

  return blocks;
}
