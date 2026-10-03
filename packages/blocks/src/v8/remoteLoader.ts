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
 * - `load(pointer)` fetches the draft a pointer names and waits for it. Only
 *   pointers to the delivery host are fetched; anything else is refused.
 * - In development (`NODE_ENV=development`), releases stay on the fallback so
 *   local files win; drafts still load.
 *
 * Instances are process-wide singletons, like `createCMS`'s.
 */
import { computeContentRevision } from "../protocol/canonical";
import { isSnapshot } from "./content";
import { parseDraftPointer } from "./draft";
import { clearGlobals, contentIdentity, fnv1a } from "./identity";
import { isPlainObject } from "./json";
import type { Loader, Snapshot } from "./types";

/** The hosted delivery origin: channel manifests, release assets and drafts. */
const HOSTED_DELIVERY_ORIGIN = "https://delivery.decocms.com";

const INSTANCE_PREFIX = "decocms.blocks.remote:";
const MANIFEST_FORMAT = 1;
const FETCH_TIMEOUT_MS = 10_000;

interface RemoteLoaderOptions {
  site: string;
  token: string;
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

  constructor(fallback: Snapshot | Loader, options: RemoteLoaderOptions) {
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

    // Best effort: a fallback that can't load (a missing kvLoader key) is
    // fixed by downloading the release, not by failing the check.
    const fallbackRevision = await this.#fallbackRevisionNow().catch(() => undefined);
    const served = this.#current !== undefined ? this.#current.revision : fallbackRevision;
    if (served !== undefined && manifest.revision === served) {
      this.#generation = manifest.generation;
      return { updated: false };
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
    const snapshot: unknown = await response.json();
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
    // If-Match: serve exactly this version or fail, never the branch's newer head.
    const response = await fetchWithTimeout(`https://${pointer.host}${pointer.path}`, {
      ...this.#auth(),
      "if-match": pointer.version,
    });
    if (!response.ok) throw new Error(`draft: HTTP ${response.status}`);
    const snapshot: unknown = await response.json();
    if (!isSnapshot(snapshot)) throw new Error("draft: not a snapshot");
    return snapshot;
  }

  #auth(): Record<string, string> {
    return { authorization: `Bearer ${this.#token}` };
  }
}

/**
 * Hosted releases and drafts over a fallback. `createCMS` builds it for you
 * when `site` and `token` are set. With either unset (a dev or test
 * environment without the variables), it returns `fallback` unchanged.
 */
export function remoteLoader(
  fallback: Snapshot | Loader,
  options: RemoteLoaderOptions,
): Snapshot | Loader {
  if (!options?.site || !options.token) return fallback;
  const key = Symbol.for(
    `${INSTANCE_PREFIX}${contentIdentity(fallback)}|site:${options.site}|token:${fnv1a(options.token)}`,
  );
  const store = globalThis as unknown as Record<symbol, RemoteLoader | undefined>;
  const existing = store[key];
  if (existing instanceof Object && typeof existing.adopt === "function") {
    if (existing.interval !== options.interval) {
      console.warn(
        "[decocms/blocks] remoteLoader was called again for the same site with different options " +
          "(interval); keeping the first instance's options.",
      );
    }
    existing.adopt(fallback);
    return existing;
  }
  const instance = new RemoteLoader(fallback, options);
  store[key] = instance;
  return instance;
}

export function resetRemoteLoaders(): void {
  clearGlobals(INSTANCE_PREFIX);
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
