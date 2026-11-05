/**
 * The content side of a CMS: one source (the content module, a `Loader`, or
 * hosted releases) and what every client shares. Clients are handed a
 * `Selection`: the current index (and the previous one, for hosted releases)
 * that a request pins (see ./pin.ts).
 *
 * A draft is the current index with a draft's files laid over it (see
 * ./draftChanges.ts), read for each draft request and never kept: the
 * draft reads of one request share one read of its files, and nothing read
 * by name from `drafts/` serves a later request.
 */
import { type IndexedContent, localIndex } from "./contentIndex.ts";
import { parseDraftPointer } from "./draft.ts";
import {
  DEFAULT_DRAFT_HOSTS,
  type DraftState,
  fetchDraft,
  LOCAL_VERSION,
  overlayDraft,
} from "./draftChanges.ts";
import { errors, isResolutionError } from "./errors.ts";
import {
  type HostedSource,
  isHostedSource,
  previewHostsOf,
  type ReleasePreviewHosts,
} from "./hostedSource.ts";
import { isPlainObject } from "./json.ts";
import type { Selection } from "./pin.ts";
import type { DraftPointer, Loader, Snapshot } from "./types.ts";

export { BoundedMap } from "./boundedMap.ts";
export { previewHostsOf, type ReleasePreviewHosts } from "./hostedSource.ts";

export function isLoader(content: unknown): content is Loader {
  return (
    (typeof content === "object" || typeof content === "function") &&
    content !== null &&
    typeof (content as Loader).load === "function"
  );
}

