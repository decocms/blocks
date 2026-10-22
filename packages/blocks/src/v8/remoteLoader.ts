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
 *   `{ revision, schemaHash, publishedAt, previewHosts }`. Whoever is newer wins: when it
 *   names a revision other than the one this process last swapped in, its
 *   `schemaHash` equals the fallback's, and its `publishedAt` is later than
 *   the fallback's `committedAt` (the commit time of the git HEAD
 *   `deco content` built it from), it downloads
 *   `sites/<site>/revisions/<revision>.json`,
 *   `{ revision, schemaHash, blocks, previewHosts }`, and swaps it in whole. Otherwise, and on any error, memory stays as it is.
 *   A fallback without a `schemaHash` never swaps; one without a `committedAt`
 *   (a custom loader, an older content module, a build outside git) counts as
 *   the oldest. Studio writes `publishedAt` on Publish, on "Make current" (a
 *   rollback) and on Resync, so a rollback wins over the bundles of earlier
 *   commits and a deploy of a later commit wins over the rollback. Commit
 *   time, not build time: a slow build of an older commit that finishes after
 *   a publish still loses to it.
 *   Pointers aren't ordered among themselves, and the fallback's content is
 *   never compared: only the two timestamps are.
 * - `previewHosts` (host patterns) is where the site may be previewed: Studio
 *   knows the site's addresses and writes them into the release metadata
 *   whenever it writes `latest.json` or a revision (delivery is trusted).
 *   Previews are checked against the current release's list: the last
 *   `latest.json` read, whether or not its revision was swapped in (a newer
 *   bundle still previews where Studio says). With no list to check
 *   (PO 2026-10-22), previews are allowed on every host: a site with no
 *   `latest.json` yet (a 404), or one whose `latest.json` has no
 *   `previewHosts` (published before Studio wrote the list; its next publish
 *   writes one). A read that fails (a network error, a 5xx, a malformed
 *   `latest.json`) isn't "no list": until a read succeeds, previews stay
 *   closed, and a later failure keeps the last answer.
 *   A preview request before this process has read `latest.json` reads it
 *   then (only `latest.json`, once, shared); a read older than the interval
 *   is read again the same way, so `dev: true` follows Studio too.
 * - With `dev: true`, it never swaps, so local files win. `createCMS` passes
 *   its `dev` option, or `NODE_ENV === "development"` when the site omits it;
 *   this loader reads no environment itself.
 * - A release larger than `MAX_SNAPSHOT_BYTES` is refused while it downloads,
 *   before it's buffered whole (a Worker isolate has 128 MB).
 * - A client can ask for a published release by its commit SHA
 *   (`cms.client({ version })`): it's read from
 *   `sites/<site>/revisions/<sha>.json` on first use and kept in memory, a
 *   few at a time (the least recently used dropped first), since a revision
 *   never changes. One built with another schema than the bundled content is
 *   an error, never half a page.
 * - Without `site` it's a plain loader over the fallback.
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
import { errors } from "./errors.ts";
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
/** Published releases kept in memory once read (a client asked for one by its SHA). */
const CACHED_REVISIONS = 3;
// OPEN: a revision is the git commit SHA; only SHA-1 (40 hex) object names are accepted.
const REVISION = /^[0-9a-f]{40}$/;
const SCHEMA_HASH = /^[0-9a-f]{64}$/;
/** How long a failed read of the preview hosts waits before a preview request tries again. */
const PREVIEW_HOSTS_RETRY_MS = 10_000;
/** How old the preview hosts may get before a preview request reads them again (without `interval`). */
const PREVIEW_HOSTS_MAX_AGE_MS = 60_000;

interface RemoteLoaderOptions {
  site?: string;
  /** ms between release checks, used when `createCMS` has no `interval` of its own. */
  interval?: number;
  /** Local development: never swap in a release, so local files win. */
  dev?: boolean;
}

/** `sites/<site>/latest.json`: the release a site serves. */
interface Latest {
  revision: string;
  schemaHash: string;
  publishedAt: string;
  /** Where the site may be previewed; `undefined` when Studio wrote none. */
  previewHosts: string[] | undefined;
}

/** A revision file's body. */
interface Revision {
  blocks: Record<string, unknown>;
  schemaHash: string;
  previewHosts: string[] | undefined;
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
  readonly #dev: boolean;
  /** Published releases read by SHA; immutable, so a hit is never revalidated. */
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

