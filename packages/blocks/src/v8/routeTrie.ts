/**
 * The segment trie behind `matchRoute` (see /next/router-internals): paths
 * compile into nodes keyed by segment, and a lookup walks the URL's segments,
 * trying the literal child, then the parameter child, then a trailing `*` (a
 * splat: one or more remaining segments). A lookup costs the URL's depth, not
 * the number of entries. No regex, no sorting.
 */

/** A leaf holds the entry and its parameter names, in path order; `splat` is a trailing `*`'s leaf. */
type Leaf<T> = { value: T; names: string[] };
export type TrieNode<T> = {
  literals: Map<string, TrieNode<T>>;
  param?: TrieNode<T>;
  leaf?: Leaf<T>;
  splat?: Leaf<T>;
};
export type Hit<T> = { value: T; params: Record<string, string>; rest: string[] };

/** A trie holding `entries` (`[path, value]`); on a conflict the earlier keeps the leaf. */
export function buildTrie<T>(entries: Iterable<[string, T]>): TrieNode<T> {
  const root: TrieNode<T> = { literals: new Map() };
  for (const [path, value] of entries) insert(root, path, value);
  return root;
}

/** Adds `path`; returns the value already holding its leaf (a conflict: the earlier keeps it). */
export function insert<T>(root: TrieNode<T>, path: string, value: T): T | undefined {
  const names: string[] = [];
  const segments = splitPath(path);
  let node = root;
  for (const [i, segment] of segments.entries()) {
    if (segment === "*" && i === segments.length - 1) {
      if (node.splat) return node.splat.value;
      node.splat = { value, names };
      return undefined;
    }
    if (segment.startsWith(":") && segment.length > 1) {
      names.push(segment.slice(1));
      node = node.param ??= { literals: new Map() };
      continue;
    }
    const literal = safeDecode(segment);
    const child = node.literals.get(literal) ?? { literals: new Map() };
    node.literals.set(literal, child);
    node = child;
  }
  if (node.leaf) return node.leaf.value;
  node.leaf = { value, names };
  return undefined;
}

/** Walks the URL's segments: the literal child first, then the parameter child, then the splat. */
export function lookup<T>(
  node: TrieNode<T>,
  segs: string[],
  i = 0,
  vals: string[] = [],
): Hit<T> | null {
  if (i === segs.length) return node.leaf ? hit(node.leaf, vals, []) : null;
  const literal = node.literals.get(segs[i]!);
  let found = literal ? lookup(literal, segs, i + 1, vals) : null;
  // A parameter is one segment and never contains a slash, even an encoded one.
  if (!found && node.param && !segs[i]!.includes("/")) {
    found = lookup(node.param, segs, i + 1, [...vals, segs[i]!]);
  }
  // A splat takes the rest (at least one segment, as there is one here).
  return found ?? (node.splat ? hit(node.splat, vals, segs.slice(i)) : null);
}

function hit<T>({ value, names }: Leaf<T>, values: string[], rest: string[]): Hit<T> {
  const params: Record<string, string> = Object.fromEntries(names.map((n, i) => [n, values[i]!]));
  if (rest.length > 0) params["*"] = rest.join("/");
  return { value, params, rest };
}

/** `/a/b/`, `/a//b` and `/a/b?x` all name `["a", "b"]`; `/` names `[]`. */
export function splitPath(path: string): string[] {
  return splitRef(path)
    .path.split("/")
    .filter((segment) => segment.length > 0);
}

/**
 * A path or URL split at its first `?` and `#`: everything before, the query
 * (without its `?`, `""` when there's none) and the fragment (with its `#`).
 */
export function splitRef(ref: string): { path: string; query: string; hash: string } {
  const hashAt = ref.indexOf("#") === -1 ? ref.length : ref.indexOf("#");
  const queryAt = ref.indexOf("?") === -1 || ref.indexOf("?") > hashAt ? hashAt : ref.indexOf("?");
  return {
    path: ref.slice(0, queryAt),
    query: ref.slice(queryAt + 1, hashAt),
    hash: ref.slice(hashAt),
  };
}

export function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
