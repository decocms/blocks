/**
 * `matchRoute(url, items)`: finds the entry for a URL (see /next/routing and
 * /next/router-internals).
 *
 * Paths compile into a segment trie (`routeTrie.ts`), cached per array
 * object: a lookup costs the URL's depth, not the number of routes. At every
 * node the walk tries the literal child, then the parameter child, then a
 * trailing `*` (a splat: one or more remaining segments), so exact paths win
 * over parameters and parameters over a splat, per segment. Redirects are
 * checked first, in their own tries: one per query a `from` is scoped to
 * (`/calcados?map=c,ft`), tried when the request's query is exactly that one,
 * then one for the path-only sources. Two entries that reach the same leaf
 * are a conflict `deco check` reports; here the earlier one keeps it, so a
 * lookup never throws. No regex, no sorting.
 */

import type { TrieNode } from "./routeTrie.ts";
import {
  buildTrie,
  type Hit,
  insert,
  lookup,
  safeDecode,
  splitPath,
  splitRef,
} from "./routeTrie.ts";
import type { LegacyRedirect, Match, Redirect, RedirectStatus, Route } from "./types.ts";

/** `query`: what `from` is scoped to, after its `?` (`""`: any query, or none). */
type NormalizedRedirect = Redirect & { status: RedirectStatus; query: string };
/** The redirect tries, by the query their sources are scoped to (`""`: path-only). */
type RedirectTries = Map<string, TrieNode<NormalizedRedirect>>;

const routeTries = new WeakMap<object, TrieNode<Route>>();
const redirectTries = new WeakMap<object, RedirectTries>();
const STATUSES = new Set<number>([301, 302, 307, 308]);

export function matchRoute<T extends Route>(
  url: string | URL | Request,
  items: { routes: T[]; redirects?: Redirect[] },
): Match<T> {
  const target = parseTarget(url);
  if (target === null) return { kind: "not-found" };

  const redirects: unknown[] = Array.isArray(items?.redirects) ? items.redirects : [];
  const tries = cached(redirectTries, redirects, () => compileRedirects(redirects));
  // A source scoped to the request's exact query string beats a path-only one,
  // as Fresh's router tried `pathname + search` before `pathname`.
  const scoped = target.search ? tries.get(target.search.slice(1)) : undefined;
  const pathOnly = tries.get("");
  const redirect =
    (scoped && lookup(scoped, target.segments)) || (pathOnly && lookup(pathOnly, target.segments));
  if (redirect) {
    const location = buildLocation(redirect, target.search);
    return { kind: "redirect", location, status: redirect.value.status };
  }

  const routes = Array.isArray(items?.routes) ? items.routes : [];
  const trie = cached(routeTries, routes, () =>
    buildTrie(routes.filter((r) => typeof r?.path === "string").map((r) => [r.path, r as Route])),
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

/** Built once per array object. */
function cached<V>(cache: WeakMap<object, V>, key: object, build: () => V): V {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = build();
  cache.set(key, value);
  return value;
}

function compileRedirects(redirects: unknown[]): RedirectTries {
  const tries: RedirectTries = new Map();
  for (const redirect of redirects.map(normalizeRedirect)) {
    if (redirect === null) continue;
    const root = tries.get(redirect.query) ?? { literals: new Map() };
    tries.set(redirect.query, root);
    insert(root, redirect.from, redirect);
  }
  return tries;
}

/**
 * The entries that reach a leaf an earlier entry already holds: two equal
 * paths, or two templates of one shape (`/:slug/p` and `/:id/p`), scoped to the
 * same query. `matchRoute` serves the earlier one; `deco check` reports each pair.
 */
export function findRouteConflicts<T extends { path: string }>(entries: readonly T[]) {
  // A redirect scoped to a query (`/x?map=ft`) never meets `/x` or `/x?map=c`.
  const roots = new Map<string, TrieNode<T>>();
  const conflicts: { entry: T; other: T }[] = [];
  for (const entry of entries) {
    const query = splitRef(entry.path).query;
    const root = roots.get(query) ?? { literals: new Map() };
    roots.set(query, root);
    const other = insert(root, entry.path, entry);
    if (other !== undefined) conflicts.push({ entry, other });
  }
  return conflicts;
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
  const query = splitRef(from).query;
  // A `to` naming the path `from` matches would match again, forever: `/a` →
  // `/a`, `/a/` → `/a`, `/x` → `/x?utm=1` (a path-only source takes any
  // query), `/p/:id` → `/p/:id`, and `/x?a=1` → `/x` (the query is carried
  // over). Dropped, as Fresh's loader skipped `from === to`. Compared as
  // written (`/café` and `/caf%C3%A9` aren't folded); `https://…` never equals.
  const back = [splitRef(to).query, discardQueryParameters ? "" : query].filter(Boolean).join("&");
  const loops = splitPath(from).join("/") === splitPath(to).join("/") && (!query || back === query);
  if (to[0] === "/" && loops) return null;
  const permanent = status === 301 || status === 308;
  return { from, to, permanent, status, discardQueryParameters, query };
}

/**
 * Fills the redirect's `:name` segments with the parameters `from` captured,
 * and a `*` segment with the splat's segments, then carries the request's
 * query string over unless the redirect discards it. Each captured segment is
 * re-encoded on its own and none is empty, so a `to` on this site can't turn
 * into `//other.host` (or `/\other.host`).
 */
function buildLocation({ value: redirect, params, rest }: Hit<NormalizedRedirect>, search: string) {
  const { path, query: written, hash } = splitRef(redirect.to);
  const filled = path
    .split("/")
    .map((s) => {
      if (s === "*" && rest.length > 0) return rest.map(encodeURIComponent).join("/");
      return Object.hasOwn(params, s.slice(1)) && s[0] === ":"
        ? encodeURIComponent(params[s.slice(1)]!)
        : s;
    })
    .join("/");
  const carried = redirect.discardQueryParameters ? "" : search.slice(1);
  const query = [written, carried].filter(Boolean).join("&");
  return `${filled}${query ? `?${query}` : ""}${hash}`;
}
