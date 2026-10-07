/**
 * `remoteLoader`: hosted releases from `delivery.decocms.com`, over a fallback
 * (the content module, or any loader). See /next/hosted-releases-internals.
 * Drafts aren't a loader's job: the CMS layers a draft's changes over what
 * `load()` returns (see ./draftChanges.ts).
 *
 * - `load()` never touches the network: it returns the release this process
 *   last swapped in, or the fallback's content until then. Nothing persists
 *   across restarts: every boot starts from the fallback.
 * - `update()` (the CMS calls it in the background, on first use and then
 *   every interval) reads `sites/<site>/latest.json`,
 *   `{ revision, schemaHash, publishedAt }`. Whoever is newer wins: when it
 *   names a revision other than the one this process last swapped in, its
 *   `schemaHash` equals the fallback's, and its `publishedAt` is later than
 *   the fallback's `builtAt` (the time `deco content` generated it), it
 *   downloads `sites/<site>/revisions/<revision>.json`,
 *   `{ revision, schemaHash, blocks }`, and swaps it in whole. Otherwise, and
 *   on any error, memory stays as it is. A fallback without a `schemaHash`
 *   never swaps; one without a `builtAt` (a custom loader, an older content
 *   module) counts as the oldest. Studio writes `publishedAt` on Publish, on
 *   "Make current" (a rollback) and on Resync, so a rollback wins over the
 *   bundles built before it and a later deploy wins over the rollback.
 *   Pointers aren't ordered among themselves, and the fallback's content is
 *   never compared: only the two timestamps are.
 * - In development (`NODE_ENV=development`), it never swaps, so local files win.
 * - A release larger than `MAX_SNAPSHOT_BYTES` is refused while it downloads,
 *   before it's buffered whole (a Worker isolate has 128 MB).
 * - Without `site` it's a plain loader over the fallback.
 *
 * Instances are process-wide singletons, like `createCMS`'s.
 */
import { readBoundedJson, timeoutSignal } from "./boundedJson.ts";
import { isSnapshot, PEEK_RELEASE, peekRelease } from "./content.ts";
import { clearGlobals, contentIdentity } from "./identity.ts";
import { isPlainObject } from "./json.ts";
import type { Loader, Snapshot } from "./types.ts";

/** The hosted delivery origin: release pointers and revisions. */
const HOSTED_DELIVERY_ORIGIN = "https://delivery.decocms.com";
/** test-only: replaces the delivery origin in local end-to-end runs. Not documented, not exported. */
const TEST_DELIVERY_ORIGIN = Symbol.for("decocms.blocks.test.deliveryOrigin");

const INSTANCE_PREFIX = "decocms.blocks.remote:";
const FETCH_TIMEOUT_MS = 10_000;
/** The largest release accepted, in bytes of JSON. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
// OPEN: a revision is the git commit SHA; only SHA-1 (40 hex) object names are accepted.
const REVISION = /^[0-9a-f]{40}$/;
const SCHEMA_HASH = /^[0-9a-f]{64}$/;

interface RemoteLoaderOptions {
  site?: string;
  /** ms between release checks, used when `createCMS` has no `interval` of its own. */
  interval?: number;
}

/** `sites/<site>/latest.json`: the release a site serves. */
interface Latest {
  revision: string;
  schemaHash: string;
  publishedAt: string;
}

class RemoteLoader implements Loader {
  readonly #site: string;
  /** The `interval` this loader was created with; `createCMS` reads it. */
  readonly interval: number | undefined;
  #fallback: Snapshot | Loader;
  /** The fallback's content as last loaded, for a fallback that is itself a loader. */
  #fallbackSnapshot: Snapshot | undefined;
  /** The release this process last swapped in; `undefined` serves the fallback. */
  #current: Snapshot | undefined;

  constructor(fallback: Snapshot | Loader, options: { site: string; interval?: number }) {
    this.#fallback = fallback;
    this.#site = options.site;
    this.interval = options.interval;
  }

