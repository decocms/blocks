/**
 * `matchRoute(url, items)`: finds the entry for a URL (see /next/routing and
 * /next/router-internals).
 *
 * Paths compile into a segment trie, cached per array object: a lookup costs
 * the URL's depth, not the number of routes. At every node the walk tries the
 * literal child, then the parameter child, then a trailing splat, so exact
 * paths win over templates per segment and a splat is the last resort.
 * Redirects are a second trie, checked first. Two entries that reach the same
 * leaf are a conflict `deco check` reports; here the earlier one keeps it, so
 * a lookup never throws.
 */
import type { LegacyRedirect, Match, Redirect, RedirectStatus, Route } from "./types";

export interface MatchRouteOptions {
  /** Match literal segments regardless of case. Default `false`. */
  ignoreCase?: boolean;
}

interface Leaf<T> {
  value: T;
  /** Parameter names in path order; a splat's is its own name or `"*"`. */
  names: string[];
}

interface TrieNode<T> {
  literals: Map<string, TrieNode<T>>;
  param?: TrieNode<T>;
  /** A trailing splat: matches the remaining segments, zero or more, at lowest precedence. */
  splat?: Leaf<T> & { splatName: string };
  leaf?: Leaf<T>;
}

interface NormalizedRedirect {
  from: string;
  to: string;
  status: RedirectStatus;
  discardQueryParameters: boolean;
}

type Trie<T> = TrieNode<T>;

const routeTries = [new WeakMap<object, Trie<Route>>(), new WeakMap<object, Trie<Route>>()];
const redirectTries = [
  new WeakMap<object, Trie<NormalizedRedirect>>(),
  new WeakMap<object, Trie<NormalizedRedirect>>(),
];

