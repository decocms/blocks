/**
 * `remoteLoader`: hosted releases from `delivery.decocms.com`, read at
 * runtime only (see /next/hosted-releases-internals). Content is never
 * bundled: with `site`, the release comes from the CDN or not at all. Drafts
 * aren't a loader's job: the CMS layers a draft's changes over what `load()`
 * returns (see ./draftChanges.ts).
 *
 * - `load()` returns the release this process holds. The first call (and
 *   every call until one succeeds) loads it: `sites/<site>/latest.json`,
 *   `{ revision, previewHosts }`, then the revision it names,
 *   `sites/<site>/revisions/<revision>/data.json`, `{ blocks }`. Calls made
 *   while that load is in flight share it, so a burst of requests to a cold
 *   isolate makes one fetch of each. A load that fails isn't kept: it
 *   rejects with a `ContentUnavailableError` (`reason`: `"timeout"`,
 *   `"network"`, `"http"` or `"format"`), which the CMS hands the client as
 *   the cause of its `LOADER_FAILED` error, and the next call tries again.
 *   A site that has published nothing yet (no `latest.json`, a 404) is that
 *   error too, never an empty release. What to render then is the site's
 *   choice. Nothing persists across restarts.
 * - `update()` (the CMS calls it in the background, on first use and then
 *   every interval, and once per draft request, which waits for it, so a
 *   draft always shows over the latest release: `cms.checkRelease()`) reads
 *   `latest.json` again and, when it names a revision other than the one
 *   this process holds, downloads that revision, parses it and swaps it in
 *   whole. The old release keeps serving until then; on any error, memory
 *   stays as it is. Whatever `latest.json` names is followed, older revisions
 *   included (a rollback is a new revision anyway): no schema, date or
 *   content check, and the revision's body isn't compared with its id.
 *   Before the first load it is that load (shared); it reports no update
 *   (nothing was swapped, and caches over no release have nothing to drop).
 * - Each fetch has 10 s (headers and body), sends no credential (delivery
 *   is public), and a revision larger than `MAX_SNAPSHOT_BYTES` is refused
 *   while it downloads, before it's buffered whole (a Worker isolate has
 *   128 MB). Unknown keys in `latest.json` and `data.json` are ignored.
 * - `previewHosts` (host patterns) is where the site may be previewed:
 *   Studio knows the site's addresses and writes them into `latest.json`
 *   whenever it writes it (delivery is trusted). Previews are checked
 *   against the last `latest.json` read, whether or not its revision was
 *   swapped in yet. With no list to check (PO 2026-10-22), previews are
 *   allowed on every host: a site with no `latest.json` yet (a 404), or one
 *   whose `latest.json` has no `previewHosts`. A read that fails (a network
 *   error, a 5xx, a malformed `latest.json`) isn't "no list": until a read
 *   succeeds, previews stay closed, and a later failure keeps the last
 *   answer (a 404 once a list was read is a failure too: a published site
 *   stays published). A preview request before this process has read
 *   `latest.json` reads it then (only `latest.json`, once, shared); a read
 *   older than the interval is read again the same way.
 * - A client can ask for a published release by its revision id
 *   (`cms.client({ version })`): it's read from
 *   `sites/<site>/revisions/<id>/data.json` on first use and kept in memory,
 *   a few at a time (the least recently used dropped first), since a
 *   revision never changes.
 * - Without `site` it's a plain loader over the content it's given.
 *
 * Instances are process-wide singletons, like `createCMS`'s.
 */
import { readBoundedJson, timeoutSignal } from "./boundedJson.ts";
import {
  BoundedMap,
  isSnapshot,
  PEEK_RELEASE,
  PREVIEW_HOSTS,
  peekRelease,
  previewHostsOf,
  READ_REVISION,
  type ReleasePreviewHosts,
} from "./content.ts";
import { ContentUnavailableError, errors } from "./errors.ts";
import { clearGlobals, contentIdentity } from "./identity.ts";
import { isPlainObject } from "./json.ts";
import { isRevisionId } from "./revisionId.ts";
import type { Loader, Snapshot } from "./types.ts";

