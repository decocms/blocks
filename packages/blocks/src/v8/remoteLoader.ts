/**
 * `remoteLoader`: hosted releases from `delivery.decocms.com`, read at
 * runtime only (see /next/hosted-releases-internals). Content is never
 * bundled: with `site`, the release comes from the CDN or not at all. Sites
 * talk only to the CDN, with plain HTTP (ETag, `If-None-Match`, 304).
 *
 * - **The index.** `sites/<site>/latest.json` is the current revision's
 *   index (`{ revision, sequence, previewHosts, blocks: { <name>: { version,
 *   meta?, data? } } }`). The first use loads it (calls made meanwhile share
 *   the load; a failed load isn't kept and rejects with a
 *   `ContentUnavailableError`, a 404 included: never an empty site). A poll
 *   (the CMS starts one in the background every interval, and a draft
 *   request's release check is one) sends `If-None-Match` on the held ETag, so
 *   an unchanged index is a 304: nothing is downloaded or parsed. A read is
 *   adopted only when its `sequence` is higher than the held one, so a
 *   slightly stale CDN answer never moves the isolate backwards; the index
 *   that was current is kept as the previous one (one only). A failed poll
 *   keeps the held index.
 * - **Blocks.** `sites/<site>/blocks/<hash>.json`, immutable, fetched with
 *   plain `fetch()` (it reads through the CDN cache) when a request needs one,
 *   into an LRU per isolate keyed by hash and bounded by bytes (32 MiB of
 *   JSON text). Concurrent requests share one fetch per hash; a failed fetch
 *   (a 404 included) isn't kept.
 * - **Revisions by id** (`cms.client({ version: <id> })`): the
 *   `revisions/<id>/index.json` of that revision, read on first use and kept,
 *   three at a time, since a revision never changes. Bodies by hash as usual.
 * - Each fetch has 10 s (headers and body), sends no credential, and refuses
 *   a body over 16 MiB while it downloads. Unknown keys are ignored.
 * - `previewHosts`: as before, from the last `latest.json` read whose index
 *   was adopted (a 304, or a stale answer with a lower or equal `sequence`,
 *   keeps the list it had). A site with no `latest.json` yet (a 404), or one without
 *   `previewHosts`, previews on every host; until a read succeeds, previews
 *   stay closed, and a later failure keeps the last answer.
 * - Without `site` it's a plain loader over the content it's given.
 *
 * Instances are process-wide singletons, like `createCMS`'s.
 */

import { keepAlive } from "./background.ts";
import type { BlockIndex, BlockMeta, IndexEntry } from "./blockMeta.ts";
import { BlockStore, type FetchedBody } from "./blockStore.ts";
import { readBoundedJson, readBoundedJsonSized, timeoutSignal } from "./boundedJson.ts";
import { BoundedMap } from "./boundedMap.ts";
import { PEEK_RELEASE, peekRelease } from "./content.ts";
import type { IndexedContent } from "./contentIndex.ts";
import { ContentUnavailableError, errors } from "./errors.ts";
import {
  HOSTED,
  type HostedSource,
  previewHostsOf,
  type ReleasePreviewHosts,
} from "./hostedSource.ts";
import { clearGlobals, contentIdentity } from "./identity.ts";
import { isPlainObject } from "./json.ts";
import { isRevisionId } from "./revisionId.ts";
import type { Loader, Snapshot } from "./types.ts";

/** The hosted delivery origin. */
const HOSTED_DELIVERY_ORIGIN = "https://delivery.decocms.com";
/**
 * test-only: replaces the delivery origin (it may carry a path prefix) in
 * local end-to-end runs. Not documented, not exported.
 */
const TEST_DELIVERY_ORIGIN = Symbol.for("decocms.blocks.test.deliveryOrigin");

