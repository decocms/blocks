/**
 * Legacy type names the next major's alias table doesn't carry (spec:
 * studio-compatibility › Well-known types and the alias table). v7 resolved
 * these; the next major resolves only the names the site editor's screens
 * look for, so the migration rewrites the others to one of those (or to the
 * built-in's own name) in the saved content.
 */
import fs from "node:fs";
import path from "node:path";
import { serializeBlock } from "@decocms/blocks/protocol/keys";
import type { Report } from "./report";
import { forEachBlock, readContent } from "./walk";

/** Old name → the name it's saved under after the migration. Same props, same behaviour. */
export const RENAMED_TYPES: Readonly<Record<string, string>> = {
  "website/flags/multivariate/image.ts": "website/flags/multivariate.ts",
  "website/flags/multivariate/message.ts": "website/flags/multivariate.ts",
  "website/flags/multivariate/page.ts": "website/flags/multivariate.ts",
  "$live/flags/multivariate.ts": "website/flags/multivariate.ts",
  "$live/matchers/MatchAlways.ts": "website/matchers/always.ts",
  "website/matchers/date.ts": "date",
  "$live/matchers/MatchDate.ts": "date",
};

export function renameLegacyTypes(root: string, report: Report): void {
  const { blocks, files } = readContent(root);
  for (const [entry, block] of Object.entries(blocks)) {
    const renamed = new Set<string>();
    forEachBlock(block, (node) => {
      const to = Object.hasOwn(RENAMED_TYPES, node.__resolveType)
        ? RENAMED_TYPES[node.__resolveType]
        : undefined;
      if (to === undefined) return;
      renamed.add(`${node.__resolveType} → ${to}`);
      node.__resolveType = to;
    });
    if (renamed.size === 0) continue;
    fs.writeFileSync(path.join(root, ".deco", "blocks", files[entry]!), serializeBlock(block));
    report.done.push({
      step: "content",
      subject: files[entry]!,
      message: `renamed ${[...renamed].join(", ")}`,
    });
  }
}
