/**
 * The content a request reads, as an index (see /next/hosted-releases-internals):
 * block name → `{ version, meta?, data? }`, the shape of a hosted revision's
 * `index.json`. Routing, the reference walk and existence checks read the
 * index only; bodies come from memory (local content, a draft's own files,
 * the inline `CMS` body) or, by hash, from the hosted block store.
 *
 * Local content (a content module or a custom `Loader`) is turned into an
 * index once per snapshot object, with `blockMeta` over its bodies (a page's
 * saved SEO block resolved from them), so `routes()`, `redirects()`,
 * `entries()` and `prefetch()` behave the same everywhere.
 */
import { type BlockIndex, blockMeta, type IndexEntry, META_VERSION } from "./blockMeta.ts";
import { REDIRECTS_TYPE } from "./builtins/data.ts";
import { LEGACY_ALIASES } from "./builtins/legacy.ts";
import { own } from "./json.ts";
import type { Entry, Route, Snapshot } from "./types.ts";

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
  /**
   * The version of `blockMeta` that computed the entries' `meta` (the index's
   * `metaVersion`, 1 when it has none; `META_VERSION` for local content).
   */
  readonly metaVersion: number;
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

interface Derived {
  names: string[];
  routes: Route[];
  redirects: string | null;
  /** `entries(type)` by canonical type (`""`: every typed entry), built on first ask. */
  entries: Map<string, readonly Entry[]>;
}

const derived = new WeakMap<IndexedContent, Derived>();

/** Sorted names, routes and the redirects block's name, computed once per index object. */
function derive(content: IndexedContent): Derived {
  let found = derived.get(content);
  if (found !== undefined) return found;
  const names = Object.keys(content.blocks).sort(byCodeUnit);
  const routes: Route[] = [];
  let redirects: string | null = null;
  for (const name of names) {
    const meta = content.blocks[name]?.meta;
    if (meta?.type === undefined) continue;
    const type = canonicalType(content, meta.type);
    if (type === PAGE && typeof meta.path === "string") routes.push({ name, path: meta.path });
    else if (type === REDIRECTS_TYPE && redirects === null) redirects = name;
  }
  found = { names, routes, redirects, entries: new Map() };
  derived.set(content, found);
  return found;
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
 * What the index says about each typed entry (of `type`, after alias mapping,
 * when given), in code-unit order of name: `{ name, type, path?, refs,
 * noIndex? }`, `type` mapped through the aliases. `noIndex` is a boolean on an
 * index whose meta version has it (`metaVersion` 2 or later: a missing one is
 * `false`), absent on an older one. Never reads a body. The same frozen array
 * for the same index and type.
 */
export function entriesOf(content: IndexedContent, type?: string): readonly Entry[] {
  const derived = derive(content);
  const wanted = type === undefined ? "" : canonicalType(content, type);
  let found = derived.entries.get(wanted);
  if (found !== undefined) return found;
  const knowsNoIndex = content.metaVersion >= 2;
  const out: Entry[] = [];
  for (const name of derived.names) {
    const meta = content.blocks[name]?.meta;
    if (meta?.type === undefined) continue;
    const canonical = canonicalType(content, meta.type);
    if (wanted !== "" && canonical !== wanted) continue;
    const entry: Entry = {
      name,
      type: canonical,
      refs: Object.freeze([...(meta.refs ?? [])]) as string[],
    };
    if (meta.path !== undefined) entry.path = meta.path;
    if (knowsNoIndex) entry.noIndex = meta.noIndex === true;
    out.push(Object.freeze(entry));
  }
  found = Object.freeze(out);
  derived.entries.set(wanted, found);
  return found;
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
  const bodyOf = (name: string) => (Object.hasOwn(bodies, name) ? bodies[name] : undefined);
  const blocks = Object.create(null) as BlockIndex;
  for (const name of names) {
    const meta = blockMeta(bodies[name], names, bodyOf);
    // Local bodies are held, so no hash is needed (or computed).
    blocks[name] = Object.keys(meta).length > 0 ? { version: "", meta } : { version: "" };
  }
  found = {
    revision: snapshot.revision,
    sequence: 0,
    metaVersion: META_VERSION,
    blocks,
    held: {
      has: (name) => Object.hasOwn(bodies, name),
      get: bodyOf,
    },
  };
  if (snapshot.aliases !== undefined) (found as { aliases?: unknown }).aliases = snapshot.aliases;
  local.set(snapshot, found);
  return found;
}
