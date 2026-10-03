/**
 * `matchRoute(url, items)`: finds the entry for a URL (see /next/routing and
 * /next/router-internals).
 *
 * Paths compile into a segment trie, cached per array object: a lookup costs
 * the URL's depth, not the number of routes. At every node the walk tries the
 * literal child, then the parameter child, then a trailing `*` (a splat: one
 * or more remaining segments), so exact paths win over parameters and
 * parameters over a splat, per segment. Redirects are a second trie, checked
 * first. Two entries that
 * reach the same leaf are a conflict `deco check` reports; here the earlier
 * one keeps it, so a lookup never throws. No regex, no sorting.
 */
import type { LegacyRedirect, Match, Redirect, RedirectStatus, Route } from "./types.ts";

/** A leaf holds the entry and its parameter names, in path order; `splat` is a trailing `*`'s leaf. */
type Leaf<T> = { value: T; names: string[] };
type TrieNode<T> = {
  literals: Map<string, TrieNode<T>>;
  param?: TrieNode<T>;
  leaf?: Leaf<T>;
  splat?: Leaf<T>;
};
type Hit<T> = { value: T; params: Record<string, string>; rest: string[] };
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
    const location = buildLocation(redirect, target.search);
    return { kind: "redirect", location, status: redirect.value.status };
  }

  const routes = Array.isArray(items?.routes) ? items.routes : [];
  const trie = cached(routeTries, routes, () =>
    routes.filter((r) => typeof r?.path === "string").map((r) => [r.path, r as Route]),
  );
  const found = lookup(trie, target.segments);
  if (found === null) return { kind: "not-found" };
  return { kind: "match", entry: found.value as T, params: found.params };
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

/** Walks the URL's segments: the literal child first, then the parameter child, then the splat. */
function lookup<T>(node: TrieNode<T>, segs: string[], i = 0, vals: string[] = []): Hit<T> | null {
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
 * and a `*` segment with the splat's segments, then carries the request's
 * query string over unless the redirect discards it. Each captured segment is
 * re-encoded on its own and none is empty, so a `to` on this site can't turn
 * into `//other.host` (or `/\other.host`).
 */
function buildLocation({ value: redirect, params, rest }: Hit<NormalizedRedirect>, search: string) {
  const { to } = redirect;
  const hashAt = to.indexOf("#") === -1 ? to.length : to.indexOf("#");
  const queryAt = to.indexOf("?") === -1 || to.indexOf("?") > hashAt ? hashAt : to.indexOf("?");
  const filled = to
    .slice(0, queryAt)
    .split("/")
    .map((s) => {
      if (s === "*" && rest.length > 0) return rest.map(encodeURIComponent).join("/");
      return Object.hasOwn(params, s.slice(1)) && s[0] === ":"
        ? encodeURIComponent(params[s.slice(1)]!)
        : s;
    })
    .join("/");
  const carried = redirect.discardQueryParameters ? "" : search.slice(1);
  const query = [to.slice(queryAt + 1, hashAt), carried].filter(Boolean).join("&");
  return `${filled}${query ? `?${query}` : ""}${to.slice(hashAt)}`;
}
