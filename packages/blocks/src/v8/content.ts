/**
 * The content side of a CMS: one source (the content module or a `Loader`),
 * the caches every client shares, and the revisions this process has served.
 * Clients only ever see whole `{ revision, blocks }` snapshots.
 */
import { formatDraftPointer, parseDraftPointer } from "./draft";
import { errors, isResolutionError } from "./errors";
import { isPlainObject } from "./json";
import type { Loader, Snapshot } from "./types";

const SERVED_REVISIONS = 16;
const CACHED_DRAFTS = 32;

export function isLoader(content: unknown): content is Loader {
  return (
    (typeof content === "object" || typeof content === "function") &&
    content !== null &&
    typeof (content as Loader).load === "function"
  );
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
  readonly #drafts = new BoundedMap<string, Promise<Snapshot>>(CACHED_DRAFTS);
  readonly #served = new BoundedMap<string, Snapshot>(SERVED_REVISIONS);

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
    if (!this.updatable) return this.#load(source, null);
    if (this.#release === undefined) {
      const pending = this.#load(source, null);
      this.#release = pending;
      // A failed load isn't cached: the next client tries again.
      pending.catch(() => {
        if (this.#release === pending) this.#release = undefined;
      });
    }
    return this.#release;
  }

  /**
   * The draft a pointer names. A snapshot has no drafts and ignores the
   * pointer. A loader gets `load(pointer)` only for a pointer that parses;
   * anything else is `LOADER_FAILED`, never a silent fallback to the release.
   */
  draft(pointer: string): Promise<Snapshot> {
    const source = this.#source;
    if (!isLoader(source)) return this.release();
    const parsed = parseDraftPointer(pointer);
    if (parsed === null) {
      return Promise.reject(errors.loaderFailed(`invalid draft pointer "${truncate(pointer)}"`));
    }
    const key = formatDraftPointer(parsed);
    const cached = this.#drafts.get(key);
    if (cached !== undefined) return cached;
    const pending = this.#load(source, pointer);
    this.#drafts.set(key, pending);
    pending.catch(() => this.#drafts.delete(key));
    return pending;
  }

  /** A revision this store has served, or the release when it's unknown. */
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
        if (updated) this.#release = undefined;
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
   * content module. Same revision, nothing to do.
   */
  replace(source: Snapshot | Loader): void {
    if (source === this.#source) return;
    if (isSnapshot(source) && isSnapshot(this.#source)) {
      if (source.revision === this.#source.revision) return;
    }
    this.#source = source;
    this.#release = undefined;
    this.#drafts.clear();
  }

  async #load(loader: Loader, pointer: string | null): Promise<Snapshot> {
    let snapshot: unknown;
    try {
      snapshot = pointer === null ? await loader.load() : await loader.load(pointer);
    } catch (error) {
      if (isResolutionError(error)) throw error;
      throw errors.loaderFailed(
        pointer === null ? "the content loader failed" : "the draft couldn't load",
        error,
      );
    }
    if (!isSnapshot(snapshot)) {
      throw errors.loaderFailed("the content loader returned something other than a snapshot");
    }
    return this.#serve(snapshot);
  }

  #serve(snapshot: Snapshot): Snapshot {
    this.#served.set(snapshot.revision, snapshot);
    return snapshot;
  }
}

function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

/** A Map that forgets its least recently set entry past `limit`. */
class BoundedMap<K, V> {
  readonly #map = new Map<K, V>();
  constructor(readonly limit: number) {}

  get(key: K): V | undefined {
    return this.#map.get(key);
  }

  set(key: K, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.limit) {
      const oldest = this.#map.keys().next();
      if (!oldest.done) this.#map.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
  }
}