export function matchRoute<T extends Route>(
  url: string | URL | Request,
  items: { routes: T[]; redirects?: (Redirect | LegacyRedirect)[] },
  options: MatchRouteOptions = {},
): Match<T> {
  const target = parseTarget(url);
  if (target === null) return { kind: "not-found" };
  const ignoreCase = options.ignoreCase === true;
  const segments = target.segments.map((segment) => (ignoreCase ? segment.toLowerCase() : segment));
  const original = target.segments;

  const redirects = Array.isArray(items?.redirects) ? items.redirects : [];
  if (redirects.length > 0) {
    const trie = cached(redirectTries[ignoreCase ? 1 : 0], redirects, () =>
      buildRedirectTrie(redirects, ignoreCase),
    );
    const hit = lookup(trie, segments, original);
    if (hit !== null) {
      return {
        kind: "redirect",
        location: buildLocation(hit.value, hit, target.search),
        status: hit.value.status,
      };
    }
  }

  const routes = Array.isArray(items?.routes) ? items.routes : [];
  const trie = cached(routeTries[ignoreCase ? 1 : 0], routes, () =>
    buildTrie(
      routes.filter(isRoute).map((route) => ({ path: route.path, value: route as Route })),
      ignoreCase,
    ),
  );
  const hit = lookup(trie, segments, original);
  if (hit === null) return { kind: "not-found" };
  return { kind: "match", entry: hit.value as T, params: hit.params };
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

interface Target {
  segments: string[];
  /** The query string, with its `?`, or `""`. */
  search: string;
}

function parseTarget(url: string | URL | Request): Target | null {
  try {
    const raw = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    // A bare path stays a path: `//summer` is not a host named "summer".
    if (raw.startsWith("/")) {
      const end = raw.search(/[?#]/);
      const pathname = end === -1 ? raw : raw.slice(0, end);
      const queryAt = raw.indexOf("?");
      const hashAt = raw.indexOf("#");
      const search =
        queryAt === -1 || (hashAt !== -1 && hashAt < queryAt)
          ? ""
          : raw.slice(queryAt, hashAt > queryAt ? hashAt : undefined);
      return { segments: splitPath(pathname, true), search: search === "?" ? "" : search };
    }
    const parsed = new URL(raw);
    return { segments: splitPath(parsed.pathname, true), search: parsed.search };
  } catch {
    return null;
  }
}

/**
 * Splits a path into segments: percent-decoded (when `decode`), with empty
 * segments, the query and the fragment dropped, so `/a/b/`, `/a//b` and
 * `/a/b?x` all name `["a", "b"]` and `/` names `[]`.
 */
function splitPath(path: string, decode: boolean): string[] {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  return pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => (decode ? safeDecode(segment) : segment));
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

function isRoute(entry: unknown): entry is Route {
  return typeof entry === "object" && entry !== null && typeof (entry as Route).path === "string";
}

function cached<T>(cache: WeakMap<object, Trie<T>>, key: object, build: () => Trie<T>): Trie<T> {
  let trie = cache.get(key);
  if (trie === undefined) {
    trie = build();
    cache.set(key, trie);
  }
  return trie;
}

function emptyNode<T>(): TrieNode<T> {
  return { literals: new Map() };
}

function buildTrie<T>(entries: { path: string; value: T }[], ignoreCase: boolean): Trie<T> {
  const root = emptyNode<T>();
  for (const { path, value } of entries) insert(root, path, value, ignoreCase);
  return root;
}

/**
 * Adds `path` to the trie. Returns the value already holding its leaf (a
 * conflict: the earlier entry keeps it), else `undefined`.
 */
function insert<T>(root: TrieNode<T>, path: string, value: T, ignoreCase: boolean): T | undefined {
  const segments = splitPath(path, false);
  const names: string[] = [];
  let node = root;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const splatName = splatOf(segment);
    if (splatName !== null) {
      // A splat is only meaningful last; anywhere else the path is ignored.
      if (i !== segments.length - 1) return undefined;
      if (node.splat) return node.splat.value;
      node.splat = { value, names: [...names, splatName], splatName };
      return undefined;
    }
    if (segment.startsWith(":") && segment.length > 1) {
      names.push(segment.slice(1));
      node.param ??= emptyNode();
      node = node.param;
      continue;
    }
    const literal = safeDecode(segment);
    const key = ignoreCase ? literal.toLowerCase() : literal;
    let child = node.literals.get(key);
    if (child === undefined) {
      child = emptyNode();
      node.literals.set(key, child);
    }
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
export function findRouteConflicts<T extends { path: string }>(
  entries: readonly T[],
): { entry: T; other: T }[] {
  const root = emptyNode<T>();
  const conflicts: { entry: T; other: T }[] = [];
  for (const entry of entries) {
    const other = insert(root, entry.path, entry, false);
    if (other !== undefined) conflicts.push({ entry, other });
  }
  return conflicts;
}

/** `*` → `"*"`, `:rest*` → `"rest"`, anything else → `null`. */
function splatOf(segment: string): string | null {
  if (segment === "*") return "*";
  if (segment.length > 2 && segment.startsWith(":") && segment.endsWith("*")) {
    return segment.slice(1, -1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface Hit<T> {
  value: T;
  params: Record<string, string>;
  /**
   * A splat's captured segments, each still separate and decoded. A redirect
   * re-encodes them one by one, so an encoded `%2F` inside a segment stays
   * `%2F` in the location and can't become a real slash (an open redirect via
   * `/old/%2Fevil.com` → `//evil.com`).
   */
  splats: Record<string, string[]>;
}

/** A captured value: one segment for a parameter, the remaining segments for a splat. */
type Capture = string | string[];

function lookup<T>(root: TrieNode<T>, segments: string[], original: string[]): Hit<T> | null {
  const found = walk(root, segments, original, 0, []);
  if (found === null) return null;
  const params: Record<string, string> = {};
  const splats: Record<string, string[]> = {};
  found.leaf.names.forEach((name, i) => {
    const value = found.values[i];
    if (value === undefined) return;
    if (Array.isArray(value)) {
      splats[name] = value;
      params[name] = value.join("/");
    } else {
      params[name] = value;
    }
  });
  return { value: found.leaf.value, params, splats };
}

function walk<T>(
  node: TrieNode<T>,
  segments: string[],
  original: string[],
  depth: number,
  values: Capture[],
): { leaf: Leaf<T>; values: Capture[] } | null {
  if (depth === segments.length) {
    if (node.leaf) return { leaf: node.leaf, values: [...values] };
    // A splat also matches nothing, so `/blog/*` serves `/blog` (and `/*` serves `/`).
    return node.splat ? { leaf: node.splat, values: [...values, []] } : null;
  }
  const literal = node.literals.get(segments[depth]!);
  if (literal) {
    const found = walk(literal, segments, original, depth + 1, values);
    if (found) return found;
  }
  // A parameter is one segment and never contains a slash, even an encoded one.
  if (node.param && !original[depth]!.includes("/")) {
    values.push(original[depth]!);
    const found = walk(node.param, segments, original, depth + 1, values);
    values.pop();
    if (found) return found;
  }
  if (node.splat) {
    return { leaf: node.splat, values: [...values, original.slice(depth)] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

function buildRedirectTrie(
  redirects: (Redirect | LegacyRedirect)[],
  ignoreCase: boolean,
): Trie<NormalizedRedirect> {
  const entries: { path: string; value: NormalizedRedirect }[] = [];
  for (const redirect of redirects) {
    const normalized = normalizeRedirect(redirect);
    if (normalized) entries.push({ path: normalized.from, value: normalized });
  }
  return buildTrie(entries, ignoreCase);
}

const STATUSES = new Set<number>([301, 302, 307, 308]);

/**
 * Both redirect shapes: the flat built-in `{ from, to, permanent, status?,
 * discardQueryParameters? }` and v7's nested `{ redirect: { from, to, type } }`,
 * where `permanent` is a 301 and anything else a 307.
 */
function normalizeRedirect(input: unknown): NormalizedRedirect | null {
  if (typeof input !== "object" || input === null) return null;
  const nested = (input as LegacyRedirect).redirect;
  if (typeof nested === "object" && nested !== null) {
    if (typeof nested.from !== "string" || typeof nested.to !== "string") return null;
    return {
      from: nested.from,
      to: nested.to,
      status: nested.type === "permanent" ? 301 : 307,
      discardQueryParameters: nested.discardQueryParameters === true,
    };
  }
  const flat = input as Partial<Redirect>;
  if (typeof flat.from !== "string" || typeof flat.to !== "string") return null;
  const status =
    typeof flat.status === "number" && STATUSES.has(flat.status)
      ? flat.status
      : flat.permanent === true
        ? 301
        : 302;
  return {
    from: flat.from,
    to: flat.to,
    status,
    discardQueryParameters: flat.discardQueryParameters === true,
  };
}

/**
 * Fills the redirect's `to` with the parameters `from` captured (`:name`,
 * `:rest*` and `*`), then carries the request's query string over unless the
 * redirect discards it.
 */
function buildLocation(
  redirect: NormalizedRedirect,
  { params, splats }: Pick<Hit<NormalizedRedirect>, "params" | "splats">,
  search: string,
): string {
  const hashAt = redirect.to.indexOf("#");
  const beforeHash = hashAt === -1 ? redirect.to : redirect.to.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : redirect.to.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  const base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const ownQuery = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);

  const filled = base.replace(
    /\/(\*|:([A-Za-z0-9_]+)(\*)?)(?=\/|$)/g,
    (match, _token: string, name: string | undefined, star: string | undefined) => {
      const key = name ?? "*";
      const splat = splats[key];
      if (splat !== undefined && (name === undefined || star !== undefined)) {
        return `/${splat.map(encodeURIComponent).join("/")}`;
      }
      const value = params[key];
      return value === undefined ? match : `/${encodeURIComponent(value)}`;
    },
  );
  const location = sameOrigin(redirect.to, filled);

  const carried = redirect.discardQueryParameters ? "" : search.replace(/^\?/, "");
  const query = [ownQuery, carried].filter((part) => part.length > 0).join("&");
  return `${location}${query ? `?${query}` : ""}${hash}`;
}

/**
 * A `to` that names a path on this site (one leading `/`) must stay one: if
 * filling it produced `//host` or `/\\host`, which browsers read as another
 * origin, the leading slashes collapse to one. Encoding every captured
 * segment already prevents this; the check is a second line of defence.
 */
function sameOrigin(to: string, filled: string): string {
  if (!to.startsWith("/") || to.startsWith("//") || to.startsWith("/\\")) return filled;
  return filled.replace(/^[/\\]+/, "/");
}
