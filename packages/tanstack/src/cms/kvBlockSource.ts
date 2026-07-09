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
  computeRevision,
  type KVNamespace,
  revisionKey,
  snapshotKey,
} from "@decocms/blocks/cms";

export class KVBlockSource implements BlockSource {
  private readonly snapshotKey: string;
  private readonly revisionKey: string;

  constructor(
    private readonly kv: KVNamespace,
    /** Deployment id (git commit sha) this source is scoped to. */
    private readonly deploymentId: string,
  ) {
    this.snapshotKey = snapshotKey(deploymentId);
    this.revisionKey = revisionKey(deploymentId);
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
