/**
 * `bun scripts/checkContentReads.ts [--root <dir>]`: fails (exit 1) when the
 * site's code still calls `client.list(…)`, which 8.11 removed; prints
 * every `.deco/blocks` scan too, without failing on it (see
 * ./contentReads.ts). Run it from the skill's verify step, after the
 * migration and before review.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { findContentReads } from "./contentReads";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { root: { type: "string", default: "." } },
});
const root = path.resolve(values.root!);
const reads = findContentReads(root);
for (const read of reads) {
  const label =
    read.kind === "list" ? "error: client.list() is gone" : "warning: scans .deco/blocks";
  console.log(`${read.file}:${read.line}: ${label}: ${read.code}`);
}
const lists = reads.filter((read) => read.kind === "list").length;
if (lists > 0) {
  console.log(
    `\n${lists} client.list() call(s): read client.entries(type) (names, paths, noIndex from the index) or client.resolve(name) (one block) instead.`,
  );
  process.exitCode = 1;
} else {
  console.log(reads.length === 0 ? "No content reads to change." : "No client.list() calls.");
}
