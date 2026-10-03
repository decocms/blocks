import fs from "node:fs";
import path from "node:path";

export interface Watcher {
  close(): void;
}

/**
 * Call `onChange` (debounced) when a file under `dir` that passes `filter`
 * changes. `filter` gets the path relative to `dir`, with forward slashes.
 * A missing `dir` is created so a later first file is seen.
 */
export function watchTree(
  dir: string,
  filter: (relativePath: string) => boolean,
  onChange: () => void,
  debounceMs = 100,
): Watcher {
  fs.mkdirSync(dir, { recursive: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
    if (filename === null) return;
    const rel = String(filename).split(path.sep).join("/");
    if (!filter(rel)) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  });
  return {
    close() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}

/**
 * Watch a set of single files that can change between runs (the sources a
 * schema was read from outside the root). Each file's folder is watched, not
 * the file, so an editor that saves by replacing the file is still seen.
 * `update` swaps the set; a folder that can't be watched is skipped until the
 * next update.
 */
export function watchFiles(
  onChange: () => void,
  debounceMs = 100,
): Watcher & { update(files: Iterable<string>): void } {
  const watchers = new Map<string, fs.FSWatcher>();
  let names = new Map<string, Set<string>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    update(files) {
      const next = new Map<string, Set<string>>();
      for (const file of files) {
        const dir = path.dirname(file);
        const set = next.get(dir) ?? new Set<string>();
        set.add(path.basename(file));
        next.set(dir, set);
      }
      names = next;
      for (const [dir, watcher] of watchers) {
        if (!next.has(dir)) {
          watcher.close();
          watchers.delete(dir);
        }
      }
      for (const dir of next.keys()) {
        if (watchers.has(dir)) continue;
        try {
          const watcher = fs.watch(dir, (_event, filename) => {
            if (filename === null || !names.get(dir)?.has(String(filename))) return;
            clearTimeout(timer);
            timer = setTimeout(onChange, debounceMs);
          });
          watchers.set(dir, watcher);
        } catch {
          // gone since the program read it: picked up again on the next update
        }
      }
    },
    close() {
      clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