const INSTANCE_PREFIX = "decocms.blocks.remote:";
const FETCH_TIMEOUT_MS = 10_000;
/** The largest index (`latest.json`, a revision's `index.json`) accepted, in bytes of JSON. */
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
/** The largest block body accepted, in bytes of JSON. */
const MAX_BLOCK_BYTES = 16 * 1024 * 1024;
/** Revision indexes kept in memory once read (a client asked for one by its id). */
const CACHED_REVISIONS = 3;
/** How long a failed read of the preview hosts waits before a preview request tries again. */
const PREVIEW_HOSTS_RETRY_MS = 10_000;
/** How old the preview hosts may get before a preview request reads them again (without `interval`). */
const PREVIEW_HOSTS_MAX_AGE_MS = 60_000;
/** A block hash: `blockVersion`, base64url of 16 bytes. */
const HASH_RE = /^[A-Za-z0-9_-]{22}$/;
/** The one entry whose body an index carries inline. */
const INLINE_BLOCK = "CMS";

interface RemoteLoaderOptions {
  site?: string;
  /** ms between release checks, used when `createCMS` has no `interval` of its own. */
  interval?: number;
}

/** A parsed `latest.json` and its ETag. */
interface LatestRead {
  content: IndexedContent;
  etag: string | null;
  previewHosts: string[] | undefined;
}

class RemoteLoader implements Loader, HostedSource {
  readonly [HOSTED] = true as const;
  readonly #site: string;
  readonly interval: number | undefined;
  readonly blocks: BlockStore;
  /** The index this process holds; `undefined` until the first load succeeds. */
  #current: { content: IndexedContent; etag: string | null } | undefined;
  #previous: IndexedContent | undefined;
  /** A read of `latest.json` in flight: the first load, a poll or a preview-hosts read. */
  #reading: Promise<boolean> | undefined;
  readonly #revisions = new BoundedMap<string, Promise<IndexedContent>>(CACHED_REVISIONS);
  /**
   * The preview hosts of the held release, from the last read of
   * `latest.json` that was adopted (its list, or `"every"`: a 404, or no
   * `previewHosts` in it), and when it was last confirmed. A failed read, or
   * a stale one, leaves the list as it was.
   */
  #hosts: { list: readonly string[] | "every"; at: number } | undefined;
  #hostsRead: Promise<void> | undefined;
  #hostsFailedAt = Number.NEGATIVE_INFINITY;

