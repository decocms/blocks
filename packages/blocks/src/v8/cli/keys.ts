/**
 * The file-name rule for saved blocks: one entry name per JSON file in
 * `.deco/blocks`, shared by `deco content`, `deco check` and `deco serve`.
 *
 * Spec: content-protocol › File names.
 *
 * - Name to file: `encodeURIComponent(name) + ".json"`, directly in
 *   `.deco/blocks` (no subfolders).
 * - File to name: decode the file name, without `.json`, exactly once. If
 *   decoding fails, the raw name is the entry name.
 * - Two spellings of one name (files that decode to the same name after
 *   repeated decoding): the file whose entry has a `path` wins, then the one
 *   that took more decoding, then the lowest file name. The others are
 *   reported as diagnostics.
 *
 * TODO(N-01): `@decocms/blocks/protocol/keys` owns this rule. When that
 * subpath lands, delete this file and import from it, so the site editor,
 * `deco serve` and `deco content` share one implementation.
 */

/** Largest encoded name, so `<name>.json` fits a 255-byte file-name limit. */
const MAX_ENCODED_NAME_BYTES = 250;

export function nameToFile(name: string): string {
  return `${encodeURIComponent(name)}.json`;
}

/** Decode a file name (with or without `.json`) exactly once. */
export function fileToName(file: string): string {
  const stem = file.replace(/\.json$/, "");
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
}

/** Fully decode a stem, counting the passes; groups spellings of one name. */
export function canonicalName(file: string): { name: string; passes: number } {
  let name = file.replace(/\.json$/, "");
  let passes = 0;
  while (name.includes("%")) {
    let next: string;
    try {
      next = decodeURIComponent(name);
    } catch {
      break;
    }
    if (next === name) break;
    name = next;
    passes++;
  }
  return { name, passes };
}

export interface SpellingCandidate {
  file: string;
  entry: unknown;
}

function hasPath(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as { path?: unknown }).path === "string" &&
    (entry as { path: string }).path.length > 0
  );
}

/** Order spellings of one name: the winner first. */
export function compareSpellings(a: SpellingCandidate, b: SpellingCandidate): number {
  const pa = hasPath(a.entry);
  const pb = hasPath(b.entry);
  if (pa !== pb) return pa ? -1 : 1;
  const da = canonicalName(a.file).passes;
  const db = canonicalName(b.file).passes;
  if (da !== db) return db - da;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/**
 * Why a name can't be saved, or null when it can. `existing` is every current
 * entry name, for the letter-case rule; a name already present is allowed.
 */
export function invalidNameReason(name: string, existing: Iterable<string> = []): string | null {
  if (name.length === 0) return "empty name";
  if (name.includes("\\")) return 'name contains "\\"';
  if (name.includes("..")) return 'name contains ".."';
  if (name.includes("\0")) return "name contains NUL";
  if (name === "__proto__") return 'name is "__proto__"';
  if (WINDOWS_DEVICE.test(name)) return "name is a Windows device name";
  if (SOURCE_EXTENSION.test(name)) return "name ends in a source extension";
  if (new TextEncoder().encode(encodeURIComponent(name)).length > MAX_ENCODED_NAME_BYTES) {
    return `encoded name is over ${MAX_ENCODED_NAME_BYTES} bytes`;
  }
  const names = [...existing];
  if (names.includes(name)) return null;
  const lower = name.toLowerCase();
  const clash = names.find((other) => other.toLowerCase() === lower);
  return clash === undefined ? null : `name differs from "${clash}" only in letter case`;
}
