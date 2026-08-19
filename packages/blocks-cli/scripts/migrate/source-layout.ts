/**
 * Source-layout detection.
 *
 * Classic Fresh sites place sections, islands, components etc. at the
 * repo root. Modern Fresh (post 1.6) and several community starters
 * use a `src/` layout where everything lives under `src/sections/`,
 * `src/islands/`, etc. The migration analyzer's `SKIP_DIRS` includes
 * `"src"` (because the OUTPUT site stores migrated code there), so
 * a modern-layout source would be silently scanned as if it were
 * empty — yielding a near-empty migration with no helpful errors.
 *
 * This module classifies a source directory into one of:
 *   - "classic": expected layout (sections/, islands/, …) at root
 *   - "modern":  src/-layout (src/sections/, src/islands/, …)
 *   - "mixed":   both root sections/ AND src/sections/ — usually a
 *                half-migrated repo
 *   - "empty":   nothing recognizable; could be a fresh scaffold
 *
 * The migration script consumes this for an early-abort with an
 * actionable error message. Eventually the analyzer can be extended
 * to scan `src/` natively, at which point the "modern" branch can
 * proceed instead of aborting.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type SourceLayout = "classic" | "modern" | "mixed" | "empty";

const RECOGNISED_DIRS = ["sections", "islands", "components", "loaders", "actions"];

export interface FsLike {
  existsSync(p: string): boolean;
  /**
   * True when `p` is a directory containing at least one FILE (recursively).
   * An empty leftover dir (e.g. a `sections/` stub next to a populated
   * `src/sections/`) must NOT count as a layout, or it triggers a false
   * "mixed layout" abort. Optional so existing `{ existsSync }` stubs keep
   * working — when absent, mere existence counts (previous behaviour).
   */
  hasFiles?(p: string): boolean;
}

/** Recursively: does this dir hold at least one file? Empty dirs → false. */
function realHasFiles(p: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile()) return true;
    if (e.isDirectory() && realHasFiles(path.join(p, e.name))) return true;
  }
  return false;
}

const realFs: FsLike = { existsSync: fs.existsSync, hasFiles: realHasFiles };

/**
 * Classify the source directory's layout. Pure function — accepts
 * a `FsLike` so unit tests can stub the disk without mocking node:fs.
 */
export function detectSourceLayout(sourceDir: string, fsAdapter: FsLike = realFs): SourceLayout {
  // A recognised dir only "counts" if it exists AND holds files — an empty
  // leftover `sections/` next to a populated `src/sections/` is not a real
  // second layout and must not trigger a "mixed" abort. Falls back to mere
  // existence when the adapter doesn't implement hasFiles (old test stubs).
  const counts = (p: string): boolean =>
    fsAdapter.existsSync(p) && (fsAdapter.hasFiles ? fsAdapter.hasFiles(p) : true);
  const hasRootDir = RECOGNISED_DIRS.some((d) => counts(path.join(sourceDir, d)));
  const hasSrcDir = RECOGNISED_DIRS.some((d) => counts(path.join(sourceDir, "src", d)));

  if (hasRootDir && hasSrcDir) return "mixed";
  if (hasSrcDir) return "modern";
  if (hasRootDir) return "classic";
  return "empty";
}

/**
 * Build a human-readable, actionable message for a non-classic
 * layout. Consumed by the CLI to print before exiting. Lives in
 * this module so the test can pin the exact wording.
 */
export function explainNonClassicLayout(
  layout: Exclude<SourceLayout, "classic">,
  sourceDir: string,
): string {
  switch (layout) {
    case "modern":
      return [
        `Modern Fresh "src/" layout detected at ${sourceDir}/src.`,
        "",
        "  This migration script currently scans only the classic root layout",
        "  (sections/, islands/, components/, loaders/, actions/ at the repo root).",
        "",
        "  Workaround until native support lands:",
        "  1. Move src/sections, src/islands, src/components, src/loaders, src/actions",
        "     up one level to the repo root (the script's expected layout).",
        "  2. Re-run the migration.",
        "  3. (If desired) Restructure to a src/ layout post-migration — the",
        "     TanStack Start scaffold uses src/ on the output side regardless.",
        "",
        "  File an issue with your site URL so this can be supported natively.",
      ].join("\n");
    case "mixed":
      return [
        `Mixed layout detected at ${sourceDir}.`,
        "",
        "  Both root sections/ and src/sections/ are present. This usually means",
        "  the migration was previously run partially against this directory, or",
        "  the source genuinely has parallel layouts (rare).",
        "",
        "  Resolution: pick one layout and remove the other before re-running.",
        "  If this is a half-migrated repo, restore the original via git and",
        "  run the migration against a clean checkout (--source <fresh-path>).",
      ].join("\n");
    case "empty":
      return [
        `No recognizable Deco layout found at ${sourceDir}.`,
        "",
        "  Expected one of these directories at the repo root or under src/:",
        `    ${RECOGNISED_DIRS.join(", ")}`,
        "",
        "  Did you point --source at the correct directory? It should be the",
        "  root of an existing Fresh-based Deco site, not the new TanStack site.",
      ].join("\n");
  }
}
