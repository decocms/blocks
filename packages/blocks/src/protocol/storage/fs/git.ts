/**
 * The filesystem storage's base: the git `HEAD` of the repository the app
 * root is in. Read-only: it runs `git` (no new dependency, no shell, argv
 * arrays only) and never writes git state — no index writes, no commits, no
 * `git restore`. A discard writes the files themselves, through the storage's
 * own commit.
 *
 * Changes are the working tree against `HEAD` (the index is never
 * consulted), with git's own idea of equal: a file whose bytes differ only by
 * the checkout filters (`eol=crlf`, `autocrlf`, LFS) isn't a change.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { isBlockFileName } from "../../keys.ts";
import { type StorageBase, type StorageFile, StorageUnavailableError } from "../../storage.ts";

/** The base revision reported for a repository with no commits yet (an empty base). */
export const UNBORN_REVISION = "unborn";

/** Environment that would point git at another repository, index or object store. */
const INHERITED_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
];

const COMMIT_ID = /^[0-9a-f]{40,64}$/;

/** Files per `git hash-object` call, so an argv stays far below any OS limit. */
const HASH_CHUNK = 100;

/** Base bodies read at once. */
const READ_CONCURRENCY = 4;

export interface GitOptions {
  /** The git binary (default `git`, from `PATH`). */
  git?: string;
}

/** A git call that failed: `missing` when the binary isn't there. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly reason: "missing" | "failed",
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of INHERITED_GIT_ENV) delete env[key];
  return {
    ...env,
    // Pathspecs are literal: a file named `:(glob)x.json` is just a file.
    GIT_LITERAL_PATHSPECS: "1",
    // Never refresh (write) the index while reading.
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

/** Runs git and resolves with its stdout bytes; rejects with a `GitError`. */
export function runGit(cwd: string, args: string[], options: GitOptions = {}): Promise<Buffer> {
  const git = options.git ?? "git";
  return new Promise((resolve, reject) => {
    execFile(
      git,
      args,
      {
        cwd,
        env: gitEnv(),
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const code = (error as NodeJS.ErrnoException).code;
        const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
        if (code === "ENOENT") {
          return reject(new GitError(`${git} isn't installed`, "missing", null, text));
        }
        const exitCode = typeof code === "number" ? code : null;
        const line = text.split("\n").find((l) => l.trim() !== "") ?? error.message;
        reject(new GitError(line.trim(), "failed", exitCode, text));
      },
    );
  });
}

const firstLine = (bytes: Buffer) => bytes.toString("utf8").split("\n")[0]!.trim();

/** Where `dir` stands in git: inside a work tree, not, or git is missing. */
export type GitWorkTreeCheck =
  | { status: "ok" }
  | { status: "missing" }
  | { status: "not-a-repository" }
  | { status: "failed"; message: string };

/** Checks that `dir` is inside a git work tree (not a bare repository, not inside `.git`). */
export async function checkGitWorkTree(
  dir: string,
  options: GitOptions = {},
): Promise<GitWorkTreeCheck> {
  try {
    const inside = firstLine(await runGit(dir, ["rev-parse", "--is-inside-work-tree"], options));
    return inside === "true" ? { status: "ok" } : { status: "not-a-repository" };
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (error.reason === "missing") return { status: "missing" };
    if (/not a git repository/i.test(error.stderr)) return { status: "not-a-repository" };
    return { status: "failed", message: error.message };
  }
}

function unavailable(error: unknown): never {
  if (error instanceof GitError) throw new StorageUnavailableError(`git: ${error.message}`);
  throw error;
}

/** A blob of the base: the file name inside `.deco/blocks` and its blob id. */
type BaseBlob = StorageFile;

/** The git side of one app root: its base, what differs from it, and base bodies. */
export interface GitBase {
  base(): Promise<StorageBase>;
  /** The saved-block files in the base, with their blob ids as versions. */
  baseFiles(base: StorageBase): Promise<BaseBlob[]>;
  /**
   * The working-tree files (by name, with their raw blob hash) that differ
   * from `baseFiles`: missing on one side, or different after git's filters.
   */
  differing(base: StorageBase, current: StorageFile[]): Promise<string[]>;
  /** Base bodies as a checkout writes them (smudge and eol filters applied). */
  readBase(base: StorageBase, files: string[]): Promise<Map<string, Buffer>>;
}

/**
 * The git base of the app root `root` (the folder that contains `.deco`),
 * whose saved blocks are `.deco/blocks/*.json`.
 */