  /** A hot reload hands the same instance new fallback content. */
  adopt(fallback: Snapshot | Loader): void {
    if (fallback === this.#fallback) return;
    this.#fallback = fallback;
    this.#fallbackSnapshot = undefined;
  }

  /** What `load()` would return now, from memory only (see `peekRelease`). */
  [PEEK_RELEASE](): Snapshot | undefined {
    return this.#current ?? peekRelease(this.#fallback) ?? this.#fallbackSnapshot;
  }

  load(): Promise<Snapshot> {
    if (this.#current !== undefined) return Promise.resolve(this.#current);
    return this.#loadFallback();
  }

  async update(): Promise<{ updated: boolean }> {
    if (isDevelopment()) return { updated: false };
    const fallback = this.#fallbackSnapshot ?? (await this.#loadFallback());
    if (fallback.schemaHash === undefined) return { updated: false };
    const site = encodeURIComponent(this.#site);
    const latest = await this.#latest(site);
    // Another schema: keep what this process serves (the fallback, or the last swap).
    if (latest.schemaHash !== fallback.schemaHash) return { updated: false };
    // The bundle is newer: keep what this process serves.
    // OPEN: a process that already swapped a release in keeps it (memory stays as it is).
    if (!isNewer(latest.publishedAt, fallback.builtAt)) return { updated: false };
    if (latest.revision === this.#current?.revision) return { updated: false };
    const blocks = await this.#revision(site, latest);
    const next: Snapshot = { revision: latest.revision, blocks, schemaHash: latest.schemaHash };
    if (fallback.aliases !== undefined) next.aliases = fallback.aliases;
    this.#current = next;
    return { updated: true };
  }

  async #loadFallback(): Promise<Snapshot> {
    const fallback = this.#fallback;
    const snapshot = isSnapshot(fallback) ? fallback : await (fallback as Loader).load();
    if (fallback === this.#fallback) this.#fallbackSnapshot = snapshot;
    return snapshot;
  }

  async #latest(site: string): Promise<Latest> {
    const response = await fetchWithTimeout(`${deliveryOrigin()}/sites/${site}/latest.json`);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`latest.json: HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    if (
      !isPlainObject(body) ||
      typeof body.revision !== "string" ||
      !REVISION.test(body.revision) ||
      typeof body.schemaHash !== "string" ||
      !SCHEMA_HASH.test(body.schemaHash) ||
      typeof body.publishedAt !== "string" ||
      Number.isNaN(Date.parse(body.publishedAt))
    ) {
      throw new Error("latest.json: unexpected format");
    }
    return body as unknown as Latest;
  }

  async #revision(site: string, latest: Latest): Promise<Record<string, unknown>> {
    const label = `revision ${latest.revision}`;
    const response = await fetchWithTimeout(
      `${deliveryOrigin()}/sites/${site}/revisions/${latest.revision}.json`,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${label}: HTTP ${response.status}`);
    }
    const body = await readBoundedJson(response, label, MAX_SNAPSHOT_BYTES);
    if (
      !isPlainObject(body) ||
      body.revision !== latest.revision ||
      body.schemaHash !== latest.schemaHash ||
      !isPlainObject(body.blocks)
    ) {
      throw new Error(`${label}: unexpected format, or not the revision latest.json names`);
    }
    return body.blocks;
  }
}

/** A loader over the fallback alone: `remoteLoader` without `site`. */
class LocalLoader implements Loader {
  #fallback: Snapshot | Loader;

  constructor(fallback: Snapshot | Loader) {
    this.#fallback = fallback;
  }

  adopt(fallback: Snapshot | Loader): void {
    this.#fallback = fallback;
  }

  [PEEK_RELEASE](): Snapshot | undefined {
    return peekRelease(this.#fallback);
  }

  load(): Promise<Snapshot> {
    const fallback = this.#fallback;
    return isSnapshot(fallback) ? Promise.resolve(fallback) : fallback.load();
  }
}

/**
 * Hosted releases over a fallback. `createCMS` builds it for you when `site`
 * is set. Without `site`, it's a loader over the fallback alone.
 */
export function remoteLoader(fallback: Snapshot | Loader, options: RemoteLoaderOptions): Loader {
  const { site } = options ?? {};
  const hosted = Boolean(site);
  const key = Symbol.for(
    `${INSTANCE_PREFIX}${contentIdentity(fallback)}${hosted ? `|site:${site}` : "|local"}`,
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
    ? new RemoteLoader(fallback, { site: site!, interval: options.interval })
    : new LocalLoader(fallback);
  store[key] = instance;
  return instance;
}

export function resetRemoteLoaders(): void {
  clearGlobals(INSTANCE_PREFIX);
}

/**
 * Whether a release published at `publishedAt` is newer than content built at
 * `builtAt`. Content without a `builtAt` is the oldest.
 * OPEN: a `builtAt` that doesn't parse as a date counts as missing.
 */
function isNewer(publishedAt: string, builtAt: string | undefined): boolean {
  const built = builtAt === undefined ? Number.NaN : Date.parse(builtAt);
  return Number.isNaN(built) || Date.parse(publishedAt) > built;
}

/** No credentials: delivery is public. */
function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, { signal: timeoutSignal(FETCH_TIMEOUT_MS) });
}

function deliveryOrigin(): string {
  const override = (globalThis as Record<symbol, unknown>)[TEST_DELIVERY_ORIGIN];
  return typeof override === "string" ? override : HOSTED_DELIVERY_ORIGIN;
}

/**
 * The SDK's only environment read: local development never swaps in hosted
 * releases, so local files win.
 */
function isDevelopment(): boolean {
  try {
    // Written out so bundlers that define process.env.NODE_ENV replace it.
    return process.env.NODE_ENV === "development";
  } catch {
    return false;
  }
}
