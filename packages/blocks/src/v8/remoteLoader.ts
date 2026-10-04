/**
 * `remoteLoader`: hosted releases and drafts from the Deco API, over a
 * fallback (the content module, or any loader). See
 * /next/hosted-releases-internals and /next/hosted-publishing.
 *
 * - `load()` never touches the network: it returns the newest release this
 *   process fetched, or the fallback's content until one is fetched.
 * - `update()` asks the delivery API for the small production channel
 *   manifest; the CMS calls it on first use and then every interval, at an
 *   idle moment. A manifest older than the newest observed generation is
 *   ignored; a revision equal to the fallback's is served from the fallback
 *   without a download; anything else is fetched, verified against its
 *   content hash and swapped in whole. Any error keeps memory as it was.
 * - `load(pointer)` loads a draft overlay (see /next/content-delivery#exact-draft-previews)
 *   and waits for it: it captures the production snapshot `load()` would
 *   return right now, fetches the overlay manifest the pointer's version names
 *   and only the changed-block assets not already cached, and layers their
 *   replacements and tombstones over the captured snapshot. It never fetches a
 *   production revision to align. Only pointers into this site's drafts on the
 *   delivery host are fetched; anything else is refused. Any failure rejects:
 *   a draft never falls back to published content.
 * - In development (`NODE_ENV=development`), releases stay on the fallback so
 *   local files win; drafts still load.
 * - A release, or a draft's manifest and changed blocks together, larger than
 *   `MAX_SNAPSHOT_BYTES` is refused while it downloads, before it's buffered
 *   whole (a Worker isolate has 128 MB).
 * - Without `site` or `token` it's a plain loader over the fallback: no
 *   releases, no drafts beyond what the fallback serves.
 *
 * Instances are process-wide singletons, like `createCMS`'s.
 */
import {
  computeBlockHash,
  computeContentRevision,
  computeOverlayVersion,
  DRAFT_OVERLAY_FORMAT,
  type DraftOverlay,
} from "./canonical.ts";
import { isSnapshot } from "./content.ts";
import { parseDraftPointer } from "./draft.ts";
import { clearGlobals, contentIdentity, fnv1a } from "./identity.ts";
import { isPlainObject } from "./json.ts";
import type { Loader, Snapshot } from "./types.ts";

/** The hosted delivery origin: channel manifests, release assets and drafts. */
const HOSTED_DELIVERY_ORIGIN = "https://delivery.decocms.com";

const INSTANCE_PREFIX = "decocms.blocks.remote:";
const MANIFEST_FORMAT = 1;
const FETCH_TIMEOUT_MS = 10_000;
/** The largest release, or draft (manifest plus changed blocks), accepted, in bytes of JSON. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
/** Draft caches, per site: overlay manifests, changed-block bytes, composed views. */
const CACHED_OVERLAYS = 16;
const CACHED_BLOCK_BYTES = 16 * 1024 * 1024;
const CACHED_VIEWS = 3;
/** Changed-block downloads in flight at once, per draft. */
const BLOCK_FETCH_CONCURRENCY = 8;
/** Overlay versions and block hashes: SHA-256, lowercase hex. */
const HASH_RE = /^[0-9a-f]{64}$/;

interface RemoteLoaderOptions {
  site?: string;
  token?: string;
  /** ms between release checks, used when `createCMS` has no `interval` of its own. */
  interval?: number;
}

interface Manifest {
  generation: number;
  revision: string;
  snapshot: string;
}

class RemoteLoader implements Loader {
  readonly #site: string;
  readonly #token: string;
  /** The `interval` this loader was created with; `createCMS` reads it. */
  readonly interval: number | undefined;
  #fallback: Snapshot | Loader;
  #fallbackRevision: string | undefined;
  #current: Snapshot | undefined;
  #generation = -1;
  /** Authorized manifests, by overlay version and grant: a version alone unlocks nothing. */
  readonly #overlays = new Lru<Promise<DraftOverlay>>(CACHED_OVERLAYS);
  /** Verified changed blocks, by block hash, bounded by their bytes. */
  readonly #blocks = new Lru<{ value: unknown; bytes: number }>(CACHED_BLOCK_BYTES, (b) => b.bytes);
  readonly #pendingBlocks = new Map<string, Promise<{ value: unknown; bytes: number }>>();
  /** Composed drafts, by captured production revision and overlay version. */
  readonly #views = new Lru<{ base: Snapshot; view: Snapshot }>(CACHED_VIEWS);

  constructor(
    fallback: Snapshot | Loader,
    options: { site: string; token: string; interval?: number },
  ) {
    this.#fallback = fallback;
    this.#site = options.site;
    this.#token = options.token;
    this.interval = options.interval;
  }

