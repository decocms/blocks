/**
 * `remoteLoader`: hosted releases from the Deco API, over a fallback (the
 * content module, or any loader). See /next/hosted-releases-internals and
 * /next/hosted-publishing. Drafts aren't a loader's job: the CMS layers a
 * draft's changes over what `load()` returns (see ./draftChanges.ts).
 *
 * - `load()` never touches the network: it returns the newest release this
 *   process fetched, or the fallback's content until one is fetched.
 * - `update()` asks the delivery API for the small production channel
 *   manifest; the CMS calls it on first use and then every interval, at an
 *   idle moment. A manifest older than the newest observed generation is
 *   ignored; a revision equal to the fallback's is served from the fallback
 *   without a download; anything else is fetched, verified against its
 *   content hash and swapped in whole. Any error keeps memory as it was.
 * - In development (`NODE_ENV=development`), releases stay on the fallback so
 *   local files win.
 * - A release larger than `MAX_SNAPSHOT_BYTES` is refused while it downloads,
 *   before it's buffered whole (a Worker isolate has 128 MB).
 * - Without `site` or `token` it's a plain loader over the fallback.
 *
 * Instances are process-wide singletons, like `createCMS`'s.
 */
import { readBoundedJson, timeoutSignal } from "./boundedJson.ts";
import { computeContentRevision } from "./canonical.ts";
import { isSnapshot, PEEK_RELEASE, peekRelease } from "./content.ts";
import { clearGlobals, contentIdentity, fnv1a } from "./identity.ts";
import { isPlainObject } from "./json.ts";
import type { Loader, Snapshot } from "./types.ts";

/** The hosted delivery origin: channel manifests and release assets. */
const HOSTED_DELIVERY_ORIGIN = "https://delivery.decocms.com";

const INSTANCE_PREFIX = "decocms.blocks.remote:";
const MANIFEST_FORMAT = 1;
const FETCH_TIMEOUT_MS = 10_000;
/** The largest release accepted, in bytes of JSON. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

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
  /** The fallback's content as last loaded, for a fallback that is itself a loader. */
  #fallbackSnapshot: Snapshot | undefined;
  #current: Snapshot | undefined;
  #generation = -1;

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
    if (fallback === this.#fallback) {
      this.#fallbackRevision = snapshot.revision;
      this.#fallbackSnapshot = snapshot;
    }
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
    const snapshot = await readBoundedJson(
      response,
      `release ${manifest.revision}`,
      MAX_SNAPSHOT_BYTES,
    );
    if (
      !isSnapshot(snapshot) ||
      snapshot.revision !== manifest.revision ||
      (await computeContentRevision(snapshot.blocks)) !== manifest.revision
    ) {
      throw new Error(`release ${manifest.revision}: content doesn't match its revision`);
    }
    return snapshot;
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

  [PEEK_RELEASE](): Snapshot | undefined {
    return peekRelease(this.#fallback);
  }

  load(): Promise<Snapshot> {
    const fallback = this.#fallback;
    return isSnapshot(fallback) ? Promise.resolve(fallback) : fallback.load();
  }
}

/**
 * Hosted releases over a fallback. `createCMS` builds it for you
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

function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { headers, signal: timeoutSignal(FETCH_TIMEOUT_MS) });
}

function isDevelopment(): boolean {
  try {
    // Written out so bundlers that define process.env.NODE_ENV replace it.
    return process.env.NODE_ENV === "development";
  } catch {
    return false;
  }
}
