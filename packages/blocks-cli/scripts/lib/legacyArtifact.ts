import fs from "node:fs";
import path from "node:path";

/**
 * Generator default output paths flipped from `src/server/{cms,admin}/` to
 * `.deco/` (framework artifacts live in the framework's folder, not mixed
 * into app source). Sites that never pass an explicit `--out`/`--out-file`
 * flag pick up the new default silently — except when the OLD default file
 * is still sitting on disk, which almost always means something (an
 * importer, a `.gitignore` entry, a stale CI cache check) still points at
 * it. In that case we warn once, to stderr, and then write to the NEW
 * default anyway: the artifact is regenerated code, so there's no reason to
 * block the run — the warning is just a nudge to go clean up the stale file
 * and its importers.
 *
 * An explicit flag means the caller made a deliberate choice about where
 * output goes; it gets no warning and no guard.
 */
export function warnLegacyArtifact(oldPath: string, newPath: string): void {
  console.warn(
    `[deco] Generator default output moved: ${oldPath} -> ${newPath}. Update importers to use the new path, then delete the old file.`,
  );
}

/**
 * Copies the freshly-generated file at `newPath` back to `oldPath` so that
 * sites mid-migration whose imports still point at the old location see
 * up-to-date output without requiring a full migration first.
 * Call this after generation completes, only when the old file was detected.
 */
export function syncLegacyArtifact(oldPath: string, newPath: string): void {
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.copyFileSync(newPath, oldPath);
}