  /** A hot reload hands the same instance new fallback content. */
  adopt(fallback: Snapshot | Loader): void {
    if (fallback === this.#fallback) return;
    this.#fallback = fallback;
    this.#fallbackRevision = undefined;
  }

  load(pointer?: string | null): Promise<Snapshot> {
    if (pointer) return this.#draft(pointer);
    if (this.#current !== undefined) return Promise.resolve(this.#current);
    return this.#loadFallback();
  }

  async update(): Promise<{ updated: boolean }> {
    if (isDevelopment()) return { updated: false };
    const manifest = await this.#manifest();
    if (manifest.generation < this.#generation) return { updated: false };

    // Best effort: a fallback that can't load (a KV key the deploy never wrote) is
    // fixed by downloading the release, not by failing the check.
    const fallbackRevision = await this.#fallbackRevisionNow().catch(() => undefined);
    const served = this.#current !== undefined ? this.#current.revision : fallbackRevision;
    if (served !== undefined && manifest.revision === served) {
      // A new generation of the same content (a re-promotion, a rollback to
      // it) still signals, so caches keyed on the release are invalidated.
      const changed = this.#generation !== -1 && manifest.generation > this.#generation;
      this.#generation = manifest.generation;
      return { updated: changed };
    }
    let next: Snapshot | undefined;
    if (fallbackRevision === undefined || manifest.revision !== fallbackRevision) {
      next = await this.#release(manifest);
    }
    // A slower, earlier check must not undo a newer publish or rollback.
    if (manifest.generation < this.#generation) return { updated: false };
    this.#generation = manifest.generation;
    this.#current = next;
    return { updated: true };
  }

  async #loadFallback(): Promise<Snapshot> {
    const fallback = this.#fallback;
    const snapshot = isSnapshot(fallback) ? fallback : await (fallback as Loader).load();
    if (fallback === this.#fallback) this.#fallbackRevision = snapshot.revision;
    return snapshot;
  }

  async #fallbackRevisionNow(): Promise<string> {
    return this.#fallbackRevision ?? (await this.#loadFallback()).revision;
  }

  async #manifest(): Promise<Manifest> {
    const site = encodeURIComponent(this.#site);
    const response = await fetchWithTimeout(
      `${HOSTED_DELIVERY_ORIGIN}/sites/${site}/channels/production.json`,
      this.#auth(),
    );
    if (!response.ok) throw new Error(`channel manifest: HTTP ${response.status}`);
    const body: unknown = await response.json();
    const prefix = `/sites/${site}/revisions/`;
    if (
      !isPlainObject(body) ||
      body.format !== MANIFEST_FORMAT ||
      !Number.isSafeInteger(body.generation) ||
      typeof body.revision !== "string" ||
      typeof body.snapshot !== "string" ||
      !body.snapshot.startsWith(prefix) ||
      !/^[\w.-]+\.json$/.test(body.snapshot.slice(prefix.length)) ||
      body.snapshot.includes("..")
    ) {
      throw new Error("channel manifest: unexpected format or snapshot path");
    }
    return body as unknown as Manifest;
  }

  async #release(manifest: Manifest): Promise<Snapshot> {
    const response = await fetchWithTimeout(
      `${HOSTED_DELIVERY_ORIGIN}${manifest.snapshot}`,
      this.#auth(),
    );
    if (!response.ok) throw new Error(`release ${manifest.revision}: HTTP ${response.status}`);
    const [snapshot] = await readBoundedJson(response, `release ${manifest.revision}`, {
      remaining: MAX_SNAPSHOT_BYTES,
    });
    if (
      !isSnapshot(snapshot) ||
      snapshot.revision !== manifest.revision ||
      (await computeContentRevision(snapshot.blocks)) !== manifest.revision
    ) {
      throw new Error(`release ${manifest.revision}: content doesn't match its revision`);
    }
    return snapshot;
  }

  async #draft(raw: string): Promise<Snapshot> {
    const pointer = parseDraftPointer(raw);
    if (pointer === null) throw new Error("invalid draft pointer");
    if (pointer.host !== new URL(HOSTED_DELIVERY_ORIGIN).host) {
      throw new Error(`draft pointer names an unexpected host "${pointer.host}"`);
    }
    const site = `/sites/${encodeURIComponent(this.#site)}`;
    const query = pointer.path.indexOf("?");
    const pathname = query === -1 ? pointer.path : pointer.path.slice(0, query);
    if (pathname !== `${site}/drafts`) throw new Error("draft pointer names another site's drafts");
    if (!HASH_RE.test(pointer.version)) throw new Error("draft pointer names no overlay version");
    // The grant (the pointer's query) goes, opaque, on every draft asset read.
    const grant = query === -1 ? "" : pointer.path.slice(query);

    // Capture production once, before any network: this draft is layered over it.
    const base = this.#current ?? (await this.#loadFallback());
    const budget: Budget = { remaining: MAX_SNAPSHOT_BYTES };
    const key = `${pointer.version}${grant}`;
    let overlay = this.#overlays.get(key);
    if (overlay === undefined) {
      overlay = this.#overlay(
        `${site}/drafts/${pointer.version}.json${grant}`,
        pointer.version,
        budget,
      );
      this.#overlays.set(key, overlay);
      overlay.catch(() => this.#overlays.delete(key));
    }
    const manifest = await overlay;

    // Keyed by the base object too: a hot-reloaded content module can keep its revision.
    const viewKey = `${base.revision}\n${pointer.version}`;
    const cached = this.#views.get(viewKey);
    if (cached !== undefined && cached.base === base) return cached.view;
    const hashes = [...new Set(Object.values(manifest.set))];
    const values = new Map<string, unknown>();
    let next = 0;
    const worker = async () => {
      while (next < hashes.length) {
        const hash = hashes[next++]!;
        values.set(
          hash,
          await this.#block(`${site}/draft-blocks/${hash}.json${grant}`, hash, budget),
        );
      }
    };
    const workers = Math.min(BLOCK_FETCH_CONCURRENCY, hashes.length);
    await Promise.all(Array.from({ length: workers }, worker));
    const view = composeOverlay(base, manifest, values, pointer.version);
    this.#views.set(viewKey, { base, view });
    return view;
  }

  async #overlay(path: string, version: string, budget: Budget): Promise<DraftOverlay> {
    const response = await fetchWithTimeout(`${HOSTED_DELIVERY_ORIGIN}${path}`, this.#auth());
    if (!response.ok) throw new Error(`draft overlay ${version}: HTTP ${response.status}`);
    const [body] = await readBoundedJson(response, `draft overlay ${version}`, budget);
    const overlay = parseOverlay(body);
    if ((await computeOverlayVersion(overlay)) !== version) {
      throw new Error(`draft overlay ${version}: content doesn't match its version`);
    }
    return overlay;
  }

  /**
   * A changed block, charged to this draft's budget: from the cache, or
   * downloaded once and verified against its hash (concurrent drafts share
   * one download). Only hashes an authorized manifest lists get here.
   */
  async #block(path: string, hash: string, budget: Budget): Promise<unknown> {
    const cached = this.#blocks.get(hash);
    if (cached !== undefined) return charge(budget, cached);
    const pending = this.#pendingBlocks.get(hash);
    if (pending !== undefined) return charge(budget, await pending);
    const download = (async () => {
      const response = await fetchWithTimeout(`${HOSTED_DELIVERY_ORIGIN}${path}`, this.#auth());
      if (!response.ok) throw new Error(`draft block ${hash}: HTTP ${response.status}`);
      const [value, bytes] = await readBoundedJson(response, `draft block ${hash}`, budget);
      if ((await computeBlockHash(value)) !== hash) {
        throw new Error(`draft block ${hash}: content doesn't match its hash`);
      }
      const block = { value, bytes };
      this.#blocks.set(hash, block);
      return block;
    })();
    this.#pendingBlocks.set(hash, download);
    try {
      return (await download).value;
    } finally {
      this.#pendingBlocks.delete(hash);
    }
  }

  #auth(): Record<string, string> {
    return { authorization: `Bearer ${this.#token}` };
  }
}