/** The hosted delivery origin: release pointers and revisions. */
const HOSTED_DELIVERY_ORIGIN = "https://delivery.decocms.com";
/**
 * test-only: replaces the delivery origin (it may carry a path prefix) in
 * local end-to-end runs. Not documented, not exported.
 */
const TEST_DELIVERY_ORIGIN = Symbol.for("decocms.blocks.test.deliveryOrigin");

const INSTANCE_PREFIX = "decocms.blocks.remote:";
const FETCH_TIMEOUT_MS = 10_000;
/** The largest release accepted, in bytes of JSON. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
/** Published releases kept in memory once read (a client asked for one by its id). */
const CACHED_REVISIONS = 3;
/** How long a failed read of the preview hosts waits before a preview request tries again. */
const PREVIEW_HOSTS_RETRY_MS = 10_000;
/** How old the preview hosts may get before a preview request reads them again (without `interval`). */
const PREVIEW_HOSTS_MAX_AGE_MS = 60_000;

interface RemoteLoaderOptions {
  site?: string;
  /** ms between release checks, used when `createCMS` has no `interval` of its own. */
  interval?: number;
}

/** `sites/<site>/latest.json`: the release a site serves. */
interface Latest {
  revision: string;
  /** Where the site may be previewed; `undefined` when Studio wrote none. */
  previewHosts: string[] | undefined;
}

class RemoteLoader implements Loader {
  readonly #site: string;
  /** The `interval` this loader was created with; `createCMS` reads it. */
  readonly interval: number | undefined;
  /** The release this process holds; `undefined` until the first load succeeds. */
  #current: Snapshot | undefined;
  /** The first load, in flight: every caller until it settles shares it. */
  #cold: Promise<Snapshot> | undefined;
  /** Published releases read by id; immutable, so a hit is never revalidated. */
  readonly #revisions = new BoundedMap<string, Promise<Snapshot>>(CACHED_REVISIONS);
  /**
   * The preview hosts the last read of `latest.json` found (its list, or
   * `"every"`: a 404, or no `previewHosts` in it), and when. A failed read
   * leaves it as it was.
   */
  #hosts: { list: readonly string[] | "every"; at: number } | undefined;
  /** A read of `latest.json` for its preview hosts, in flight. */
  #hostsRead: Promise<void> | undefined;
  /** When that read last failed. */
  #hostsFailedAt = Number.NEGATIVE_INFINITY;

  constructor(options: { site: string; interval?: number }) {
    this.#site = options.site;
    this.interval = options.interval;
  }

  /** What `load()` would return now, from memory only (see `peekRelease`). */
  [PEEK_RELEASE](): Snapshot | undefined {
    return this.#current;
  }

  load(): Promise<Snapshot> {
    if (this.#current !== undefined) return Promise.resolve(this.#current);
    if (this.#cold === undefined) {
      const pending = this.#fetchLatestRelease().then((snapshot) => {
        this.#current = snapshot;
        return snapshot;
      });
      this.#cold = pending;
      const settle = () => {
        if (this.#cold === pending) this.#cold = undefined;
      };
      // A failed load isn't kept: the next call tries again.
      pending.then(settle, settle);
    }
    return this.#cold;
  }

  async update(): Promise<{ updated: boolean }> {
    const held = this.#current;
    // Nothing held yet: the check is the first load (shared with any in flight).
    if (held === undefined) {
      await this.load();
      return { updated: false };
    }
    const latest = await this.#latest();
    if (latest.revision === held.revision) return { updated: false };
    const blocks = await this.#fetchBlocks(latest.revision);
    this.#current = { revision: latest.revision, blocks };
    return { updated: true };
  }

