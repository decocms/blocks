/**
 * Serializes commits to one `.deco` folder: an in-process queue per folder,
 * plus a lock file so two processes (two `deco serve`s, or a script) never
 * interleave a commit.
 */
import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { StorageUnavailableError } from "../../storage";

const LOCK_FILE = ".blocks.lock";
const queues = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireFileLock(decoDir: string, timeoutMs: number, staleMs: number) {
  const path = join(decoDir, LOCK_FILE);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > staleMs) {
      // A crashed writer left its lock behind.
      await rm(path, { force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new StorageUnavailableError("another process is writing .deco/blocks", 500);
    }
    await sleep(20);
  }
}

interface LockOptions {
  timeoutMs: number;
  staleMs: number;
}

/** Runs `fn` while holding the commit lock of `decoDir`. */
export async function withCommitLock<T>(
  decoDir: string,
  options: LockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(decoDir) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      const release = await acquireFileLock(decoDir, options.timeoutMs, options.staleMs);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  queues.set(decoDir, run);
  try {
    return await run;
  } finally {
    if (queues.get(decoDir) === run) queues.delete(decoDir);
  }
}