/** A loader over the fallback alone: `remoteLoader` without `site` or `token`. */
class LocalLoader implements Loader {
  #fallback: Snapshot | Loader;

  constructor(fallback: Snapshot | Loader) {
    this.#fallback = fallback;
  }

  adopt(fallback: Snapshot | Loader): void {
    this.#fallback = fallback;
  }

  load(pointer?: string | null): Promise<Snapshot> {
    const fallback = this.#fallback;
    return isSnapshot(fallback) ? Promise.resolve(fallback) : fallback.load(pointer);
  }
}

/**
 * Hosted releases and drafts over a fallback. `createCMS` builds it for you
 * when `site` and `token` are set. With either unset (a dev or test
 * environment without the variables), it's a loader over the fallback alone.
 */
export function remoteLoader(fallback: Snapshot | Loader, options: RemoteLoaderOptions): Loader {
  const { site, token } = options ?? {};
  const hosted = Boolean(site && token);
  const key = Symbol.for(
    `${INSTANCE_PREFIX}${contentIdentity(fallback)}` +
      (hosted ? `|site:${site}|token:${fnv1a(token!)}` : "|local"),
  );
  const store = globalThis as unknown as Record<symbol, RemoteLoader | LocalLoader | undefined>;
  const existing = store[key];
  if (existing instanceof Object && typeof existing.adopt === "function") {
    if (existing instanceof RemoteLoader && existing.interval !== options.interval) {
      console.warn(
        "[decocms/blocks] remoteLoader was called again for the same site with different options " +
          "(interval); keeping the first instance's options.",
      );
    }
    existing.adopt(fallback);
    return existing;
  }
  const instance = hosted
    ? new RemoteLoader(fallback, { site: site!, token: token!, interval: options.interval })
    : new LocalLoader(fallback);
  store[key] = instance;
  return instance;
}

