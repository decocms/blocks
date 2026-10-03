/**
 * `matchRoute(url, items)`: finds the entry for a URL (see /next/routing and
 * /next/router-internals).
 *
 * Paths compile into a segment trie, cached per array object: a lookup costs
 * the URL's depth, not the number of routes. At every node the walk tries the
 * literal child, then the parameter child, so exact paths win over templates
 * per segment. Redirects are a second trie, checked first. Two entries that
 * reach the same leaf are a conflict `deco check` reports; here the earlier
 * one keeps it, so a lookup never throws. No regex, no sorting.
 */
import type { LegacyRedirect, Match, Redirect, RedirectStatus, Route } from "./types";

/** A leaf holds the entry and its parameter names, in path order. */
type TrieNode<T> = {
  literals: Map<string, TrieNode<T>>;
  param?: TrieNode<T>;
  leaf?: { value: T; names: string[] };
};
type NormalizedRedirect = Redirect & { status: RedirectStatus };

const routeTries = new WeakMap<object, TrieNode<Route>>();
const redirectTries = new WeakMap<object, TrieNode<NormalizedRedirect>>();
const STATUSES = new Set<number>([301, 302, 307, 308]);

export function matchRoute<T extends Route>(
  url: string | URL | Request,
  items: { routes: T[]; redirects?: Redirect[] },
): Match<T> {
  const target = parseTarget(url);
  if (target === null) return { kind: "not-found" };

  const redirects: unknown[] = Array.isArray(items?.redirects) ? items.redirects : [];
  const redirectTrie = cached(redirectTries, redirects, () =>
    redirects.flatMap((input) => {
      const r = normalizeRedirect(input);
      return r ? [[r.from, r] as [string, NormalizedRedirect]] : [];
    }),
  );
  const redirect = lookup(redirectTrie, target.segments);
  if (redirect !== null) {
    const location = buildLocation(redirect.value, redirect.params, target.search);
    return { kind: "redirect", location, status: redirect.value.status };
  }

  const routes = Array.isArray(items?.routes) ? items.routes : [];
  const trie = cached(routeTries, routes, () =>
    routes.filter((r) => typeof r?.path === "string").map((r) => [r.path, r as Route]),
  );
  const hit = lookup(trie, target.segments);
  if (hit === null) return { kind: "not-found" };
  return { kind: "match", entry: hit.value as T, params: hit.params };
}

/** The URL's path segments (percent-decoded) and its query string, with its `?`, or `""`. */
function parseTarget(url: string | URL | Request): { segments: string[]; search: string } | null {
  try {
    const raw = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    // A bare path stays a path: `//summer` is not a host named "summer".
    const parsed = raw.startsWith("/") ? new URL(raw, "http://path.invalid") : new URL(raw);
    const pathname = raw.startsWith("/") ? raw : parsed.pathname;
    return { segments: splitPath(pathname).map(safeDecode), search: parsed.search };
  } catch {
    return null;
  }
}

/** `/a/b/`, `/a//b` and `/a/b?x` all name `["a", "b"]`; `/` names `[]`. */
function splitPath(path: string): string[] {
  const query = path.indexOf("?");
  const hash = path.indexOf("#");
  const end = Math.min(query === -1 ? path.length : query, hash === -1 ? path.length : hash);
  return path
    .slice(0, end)
    .split("/")
    .filter((segment) => segment.length > 0);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The trie for an array, built once per array object. */
function cached<T>(cache: WeakMap<object, TrieNode<T>>, key: object, entries: () => [string, T][]) {
  const hit = cache.get(key);
  if (hit) return hit;
  const root: TrieNode<T> = { literals: new Map() };
  for (const [path, value] of entries()) insert(root, path, value);
  cache.set(key, root);
  return root;
}

/** Adds `path`; returns the value already holding its leaf (a conflict: the earlier keeps it). */
function insert<T>(root: TrieNode<T>, path: string, value: T): T | undefined {
  const names: string[] = [];
  let node = root;
  for (const segment of splitPath(path)) {
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

/**
 * The entries that reach a leaf an earlier entry already holds: two equal
 * paths, or two templates of one shape (`/:slug/p` and `/:id/p`). `matchRoute`
 * serves the earlier one; `deco check` reports each pair.
 */
export function findRouteConflicts<T extends { path: string }>(entries: readonly T[]) {
  const root: TrieNode<T> = { literals: new Map() };
  const conflicts: { entry: T; other: T }[] = [];
  for (const entry of entries) {
    const other = insert(root, entry.path, entry);
    if (other !== undefined) conflicts.push({ entry, other });
  }
  return conflicts;
}

/** Walks the URL's segments: the literal child first, then the parameter child. */
function lookup<T>(
  node: TrieNode<T>,
  segments: string[],
  depth = 0,
  values: string[] = [],
): { value: T; params: Record<string, string> } | null {
  if (depth === segments.length) {
    if (!node.leaf) return null;
    const { value, names } = node.leaf;
    return { value, params: Object.fromEntries(names.map((name, i) => [name, values[i]!])) };
  }
  const literal = node.literals.get(segments[depth]!);
  const found = literal ? lookup(literal, segments, depth + 1, values) : null;
  // A parameter is one segment and never contains a slash, even an encoded one.
  if (found || !node.param || segments[depth]!.includes("/")) return found;
  return lookup(node.param, segments, depth + 1, [...values, segments[depth]!]);
}

/**
 * Both redirect shapes: the flat built-in `{ from, to, permanent, status?,
 * discardQueryParameters? }` and the site editor's legacy nested
 * `{ redirect: { from, to, type } }` (see /next/studio-compatibility), where
 * `permanent` is a 301 and anything else a 307.
 */
function normalizeRedirect(input: unknown): NormalizedRedirect | null {
  if (typeof input !== "object" || input === null) return null;
  const nested = (input as Partial<LegacyRedirect>).redirect;
  const flat = (nested ?? input) as Partial<Redirect & LegacyRedirect["redirect"]>;
  if (typeof flat.from !== "string" || typeof flat.to !== "string") return null;
  let status: RedirectStatus = flat.permanent === true ? 301 : 302;
  if (nested) status = flat.type === "permanent" ? 301 : 307;
  else if (STATUSES.has(flat.status as number)) status = flat.status as RedirectStatus;
  const { from, to, discardQueryParameters } = flat;
  return { from, to, permanent: status === 301 || status === 308, status, discardQueryParameters };
}

/**
 * Fills the redirect's `:name` segments with the parameters `from` captured,
 * then carries the request's query string over unless the redirect discards
 * it. Each value is re-encoded and none is empty or holds a slash, so a `to`
 * on this site can't turn into `//other.host`.
 */
function buildLocation(
  redirect: NormalizedRedirect,
  params: Record<string, string>,
  search: string,
) {
  const { to } = redirect;
  const hashAt = to.indexOf("#") === -1 ? to.length : to.indexOf("#");
  const queryAt = to.indexOf("?") === -1 || to.indexOf("?") > hashAt ? hashAt : to.indexOf("?");
  const filled = to
    .slice(0, queryAt)
    .split("/")
    .map((s) =>
      Object.hasOwn(params, s.slice(1)) && s[0] === ":"
        ? encodeURIComponent(params[s.slice(1)]!)
        : s,
    )
    .join("/");
  const carried = redirect.discardQueryParameters ? "" : search.slice(1);
  const query = [to.slice(queryAt + 1, hashAt), carried].filter(Boolean).join("&");
  return `${filled}${query ? `?${query}` : ""}${to.slice(hashAt)}`;
}
