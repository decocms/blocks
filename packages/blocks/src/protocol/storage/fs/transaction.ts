/**
 * An all-or-nothing change to several files in one folder.
 *
 * New contents are staged and fsynced in a private folder on the same
 * filesystem, then renamed into place: a rename over an existing file is
 * atomic, so a reader never sees a torn or missing file. Every file the
 * change replaces or deletes is first hard-linked into the transaction
 * folder, so if any step fails, the files already changed are put back. The
 * folder itself is fsynced after the renames and unlinks, so the change
 * survives a power loss once it returns.
 *
 * Staged and preserved copies use positional names (`0`, `1`, …), never the
 * target names, so two targets that differ only in letter case can't collide
 * on a case-insensitive filesystem (macOS, Windows).
 */
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

/** The prefix of transaction folders; a leftover one is from a crashed commit. */
const TRANSACTION_PREFIX = ".tx-";

interface FileChange {
  /** Files to write, by name inside `dir`. */
  put: Record<string, string>;
  /** Files to delete, by name inside `dir`. A file that's already gone is fine. */
  delete: string[];
}

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

async function writeDurably(path: string, content: string) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flushes a folder's entries (renames, unlinks) to disk; a no-op where that's unsupported. */
async function syncDir(dir: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (error) {
    // Windows can't open a folder; some filesystems can't fsync one.
    if (!["EISDIR", "EPERM", "EACCES", "EINVAL", "EBADF", "ENOTSUP"].includes(codeOf(error)!))
      throw error;
  } finally {
    await handle?.close();
  }
}

async function preserve(source: string, backup: string): Promise<boolean> {
  try {
    await link(source, backup);
    return true;
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT") return false;
    // Filesystems without hard links: fall back to a copy.
    if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV" || code === "EOPNOTSUPP") {
      try {
        await copyFile(source, backup);
        return true;
      } catch (copyError) {
        if (codeOf(copyError) === "ENOENT") return false;
        throw copyError;
      }
    }
    throw error;
  }
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * The deletes to perform: on a case-insensitive filesystem, a file that
 * differs from a written one only in letter case *is* that file, so the
 * rename replaces it, and unlinking it would delete what was just written.
 */
async function effectiveDeletes(dir: string, change: FileChange): Promise<string[]> {
  const puts = Object.keys(change.put);
  const out: string[] = [];
  for (const file of new Set(change.delete)) {
    if (file in change.put) continue;
    const twin = puts.find((p) => p.toLowerCase() === file.toLowerCase());
    if (twin && (await sameFile(join(dir, file), join(dir, twin)))) continue;
    out.push(file);
  }
  return out;
}

/**
 * Applies `change` to `dir` atomically: every file lands, or the folder is
 * left as it was. `scratchParent` holds the transaction folder and must be on
 * the same filesystem as `dir`.
 */
export async function applyFileChange(dir: string, scratchParent: string, change: FileChange) {
  await mkdir(dir, { recursive: true });
  const deletes = await effectiveDeletes(dir, change);
  const tx = await mkdtemp(join(scratchParent, TRANSACTION_PREFIX));
  const staged = join(tx, "new");
  const backups = join(tx, "old");
  await mkdir(staged);
  await mkdir(backups);

  const puts = Object.entries(change.put);
  // target -> its backup's path, or null when there was nothing to preserve
  const touched = new Map<string, string | null>();
  try {
    for (const [index, [, content]] of puts.entries()) {
      await writeDurably(join(staged, String(index)), content);
    }
    for (const file of [...puts.map(([file]) => file), ...deletes]) {
      if (touched.has(file)) continue;
      const backup = join(backups, String(touched.size));
      touched.set(file, (await preserve(join(dir, file), backup)) ? backup : null);
    }
    for (const [index, [file]] of puts.entries()) {
      await rename(join(staged, String(index)), join(dir, file));
    }
    for (const file of deletes) {
      await unlink(join(dir, file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await syncDir(dir);
  } catch (error) {
    for (const [file, backup] of touched) {
      const target = join(dir, file);
      try {
        if (backup) await rename(backup, target);
        else await rm(target, { force: true });
      } catch {
        // Best effort: keep restoring the others.
      }
    }
    throw error;
  } finally {
    await rm(tx, { recursive: true, force: true });
  }
}

/**
 * Removes transaction folders a crashed commit left in `scratchParent`. Call
 * it only while holding the commit lock, when no live transaction exists.
 */
export async function sweepStaleTransactions(scratchParent: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(scratchParent);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return [];
    throw error;
  }
  const stale = names.filter((name) => name.startsWith(TRANSACTION_PREFIX));
  await Promise.all(
    stale.map((name) => rm(join(scratchParent, name), { recursive: true, force: true })),
  );
  return stale;
}
