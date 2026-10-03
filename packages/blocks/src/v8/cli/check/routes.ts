/**
 * Route collisions (spec: routing › Match order; router-internals). Builds the
 * same segment trie `matchRoute` builds, once per group (routes, then
 * redirects), and reports every entry that reaches a leaf another entry
 * already holds: two equal paths, or two templates of the same shape
 * (`/:slug/p` and `/:id/p`), which can match the same URLs.
 *
 * TODO(N-02): `matchRoute` builds this trie at runtime. When it lands, share
 * the normalization and insertion code so the check and the router agree.
 */

export interface RouteEntry {
  name: string;
  path: string;
}

export interface RouteConflict {
  /** The entry that loses: `matchRoute` keeps the one earlier in the list. */
  name: string;
  path: string;
  /** The entry that keeps the leaf. */
  other: string;
  otherPath: string;
}

/** Normalize like `matchRoute`: decode, drop query and fragment, trim the trailing slash. */
export function normalizePath(raw: string): string {
  let p = raw.split("#")[0].split("?")[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep the raw path
  }
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

/** The shape of a path: parameters lose their names, so equal shapes collide. */
function segments(path: string): string[] {
  return normalizePath(path)
    .split("/")
    .filter(Boolean)
    .map((s) => (s.startsWith(":") ? ":" : s === "*" || s.startsWith("*") ? "*" : s));
}

interface Node {
  children: Map<string, Node>;
  entry?: RouteEntry;
}

/** Insert entries in order; every entry that reaches an occupied leaf is a conflict. */
export function findConflicts(entries: RouteEntry[]): RouteConflict[] {
  const root: Node = { children: new Map() };
  const conflicts: RouteConflict[] = [];
  for (const entry of entries) {
    let node = root;
    for (const segment of segments(entry.path)) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    if (node.entry) {
      conflicts.push({
        name: entry.name,
        path: entry.path,
        other: node.entry.name,
        otherPath: node.entry.path,
      });
    } else {
      node.entry = entry;
    }
  }
  return conflicts;
}