  /**
   * The current release's preview hosts (see `PREVIEW_HOSTS`): the last
   * successful read of `latest.json`, reading it first when there is none yet
   * or it is older than the interval (`peek`: never). `"every"` when
   * the site has no `latest.json` (a 404) or it names no `previewHosts`;
   * `"unknown"` while no read has succeeded (a failed one is retried after a
   * pause), so previews stay closed rather than open on an error.
   */
  async [PREVIEW_HOSTS](peek = false): Promise<ReleasePreviewHosts> {
    const known = this.#hosts;
    const maxAge = this.interval ?? PREVIEW_HOSTS_MAX_AGE_MS;
    const stale = known === undefined || Date.now() - known.at >= maxAge;
    if (!peek && stale && Date.now() - this.#hostsFailedAt >= PREVIEW_HOSTS_RETRY_MS) {
      this.#hostsRead ??= this.#latest()
        .then(
          () => undefined,
          () => {
            // A 404 is an answer (`#latest` recorded it), not a failure.
            if (this.#hosts === known) this.#hostsFailedAt = Date.now();
          },
        )
        .finally(() => {
          this.#hostsRead = undefined;
        });
      await this.#hostsRead;
    }
    const list = this.#hosts?.list;
    if (list === undefined) return "unknown";
    return list === "every" ? list : list.slice();
  }

  /** A published release by its revision id (see `READ_REVISION`). */
  async [READ_REVISION](id: string): Promise<Snapshot> {
    if (!isRevisionId(id)) throw errors.loaderFailed(`"${id}" is not a release's revision id`);
    if (this.#current?.revision === id) return this.#current;
    return this.#readRevision(id);
  }

  /** Reads a revision once; a failed read isn't kept, so the next client tries again. */
  #readRevision(id: string): Promise<Snapshot> {
    const held = this.#revisions.get(id);
    if (held !== undefined) return held;
    const pending = this.#fetchBlocks(id).then((blocks): Snapshot => ({ revision: id, blocks }));
    this.#revisions.set(id, pending);
    pending.catch(() => {
      if (this.#revisions.get(id) === pending) this.#revisions.delete(id);
    });
    return pending;
  }

  /** `latest.json`, then the revision it names. */
  async #fetchLatestRelease(): Promise<Snapshot> {
    const latest = await this.#latest();
    return { revision: latest.revision, blocks: await this.#fetchBlocks(latest.revision) };
  }

  /** `revisions/<id>/data.json`'s `blocks`. */
  async #fetchBlocks(id: string): Promise<Record<string, unknown>> {
    const label = `revision ${id}`;
    const body = await fetchJson(
      `${deliveryOrigin()}/sites/${this.#sitePath()}/revisions/${id}/data.json`,
      label,
      (response) => readBoundedJson(response, label, MAX_SNAPSHOT_BYTES),
    );
    if (!isPlainObject(body) || !isPlainObject(body.blocks)) {
      throw new ContentUnavailableError("format", `${label}: unexpected format`);
    }
    return body.blocks;
  }

  async #latest(): Promise<Latest> {
    const label = "latest.json";
    const body = await fetchJson(
      `${deliveryOrigin()}/sites/${this.#sitePath()}/latest.json`,
      label,
      (response) => response.json(),
      (status) => {
        // Not published yet: no list, so previews are allowed on every host (PO 2026-10-22).
        // A site this process has read a list for can't be unpublished: a 404 then
        // (a CDN fault, a publish caught mid-write) is a failed read, so it keeps the list.
        if (status === 404 && !Array.isArray(this.#hosts?.list)) {
          this.#hosts = { list: "every", at: Date.now() };
        }
      },
    );
    if (!isPlainObject(body) || !isRevisionId(body.revision)) {
      throw new ContentUnavailableError("format", `${label}: unexpected format`);
    }
    const previewHosts = previewHostsOf(body.previewHosts);
    // The current release's metadata, whether or not its revision is swapped in.
    // No `previewHosts` (none written): every host, as with no latest.json.
    this.#hosts = { list: previewHosts ?? "every", at: Date.now() };
    return { revision: body.revision, previewHosts };
  }

  #sitePath(): string {
    return encodeURIComponent(this.#site);
  }
}

/** A loader over the content it's given alone: `remoteLoader` without `site`. */
class LocalLoader implements Loader {
  #content: Snapshot | Loader;

  constructor(content: Snapshot | Loader) {
    this.#content = content;
  }

