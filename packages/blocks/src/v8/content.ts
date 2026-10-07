/**
 * The content side of a CMS: one source (the content module or a `Loader`),
 * the caches every client shares, and the release revisions this process has
 * served. Clients only ever see whole `{ revision, blocks }` snapshots.
 *
 * A draft is the release with a draft's changes layered over it (see
 * ./draftChanges.ts). Drafts are never recorded as served:
 * `forRevision(revision)` takes a revision string a client may hand back, so
 * it must only ever reach published content, never a draft someone loaded
 * with a pointer.
 */
import { formatDraftPointer, parseDraftPointer } from "./draft.ts";
import { type DraftChanges, fetchDraftChanges, LOCAL_VERSION, layerDraft } from "./draftChanges.ts";
import { errors, isResolutionError } from "./errors.ts";
import { isPlainObject } from "./json.ts";
import type { Loader, Snapshot } from "./types.ts";

const SERVED_REVISIONS = 16;
/** Fetched drafts kept per CMS. */
const CACHED_DRAFTS = 3;
/** How long a fetched draft is reused before it's fetched again, so its token is checked again. */
const DRAFT_TTL_MS = 60_000;

/** A fetched draft, and the views of it over each release it was layered on. */
interface CachedDraft {
  changes: Promise<DraftChanges>;
  at: number;
  views: WeakMap<Snapshot, Snapshot>;
}

export function isLoader(content: unknown): content is Loader {
  return (
    (typeof content === "object" || typeof content === "function") &&
    content !== null &&
    typeof (content as Loader).load === "function"
  );
}

/**
 * An internal hook a built-in loader (`remoteLoader`) has: the release it
 * would return right now, from memory, or `undefined` when that takes a load.
 * `cms.settings()` reads through it, so it never fetches.
 */
export const PEEK_RELEASE: unique symbol = Symbol.for("decocms.blocks.peekRelease");

/** The release a source holds in memory: the snapshot itself, or what a loader can peek. */
export function peekRelease(source: Snapshot | Loader): Snapshot | undefined {
  if (!isLoader(source)) return source;
  const peek = (source as { [PEEK_RELEASE]?: () => Snapshot | undefined })[PEEK_RELEASE];
  return typeof peek === "function" ? peek.call(source) : undefined;
}

export function isSnapshot(content: unknown): content is Snapshot {
  return (
    isPlainObject(content) &&
    typeof content.revision === "string" &&
    isPlainObject(content.blocks) &&
    (content.aliases === undefined || isPlainObject(content.aliases))
  );
}

export class ContentStore {
  #source: Snapshot | Loader;
  #release: Promise<Snapshot> | undefined;
  #updating: Promise<{ updated: boolean }> | undefined;
  readonly #drafts = new BoundedMap<string, CachedDraft>(CACHED_DRAFTS);
  readonly #served = new BoundedMap<string, Snapshot>(SERVED_REVISIONS);
  /** The release this store last handed a client, for a loader that can't peek. */
  #latest: Snapshot | undefined;

  constructor(source: Snapshot | Loader) {
    this.#source = source;
  }