export function resetRemoteLoaders(): void {
  clearGlobals(INSTANCE_PREFIX);
}

/** What a download may still read, in bytes; shared by every asset of one draft. */
interface Budget {
  remaining: number;
}

/** Charges a cached block's bytes to a draft's budget, and returns its value. */
function charge(budget: Budget, block: { value: unknown; bytes: number }): unknown {
  budget.remaining -= block.bytes;
  if (budget.remaining < 0) throw new Error(`draft: larger than ${MAX_SNAPSHOT_BYTES} bytes`);
  return block.value;
}

/**
 * Parses a JSON body and returns it with its size, refusing it as soon as it
 * would exceed the budget (charged as bytes arrive, so parallel reads share it).
 */
async function readBoundedJson(
  response: Response,
  label: string,
  budget: Budget,
): Promise<[unknown, number]> {
  const tooLarge = () => new Error(`${label}: larger than ${MAX_SNAPSHOT_BYTES} bytes`);
  if (Number(response.headers.get("content-length")) > budget.remaining) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (response.body === null) {
    const text = await response.text();
    budget.remaining -= text.length;
    if (budget.remaining < 0) throw tooLarge();
    return [JSON.parse(text), text.length];
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    budget.remaining -= value.byteLength;
    if (budget.remaining < 0) {
      await reader.cancel();
      throw tooLarge();
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return [JSON.parse(parts.join("")), size];
}

/** Validates a draft overlay manifest; throws on an unknown format or any unexpected shape. */
function parseOverlay(body: unknown): DraftOverlay {
  const invalid = (why: string) => new Error(`draft overlay: ${why}`);
  if (!isPlainObject(body) || body.format !== DRAFT_OVERLAY_FORMAT) {
    throw invalid("unknown format");
  }
  if (Object.keys(body).some((key) => key !== "format" && key !== "set" && key !== "delete")) {
    throw invalid("unexpected field");
  }
  const { set, delete: deleted } = body;
  if (!isPlainObject(set)) throw invalid("set must be an object");
  for (const hash of Object.values(set)) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) throw invalid("set names a bad hash");
  }
  if (!Array.isArray(deleted) || deleted.some((name) => typeof name !== "string")) {
    throw invalid("delete must be a list of names");
  }
  if (new Set(deleted).size !== deleted.length) throw invalid("delete repeats a name");
  if (deleted.some((name) => Object.hasOwn(set, name))) throw invalid("set and delete overlap");
  return body as unknown as DraftOverlay;
}

/**
 * The draft as a snapshot: the captured production entries, with the
 * overlay's replacements and without its tombstones. A shallow copy: every
 * unchanged entry is production's own object, and production is never
 * mutated. Its revision is an opaque identity of the pair, not a content hash.
 */
function composeOverlay(
  base: Snapshot,
  overlay: DraftOverlay,
  values: Map<string, unknown>,
  version: string,
): Snapshot {
  const blocks: Record<string, unknown> = { ...base.blocks };
  for (const name of overlay.delete) delete blocks[name];
  for (const [name, hash] of Object.entries(overlay.set)) {
    // defineProperty, so an entry named "__proto__" stays an entry.
    Object.defineProperty(blocks, name, {
      value: values.get(hash),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const view: Snapshot = { revision: `${base.revision}~${version}`, blocks };
  if (base.aliases !== undefined) view.aliases = base.aliases;
  return view;
}

/** A Map that forgets its least recently used entries past `limit` (counted by `size`). */
class Lru<V> {
  readonly #map = new Map<string, V>();
  #total = 0;
  constructor(
    readonly limit: number,
    readonly size: (value: V) => number = () => 1,
  ) {}

  get(key: string): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.delete(key);
    this.#map.set(key, value);
    this.#total += this.size(value);
    for (const [oldest, old] of this.#map) {
      if (this.#total <= this.limit || oldest === key) break;
      this.#map.delete(oldest);
      this.#total -= this.size(old);
    }
  }

  delete(key: string): void {
    const value = this.#map.get(key);
    if (value === undefined) return;
    this.#map.delete(key);
    this.#total -= this.size(value);
  }
}

function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
      : undefined;
  return fetch(url, { headers, signal });
}

function isDevelopment(): boolean {
  try {
    // Written out so bundlers that define process.env.NODE_ENV replace it.
    return process.env.NODE_ENV === "development";
  } catch {
    return false;
  }
}