/**
 * An internal hook a built-in local loader has: the snapshot it would return
 * right now, from memory, or `undefined` when that takes a load.
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
    (content.aliases === undefined || isPlainObject(content.aliases)) &&
    (content.previewHosts === undefined || Array.isArray(content.previewHosts))
  );
}

export class ContentStore {
  #source: Snapshot | Loader;
  #release: Promise<IndexedContent> | undefined;
  #updating: Promise<{ updated: boolean }> | undefined;
  /** The check a draft read waits on when one was already running when it arrived (see `checkRelease`). */
  #queued: Promise<string> | undefined;
  /**
   * Release checks a request can share (`checkRelease`): how many ended (a
   * check's id is handed out only once it ended), and this store's prefix
   * for their ids, so an id from another process (or another CMS) is never
   * taken for one of these. The prefix is made on the first check, never at
   * module scope.
   */
  #checksDone = 0;
  #checkPrefix: string | undefined;
  /** Draft reads shared under one release check, by the check's number, then the pointer (`#draftFiles`). */
  readonly #draftReads = new Map<number, Map<string, Promise<Map<string, DraftState>>>>();
  readonly #draftHosts: readonly string[];
  /** The snapshot this store last loaded, for a loader that can't peek. */
  #latest: Snapshot | undefined;

  constructor(source: Snapshot | Loader, draftHosts: readonly string[] = DEFAULT_DRAFT_HOSTS) {
    this.#source = source;
    this.#draftHosts = draftHosts;
  }

  /** Whether the source can change while the process runs (hosted, or a loader with `update()`). */
  get updatable(): boolean {
    const source = this.#source;
    if (isHostedSource(source)) return true;
    return isLoader(source) && typeof source.update === "function";
  }

  /**
   * The current release, as an index. Hosted: the index held (the first use
   * loads it), with the previous one. A snapshot is the release; a loader
   * with `update()` is loaded once (concurrent calls share the one load in
   * flight; a failed load isn't kept) and reloaded after an update; a loader
   * without `update()` is asked on every call, since it's always current by
   * construction.
   */
  release(): Promise<Selection> {
    const source = this.#source;
    if (isHostedSource(source)) {
      return source.current().then(
        (current): Selection => {
          const previous = source.previous();
          return previous === undefined ? { current } : { current, previous };
        },
        (error: unknown) => {
          throw isResolutionError(error)
            ? error
            : errors.loaderFailed("the content loader failed", error);
        },
      );
    }
    if (!isLoader(source)) return Promise.resolve({ current: this.#serve(source) });
    if (!this.updatable) {
      return this.#load(source).then((snapshot) => ({ current: this.#serve(snapshot) }));
    }
    if (this.#release === undefined) {
      const pending = this.#load(source).then((snapshot) => this.#serve(snapshot));
      this.#release = pending;
      // A failed load isn't cached: the next client tries again.
      pending.catch(() => {
        if (this.#release === pending) this.#release = undefined;
      });
    }
    return this.#release.then((current) => ({ current }));
  }

  /**
   * The draft a pointer names: its files, read from a draft host, laid over
   * the current index. A pointer that doesn't parse, or any failure, is
   * `LOADER_FAILED`, never a silent fallback to the release. A pointer whose
   * version is `local` names no draft: the release, with nothing fetched.
   * Every draft request reads the draft again (nothing from `drafts/` is kept
   * for a later request; the reads of one request, under its `releaseCheck`,
   * share one), and never the previous index.
   *
   * Before overlaying, a draft read checks the source for a newer release and
   * waits for that check (see `checkRelease`), so a draft always shows over
   * the latest release, even in a process that hasn't picked it up yet. The
   * check runs beside the draft's own reads. With `releaseCheck` (the id
   * `checkRelease` resolved with, for this request), it waits for that check
   * instead of making its own; an id this store didn't make is a check of its
   * own.
   */
  draft(pointer: string, releaseCheck?: string | null): Promise<Selection> {
    const parsed = parseDraftPointer(pointer);
    if (parsed === null) {
      return Promise.reject(errors.loaderFailed(`invalid draft pointer "${truncate(pointer)}"`));
    }
    const { variants } = parsed;
    const withVariants = (selection: Selection): Selection =>
      variants === undefined ? selection : { ...selection, variants };
    if (parsed.version === LOCAL_VERSION) {
      return this.release().then(({ current }) => withVariants({ current }));
    }
    const files = this.#draftFiles(parsed, releaseCheck);
    const release = this.waitForCheck(releaseCheck).then(() => this.release());
    return Promise.all([release, files]).then(([base, states]) =>
      withVariants({ current: overlayDraft(base.current, states, parsed.version) }),
    );
  }

  /**
   * A published release by its revision id: from the source's hosted
   * releases (`remoteLoader`, which `createCMS` builds with `site`), or the
   * content in memory when it is that revision. Anything else is
   * `LOADER_FAILED`, never a silent fallback to the current release.
   */
  revision(id: string): Promise<Selection> {
    const source = this.#source;
    if (isHostedSource(source)) {
      return source.revision(id).then(
        (current): Selection => ({ current }),
        (error: unknown) => {
          if (isResolutionError(error)) throw error;
          throw errors.loaderFailed(`the release ${id} couldn't be read`, error);
        },
      );
    }
    return this.release().then((selection) => {
      if (selection.current.revision === id) return { current: selection.current };
      throw errors.loaderFailed(
        `the release ${id} isn't available: published releases are read from hosted releases (createCMS with site)`,
      );
    });
  }

  /**
   * The current release's index as it is in memory, without loading
   * anything: the content module, what a built-in loader holds, or the
   * release this store last loaded. `undefined` before the first load.
   */
  current(): IndexedContent | undefined {
    const source = this.#source;
    if (isHostedSource(source)) return source.peek();
    const snapshot = peekRelease(source) ?? this.#latest;
    return snapshot === undefined ? undefined : localIndex(snapshot);
  }

  /**
   * The current release's preview hosts (see `ReleasePreviewHosts`): what the
   * hosted release metadata says (read once if it hasn't been yet; a failed
   * read is `"unknown"`), else, for a source with no release metadata (no
   * remote site), the snapshot in memory's own `previewHosts`, or `"local"`
   * without one. `peek` reads memory only, never the network.
   */
  async previewHosts(peek = false): Promise<ReleasePreviewHosts> {
    const source = this.#source;
    if (isHostedSource(source)) {
      return source.previewHosts(peek).catch((): ReleasePreviewHosts => "unknown");
    }
    const snapshot = peekRelease(source) ?? this.#latest;
    return previewHostsOf(snapshot?.previewHosts) ?? "local";
  }

  /** Asks the source for newer content; never throws, and concurrent calls share one check. */
  update(): Promise<{ updated: boolean }> {
    const source = this.#source;
    if (!this.updatable) return Promise.resolve({ updated: false });
    this.#updating ??= (async () => {
      try {
        if (isHostedSource(source)) return await (source as HostedSource).poll();
        const result = await (source as Loader).update?.();
        const updated = result?.updated === true;
        // `#latest` stays: settings keep the release that was serving until the next one loads.
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
   * The release check a draft request waits on (PO 2026-10-23: a draft always
   * shows over the latest release), resolving with its id once it ends. With
   * no check running, it starts one. With one running, that one started
   * before this request, so it waits on the next one instead, shared by every
   * request that arrives meanwhile: a burst makes at most two checks, and no
   * request relies on a check that started before it. No time-based throttle:
   * the request right after a publish always checks. One request shares one
   * check: the binding passes the id on to the host check and every draft
   * read (`waitForCheck`), so a preview request reads `latest.json` once.
   * Never rejects (`update()` doesn't), and a check that hangs ends with the
   * loader's fetch timeout, leaving the release held. Release reads never
   * come here: they keep the background check.
   *
   * Given the id of a check this store made (one a proxy in front made for
   * the same request, say; an id is handed out once its check ended), it
   * resolves with that id at once; any other id is ignored and a check is
   * made.
   */
  checkRelease(releaseCheck?: string | null): Promise<string> {
    if (!this.updatable) return Promise.resolve(this.#checkId(0));
    if (typeof releaseCheck === "string" && this.#madeCheck(releaseCheck)) {
      return Promise.resolve(releaseCheck);
    }
    const running = this.#updating;
    if (running === undefined) return this.#startCheck();
    this.#queued ??= running.then(() => {
      this.#queued = undefined;
      return this.#startCheck();
    });
    return this.#queued;
  }

  /**
   * Nothing to wait for when this store made the check `releaseCheck` names
   * (it ended); with no id, or one this store didn't make, makes a check of
   * its own (`checkRelease`). A source that can't change never waits.
   */
  waitForCheck(releaseCheck: string | null | undefined): Promise<void> {
    if (!this.updatable) return Promise.resolve();
    return this.checkRelease(releaseCheck).then(() => undefined);
  }

  #startCheck(): Promise<string> {
    return this.update().then(() => {
      const n = ++this.#checksDone;
      // Reads under checks older than the one before this are dropped: their requests are over or nearly.
      for (const check of this.#draftReads.keys()) {
        if (check < n - 1) this.#draftReads.delete(check);
      }
      return this.#checkId(n);
    });
  }

  /**
   * A draft's files (its index, then every file it lists). Reads under one
   * release check share one read: the check's id is handed to every draft
   * read of the request that made it (the host check, the redirects, the
   * assignments and the page), so a preview request reads the draft folder
   * once and every part of it sees the same save. A read under a check starts
   * only after the check ended, so it is never older than any request that
   * shares it. A failed read isn't shared, and reads under old checks are
   * dropped once newer checks end (`#startCheck`): nothing from `drafts/`
   * serves a later request. Without a check id this store made (or for a
   * source that can't change, whose checks are all one), every read is its
   * own.
   */
  #draftFiles(
    pointer: DraftPointer,
    releaseCheck: string | null | undefined,
  ): Promise<Map<string, DraftState>> {
    const read = () =>
      fetchDraft(pointer, { domains: this.#draftHosts }).catch((error: unknown) => {
        throw errors.loaderFailed("the draft's changes couldn't be fetched", error);
      });
    const check = this.updatable ? this.#checkNumber(releaseCheck) : undefined;
    if (check === undefined) return read();
    const key = `${pointer.host}${pointer.path}@${pointer.version}`;
    let reads = this.#draftReads.get(check);
    if (reads === undefined) {
      reads = new Map();
      this.#draftReads.set(check, reads);
    }
    const shared = reads.get(key);
    if (shared !== undefined) return shared;
    const pending = read();
    reads.set(key, pending);
    pending.catch(() => {
      if (this.#draftReads.get(check)?.get(key) === pending)
        this.#draftReads.get(check)?.delete(key);
    });
    return pending;
  }

  #checkId(n: number): string {
    this.#checkPrefix ??= `${globalThis.crypto.randomUUID()}:`;
    return `${this.#checkPrefix}${n}`;
  }

  /** Whether `id` names a check this store made (and so one that ended). */
  #madeCheck(id: string): boolean {
    return this.#checkNumber(id) !== undefined;
  }

  /** The number of the check `id` names, when this store made it; otherwise `undefined`. */
  #checkNumber(id: string | null | undefined): number | undefined {
    const prefix = this.#checkPrefix;
    if (typeof id !== "string" || prefix === undefined || !id.startsWith(prefix)) return undefined;
    const digits = id.slice(prefix.length);
    if (!/^\d{1,15}$/.test(digits)) return undefined;
    const n = Number(digits);
    return n <= this.#checksDone ? n : undefined;
  }

  /**
   * Swaps the content in place, for a hot reload that hands the same CMS a new
   * content module. Any new object swaps, even with the same `revision`: an
   * edited JSON file can carry new `blocks` under the old revision.
   */
  replace(source: Snapshot | Loader): void {
    this.#source = source;
    this.#draftReads.clear();
    this.#release = undefined;
    this.#latest = undefined;
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

  #serve(snapshot: Snapshot): IndexedContent {
    this.#latest = snapshot;
    return localIndex(snapshot);
  }
}

function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}