  constructor(options: { site: string; interval?: number }) {
    this.#site = options.site;
    this.interval = options.interval;
    this.blocks = new BlockStore((hash, name) => this.#fetchBlock(hash, name));
  }

  /** Hosted content is read lazily, by index and hash; there is no whole snapshot to load. */
  load(): Promise<Snapshot> {
    return Promise.reject(
      errors.loaderFailed(
        "hosted releases are read through createCMS (an index plus blocks by hash), not as one snapshot",
      ),
    );
  }

  peek(): IndexedContent | undefined {
    return this.#current?.content;
  }

  previous(): IndexedContent | undefined {
    return this.#previous;
  }

  async current(): Promise<IndexedContent> {
    const held = this.#current;
    if (held !== undefined) return held.content;
    await this.#read();
    const loaded = this.#current as { content: IndexedContent } | undefined;
    if (loaded === undefined) {
      throw new ContentUnavailableError("format", "latest.json: no index was read");
    }
    return loaded.content;
  }

  async poll(): Promise<{ updated: boolean }> {
    if (this.#current === undefined) {
      await this.current();
      return { updated: false };
    }
    return { updated: await this.#read() };
  }

  async revision(id: string): Promise<IndexedContent> {
    if (!isRevisionId(id)) throw errors.loaderFailed(`"${id}" is not a release's revision id`);
    for (const content of [this.#current?.content, this.#previous]) {
      if (content?.revision === id) return content;
    }
    const held = this.#revisions.get(id);
    if (held !== undefined) return held;
    const label = `revision ${id}`;
    const pending = request(
      `${deliveryOrigin()}/sites/${this.#sitePath()}/revisions/${id}/index.json`,
      label,
    ).then(async (response) => {
      const body = await readBody(response, label, MAX_INDEX_BYTES);
      const content = this.#parseIndex(body, label);
      if (content.revision !== id) {
        throw new ContentUnavailableError("format", `${label}: names another revision`);
      }
      return content;
    });
    this.#revisions.set(id, pending);
    // Shared with later clients: kept alive past the request that started it.
    keepAlive(pending);
    // A failed read isn't kept, so the next client tries again.
    pending.catch(() => {
      if (this.#revisions.get(id) === pending) this.#revisions.delete(id);
    });
    return pending;
  }

  /**
   * The current release's preview hosts: the last successful read of
   * `latest.json`, reading it first when there is none yet or it is older than
   * the interval (`peek`: never). `"every"` when the site has no `latest.json`
   * (a 404) or it names no `previewHosts`; `"unknown"` while no read has
   * succeeded (a failed one is retried after a pause).
   */
  async previewHosts(peek = false): Promise<ReleasePreviewHosts> {
    const known = this.#hosts;
    const maxAge = this.interval ?? PREVIEW_HOSTS_MAX_AGE_MS;
    const stale = known === undefined || Date.now() - known.at >= maxAge;
    if (!peek && stale && Date.now() - this.#hostsFailedAt >= PREVIEW_HOSTS_RETRY_MS) {
      this.#hostsRead ??= this.#read()
        .then(
          () => undefined,
          () => {
            // A 404 is an answer (`#readLatest` recorded it), not a failure.
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

  /** One read of `latest.json` at a time (shared); resolves with whether it adopted a new index. */
  #read(): Promise<boolean> {
    if (this.#reading === undefined) {
      const pending = this.#readAndAdopt();
      this.#reading = pending;
      const settle = () => {
        if (this.#reading === pending) this.#reading = undefined;
      };
      pending.then(settle, settle);
      // Shared with later requests: kept alive past the request that started it.
      keepAlive(pending);
    }
    return this.#reading;
  }

  async #readAndAdopt(): Promise<boolean> {
    const held = this.#current;
    const read = await this.#readLatest(held?.etag ?? null);
    if (read === null) return false;
    const current = this.#current;
    const at = Date.now();
    // The newest index wins, by sequence: a stale CDN answer never moves the
    // isolate back, its preview hosts included (the held list counts as read now).
    if (current !== undefined && read.content.sequence <= current.content.sequence) {
      this.#hosts =
        this.#hosts === undefined
          ? { list: read.previewHosts ?? "every", at }
          : { list: this.#hosts.list, at };
      return false;
    }
    // The adopted release's metadata. No `previewHosts` (none written): every host, as with no latest.json.
    this.#hosts = { list: read.previewHosts ?? "every", at };
    if (current !== undefined) this.#previous = current.content;
    this.#current = { content: read.content, etag: read.etag };
    return current !== undefined;
  }

  /** `latest.json`, revalidating `etag`: `null` for a 304. */
  async #readLatest(etag: string | null): Promise<LatestRead | null> {
    const label = "latest.json";
    const response = await request(
      `${deliveryOrigin()}/sites/${this.#sitePath()}/latest.json`,
      label,
      etag,
      (status) => {
        // Not published yet: no list, so previews are allowed on every host (PO 2026-10-22).
        // A site this process has read a list for can't be unpublished: a 404 then
        // (a CDN fault, a publish caught mid-write) is a failed read, so it keeps the list.
        if (status === 404 && !Array.isArray(this.#hosts?.list)) {
          this.#hosts = { list: "every", at: Date.now() };
        }
      },
    );
    if (response.status === 304) {
      if (this.#hosts !== undefined) this.#hosts = { list: this.#hosts.list, at: Date.now() };
      return null;
    }
    const body = await readBody(response, label, MAX_INDEX_BYTES);
    const content = this.#parseIndex(body, label);
    const previewHosts = previewHostsOf((body as Record<string, unknown>).previewHosts);
    // Its preview hosts are taken only with its index (`#readAndAdopt`).
    return { content, etag: response.headers.get("etag"), previewHosts };
  }

  /** An index body (`latest.json` or a revision's `index.json`), checked. */
  #parseIndex(body: unknown, label: string): IndexedContent {
    const format = (why: string) => new ContentUnavailableError("format", `${label}: ${why}`);
    if (!isPlainObject(body) || !isRevisionId(body.revision)) throw format("unexpected format");
    const sequence = body.sequence;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
      throw format("sequence must be a positive integer");
    }
    if (!isPlainObject(body.blocks)) throw format("blocks must be an object");
    const blocks = Object.create(null) as BlockIndex;
    for (const [name, raw] of Object.entries(body.blocks)) {
      if (!isPlainObject(raw) || typeof raw.version !== "string" || !HASH_RE.test(raw.version)) {
        throw format(`the entry "${name}" has no version`);
      }
      const entry: IndexEntry = { version: raw.version };
      const meta = metaOf(raw.meta);
      if (meta !== undefined) entry.meta = meta;
      if (name === INLINE_BLOCK && raw.data !== undefined) entry.data = raw.data;
      blocks[name] = entry;
    }
    return { revision: body.revision, sequence, blocks, source: this.blocks };
  }

  /** `blocks/<hash>.json`. */
  async #fetchBlock(hash: string, name: string): Promise<FetchedBody> {
    const label = `block "${name}" (${hash})`;
    if (!HASH_RE.test(hash)) throw new ContentUnavailableError("format", `${label}: not a hash`);
    const response = await request(
      `${deliveryOrigin()}/sites/${this.#sitePath()}/blocks/${hash}.json`,
      label,
    );
    try {
      const { value, bytes } = await readBoundedJsonSized(response, label, MAX_BLOCK_BYTES);
      return { body: value, bytes };
    } catch (error) {
      throw unavailable(label, error, "format");
    }
  }

  #sitePath(): string {
    return encodeURIComponent(this.#site);
  }
}

/**
 * An entry's `meta`, kept to the keys the SDK reads (`rules` is for Studio and
 * isn't held); `undefined` when none.
 */
function metaOf(raw: unknown): BlockMeta | undefined {
  if (!isPlainObject(raw)) return undefined;
  const meta: BlockMeta = {};
  if (typeof raw.type === "string") meta.type = raw.type;
  if (typeof raw.path === "string") meta.path = raw.path;
  if (Array.isArray(raw.refs)) {
    const refs = raw.refs.filter((ref): ref is string => typeof ref === "string");
    if (refs.length > 0) meta.refs = refs;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
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
    return typeof (content as Loader).load === "function"
      ? (content as Loader).load()
      : Promise.resolve(content as Snapshot);
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
    if (hosted && (existing as Partial<HostedSource>)[HOSTED] === true) {
      if ((existing as RemoteLoader).interval !== options.interval) {
        console.warn(
          "[decocms/blocks] remoteLoader was called again for the same site with different options " +
            "(interval); keeping the first instance's options.",
        );
      }
      return existing;
    }
    if (!hosted && typeof (existing as LocalLoader).adopt === "function") {
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
 * GETs `url` (no credentials, 10 s for headers; `If-None-Match: etag` when
 * given). Resolves with a 2xx, or with a 304 to a request that sent an ETag.
 * Every other outcome is a `ContentUnavailableError`: the timeout, the
 * network, any other HTTP status (`onStatus` sees it first).
 */
async function request(
  url: string,
  label: string,
  etag?: string | null,
  onStatus?: (status: number) => void,
): Promise<Response> {
  let response: Response;
  const headers: Record<string, string> = {};
  if (etag) headers["if-none-match"] = etag;
  try {
    response = await fetch(url, { headers, signal: timeoutSignal(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw unavailable(label, error, "network");
  }
  if (response.status === 304 && etag) {
    void response.body?.cancel().catch(() => {});
    return response;
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    onStatus?.(response.status);
    throw new ContentUnavailableError("http", `${label}: HTTP ${response.status}`, {
      status: response.status,
    });
  }
  return response;
}

async function readBody(response: Response, label: string, maxBytes: number): Promise<unknown> {
  try {
    return await readBoundedJson(response, label, maxBytes);
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
