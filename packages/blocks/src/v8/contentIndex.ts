/**
 * The content a request reads, as an index (see /next/hosted-releases-internals):
 * block name → `{ version, meta?, data? }`, the shape of a hosted revision's
 * `index.json`. Routing, the reference walk and existence checks read the
 * index only; bodies come from memory (local content, a draft's own files,
 * the inline `CMS` body) or, by hash, from the hosted block store.
 *
 * Local content (a content module or a custom `Loader`) is turned into an
 * index once per snapshot object, with `blockMeta` over its bodies, so
 * `routes()`, `redirects()` and `prefetch()` behave the same everywhere.
 */
import { type BlockIndex, blockMeta, type IndexEntry } from "./blockMeta.ts";
import { REDIRECTS_TYPE } from "./builtins/data.ts";
import { LEGACY_ALIASES } from "./builtins/legacy.ts";
import { own } from "./json.ts";
import type { Route, Snapshot } from "./types.ts";

/** Fetches bodies by hash, shared across requests (see ./blockStore.ts). */
export interface BodySource {
  /** The body for `hash` when this process holds it, without fetching. */
  peek(hash: string): unknown | undefined;
  /** The body for `hash`: held, in flight, or fetched now. Rejects with a `ContentUnavailableError`. */
  get(hash: string, name: string): Promise<unknown>;
}

/** Bodies held by name: never fetched, never shared beyond the content that holds them. */
export interface HeldBodies {
  has(name: string): boolean;
  get(name: string): unknown;
}

/** One index a request can pin. */
export interface IndexedContent {
  readonly revision: string;
  /** `latest.json`'s `sequence` (0 for local content). */
  readonly sequence: number;
  /** Name → entry; a null-prototype object, so any name is an entry. */
  readonly blocks: Readonly<BlockIndex>;
  /** The content module's alias table (local content only). */
  readonly aliases?: Readonly<Record<string, string>>;
  /** Bodies in memory by name (local content, a draft's files). */
  readonly held?: HeldBodies;
  /** Where the other bodies come from, by hash; absent when every body is held. */
  readonly source?: BodySource;
  /** A draft overlay: never served on a previous index. */
  readonly draft?: boolean;
}

/** The type an alias points at (the content's own table, then the legacy one), or the type itself. */
export function canonicalType(content: IndexedContent, type: string): string {
  return (
    own(content.aliases as Record<string, string> | undefined, type) ??
    own(LEGACY_ALIASES, type) ??
    type
  );
}

export function hasEntry(content: IndexedContent, name: string): boolean {
  return Object.hasOwn(content.blocks, name);
}

export function entryOf(content: IndexedContent, name: string): IndexEntry | undefined {
  return Object.hasOwn(content.blocks, name) ? content.blocks[name] : undefined;
}

/** Whether a body comes from memory, never a fetch: held by name, or inline. */
export function bodyInMemory(content: IndexedContent, name: string): boolean {
  if (content.held?.has(name)) return true;
  const entry = entryOf(content, name);
  return entry !== undefined && entry.data !== undefined;
}

/** Names sorted in code-unit order (the order of every listing, the same on every server). */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The type of a page, after alias mapping. */
const PAGE = "page";

export { REDIRECTS_TYPE };

/**
 * v7's per-rule redirect type. Blocks saved under this name (by the v7 site
 * editor, or carried over by the migration) are routed, as `client.list("redirect")`
 * routed them before the redirects block; a block typed `redirect` is not.
 */
export const LEGACY_REDIRECT_TYPE = "website/loaders/redirect.ts";

interface Derived {
  names: string[];
  routes: Route[];
  redirects: string | null;
  legacyRedirects: string[];
}

const derived = new WeakMap<IndexedContent, Derived>();

/** Sorted names, routes and the redirects block's name, computed once per index object. */
function derive(content: IndexedContent): Derived {
  let found = derived.get(content);
  if (found !== undefined) return found;
  const names = Object.keys(content.blocks).sort(byCodeUnit);
  const routes: Route[] = [];
  let redirects: string | null = null;
  const legacyRedirects: string[] = [];
  for (const name of names) {
    const meta = content.blocks[name]?.meta;
    if (meta?.type === undefined) continue;
    if (meta.type === LEGACY_REDIRECT_TYPE) legacyRedirects.push(name);
    const type = canonicalType(content, meta.type);
    if (type === PAGE && typeof meta.path === "string") routes.push({ name, path: meta.path });
    else if (type === REDIRECTS_TYPE && redirects === null) redirects = name;
  }
  found = { names, routes, redirects, legacyRedirects };
  derived.set(content, found);
  return found;
}

/** Every name, in code-unit order. */
export function namesOf(content: IndexedContent): readonly string[] {
  return derive(content).names;
}

/**
 * `{ name, path }` of every page entry (its `meta.type` maps to `page` and it
 * has a `meta.path`), in code-unit order of name, so the same page wins a path
 * conflict whatever the index's key order. The same array for the same index,
 * so `matchRoute`'s per-array trie cache is the per-revision trie.
 */
export function routesOf(content: IndexedContent): Route[] {
  return derive(content).routes;
}

/** The redirects block: the first `redirects`-typed entry in code-unit name order, or `null`. */
export function redirectsBlockOf(content: IndexedContent): string | null {
  return derive(content).redirects;
}

/**
 * v7's per-rule redirect blocks (saved as `website/loaders/redirect.ts`), in
 * code-unit name order: routed after the redirects block's rules.
 */
export function legacyRedirectBlocksOf(content: IndexedContent): readonly string[] {
  return derive(content).legacyRedirects;
}

/** Names of entries whose type maps to `type`, in code-unit order. */
export function namesOfType(content: IndexedContent, type: string): string[] {
  const wanted = canonicalType(content, type);
  return namesOf(content).filter((name) => {
    const t = content.blocks[name]?.meta?.type;
    return t !== undefined && canonicalType(content, t) === wanted;
  });
}

/**
 * The walk: `roots` plus every name reachable through `meta.refs`, names the
 * index doesn't have skipped.
 */
export function walk(content: IndexedContent, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = roots.filter((name) => hasEntry(content, name));
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i]!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const ref of content.blocks[name]?.meta?.refs ?? []) {
      if (!seen.has(ref) && hasEntry(content, ref)) queue.push(ref);
    }
  }
  return [...seen];
}

/** Local content as an index: once per snapshot object. */
const local = new WeakMap<Snapshot, IndexedContent>();

export function localIndex(snapshot: Snapshot): IndexedContent {
  let found = local.get(snapshot);
  if (found !== undefined) return found;
  const bodies = snapshot.blocks;
  const names = new Set(Object.keys(bodies));
  const blocks = Object.create(null) as BlockIndex;
  for (const name of names) {
    const meta = blockMeta(bodies[name], names);
    // Local bodies are held, so no hash is needed (or computed).
    blocks[name] = Object.keys(meta).length > 0 ? { version: "", meta } : { version: "" };
  }
  found = {
    revision: snapshot.revision,
    sequence: 0,
    blocks,
    held: {
      has: (name) => Object.hasOwn(bodies, name),
      get: (name) => (Object.hasOwn(bodies, name) ? bodies[name] : undefined),
    },
  };
  if (snapshot.aliases !== undefined) (found as { aliases?: unknown }).aliases = snapshot.aliases;
  local.set(snapshot, found);
  return found;
}