export function createGitBase(root: string, options: GitOptions = {}): GitBase {
  const blocksDir = join(root, ".deco", "blocks");
  let prefix: Promise<string> | undefined;
  /** Base listings by commit: a commit's tree never changes. */
  let listing: { revision: string; files: Promise<BaseBlob[]> } | undefined;

  const git = (args: string[], cwd = root) => runGit(cwd, args, options);

  async function base(): Promise<StorageBase> {
    try {
      let revision = UNBORN_REVISION;
      try {
        const sha = firstLine(await git(["rev-parse", "-q", "--verify", "HEAD^{commit}"]));
        if (COMMIT_ID.test(sha)) revision = sha;
      } catch (error) {
        // `--verify -q` exits 1 without output on an unborn HEAD (a fresh `git init`).
        if (!(error instanceof GitError) || error.reason !== "failed" || error.stderr.trim()) {
          throw error;
        }
      }
      let resolvedRef: string | null = null;
      try {
        resolvedRef = firstLine(await git(["symbolic-ref", "-q", "--short", "HEAD"])) || null;
      } catch (error) {
        // Exits 1 on a detached HEAD.
        if (!(error instanceof GitError) || error.reason !== "failed" || error.stderr.trim()) {
          throw error;
        }
      }
      return { revision, resolvedRef };
    } catch (error) {
      unavailable(error);
    }
  }

  async function listBase(revision: string): Promise<BaseBlob[]> {
    if (!COMMIT_ID.test(revision)) return [];
    // Relative to the app root (cwd): `.deco/blocks/<file>`. Only regular
    // files directly in the folder; subfolders, symlinks and submodules aren't blocks.
    const out = await git(["ls-tree", "-z", "--long", revision, "--", ".deco/blocks/"]);
    const files: BaseBlob[] = [];
    for (const record of out.toString("utf8").split("\0")) {
      const tab = record.indexOf("\t");
      if (tab === -1) continue;
      const [mode, type, id, size] = record.slice(0, tab).trim().split(/\s+/);
      const path = record.slice(tab + 1);
      if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
      if (!path.startsWith(".deco/blocks/")) continue;
      const file = path.slice(".deco/blocks/".length);
      if (!isBlockFileName(file) || !id || !COMMIT_ID.test(id)) continue;
      const bytes = Number(size);
      files.push(
        Number.isFinite(bytes) ? { file, version: id, size: bytes } : { file, version: id },
      );
    }
    return files;
  }

  function baseFiles(current: StorageBase): Promise<BaseBlob[]> {
    if (listing?.revision !== current.revision) {
      const files = listBase(current.revision).catch(unavailable);
      listing = { revision: current.revision, files };
      files.catch(() => {
        if (listing?.files === files) listing = undefined;
      });
    }
    return listing.files;
  }

  /** The blob ids git would store for these working-tree files (filters applied). */
  async function hashWorking(files: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < files.length; i += HASH_CHUNK) {
      const chunk = files.slice(i, i + HASH_CHUNK);
      const out = await git(["hash-object", "--", ...chunk], blocksDir);
      const lines = out.toString("utf8").split("\n").filter(Boolean);
      if (lines.length !== chunk.length) {
        throw new GitError("hash-object answered an unexpected listing", "failed", null, "");
      }
      ids.push(...lines);
    }
    return ids;
  }

  async function differing(current: StorageBase, now: StorageFile[]): Promise<string[]> {
    try {
      const inBase = new Map((await baseFiles(current)).map((f) => [f.file, f.version]));
      const changed = new Set<string>();
      const toConfirm: string[] = [];
      const present = new Set<string>();
      for (const file of now) {
        present.add(file.file);
        const id = inBase.get(file.file);
        if (id === undefined) changed.add(file.file);
        // The raw bytes' hash equals the blob id: the same content, no filter involved.
        else if (id !== file.version) toConfirm.push(file.file);
      }
      for (const file of inBase.keys()) if (!present.has(file)) changed.add(file);
      if (toConfirm.length > 0) {
        let ids: string[];
        try {
          ids = await hashWorking(toConfirm);
        } catch (error) {
          // A file vanished meanwhile: count every candidate as changed; the
          // core's next snapshot reports the truth.
          if (
            error instanceof GitError &&
            /No such file|cannot open|unable to/i.test(error.stderr)
          ) {
            ids = toConfirm.map(() => "");
          } else throw error;
        }
        toConfirm.forEach((file, i) => {
          if (ids[i] !== inBase.get(file)) changed.add(file);
        });
      }
      return [...changed].sort();
    } catch (error) {
      unavailable(error);
    }
  }

  async function readBase(current: StorageBase, files: string[]): Promise<Map<string, Buffer>> {
    try {
      const out = new Map<string, Buffer>();
      if (files.length === 0) return out;
      const inBase = new Map((await baseFiles(current)).map((f) => [f.file, f.version]));
      prefix ??= git(["rev-parse", "--show-prefix"]).then((b) => firstLine(b));
      const repoPrefix = await prefix;
      const wanted = files.filter((file) => isBlockFileName(file) && inBase.has(file));
      for (let i = 0; i < wanted.length; i += READ_CONCURRENCY) {
        await Promise.all(
          wanted.slice(i, i + READ_CONCURRENCY).map(async (file) => {
            const id = inBase.get(file)!;
            // Per file: `cat-file --batch --filters` frames its output with the
            // unfiltered size, so a filtered stream can't be split reliably.
            const body = await git([
              "cat-file",
              "--filters",
              `--path=${repoPrefix}.deco/blocks/${file}`,
              id,
            ]);
            out.set(file, body);
          }),
        );
      }
      return out;
    } catch (error) {
      prefix = undefined;
      unavailable(error);
    }
  }

  return { base, baseFiles, differing, readBase };
}
