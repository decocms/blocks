/**
 * Experiment IDs (spec: renames-and-migrations › Telemetry and analytics).
 * v7 keyed A/B results on the saved name of the random matcher a variant's
 * rule pointed at. The next major keys them on `multivariate`'s `experiment`,
 * so this step copies that name into it and results carry over.
 */
import fs from "node:fs";
import path from "node:path";
import { LEGACY_ALIASES } from "@decocms/blocks/cli";
import { serializeBlock } from "@decocms/blocks/protocol/keys";
import type { Report } from "./report";
import { forEachBlock, readContent } from "./walk";

const RANDOM_MATCHERS = new Set(["website/matchers/random.ts", "website/matchers/random"]);

function isMultivariate(type: string): boolean {
  return (
    type === "multivariate" ||
    (Object.hasOwn(LEGACY_ALIASES, type) && LEGACY_ALIASES[type] === "multivariate")
  );
}

/** Set `experiment` on every `multivariate` whose variant rule is a saved random matcher. */
export function copyExperimentIds(root: string, report: Report): void {
  const { blocks, files } = readContent(root);
  const randoms = new Set(
    Object.entries(blocks)
      .filter(([, b]) => RANDOM_MATCHERS.has(b.__resolveType as string))
      .map(([name]) => name),
  );
  if (randoms.size === 0) return;

  for (const [entry, block] of Object.entries(blocks)) {
    let changed = false;
    forEachBlock(block, (node) => {
      if (!isMultivariate(node.__resolveType) || node.experiment !== undefined) return;
      const variants = Array.isArray(node.variants) ? node.variants : [];
      const name = variants
        .map((v) => (v as { rule?: { __resolveType?: unknown } } | null)?.rule?.__resolveType)
        .find((t): t is string => typeof t === "string" && randoms.has(t));
      if (!name) return;
      node.experiment = name;
      changed = true;
      report.done.push({
        step: "content",
        subject: files[entry],
        message: `set experiment "${name}" (the random matcher's saved name), so A/B results carry over`,
      });
    });
    if (changed) {
      fs.writeFileSync(path.join(root, ".deco", "blocks", files[entry]), serializeBlock(block));
    }
  }
}
