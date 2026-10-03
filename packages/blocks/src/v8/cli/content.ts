/**
 * `deco content`: turns the JSON files in `.deco/blocks` into the content
 * module, `.deco/blocks.gen.ts` (spec: content › The content module). It never
 * reads the block map.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LEGACY_ALIASES } from "./builtins";
import {
  canonicalName,
  compareSpellings,
  fileToName,
  invalidNameReason,
  type SpellingCandidate,
} from "./keys";
import { consoleReporter, type Reporter } from "./log";
import { CliError, type DecoPaths, decoPaths, findDecoRoot } from "./root";

export interface ContentDiagnostic {
  /** The file name inside `.deco/blocks`. */
  file: string;
  /** "error" stops `deco content` and fails `deco check`; "warning" doesn't. */
  severity: "error" | "warning";
  message: string;
}

export interface SavedBlocks {
  /**
   * Every saved block, by entry name, as parsed from disk. Both maps have no
   * prototype, so a block named `constructor` or `toString` is just a name:
   * look names up with `Object.hasOwn`, never `in` or a bare index.
   */
  blocks: Record<string, Record<string, unknown>>;
  /** The file that holds each entry (the winning spelling). */
  files: Record<string, string>;
  diagnostics: ContentDiagnostic[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `.deco/blocks` by the file-name rule. A missing folder is an empty
 * map. Files that aren't JSON objects, files whose name the rule rejects
 * (`__proto__.json`, `con.json`, …) and losing spellings of one name are
 * reported as diagnostics instead of entries.
 */
export function readSavedBlocks(blocksDir: string): SavedBlocks {
  const diagnostics: ContentDiagnostic[] = [];
  let dirents: fs.Dirent[] = [];
  try {
    dirents = fs.readdirSync(blocksDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const groups = new Map<string, SpellingCandidate[]>();
  for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (dirent.isDirectory()) {
      diagnostics.push({
        file: dirent.name,
        severity: "warning",
        message: "subfolders of .deco/blocks aren't read",
      });
      continue;
    }
    if (!dirent.name.endsWith(".json")) continue;
    const invalid = invalidNameReason(fileToName(dirent.name));
    if (invalid) {
      diagnostics.push({
        file: dirent.name,
        severity: "error",
        message: `not a valid entry name (${invalid}); rename the file`,
      });
      continue;
    }
    const text = fs.readFileSync(path.join(blocksDir, dirent.name), "utf8");
    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch (error) {
      diagnostics.push({
        file: dirent.name,
        severity: "error",
        message: `invalid JSON: ${(error as Error).message}`,
      });
      continue;
    }
    if (!isPlainObject(entry)) {
      diagnostics.push({
        file: dirent.name,
        severity: "error",
        message: "a saved block must be a JSON object",
      });
      continue;
    }
    const key = canonicalName(dirent.name).name;
    const group = groups.get(key) ?? [];
    group.push({ file: dirent.name, entry });
    groups.set(key, group);
  }

  const blocks: Record<string, Record<string, unknown>> = Object.create(null);
  const files: Record<string, string> = Object.create(null);
  for (const group of groups.values()) {
    group.sort(compareSpellings);
    const [winner, ...losers] = group;
    const name = fileToName(winner.file);
    blocks[name] = winner.entry as Record<string, unknown>;
    files[name] = winner.file;
    for (const loser of losers) {
      diagnostics.push({
        file: loser.file,
        severity: "warning",
        message: `another spelling of "${name}"; ${winner.file} wins`,
      });
    }
  }
  return { blocks, files, diagnostics };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The revision of a content map: a SHA-256 of the whole map in canonical JSON
 * (keys sorted at every level), so the same content gets the same revision
 * wherever it's built, and any change to any entry gives a new one
 * (spec: internals › Snapshots and revisions).
 *
 * TODO(N-02): the runtime and the hosted release service compute revisions
 * too. Move this into the core when it lands, so there's one definition, and
 * re-export it here.
 */
export function computeRevision(blocks: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(blocks)).digest("hex");
}

const RESERVED = new Set(
  `break case catch class const continue debugger default delete do else enum export extends false
  finally for function if import in instanceof new null return super switch this throw true try
  typeof var void while with yield let static implements interface package private protected public
  await arguments eval undefined NaN Infinity content`.split(/\s+/),
);

function identifierFor(name: string, taken: Set<string>): string {
  let id = name.replace(/[^A-Za-z0-9_$]/g, "_");
  if (id === "" || /^[0-9]/.test(id)) id = `_${id}`;
  if (RESERVED.has(id)) id = `_${id}`;
  let candidate = id;
  for (let i = 2; taken.has(candidate); i++) candidate = `${id}_${i}`;
  taken.add(candidate);
  return candidate;
}

/**
 * File names a bundler can import verbatim. Anything else is inlined, a
 * deliberate departure from "one import per file": every name with a space,
 * `/` or non-ASCII character is stored percent-encoded (`pages-Home%20Page`),
 * and tools disagree on what a `%` in an import specifier means. Vite and
 * esbuild read `./blocks/a%20b.json` as that file and fail on `a%2520b.json`;
 * Node reads it as a URL and loads `a b.json` instead. No spelling of the
 * specifier names the same file everywhere, so those entries are written into
 * the module, and hand edits to them need `deco content` again (`--watch`
 * does it; `deco serve` regenerates after every save).
 */
const IMPORTABLE_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.json$/;

/** The files `renderContentModule` inlines instead of importing. */
function inlinedFiles(saved: SavedBlocks): string[] {
  return Object.keys(saved.blocks)
    .sort()
    .map((name) => saved.files[name])
    .filter((file) => !IMPORTABLE_FILE.test(file));
}

/** The source of `.deco/blocks.gen.ts` for a set of saved blocks. */
export function renderContentModule(saved: SavedBlocks): string {
  const names = Object.keys(saved.blocks).sort();
  const revision = computeRevision(saved.blocks);
  const taken = new Set<string>();
  const imports: string[] = [];
  const entries: string[] = [];
  for (const name of names) {
    const file = saved.files[name];
    if (IMPORTABLE_FILE.test(file)) {
      const id = identifierFor(name, taken);
      imports.push(`import ${id} from "./blocks/${file}" with { type: "json" };`);
      entries.push(`    ${JSON.stringify(name)}: ${id},`);
    } else {
      entries.push(
        `    // inlined: ${JSON.stringify(file)} isn't a portable import path\n` +
          `    ${JSON.stringify(name)}: ${JSON.stringify(saved.blocks[name])},`,
      );
    }
  }
  const aliases = Object.entries(LEGACY_ALIASES).map(
    ([alias, target]) => `    ${JSON.stringify(alias)}: ${JSON.stringify(target)},`,
  );
  return [
    "// Generated by deco content; don't edit.",
    ...imports,
    "",
    "const content: {",
    "  revision: string;",
    "  blocks: Record<string, unknown>;",
    "  aliases: Record<string, string>;",
    "} = {",
    `  revision: ${JSON.stringify(revision)},`,
    "  blocks: {",
    ...entries,
    "  },",
    "  aliases: {",
    ...aliases,
    "  },",
    "};",
    "",
    "export default content;",
    "",
  ].join("\n");
}

export interface ContentResult {
  root: string;
  file: string;
  revision: string;
  count: number;
  /** False when the file already had this content. */
  changed: boolean;
  /** Files written into the module instead of imported (see `inlinedFiles`). */
  inlined: string[];
  diagnostics: ContentDiagnostic[];
}

/** Write a file only when its content changed, so watchers and HMR stay quiet. */
export function writeIfChanged(file: string, content: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === content) return false;
  } catch {
    // missing: write it
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
  return true;
}

/** Generate `.deco/blocks.gen.ts` for a root. Throws on unreadable content. */
export function writeContent(paths: DecoPaths): ContentResult {
  const saved = readSavedBlocks(paths.blocks);
  const errors = saved.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    throw new CliError(errors.map((d) => `.deco/blocks/${d.file}: ${d.message}`).join("\n"));
  }
  const source = renderContentModule(saved);
  const changed = writeIfChanged(paths.content, source);
  return {
    root: paths.root,
    file: paths.content,
    revision: computeRevision(saved.blocks),
    count: Object.keys(saved.blocks).length,
    changed,
    inlined: inlinedFiles(saved),
    diagnostics: saved.diagnostics,
  };
}

export interface ContentOptions {
  root?: string;
  cwd?: string;
  reporter?: Reporter;
  /** Set by `--watch`: inlined files are kept up to date, so no hint about them. */
  watching?: boolean;
}

/** `deco content`, once. Returns the exit code. */
export function content(options: ContentOptions = {}): number {
  const reporter = options.reporter ?? consoleReporter;
  const paths = decoPaths(findDecoRoot(options));
  const result = writeContent(paths);
  for (const d of result.diagnostics) reporter.warn(`.deco/blocks/${d.file}: ${d.message}`);
  reporter.info(
    `${result.changed ? "wrote" : "unchanged"} .deco/blocks.gen.ts (${result.count} blocks, revision ${result.revision.slice(0, 12)})`,
  );
  const inlined = result.inlined.length;
  if (inlined > 0 && !options.watching) {
    reporter.info(
      `${inlined} file${inlined === 1 ? "" : "s"} with % in the name ${inlined === 1 ? "is" : "are"} inlined, not imported: ` +
        "after editing one by hand, run deco content again (or keep deco content --watch running)",
    );
  }
  return 0;
}
