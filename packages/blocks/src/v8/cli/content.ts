/**
 * Reading `.deco/blocks` (every command that reads saved blocks), and the
 * content module, `.deco/blocks.gen.ts`, for content without a site: tests,
 * the example apps, self-hosted content and git-backed sites
 * (`createCMS({ blocks, content })`, what the v7 migration writes). It never
 * reads the block map. `deco content` (and `content()` from
 * `@decocms/blocks/cli`) writes the module; a site with `site` set gets its
 * content at runtime instead, and its `.deco/blocks` is what `deco pull` wrote.
 */
import fs from "node:fs";
import path from "node:path";
import { computeContentRevision } from "../../protocol/canonical.ts";
import {
  blockFileName,
  blockNameFromFile,
  checkBlockName,
  entryHasPath,
  isBlockFileName,
  resolveSpellings,
  type SpellingCandidate,
} from "../../protocol/keys.ts";
import { isPlainObject } from "../json.ts";
import { LEGACY_ALIASES } from "./builtins.ts";
import { consoleReporter, type Reporter } from "./log.ts";
import { CliError, type DecoPaths, decoPaths, findDecoRoot } from "./root.ts";

export interface ContentDiagnostic {
  /** The file name inside `.deco/blocks`. */
  file: string;
  /** "error" stops the content module, `deco push` and `deco check`; "warning" doesn't. */
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

  const candidates: (SpellingCandidate & { entry: Record<string, unknown> })[] = [];
  for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (dirent.isDirectory()) {
      diagnostics.push({
        file: dirent.name,
        severity: "warning",
        message: "subfolders of .deco/blocks aren't read",
      });
      continue;
    }
    if (!isBlockFileName(dirent.name)) continue;
    const [invalid] = checkBlockName(blockNameFromFile(dirent.name));
    if (invalid) {
      diagnostics.push({
        file: dirent.name,
        severity: "error",
        message: `not a valid entry name (${invalid.message}); rename the file`,
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
    candidates.push({ file: dirent.name, hasPath: entryHasPath(entry), entry });
  }

  const blocks: Record<string, Record<string, unknown>> = Object.create(null);
  const files: Record<string, string> = Object.create(null);
  for (const { name, winner, shadowed } of resolveSpellings(candidates).values()) {
    blocks[name] = winner.entry;
    files[name] = winner.file;
    for (const loser of shadowed) {
      diagnostics.push({
        file: loser.file,
        severity: "warning",
        message: `another spelling of "${name}"; ${winner.file} wins`,
      });
    }
  }
  return { blocks, files, diagnostics };
}

/**
 * Blocks fetched from a draft or a revision, as if read from `.deco/blocks`
 * (`deco check`, `--draft`, `--revision`): each at its file name; a name the
 * file-name rule rejects, or a value that isn't a JSON object, is a
 * diagnostic, as on disk.
 */
export function savedBlocksFromMap(map: Record<string, unknown>): SavedBlocks {
  const blocks: Record<string, Record<string, unknown>> = Object.create(null);
  const files: Record<string, string> = Object.create(null);
  const diagnostics: ContentDiagnostic[] = [];
  for (const name of Object.keys(map).sort()) {
    const file = blockFileName(name);
    const entry = map[name];
    const [invalid] = checkBlockName(name);
    if (invalid) {
      diagnostics.push({
        file,
        severity: "error",
        message: `not a valid entry name (${invalid.message})`,
      });
      continue;
    }
    if (!isPlainObject(entry)) {
      diagnostics.push({ file, severity: "error", message: "a saved block must be a JSON object" });
      continue;
    }
    blocks[name] = entry;
    files[name] = file;
  }
  return { blocks, files, diagnostics };
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
 * the module, and hand edits to them need the module written again.
 */
const IMPORTABLE_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.json$/;

/** The files `renderContentModule` inlines instead of importing. */
function inlinedFiles(saved: SavedBlocks): string[] {
  return Object.keys(saved.blocks)
    .sort()
    .map((name) => saved.files[name])
    .filter((file) => !IMPORTABLE_FILE.test(file));
}

/**
 * The `.deco` folder's identity for `createCMS` (one instance per folder, so
 * a hot-reloaded module keeps its instance): its path from the repository
 * root, or `.deco` outside a repository. Relative, so it doesn't depend on
 * where the repository is checked out.
 */
export function contentRoot(deco: string): string {
  for (let dir = path.dirname(deco); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return path.relative(dir, deco).split(path.sep).join("/");
    }
    if (path.dirname(dir) === dir) return ".deco";
  }
}

/** The source of `.deco/blocks.gen.ts` for a set of saved blocks. */
export async function renderContentModule(saved: SavedBlocks, root = ".deco"): Promise<string> {
  const names = Object.keys(saved.blocks).sort();
  const revision = await computeContentRevision(saved.blocks);
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
    "// Generated from .deco/blocks; don't edit.",
    ...imports,
    "",
    "const content: {",
    "  revision: string;",
    "  blocks: Record<string, unknown>;",
    "  aliases: Record<string, string>;",
    "  root: string;",
    "} = {",
    `  revision: ${JSON.stringify(revision)},`,
    "  blocks: {",
    ...entries,
    "  },",
    "  aliases: {",
    ...aliases,
    "  },",
    `  root: ${JSON.stringify(root)},`,
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
export async function writeContent(paths: DecoPaths): Promise<ContentResult> {
  const saved = readSavedBlocks(paths.blocks);
  const errors = saved.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    throw new CliError(errors.map((d) => `.deco/blocks/${d.file}: ${d.message}`).join("\n"));
  }
  const source = await renderContentModule(saved, contentRoot(paths.deco));
  const changed = writeIfChanged(paths.content, source);
  return {
    root: paths.root,
    file: paths.content,
    revision: await computeContentRevision(saved.blocks),
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
  /** Set when something rewrites the module on every change: no hint about inlined files. */
  watching?: boolean;
}

/** Write `.deco/blocks.gen.ts` once (content without a site). Returns the exit code. */
export async function content(options: ContentOptions = {}): Promise<number> {
  const reporter = options.reporter ?? consoleReporter;
  const paths = decoPaths(findDecoRoot(options));
  const result = await writeContent(paths);
  for (const d of result.diagnostics) reporter.warn(`.deco/blocks/${d.file}: ${d.message}`);
  reporter.info(
    `${result.changed ? "wrote" : "unchanged"} .deco/blocks.gen.ts (${result.count} blocks, revision ${result.revision.slice(0, 12)})`,
  );
  const inlined = result.inlined.length;
  if (inlined > 0 && !options.watching) {
    reporter.info(
      `${inlined} file${inlined === 1 ? "" : "s"} with % in the name ${inlined === 1 ? "is" : "are"} inlined, not imported: ` +
        "after editing one by hand, write the module again",
    );
  }
  return 0;
}
