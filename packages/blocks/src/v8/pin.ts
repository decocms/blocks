/**
 * What one request reads (see /next/hosted-releases-internals): the index it
 * pinned and every body it fetched, for its whole life. Lazy and streamed
 * sections and names read at run time use the same data, and LRU eviction
 * can't pull a body out mid-request. Whether a name exists comes only from the
 * pinned index; a body that isn't pinned is an awaited fetch by its hash.
 *
 * `choosePin` is the previous-index rule: after a publish, a request whose
 * subtree under the new index has blocks missing, while its subtree under the
 * previous index is all cached, is served on the previous index, and the
 * missing hashes are fetched in the background. A draft never is.
 */
import { runInBackground } from "./background.ts";
import {
  bodyInMemory,
  entryOf,
  hasEntry,
  type IndexedContent,
  redirectsBlockOf,
  walk,
} from "./contentIndex.ts";
import { errors } from "./errors.ts";
import type { ForcedVariant } from "./types.ts";
import { forceBody } from "./variants.ts";

/** What a client is handed to read: the current index, the previous one, a draft's forced variants. */
export interface Selection {
  current: IndexedContent;
  previous?: IndexedContent;
  variants?: readonly ForcedVariant[];
}

export class Pin {
  readonly content: IndexedContent;
  readonly #variants: readonly ForcedVariant[] | undefined;
  /** Bodies this request fetched or found cached, by hash. */
  readonly #bodies = new Map<string, unknown>();
  /** Fetches that failed in this request, by hash: every later use fails fast. */
  readonly #failed = new Map<string, unknown>();
  /** Bodies in flight or read, by name (forced variants applied once). */
  readonly #byName = new Map<string, Promise<unknown>>();

  constructor(content: IndexedContent, variants?: readonly ForcedVariant[]) {
    this.content = content;
    this.#variants = variants !== undefined && variants.length > 0 ? variants : undefined;
  }

  get aliases(): Readonly<Record<string, string>> | undefined {
    return this.content.aliases;
  }

  has(name: string): boolean {
    return hasEntry(this.content, name);
  }

  /** The body of a name the pinned index has. Rejects with `LOADER_FAILED` when it can't be fetched. */
  body(name: string, path: (string | number)[] = []): Promise<unknown> {
    let pending = this.#byName.get(name);
    if (pending === undefined) {
      pending = this.#read(name).then((body) =>
        this.#variants === undefined ? body : forceBody(name, body, this.#variants, this.aliases),
      );
      this.#byName.set(name, pending);
    }
    return pending.catch((error: unknown) => {
      throw errors.blockUnavailable(name, path, error);
    });
  }

  /**
   * One parallel wave of every body `names` need that isn't pinned yet: an
   * LRU hit is pinned at once, the rest are fetched. Never rejects; a failure
   * is remembered for the body's later use.
   */
  async wave(names: readonly string[]): Promise<void> {
    const source = this.content.source;
    if (source === undefined) return;
    const fetches: Promise<unknown>[] = [];
    for (const name of names) {
      if (bodyInMemory(this.content, name)) continue;
      const hash = entryOf(this.content, name)?.version;
      if (hash === undefined || this.#bodies.has(hash) || this.#failed.has(hash)) continue;
      const cached = source.peek(hash);
      if (cached !== undefined) {
        this.#bodies.set(hash, cached);
        continue;
      }
      fetches.push(this.#fetch(hash, name).catch(() => {}));
    }
    await Promise.all(fetches);
  }

  async #read(name: string): Promise<unknown> {
    const content = this.content;
    if (content.held?.has(name)) return content.held.get(name);
    const entry = entryOf(content, name);
    if (entry === undefined) return undefined;
    if (entry.data !== undefined) return entry.data;
    const hash = entry.version;
    if (this.#bodies.has(hash)) return this.#bodies.get(hash);
    if (this.#failed.has(hash)) throw this.#failed.get(hash);
    const source = content.source;
    if (source === undefined) return undefined;
    const cached = source.peek(hash);
    if (cached !== undefined) {
      this.#bodies.set(hash, cached);
      return cached;
    }
    return this.#fetch(hash, name);
  }

  #fetch(hash: string, name: string): Promise<unknown> {
    return (this.content.source as NonNullable<IndexedContent["source"]>).get(hash, name).then(
      (body) => {
        this.#bodies.set(hash, body);
        return body;
      },
      (error: unknown) => {
        this.#failed.set(hash, error);
        throw error;
      },
    );
  }
}

/** The walk a request starts from: its page (when known) plus the redirects block. */
export function rootsOf(content: IndexedContent, name: string | undefined): string[] {
  const roots = name !== undefined ? [name] : [];
  const redirects = redirectsBlockOf(content);
  if (redirects !== null && redirects !== name) roots.push(redirects);
  return roots;
}

/** Every body of `names` is in memory or in the LRU. */
function allCached(content: IndexedContent, names: readonly string[]): boolean {
  const source = content.source;
  return names.every((name) => {
    if (bodyInMemory(content, name)) return true;
    const hash = entryOf(content, name)?.version;
    return hash !== undefined && source?.peek(hash) !== undefined;
  });
}

/**
 * The index a request pins (contract §3.4 rule 1): the current one when its
 * walk is cached, when there is no previous index, or for a draft; the
 * previous one when its walk is cached and the current one's isn't (and the
 * page has the same path in both), warming the current one's missing blocks in
 * the background.
 */
export function choosePin(selection: Selection, name: string | undefined): Pin {
  const { current, previous, variants } = selection;
  const onCurrent = () => new Pin(current, variants);
  if (current.draft || previous === undefined || current.source === undefined) return onCurrent();
  const fresh = walk(current, rootsOf(current, name));
  if (allCached(current, fresh)) return onCurrent();
  if (name !== undefined) {
    const now = entryOf(current, name);
    const before = entryOf(previous, name);
    if (now === undefined || before === undefined || now.meta?.path !== before.meta?.path) {
      return onCurrent();
    }
  }
  if (!allCached(previous, walk(previous, rootsOf(previous, name)))) return onCurrent();
  const source = current.source;
  const missing = fresh.filter((n) => !bodyInMemory(current, n));
  runInBackground(() =>
    Promise.all(
      missing.map((n) => {
        const hash = current.blocks[n]?.version as string;
        return source.peek(hash) !== undefined ? undefined : source.get(hash, n).catch(() => {});
      }),
    ),
  );
  return new Pin(previous, variants);
}