  /** Whether the source can change while the process runs (has `update()`). */
  get updatable(): boolean {
    return isLoader(this.#source) && typeof this.#source.update === "function";
  }

  /**
   * The current release. A snapshot is the release; a loader with `update()`
   * is loaded once and reloaded after an update; a loader without `update()`
   * is asked on every call, since it's always current by construction.
   */
  release(): Promise<Snapshot> {
    const source = this.#source;
    if (!isLoader(source)) return Promise.resolve(this.#serve(source));
    if (!this.updatable) return this.#load(source).then((snapshot) => this.#serve(snapshot));
    if (this.#release === undefined) {
      const pending = this.#load(source).then((snapshot) => this.#serve(snapshot));
      this.#release = pending;
      // A failed load isn't cached: the next client tries again.
      pending.catch(() => {
        if (this.#release === pending) this.#release = undefined;
      });
    }
    return this.#release;
  }

  /**
   * The draft a pointer names: its changes, fetched from a preview API domain,
   * layered over the release. A pointer that doesn't parse, or any failure, is
   * `LOADER_FAILED`, never a silent fallback to the release. A pointer whose
   * version is `local` names no draft: the release, with nothing fetched. The
   * changes are keyed by the pointer without its `__variant` parameters (every
   * variant of one draft shares one fetch) and reused for a minute.
   */
  draft(pointer: string): Promise<Snapshot> {
    const parsed = parseDraftPointer(pointer);
    if (parsed === null) {
      return Promise.reject(errors.loaderFailed(`invalid draft pointer "${truncate(pointer)}"`));
    }
    if (parsed.version === LOCAL_VERSION) return this.release();
    const { host, path, version } = parsed;
    const key = formatDraftPointer({ host, path, version });
    let entry = this.#drafts.get(key);
    if (entry === undefined || Date.now() - entry.at >= DRAFT_TTL_MS) {
      const fetched: CachedDraft = {
        changes: fetchDraftChanges(parsed).catch((error: unknown) => {
          throw errors.loaderFailed("the draft's changes couldn't be fetched", error);
        }),
        at: Date.now(),
        views: new WeakMap(),
      };
      this.#drafts.set(key, fetched);
      // A failure isn't reused: the next client fetches again.
      fetched.changes.catch(() => {
        if (this.#drafts.get(key) === fetched) this.#drafts.delete(key);
      });
      entry = fetched;
    }
    const { changes, views } = entry;
    return Promise.all([this.release(), changes]).then(([base, draft]) => {
      let view = views.get(base);
      if (view === undefined) {
        view = layerDraft(base, draft, version);
        views.set(base, view);
      }
      return view;
    });
  }

  /**
   * The current release as it is in memory, without loading anything: the
   * content module, what a built-in loader holds, or the release this store
   * last loaded. `undefined` before a custom loader's first load.
   */
  current(): Snapshot | undefined {
    return peekRelease(this.#source) ?? this.#latest;
  }

  /** A release revision this store has served, or the release when it's unknown (drafts included). */
  revision(revision: string): Promise<Snapshot> {
    const served = this.#served.get(revision);
    return served === undefined ? this.release() : Promise.resolve(served);
  }

  /** Asks the source for newer content; never throws, and concurrent calls share one check. */
  update(): Promise<{ updated: boolean }> {
    const source = this.#source;
    if (!isLoader(source) || typeof source.update !== "function") {
      return Promise.resolve({ updated: false });
    }
    this.#updating ??= (async () => {
      try {
        const result = await source.update?.();
        const updated = result?.updated === true;
        if (updated) {
          this.#release = undefined;
          // `#latest` stays: settings keep the release that was serving until
          // the next one loads, never the defaults (which may allow every host).
          // Drafts are fetched again, so a preview follows the release too.
          this.#drafts.clear();
        }
        return { updated };
      } catch {
        return { updated: false };
      } finally {
        this.#updating = undefined;
      }
    })();
    return this.#updating;
  }

  /**
   * Swaps the content in place, for a hot reload that hands the same CMS a new
   * content module. Any new object swaps, even with the same `revision`: an
   * edited JSON file reloads without rerunning `deco content`, so the new
   * module carries new `blocks` under the old revision.
   */
  replace(source: Snapshot | Loader): void {
    const previous = this.#source;
    if (source === previous) {
      // The same loader (a hosted remoteLoader that adopted new fallback content): re-read it.
      this.#release = undefined;
      this.#latest = undefined;
      this.#drafts.clear();
      return;
    }
    if (isSnapshot(previous)) this.#served.delete(previous.revision);
    this.#source = source;
    this.#release = undefined;
    this.#latest = undefined;
    this.#drafts.clear();
  }

  async #load(loader: Loader): Promise<Snapshot> {
    let snapshot: unknown;
    try {
      snapshot = await loader.load();
    } catch (error) {
      if (isResolutionError(error)) throw error;
      throw errors.loaderFailed("the content loader failed", error);
    }
    if (!isSnapshot(snapshot)) {
      throw errors.loaderFailed("the content loader returned something other than a snapshot");
    }
    return snapshot;
  }

  #serve(snapshot: Snapshot): Snapshot {
    this.#latest = snapshot;
    this.#served.set(snapshot.revision, snapshot);
    return snapshot;
  }
}

function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

/**
 * A Map that forgets its least recently used entries past `limit`, counted by
 * `size` (one per entry unless given).
 */
export class BoundedMap<K, V> {
  readonly #map = new Map<K, V>();
  #total = 0;
  constructor(
    readonly limit: number,
    readonly size: (value: V) => number = () => 1,
  ) {}

  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.delete(key);
    this.#map.set(key, value);
    this.#total += this.size(value);
    for (const [oldest, old] of this.#map) {
      if (this.#total <= this.limit || oldest === key) break;
      this.#map.delete(oldest);
      this.#total -= this.size(old);
    }
  }

  delete(key: K): void {
    if (!this.#map.has(key)) return;
    this.#total -= this.size(this.#map.get(key) as V);
    this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
    this.#total = 0;
  }
}
