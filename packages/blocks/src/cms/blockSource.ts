/**
 * BlockSource — the runtime source of truth for the CMS decofile.
 *
 * A `BlockSource` asynchronously yields the *whole* decofile snapshot (the
 * `Record<string, unknown>` blocks map) plus its revision hash. This is the
 * "fast deploy" seam: the framework can hydrate the in-memory block map from a
 * remote source (Cloudflare KV) on cold start and swap it on revision change,
 * WITHOUT making the synchronous resolution hot path (`loadBlocks()` in
 * `loader.ts`) async.
 *
 * Design note (whole-snapshot vs per-block): the resolver calls `loadBlocks()`
 * synchronously in dozens of places (matchers, deferral checks, page lookup,
 * SEO). Rather than threading `async` through all of that, a `BlockSource`
 * loads the entire decofile once and the framework calls `setBlocks()` to swap
 * the in-memory map. Per-request reads stay in-memory (zero added latency); KV
 * is touched only on cold start and during the opportunistic revision poll.
 *
 * Mirrors the `DecofileProvider` pattern from the original deco-cx/deco Fresh
 * runtime (`engine/decofile/provider.ts`), trimmed to what the snapshot-swap
 * model needs.
 */

import { djb2Hex } from "../sdk/djb2";

/** A fully-loaded decofile snapshot: the blocks map and its revision hash. */
export interface BlockSnapshot {
  /** The decofile — a flat map of block name → block JSON. */
  blocks: Record<string, unknown>;
  /** DJB2 hex revision computed over the blocks (see `computeRevision`). */
  revision: string;
}

/**
 * Source of the runtime decofile snapshot.
 *
 * Implementations:
 * - `BundledBlockSource` — the build-time `blocks.gen` snapshot (fallback /
 *   local dev). A no-op here because `setup.ts` already loads it via
 *   `setBlocks()` at module init.
 * - `KVBlockSource` — reads `decofile:<id>` + `index:revision:<id>` (keyed by
 *   deployment id) from a Cloudflare KV namespace.
 */
export interface BlockSource {
  /**
   * Load the full decofile snapshot. Returns `null` when this source has no
   * snapshot to offer (e.g. KV key missing, or the bundled source which is
   * already applied at startup) — the caller then keeps whatever blocks are
   * currently in memory.
   */
  loadSnapshot(): Promise<BlockSnapshot | null>;

  /**
   * Cheap revision probe used for change detection during polling. Returns the
   * current revision without transferring the full snapshot, or `null` when
   * unavailable.
   */
  getRevision(): Promise<string | null>;
}

/**
 * Compute the revision hash for a blocks map.
 *
 * MUST match `computeRevision` in `loader.ts` (DJB2 over the JSON string) so
 * that a snapshot written to KV and the revision stored alongside it agree
 * with the revision an isolate computes after `setBlocks()` — otherwise the
 * poller would see a permanent mismatch and reload on every tick.
 */
export function computeRevision(blocks: Record<string, unknown>): string {
  return djb2Hex(JSON.stringify(blocks));
}

/**
 * Bundled (build-time) snapshot source.
 *
 * Intentionally a no-op `loadSnapshot()`: the bundled `blocks.gen` is applied
 * by `createSiteSetup()` → `setBlocks()` at module load, before any request.
 * This exists so callers can treat "bundled" uniformly through the
 * `BlockSource` interface and so the composition layer (KV primary + bundled
 * fallback) has a concrete fallback object.
 */
export class BundledBlockSource implements BlockSource {
  loadSnapshot(): Promise<BlockSnapshot | null> {
    return Promise.resolve(null);
  }

