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
 * Keeps the legacy `oldPath` in sync with the freshly-generated `newPath` so
 * sites mid-migration whose imports still point at the old location keep
 * working without a full migration first. Call this after generation
 * completes, only when the old file was detected.
 *
 * For `.ts`/`.tsx` artifacts a verbatim copy would be broken: the generated
 * file's import specifiers are relative to `newPath`'s directory (`.deco/`,
 * one level deep), but `oldPath` lives deeper (`src/server/cms/`), so every
 * `../src/...` specifier would resolve to a nonexistent path and crash the
 * dev server on boot. Instead we write a re-export shim pointing at `newPath`
 * — one specifier, correct at any depth, and self-documenting the deprecation.
 * The generated `.gen.ts` files only have named exports, so `export *` forwards
 * everything (including type exports). Non-TS artifacts (e.g. `.json` schema)
 * have no import paths, so a byte copy is still correct.
 */
export function syncLegacyArtifact(oldPath: string, newPath: string): void {
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });

  if (!/\.tsx?$/.test(oldPath)) {
    fs.copyFileSync(newPath, oldPath);
    return;
  }

  const newRel = path.relative(process.cwd(), newPath).replace(/\\/g, "/");
  let specifier = path
    .relative(path.dirname(oldPath), newPath)
    .replace(/\\/g, "/")
    .replace(/\.tsx?$/, "");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;

  fs.writeFileSync(
    oldPath,
    `// AUTO-GENERATED — DO NOT EDIT.\n` +
      `// Deprecated path: the generator now writes to "${newRel}".\n` +
      `// This file only re-exports it so mid-migration imports keep working.\n` +
      `// Update your imports to the new path, then delete this file.\n` +
      `export * from "${specifier}";\n`,
  );
}
