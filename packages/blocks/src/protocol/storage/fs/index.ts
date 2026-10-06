/**
 * `@decocms/blocks/protocol/storage/fs`: the filesystem `ContentStorage`
 * (Node only), which `deco serve` serves a working tree with.
 *
 * Inside the app root (the folder that contains `.deco/`):
 * - `.deco/blocks/*.json` — the saved blocks; the only thing it writes.
 * - `.deco/schema.gen.json`, falling back to `.deco/meta.gen.json` — read only.
 * - `.deco/secrets.pub` — read only, reported by `describe`.
 * - `.deco/index.ts` is code and is never written.
 * - Uploads go to `public/assets` (or `assetsDir`), never overwriting a file.
 *
 * A file's version is its git blob hash, as `git hash-object` prints it.
 * Commits are serialized per `.deco` folder (in process and across processes)
 * and applied with staged files and atomic renames, rolled back on failure,
 * with the folder fsynced before a commit returns.
 *
 * While committing it uses `.deco/.blocks.lock` and `.deco/.tx-*` folders;
 * add both to `.gitignore`. A crashed process can leave them behind: a lock
 * older than 30 s is taken over, and leftover `.tx-*` folders are removed by
 * the next commit.
 */
import { lstat, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { suffixedAssetName } from "../../assets.ts";
import { isBlockFileName } from "../../keys.ts";
import {
  type CommitResult,
  type ContentStorage,
  type StorageDescription,
  type StorageFile,
  StorageInvalidFileError,
  StorageNotFoundError,
  type StorageSnapshot,
  StorageUnavailableError,
  type StoredFileBody,
  type StoredSchema,
} from "../../storage.ts";
import { gitBlobHash, revisionOf } from "./hash.ts";
import { withCommitLock } from "./lock.ts";
import { applyFileChange, sweepStaleTransactions } from "./transaction.ts";

export interface FsStorageOptions {
  /** The app root: the folder that contains `.deco/`. */
  root: string;
  /**
   * The repository root, which `describe` reports paths relative to. Default:
   * the nearest folder above `root` (or `root` itself) that contains `.git`,
   * else `root`.
   */
  repoRoot?: string;
  /** Serve the content without accepting writes or uploads. */
  readOnly?: boolean;
  /** The upload folder, relative to `root` (default `public/assets`). */
  assetsDir?: string;
  /** The largest upload accepted, in bytes (default 25 MiB). */
  assetsMaxBytes?: number;
  /** Overrides the poll interval (default 2000 ms). */
  pollIntervalMs?: number;
  /** How long a commit waits for another process's lock (default 10 s). */
  lockTimeoutMs?: number;
}

export type FsStorage = ContentStorage & {
  /** The absolute app root. */
  readonly root: string;
};

const DEFAULT_ASSETS_DIR = "public/assets";
const DEFAULT_ASSETS_MAX_BYTES = 25 * 1024 * 1024;

const toPosix = (path: string) => path.split(sep).join("/");

const isMissing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** The nearest folder at or above `start` that contains `.git`, else `start`. */
async function findRepoRoot(start: string): Promise<string> {
  for (let dir = start; ; dir = dirname(dir)) {
    if (await exists(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readBytesOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function assertBlockFile(file: string) {
  if (!isBlockFileName(file)) throw new StorageInvalidFileError(file);
}

function wrapIoError(error: unknown): never {
  if (
    error instanceof StorageUnavailableError ||
    error instanceof StorageNotFoundError ||
    error instanceof StorageInvalidFileError
  )
    throw error;
  throw new StorageUnavailableError(`filesystem error: ${(error as Error).message}`);
}

export function createFsStorage(options: FsStorageOptions): FsStorage {
  const root = resolve(options.root);
  const decoDir = join(root, ".deco");
  const blocksDir = join(decoDir, "blocks");
  const assetsDir = resolve(root, options.assetsDir ?? DEFAULT_ASSETS_DIR);
  const readOnly = options.readOnly ?? false;
  const lockOptions = { timeoutMs: options.lockTimeoutMs ?? 10_000, staleMs: 30_000 };
  let repoRoot: Promise<string> | undefined;
  let swept = false;

  /** file -> stat fingerprint and its hash, so a poll only rehashes changed files. */
  const hashCache = new Map<string, { fingerprint: string; version: string }>();

  async function hashFile(file: string): Promise<StorageFile | null> {
    const path = join(blocksDir, file);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path, { bigint: true });
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!info.isFile()) return null;
    const fingerprint = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    const cached = hashCache.get(file);
    if (cached?.fingerprint === fingerprint) {
      return { file, version: cached.version, size: Number(info.size) };
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const version = gitBlobHash(bytes);
    hashCache.set(file, { fingerprint, version });
    return { file, version, size: bytes.byteLength };
  }

  /** The current version of a file, read fresh (no cache), or `null` when absent. */
  async function freshVersion(file: string): Promise<string | null> {
    try {
      return gitBlobHash(await readFile(join(blocksDir, file)));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async function readSchema(): Promise<StoredSchema | null> {
    for (const name of ["schema.gen.json", "meta.gen.json"]) {
      const bytes = await readBytesOrNull(join(decoDir, name));
      if (bytes !== null) {
        return {
          version: gitBlobHash(bytes),
          text: new TextDecoder().decode(bytes),
          resolvedRef: null,
        };
      }
    }
    return null;
  }

  async function snapshot(): Promise<StorageSnapshot> {
    if (!(await exists(decoDir))) {
      throw new StorageNotFoundError(`no .deco folder in ${root}`);
    }
    let names: string[];
    try {
      names = (await readdir(blocksDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && isBlockFileName(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if (isMissing(error)) names = [];
      else throw error;
    }
    const files = (await Promise.all(names.map(hashFile))).filter(
      (f): f is StorageFile => f !== null,
    );
    files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const present = new Set(names);
    for (const cached of hashCache.keys()) if (!present.has(cached)) hashCache.delete(cached);
    return { revision: revisionOf(files), resolvedRef: null, files };
  }

  const storage: FsStorage = {
    root,

    async describe(): Promise<StorageDescription> {
      repoRoot ??= options.repoRoot
        ? Promise.resolve(resolve(options.repoRoot))
        : findRepoRoot(root);
      const base = await repoRoot;
      const relativeRoot = toPosix(relative(base, root)) || ".";
      return {
        kind: "working-tree",
        root: relativeRoot,
        readOnly,
        assets: readOnly
          ? null
          : {
              dir: toPosix(relative(base, assetsDir)) || ".",
              maxBytes: options.assetsMaxBytes ?? DEFAULT_ASSETS_MAX_BYTES,
            },
        pollIntervalMs: options.pollIntervalMs ?? 2000,
      };
    },

    async snapshot() {
      try {
        return await snapshot();
      } catch (error) {
        wrapIoError(error);
      }
    },

    async readFiles(_snapshot, files) {
      // A working tree has no past snapshots: read current bytes and report
      // their version, so the core notices a file that changed meanwhile.
      const out: Record<string, StoredFileBody> = Object.create(null);
      await Promise.all(
        files.map(async (file) => {
          assertBlockFile(file);
          const bytes = await readBytesOrNull(join(blocksDir, file));
          if (bytes !== null) {
            out[file] = { text: new TextDecoder().decode(bytes), version: gitBlobHash(bytes) };
          }
        }),
      );
      return out;
    },

    readSchema,

    readSecretsPublicKey: () => readTextOrNull(join(decoDir, "secrets.pub")),

    async commit(attempt): Promise<CommitResult> {
      if (readOnly) throw new StorageUnavailableError("the storage is read-only");
      for (const file of [
        ...Object.keys(attempt.put),
        ...attempt.delete,
        ...Object.keys(attempt.expected),
      ]) {
        assertBlockFile(file);
      }
      if (!(await exists(decoDir))) throw new StorageNotFoundError(`no .deco folder in ${root}`);
      try {
        return await withCommitLock(decoDir, lockOptions, async () => {
          // Under the lock, any transaction folder left is from a crashed commit.
          if (!swept) {
            await sweepStaleTransactions(decoDir);
            swept = true;
          }
          if (attempt.expectedSchemaVersion !== undefined) {
            const schema = await readSchema();
            if ((schema?.version ?? null) !== attempt.expectedSchemaVersion) {
              return { status: "stale" } as const;
            }
          }
          for (const [file, expected] of Object.entries(attempt.expected)) {
            if ((await freshVersion(file)) !== expected) return { status: "stale" } as const;
          }
          await applyFileChange(blocksDir, decoDir, { put: attempt.put, delete: attempt.delete });
          const versions: Record<string, string> = {};
          for (const [file, content] of Object.entries(attempt.put))
            versions[file] = gitBlobHash(content);
          const after = await snapshot();
          return { status: "committed", revision: after.revision, versions } as const;
        });
      } catch (error) {
        wrapIoError(error);
      }
    },

    async putAsset(name, body) {
      if (readOnly) throw new StorageUnavailableError("the storage is read-only");
      if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
        throw new Error(`not an asset file name: ${JSON.stringify(name)}`);
      }
      await mkdir(assetsDir, { recursive: true });
      let candidate = name;
      for (let attempt = 0; ; attempt++) {
        const path = join(assetsDir, candidate);
        if (!isAbsolute(path) || dirname(path) !== assetsDir) throw new Error("invalid asset path");
        try {
          const handle = await open(path, "wx");
          try {
            await handle.writeFile(body);
            await handle.sync();
          } finally {
            await handle.close();
          }
          return { name: candidate };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 20) throw error;
          candidate = suffixedAssetName(name);
        }
      }
    },
  };
  return storage;
}