  getRevision(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

// ---------------------------------------------------------------------------
// Minimal Cloudflare KV type
// ---------------------------------------------------------------------------

/**
 * Minimal structural type for a Cloudflare KV namespace binding.
 *
 * Declared locally (matching the pattern in `workerEntry.ts`, which defines
 * its own `WorkerExecutionContext`) so `@decocms/start` does not depend on
 * `@cloudflare/workers-types`. Only the methods the framework actually uses
 * are modeled.
 */
export interface KVNamespace {
  get(key: string, options?: { type?: "text"; cacheTtl?: number }): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: Record<string, unknown> },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// KV key layout — keyed by DEPLOYMENT ID so every code deployment reads its own
// content snapshot (deploy isolation, cheap rollback, build-time content sync).
//
// The deployment id is the git commit sha (see `getDeploymentId` below).
// Shared by the runtime reader (`kvBlockSource.ts`), the write-through path
// (`admin/decofile.ts`), and the CI sync/migrate scripts, so the contract can't
// drift between read and write sides.
//
//   decofile:<id>          full decofile JSON for deployment <id>
//   index:revision:<id>    DJB2 hex revision of that snapshot (polled)
//   index:live             pointer to the currently-live <id> (set post-deploy)
//   index:deployments      JSON [{id, ts}] (newest last) — GC bookkeeping
// ---------------------------------------------------------------------------

/** KV key holding the full decofile JSON for deployment `id`. */
export function snapshotKey(id: string): string {
  return `decofile:${id}`;
}

/** KV key holding the DJB2 hex revision of deployment `id`'s snapshot. */
export function revisionKey(id: string): string {
  return `index:revision:${id}`;
}

/** Pointer key naming the currently-live deployment id. Written by a code
 * deploy AFTER the new version has activated (so a rolling deploy never points
 * live at a version that isn't serving yet). */
export const LIVE_KEY = "index:live";

/** Bookkeeping key: JSON array of `{ id, ts }` (newest last) tracking known
 * deployment snapshots so the sync script can GC all but the last N. */
export const DEPLOYMENTS_KEY = "index:deployments";

// ---------------------------------------------------------------------------
// Deployment id resolution
//
// Which snapshot key does THIS running worker read/write? The deployment id.
// Kept here (framework-agnostic) alongside the key builders it feeds, so the
// runtime read path (`@decocms/tanstack` kvHydration) and the write-through
// path (`@decocms/blocks-admin` decofile) resolve it identically — no drift.
// ---------------------------------------------------------------------------

/** Deploy-time var naming this version's content snapshot key. Set by the
 * deploy command (`wrangler deploy --var DECO_DEPLOYMENT_ID:<sha>`). */
export const DEPLOYMENT_ID_ENV = "DECO_DEPLOYMENT_ID";

/** Fallback var (cache-key version) — the same commit sha, already threaded by
 * some sites via `--var BUILD_HASH:<sha>`. */
export const BUILD_HASH_ENV = "BUILD_HASH";

// Build-time constant injected by the tanstack `decoVitePlugin()` (git
// rev-parse / WORKERS_CI_COMMIT_SHA) as the last-resort deployment id. Declared
// here with a `typeof` guard so it's inert where the define isn't applied
// (e.g. the Next.js build, or this package's own tsc output).
declare const __DECO_BUILD_HASH__: string | undefined;

/**
 * Resolve this worker's deployment id — the key its content is stored under
 * (`decofile:<id>`). Priority:
 *   1. `env.DECO_DEPLOYMENT_ID` — set by the deploy command (authoritative).
 *   2. `env.BUILD_HASH` — the cache-key version var; the same commit sha.
 *   3. `__DECO_BUILD_HASH__` — build-time constant (the commit the bundle, and
 *      thus the build-time content sync, was produced from).
 * Returns `null` when none resolves — the caller then serves the bundled
 * snapshot (never another deployment's content).
 */
export function getDeploymentId(env: Record<string, unknown>): string | null {
  const fromDeploymentVar = env[DEPLOYMENT_ID_ENV];
  if (typeof fromDeploymentVar === "string" && fromDeploymentVar) {
    return fromDeploymentVar;
  }
  const fromBuildHash = env[BUILD_HASH_ENV];
  if (typeof fromBuildHash === "string" && fromBuildHash) return fromBuildHash;
  if (typeof __DECO_BUILD_HASH__ !== "undefined" && __DECO_BUILD_HASH__) {
    return __DECO_BUILD_HASH__;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Split snapshot — pages out of the isolate, everything else resident
//
// Measured on a real 10.2 MB / 1690-block decofile (montecarlo): `pages-*`
// blocks are 1303 of those 1690 and carry 9.5 MB of the 10.2 MB. Every other
// block — matchers, loaders, Header/Footer/Theme, redirects — totals 0.63 MB.
// A full graph walk over `__resolveType` also found ZERO references INTO a
// `pages-` block from anywhere else: pages are roots.
//
// So the split is trivial and needs no reachability analysis. Keep the 387
// non-page blocks resident (the resolver reads them by key, synchronously, all
// over `resolve.ts`) and fetch exactly one page per request from KV. Resident
// heap goes 17.2 MB -> 1.5 MB; a request adds p50 2.3 KB / p99 66 KB of page.
//
//   blocks:<id>       non-page blocks (the resident base)
//   pageindex:<id>    [{ key, path }] routing index (resident, ~50 KB)
//   page:<id>:<key>   one page block each (fetched on match)
//
// `decofile:<id>` keeps being written unchanged — the admin delta/read paths
// and the pre-split fallback both still need a whole snapshot, and the split
// keys are always derived from the same blocks object in the same write, so
// the two can't drift.
// ---------------------------------------------------------------------------

/**
 * Opt-in env var for the split layout — `"1"` / `"true"` to enable.
 *
 * Gates BOTH sides, and they must agree. Off on the write path means the split
 * keys are actively deleted, not merely left unwritten: a stale `blocks:<id>`
 * next to a fresh `index:revision:<id>` would let a reader hydrate old content
 * under a new revision, stop polling, and serve it silently. Deleting makes
 * "flag off" mean exactly one thing — whole-snapshot behavior, as before.
 */
export const BLOCKS_SPLIT_ENV = "DECO_BLOCKS_SPLIT";

/** Is the pages-out-of-memory split layout enabled for this environment? */
export function isBlocksSplitEnabled(env: Record<string, unknown> | undefined): boolean {
  const flag = env?.[BLOCKS_SPLIT_ENV];
  return flag === "1" || flag === "true";
}

/** Key prefix identifying a CMS page block. Mirrors `getAllPages()`. */
export const PAGE_BLOCK_PREFIX = "pages-";

/** One routing-index entry: enough to match a path, not to render it. */
export interface PageIndexEntry {
  /** The page's block key (`pages-Home-123`) — the `page:<id>:<key>` suffix. */
  key: string;
  /** The page's URLPattern path. */
  path: string;
}

/** KV key holding deployment `id`'s non-page blocks (the resident base). */
export function baseBlocksKey(id: string): string {
  return `blocks:${id}`;
}

/** KV key holding deployment `id`'s routing index. */
export function pageIndexKey(id: string): string {
  return `pageindex:${id}`;
}

/** KV key holding a single page block of deployment `id`. */
export function pageBlockKey(id: string, blockKey: string): string {
  return `page:${id}:${blockKey}`;
}

/** A decofile cut into the three pieces the split KV layout stores. */
export interface SplitDecofile {
  /** Non-page blocks — hydrated into the isolate via `setBlocks()`. */
  base: Record<string, unknown>;
  /** Routing index over the pages, in decofile order. */
  index: PageIndexEntry[];
  /** Page blocks by key — written one KV entry each, never held resident. */
  pages: Record<string, unknown>;
}

/**
 * Cut a decofile into base / index / pages.
 *
 * A `pages-` block only reaches the index when it has BOTH a `path` and
 * `sections` — exactly the filter `getAllPages()` applies today, so routing
 * sees the same candidate set whether it reads the index or scans memory.
 * A malformed page block (no path/sections) stays in `pages` but out of the
 * index; nothing can route to it, which is the current behavior too.
 */
export function splitDecofile(blocks: Record<string, unknown>): SplitDecofile {
  const base: Record<string, unknown> = {};
  const pages: Record<string, unknown> = {};
  const index: PageIndexEntry[] = [];

  for (const [key, block] of Object.entries(blocks)) {
    if (!key.startsWith(PAGE_BLOCK_PREFIX)) {
      base[key] = block;
      continue;
    }
    pages[key] = block;
    const page = block as { path?: unknown; sections?: unknown } | null;
    if (!page || typeof page !== "object") continue;
    if (typeof page.path !== "string" || !page.path) continue;
    if (!page.sections) continue;
    index.push({ key, path: page.path });
  }

  return { base, index, pages };
}
