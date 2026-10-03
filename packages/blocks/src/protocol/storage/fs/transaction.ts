/**
 * An all-or-nothing change to several files in one folder.
 *
 * New contents are staged and fsynced in a private folder on the same
 * filesystem, then renamed into place: a rename over an existing file is
 * atomic, so a reader never sees a torn or missing file. Every file the
 * change replaces or deletes is first hard-linked into the transaction
 * folder, so if any step fails, the files already changed are put back.
 */
import { copyFile, link, mkdir, mkdtemp, open, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

interface FileChange {
  /** Files to write, by name inside `dir`. */
  put: Record<string, string>;
  /** Files to delete, by name inside `dir`. A file that's already gone is fine. */
  delete: string[];
}

async function writeDurably(path: string, content: string) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function preserve(source: string, backup: string): Promise<boolean> {
  try {
    await link(source, backup);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    // Filesystems without hard links: fall back to a copy.
    if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV" || code === "EOPNOTSUPP") {
      try {
        await copyFile(source, backup);
        return true;
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw copyError;
      }
    }
    throw error;
  }
}

/**
 * Applies `change` to `dir` atomically: every file lands, or the folder is
 * left as it was. `scratchParent` holds the transaction folder and must be on
 * the same filesystem as `dir`.
 */
export async function applyFileChange(dir: string, scratchParent: string, change: FileChange) {
  await mkdir(dir, { recursive: true });
  const tx = await mkdtemp(join(scratchParent, ".tx-"));
  const staged = join(tx, "new");
  const backups = join(tx, "old");
  await mkdir(staged);
  await mkdir(backups);

  // name -> whether a previous version was preserved
  const touched = new Map<string, boolean>();
  try {
    for (const [file, content] of Object.entries(change.put)) {
      await writeDurably(join(staged, file), content);
    }
    for (const file of [...Object.keys(change.put), ...change.delete]) {
      if (touched.has(file)) continue;
      touched.set(file, await preserve(join(dir, file), join(backups, file)));
    }
    for (const file of Object.keys(change.put)) {
      await rename(join(staged, file), join(dir, file));
    }
    for (const file of change.delete) {
      if (file in change.put) continue;
      await unlink(join(dir, file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  } catch (error) {
    for (const [file, preserved] of touched) {
      const target = join(dir, file);
      try {
        if (preserved) await rename(join(backups, file), target);
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
