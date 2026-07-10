#!/usr/bin/env tsx
/**
 * Internal implementation detail of generate.ts (the unified orchestrator)
 * -- invoke `generate` instead; direct invocation remains possible but
 * undocumented.
 */
/**
 * Scans site section files and extracts convention-based metadata:
 *   - export const eager = true       → alwaysEager
 *   - export const cache = "listing"  → registerCacheableSections
 *   - export const layout = true      → registerLayoutSections
 *   - export const sync = true        → registerSectionsSync (bundled, not lazy)
 *   - export const clientOnly = true  → registerSection with clientOnly
 *   - export const seo = true         → registerSeoSections
 *   - export function LoadingFallback → registerSection with loadingFallback
 *
 * Emits sections.gen.ts with metadata + sync imports for sections marked sync=true.
 *
 * Usage (from site root):
 *   npx tsx node_modules/@decocms/blocks-cli/scripts/generate-sections.ts
 *
 * CLI:
 *   --sections-dir  override input  (default: src/sections)
 *   --out-file      override output (default: .deco/sections.gen.ts)
 *   --registry      also emit `sectionImports` — a lazy section-import map
 *                   keyed glob-style (`./sections/...`), the Next.js/webpack
 *                   equivalent of Vite's `import.meta.glob("./sections/**\/*.tsx")`.
 *                   Built from every scanned section file, not just the ones
 *                   carrying convention exports. Off by default so existing
 *                   Vite sites regenerating sections.gen.ts in CI see zero diff.
 *
 * If no `--out-file` is passed and the OLD default (src/server/cms/sections.gen.ts)
 * still exists on disk, a one-line legacy warning is printed to stderr and the
 * NEW default is written anyway — see lib/legacyArtifact.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { isExcludedCodegenFile } from "./lib/codegenExclusions";
import { warnLegacyArtifact } from "./lib/legacyArtifact";

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const sectionsDir = path.resolve(process.cwd(), arg("sections-dir", "src/sections"));
const OUT_FILE_EXPLICIT = args.includes("--out-file");
const NEW_DEFAULT_OUT_FILE = ".deco/sections.gen.ts";
const OLD_DEFAULT_OUT_FILE = "src/server/cms/sections.gen.ts";
const outFile = path.resolve(process.cwd(), arg("out-file", NEW_DEFAULT_OUT_FILE));
if (!OUT_FILE_EXPLICIT && fs.existsSync(path.resolve(process.cwd(), OLD_DEFAULT_OUT_FILE))) {
  warnLegacyArtifact(OLD_DEFAULT_OUT_FILE, NEW_DEFAULT_OUT_FILE);
}
const EMIT_REGISTRY = args.includes("--registry");

interface SectionMeta {
  eager?: boolean;
  neverDefer?: boolean;
  cache?: string;
  layout?: boolean;
  sync?: boolean;
  clientOnly?: boolean;
  seo?: boolean;
  hasLoadingFallback?: boolean;
}

const EXPORT_CONST_RE = /export\s+const\s+(eager|neverDefer|cache|layout|sync|clientOnly|seo)\s*=\s*(.+?)(?:;|\n)/g;
// Detects `export function LoadingFallback(...)`, `export const LoadingFallback = ...`, etc.
const LOADING_FALLBACK_INLINE_RE = /export\s+(?:function|const|let|var)\s+LoadingFallback\b/;
// Detects re-exports like:
//   export { LoadingFallback } from "..."
//   export { default as LoadingFallback } from "..."
//   export { Foo as LoadingFallback } from "..."
// False-positive for `export { LoadingFallback as Foo }` (exports `Foo`, not
// `LoadingFallback`), but that's unrealistic in section files and would surface
// as a loud build error rather than silent CLS.
const LOADING_FALLBACK_REEXPORT_RE = /export\s*\{[^}]*\bLoadingFallback\b[^}]*\}/;

function hasLoadingFallbackExport(content: string): boolean {
  return (
    LOADING_FALLBACK_INLINE_RE.test(content) ||
    LOADING_FALLBACK_REEXPORT_RE.test(content)
  );
}

function extractMeta(content: string): SectionMeta | null {
  const meta: SectionMeta = {};
  let found = false;

  for (const match of content.matchAll(EXPORT_CONST_RE)) {
    const key = match[1] as keyof SectionMeta;
    const rawValue = match[2].trim().replace(/['"]/g, "");
    found = true;

    if (key === "cache") {
      meta.cache = rawValue;
    } else if (rawValue === "true") {
      (meta as any)[key] = true;
    }
  }

  if (hasLoadingFallbackExport(content)) {
    meta.hasLoadingFallback = true;
    found = true;
  }

  return found ? meta : null;
}

function walkDir(dir: string, base: string = dir): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, base));
    } else if (
      (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) &&
      !isExcludedCodegenFile(entry.name)
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

function fileToSectionKey(filePath: string, _sectionsDir: string): string {
  const rel = path.relative(_sectionsDir, filePath).replace(/\\/g, "/");
  return `site/sections/${rel}`;
}

function relativeImportPath(from: string, to: string): string {
  let rel = path.relative(path.dirname(from), to).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.replace(/\.tsx?$/, "");
}

// ---------------------------------------------------------------------------

if (!fs.existsSync(sectionsDir)) {
  console.warn(`Sections directory not found: ${sectionsDir} — generating empty output.`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, [
    "// Auto-generated — no sections found.",
    "export const sectionMeta = {};",
    "",
  ].join("\n"));
  process.exit(0);
}

const sectionFiles = walkDir(sectionsDir);
const entries: Array<{ key: string; meta: SectionMeta; filePath: string }> = [];

for (const filePath of sectionFiles) {
  const content = fs.readFileSync(filePath, "utf-8");
  const meta = extractMeta(content);
  if (!meta) continue;
  const key = fileToSectionKey(filePath, sectionsDir);
  entries.push({ key, meta, filePath });
}

const syncEntries = entries.filter((e) => e.meta.sync);
const fallbackEntries = entries.filter((e) => e.meta.hasLoadingFallback);

const lines: string[] = [
  "// Auto-generated by @decocms/blocks-cli/scripts/generate-sections.ts",
  "// Do not edit manually. Add convention exports to your section files instead.",
  "//",
  "// Supported conventions:",
  "//   export const eager = true       → prefer eager (defers past fold threshold)",
  "//   export const neverDefer = true  → ALWAYS eager, ignores fold threshold",
  "//   export const cache = \"listing\"  → SWR-cached section loader results",
  "//   export const layout = true      → cached as layout (Header, Footer, Theme)",
  "//   export const sync = true        → bundled synchronously (not lazy-loaded)",
  "//   export const clientOnly = true  → skip SSR (client-only rendering)",
  "//   export const seo = true         → SEO section (provides page head data)",
  "//   export function LoadingFallback → skeleton shown while section loads",
  "",
];

// Sync imports — sections marked sync=true get static imports for registerSectionsSync
for (let i = 0; i < syncEntries.length; i++) {
  const e = syncEntries[i];
  const importPath = relativeImportPath(outFile, e.filePath);
  const varName = `_sync${i}`;
  lines.push(`import * as ${varName} from "${importPath}";`);
}

// LoadingFallback imports — sections with LoadingFallback that aren't sync-imported
const nonSyncFallbacks = fallbackEntries.filter((e) => !e.meta.sync);
for (let i = 0; i < nonSyncFallbacks.length; i++) {
  const e = nonSyncFallbacks[i];
  const importPath = relativeImportPath(outFile, e.filePath);
  lines.push(`import { LoadingFallback as _fb${i} } from "${importPath}";`);
}

lines.push("");

// Metadata map
// Keep this emitted interface in sync with SectionMetaEntry in
// @decocms/blocks/cms (applySectionConventions.ts) — every convention the
// scanner can set on an entry must be declared here, or the generated file
// fails the site's typecheck (excess-property error) and sites end up
// hand-patching a file that the next regeneration wipes.
lines.push("export interface SectionMetaEntry {");
lines.push("  eager?: boolean;");
lines.push("  neverDefer?: boolean;");
lines.push("  cache?: string;");
lines.push("  layout?: boolean;");
lines.push("  sync?: boolean;");
lines.push("  clientOnly?: boolean;");
lines.push("  seo?: boolean;");
lines.push("  hasLoadingFallback?: boolean;");
lines.push("}");
lines.push("");
lines.push("export const sectionMeta: Record<string, SectionMetaEntry> = {");
for (const e of entries) {
  const props = Object.entries(e.meta)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : v}`)
    .join(", ");
  lines.push(`  "${e.key}": { ${props} },`);
}
lines.push("};");
lines.push("");

// Sync components map
if (syncEntries.length > 0) {
  lines.push("export const syncComponents: Record<string, any> = {");
  for (let i = 0; i < syncEntries.length; i++) {
    lines.push(`  "${syncEntries[i].key}": _sync${i},`);
  }
  lines.push("};");
} else {
  lines.push("export const syncComponents: Record<string, any> = {};");
}
lines.push("");

// LoadingFallback components map
const allFallbacks = entries.filter((e) => e.meta.hasLoadingFallback);
if (allFallbacks.length > 0) {
  lines.push("export const loadingFallbacks: Record<string, React.ComponentType<any>> = {");
  for (const e of allFallbacks) {
    if (e.meta.sync) {
      const syncIdx = syncEntries.indexOf(e);
      lines.push(`  "${e.key}": _sync${syncIdx}.LoadingFallback,`);
    } else {
      const fbIdx = nonSyncFallbacks.indexOf(e);
      lines.push(`  "${e.key}": _fb${fbIdx},`);
    }
  }
  lines.push("};");
} else {
  lines.push("export const loadingFallbacks: Record<string, React.ComponentType<any>> = {};");
}
lines.push("");

// Lazy section-import registry — opt-in via --registry, built from every
// scanned section file (not just convention-carrying `entries`).
if (EMIT_REGISTRY) {
  // NOTE: no extra `lines.push("")` here — the loadingFallbacks block above
  // already pushed a single trailing blank line as its separator. Pushing
  // another one here doubled the blank line before this comment block in
  // every site's committed .deco/sections.gen.ts.
  lines.push("/**");
  lines.push(" * Lazy section registry — the Next.js/webpack equivalent of Vite's");
  lines.push(" * `import.meta.glob` scan over every file under ./sections, recursively.");
  lines.push(" * Keys use the glob-style `./sections/...` form so this map drops");
  lines.push(" * straight into `createSiteSetup({ sections })` / `createNextSetup({ sections })`.");
  lines.push(" */");
  lines.push("export const sectionImports: Record<string, () => Promise<any>> = {");
  for (const filePath of sectionFiles) {
    const rel = path.relative(sectionsDir, filePath).replace(/\\/g, "/");
    const importPath = relativeImportPath(outFile, filePath);
    lines.push(`  "./sections/${rel}": () => import("${importPath}"),`);
  }
  lines.push("};");
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
// Output hygiene: several sections above push a trailing "" separator
// unconditionally (e.g. after the header comment, after the sync/fallback
// import blocks) — when a following section has nothing to emit (no sync
// imports, --registry off, etc.) those separators stack into a doubled
// blank line. Collapse any run of blank lines down to a single one, then
// normalize to exactly one trailing newline: without --registry, `lines`
// ends with a pushed "" separator (one trailing "\n" once joined); with
// --registry, the last pushed line is "};" (no trailing newline at all).
fs.writeFileSync(
  outFile,
  lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n"),
);

console.log(
  `Generated section metadata for ${entries.length} sections → ${path.relative(process.cwd(), outFile)}`,
);
console.log(
  `  ${syncEntries.length} sync, ${allFallbacks.length} with LoadingFallback, ` +
  `${entries.filter((e) => e.meta.eager).length} eager, ` +
  `${entries.filter((e) => e.meta.layout).length} layout, ` +
  `${entries.filter((e) => e.meta.cache).length} cached`,
);