  constructor(
    fallback: Snapshot | Loader,
    options: { site: string; interval?: number; dev?: boolean },
  ) {
    this.#fallback = fallback;
    this.#site = options.site;
    this.interval = options.interval;
    this.#dev = options.dev === true;
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
    if (this.#dev) return { updated: false };
    const fallback = this.#fallbackSnapshot ?? (await this.#loadFallback());
    if (fallback.schemaHash === undefined) return { updated: false };
    const site = encodeURIComponent(this.#site);
    const latest = await this.#latest(site);
    // Another schema: keep what this process serves (the fallback, or the last swap).
    if (latest.schemaHash !== fallback.schemaHash) return { updated: false };
    // The bundle is newer: keep what this process serves.
    // OPEN: a process that already swapped a release in keeps it (memory stays as it is).
    if (!isNewer(latest.publishedAt, fallback.committedAt)) return { updated: false };
    if (latest.revision === this.#current?.revision) return { updated: false };
    const revision = await this.#revision(site, latest);
    const next: Snapshot = {
      revision: latest.revision,
      blocks: revision.blocks,
      schemaHash: latest.schemaHash,
    };
    if (revision.previewHosts !== undefined) next.previewHosts = revision.previewHosts;
    if (fallback.aliases !== undefined) next.aliases = fallback.aliases;
    this.#current = next;
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
      this.#hostsRead ??= this.#latest(encodeURIComponent(this.#site))
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

  /** A published release by its commit SHA (see `READ_REVISION`). */
  async [READ_REVISION](sha: string): Promise<Snapshot> {
    if (!REVISION.test(sha)) throw errors.loaderFailed(`"${sha}" is not a release's commit SHA`);
    if (this.#current?.revision === sha) return this.#current;
    const fallback = this.#fallbackSnapshot ?? (await this.#loadFallback());
    if (fallback.revision === sha) return fallback;
    if (fallback.schemaHash === undefined) {
      throw errors.loaderFailed(
        `the release ${sha} can't be checked against this code: the bundled content has no schemaHash (run deco content)`,
      );
    }
    const snapshot = await this.#readRevision(sha);
    if (snapshot.schemaHash !== fallback.schemaHash) {
      throw errors.loaderFailed(
        `the release ${sha} was published with another schema than this code's ` +
          `(${snapshot.schemaHash} ≠ ${fallback.schemaHash}): preview it on a deploy of its own code`,
      );
    }
    if (fallback.aliases === undefined) return snapshot;
    return { ...snapshot, aliases: fallback.aliases };
  }

  /** Reads a revision once; a failed read isn't kept, so the next client tries again. */
  #readRevision(sha: string): Promise<Snapshot> {
    const held = this.#revisions.get(sha);
    if (held !== undefined) return held;
    const site = encodeURIComponent(this.#site);
    const pending = this.#fetchRevision(site, sha, "the revision asked for").then((body) => {
      const snapshot: Snapshot = {
        revision: sha,
        blocks: body.blocks,
        schemaHash: body.schemaHash,
      };
      if (body.previewHosts !== undefined) snapshot.previewHosts = body.previewHosts;
      return snapshot;
    });
    this.#revisions.set(sha, pending);
    pending.catch(() => {
      if (this.#revisions.get(sha) === pending) this.#revisions.delete(sha);
    });
    return pending;
  }

  async #fetchRevision(site: string, sha: string, expected: string): Promise<Revision> {
    const label = `revision ${sha}`;
    const response = await fetchWithTimeout(
      `${deliveryOrigin()}/sites/${site}/revisions/${sha}.json`,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${label}: HTTP ${response.status}`);
    }
    const body = await readBoundedJson(response, label, MAX_SNAPSHOT_BYTES);
    if (
      !isPlainObject(body) ||
      body.revision !== sha ||
      typeof body.schemaHash !== "string" ||
      !isPlainObject(body.blocks)
    ) {
      throw new Error(`${label}: unexpected format, or not ${expected}`);
    }
    return {
      blocks: body.blocks,
      schemaHash: body.schemaHash,
      previewHosts: previewHostsOf(body.previewHosts),
    };
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
      // Not published yet: no list, so previews are allowed on every host (PO 2026-10-22).
      if (response.status === 404) this.#hosts = { list: "every", at: Date.now() };
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
    const previewHosts = previewHostsOf(body.previewHosts);
    // The current release's metadata, whether or not its revision is swapped in.
    // No `previewHosts` (published before Studio wrote the list): every host, as with no latest.json.
    this.#hosts = { list: previewHosts ?? "every", at: Date.now() };
    return {
      revision: body.revision,
      schemaHash: body.schemaHash,
      publishedAt: body.publishedAt,
      previewHosts,
    };
  }

  async #revision(site: string, latest: Latest): Promise<Revision> {
    const body = await this.#fetchRevision(site, latest.revision, "the revision latest.json names");
    if (body.schemaHash !== latest.schemaHash) {
      throw new Error(`revision ${latest.revision}: not the schema latest.json names`);
    }
    return body;
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
    ? new RemoteLoader(fallback, { site: site!, interval: options.interval, dev: options.dev })
    : new LocalLoader(fallback);
  store[key] = instance;
  return instance;
}

export function resetRemoteLoaders(): void {
  clearGlobals(INSTANCE_PREFIX);
}

/**
 * Whether a release published at `publishedAt` is newer than content built
 * from a commit made at `committedAt`. Content without a `committedAt` is the
 * oldest.
 * OPEN: a `committedAt` that doesn't parse as a date counts as missing.
 */
function isNewer(publishedAt: string, committedAt: string | undefined): boolean {
  const committed = committedAt === undefined ? Number.NaN : Date.parse(committedAt);
  return Number.isNaN(committed) || Date.parse(publishedAt) > committed;
}

/** No credentials: delivery is public. */
function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, { signal: timeoutSignal(FETCH_TIMEOUT_MS) });
}

function deliveryOrigin(): string {
  const override = (globalThis as Record<symbol, unknown>)[TEST_DELIVERY_ORIGIN];
  return typeof override === "string" ? override : HOSTED_DELIVERY_ORIGIN;
}
