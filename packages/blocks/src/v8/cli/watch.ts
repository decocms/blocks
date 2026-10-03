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
