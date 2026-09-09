/**
 * KVBlockSource — a `BlockSource` backed by a Cloudflare KV namespace, scoped
 * to a single **deployment id**.
 *
 * Reads the whole decofile snapshot (`decofile:<id>`) and its revision
 * (`index:revision:<id>`) from KV. Used by the runtime hydration path
 * (`src/sdk/kvHydration.ts`) on cold start and during revision polling, and by
 * the write-through path (`src/admin/decofile.ts`) which writes the same keys.
 * Keying by deployment id means each running version only ever sees its own
 * content — a rolling deploy can't feed new content to still-live old code.
 *
 * This class is intentionally thin — error handling (KV outages, JSON parse
 * failures) is the caller's responsibility so the framework can fall back to
 * the bundled snapshot. See `kvHydration.ts`.
 */

import {
  type BlockSnapshot,
  type BlockSource,
  baseBlocksKey,
  computeRevision,
  type DecoPage,
  type KVNamespace,
  type PageIndexEntry,
  pageBlockKey,
  pageIndexKey,
  revisionKey,
  snapshotKey,
} from "@decocms/blocks/cms";

/** The resident half of a split snapshot: non-page blocks + routing index. */
export interface SplitSnapshot extends BlockSnapshot {
  index: PageIndexEntry[];
}

/** Colo-level cache TTL for an individual page block (see `loadPage`). */
const PAGE_CACHE_TTL_SECONDS = 300;

export class KVBlockSource implements BlockSource {
  private readonly snapshotKey: string;
  private readonly revisionKey: string;
  private readonly baseKey: string;
  private readonly indexKey: string;

  constructor(
    private readonly kv: KVNamespace,
    /** Deployment id (git commit sha) this source is scoped to. */
    private readonly deploymentId: string,
  ) {
    this.snapshotKey = snapshotKey(deploymentId);
    this.revisionKey = revisionKey(deploymentId);
    this.baseKey = baseBlocksKey(deploymentId);
    this.indexKey = pageIndexKey(deploymentId);
  }

  /**
   * Read the SPLIT snapshot — non-page blocks plus the routing index — without
   * ever materializing the pages. This is the memory win: on a real 10.2 MB
   * decofile the two keys below total ~0.7 MB of JSON against 10.2 MB.
   *
   * Returns `null` when either key is absent, which is how a deployment synced
   * by a pre-split writer is detected; the caller then falls back to
   * `loadSnapshot()` and behaves exactly as before.
   */
  async loadSplit(): Promise<SplitSnapshot | null> {
    const [rawBase, rawIndex] = await Promise.all([
      this.kv.get(this.baseKey),
      this.kv.get(this.indexKey),
    ]);
    if (rawBase === null || rawIndex === null) return null;

    const base = JSON.parse(rawBase) as unknown;
    if (!base || typeof base !== "object" || Array.isArray(base)) {
      throw new Error(`[CMS/KV] ${this.baseKey} is not a JSON object`);
    }
    const index = JSON.parse(rawIndex) as unknown;
    if (!Array.isArray(index)) {
      throw new Error(`[CMS/KV] ${this.indexKey} is not a JSON array`);
    }

    // The revision covers the WHOLE decofile (pages included) and is written by
    // the same operation that wrote these two keys, so it stays comparable with
    // what the poller reads. It cannot be recomputed from `base` alone.
    const storedRevision = await this.kv.get(this.revisionKey);
    if (!storedRevision) {
      throw new Error(`[CMS/KV] ${this.revisionKey} missing — refusing a split load without it`);
    }

    return {
      blocks: base as Record<string, unknown>,
      index: index as PageIndexEntry[],
      revision: storedRevision,
    };
  }

  /** Fetch a single page block. `null` when the key is absent from KV. */
  async loadPage(blockKey: string): Promise<DecoPage | null> {
    // `cacheTtl` lets Cloudflare serve the page from the colo edge cache
    // instead of central KV, which is what keeps the added per-request hop off
    // TTFB. Content changes are picked up through the revision poll, which
    // swaps the deployment id / index, not through this key expiring.
    const raw = await this.kv.get(pageBlockKey(this.deploymentId, blockKey), {
      cacheTtl: PAGE_CACHE_TTL_SECONDS,
    });
    if (raw === null) return null;
    return JSON.parse(raw) as DecoPage;
  }

  /**
   * Read and parse this deployment's full decofile snapshot from KV.
   *
   * Returns `null` when no snapshot is present (key missing) so the caller
   * keeps whatever blocks are already in memory (the bundled fallback).
   *
   * The stored revision is preferred; if it's absent we recompute it from the
   * blocks so the result is always self-consistent. A malformed snapshot
   * (invalid JSON / non-object) throws — the caller treats that as "KV
   * unavailable" and falls back.
   */
  async loadSnapshot(): Promise<BlockSnapshot | null> {
    const raw = await this.kv.get(this.snapshotKey);
    if (raw === null) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`[CMS/KV] ${this.snapshotKey} is not a JSON object`);
    }
    const blocks = parsed as Record<string, unknown>;

    const storedRevision = await this.kv.get(this.revisionKey);
    return { blocks, revision: storedRevision ?? computeRevision(blocks) };
  }

  /** Cheap revision probe for change detection (no full snapshot transfer). */
  getRevision(): Promise<string | null> {
    return this.kv.get(this.revisionKey);
  }
}