  adopt(content: Snapshot | Loader): void {
    this.#content = content;
  }

  [PEEK_RELEASE](): Snapshot | undefined {
    return peekRelease(this.#content);
  }

  load(): Promise<Snapshot> {
    const content = this.#content;
    return isSnapshot(content) ? Promise.resolve(content) : content.load();
  }
}

/**
 * Hosted releases: `createCMS` builds it for you when `site` is set. With
 * `site`, content comes only from the CDN, so `content` must be `undefined`
 * (nothing is bundled). Without `site`, it's a loader over
 * `content` alone.
 */
export function remoteLoader(
  content: Snapshot | Loader | undefined,
  options: RemoteLoaderOptions,
): Loader {
  const { site } = options ?? {};
  const hosted = Boolean(site);
  if (hosted && content !== undefined) {
    throw new TypeError(
      "remoteLoader: with site, content comes from the delivery CDN at runtime; pass undefined as content",
    );
  }
  if (!hosted && content === undefined) {
    throw new TypeError("remoteLoader: without site, pass the content to serve");
  }
  const key = Symbol.for(
    hosted
      ? `${INSTANCE_PREFIX}site:${site}`
      : `${INSTANCE_PREFIX}${contentIdentity(content as Snapshot | Loader)}|local`,
  );
  const store = globalThis as unknown as Record<symbol, RemoteLoader | LocalLoader | undefined>;
  const existing = store[key];
  // Duck-typed, so an instance a second copy of this module made is reused too.
  if (existing instanceof Object && typeof existing.load === "function") {
    if (hosted) {
      if ((existing as RemoteLoader).interval !== options.interval) {
        console.warn(
          "[decocms/blocks] remoteLoader was called again for the same site with different options " +
            "(interval); keeping the first instance's options.",
        );
      }
      return existing;
    }
    if (typeof (existing as LocalLoader).adopt === "function") {
      (existing as LocalLoader).adopt(content as Snapshot | Loader);
      return existing;
    }
  }
  const instance = hosted
    ? new RemoteLoader({ site: site as string, interval: options.interval })
    : new LocalLoader(content as Snapshot | Loader);
  store[key] = instance;
  return instance;
}

export function resetRemoteLoaders(): void {
  clearGlobals(INSTANCE_PREFIX);
}

/**
 * GETs `url` (no credentials, 10 s for headers and body) and reads its body
 * with `read`. Every failure is a `ContentUnavailableError`: the timeout,
 * the network, an HTTP status other than 2xx (`onStatus` sees it first), or
 * a body that doesn't parse or is too large.
 */
async function fetchJson(
  url: string,
  label: string,
  read: (response: Response) => Promise<unknown>,
  onStatus?: (status: number) => void,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal: timeoutSignal(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw unavailable(label, error, "network");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    onStatus?.(response.status);
    throw new ContentUnavailableError("http", `${label}: HTTP ${response.status}`, {
      status: response.status,
    });
  }
  try {
    return await read(response);
  } catch (error) {
    throw unavailable(label, error, "format");
  }
}

/** A failed fetch or body read as a `ContentUnavailableError`; a timeout is always `"timeout"`. */
function unavailable(
  label: string,
  error: unknown,
  otherwise: "network" | "format",
): ContentUnavailableError {
  if (error instanceof ContentUnavailableError) return error;
  const name = error instanceof Error ? error.name : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError" || name === "AbortError") {
    return new ContentUnavailableError(
      "timeout",
      `${label}: no answer within ${FETCH_TIMEOUT_MS} ms`,
      { cause: error },
    );
  }
  // A connection that drops mid-body is the network's, not the body's.
  const reason = otherwise === "format" && error instanceof TypeError ? "network" : otherwise;
  return new ContentUnavailableError(reason, `${label}: ${message}`, { cause: error });
}

function deliveryOrigin(): string {
  const override = (globalThis as Record<symbol, unknown>)[TEST_DELIVERY_ORIGIN];
  return typeof override === "string" ? override : HOSTED_DELIVERY_ORIGIN;
}
