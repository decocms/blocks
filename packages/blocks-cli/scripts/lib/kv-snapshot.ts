/**
 * Shared fast-deploy snapshot helpers for the CI scripts.
 *
 * Both `migrate-blocks-to-kv.ts` and `sync-blocks-to-kv.ts` write a snapshot
 * keyed by DEPLOYMENT ID (`decofile:<id>` + `index:revision:<id>`) so every code
 * deployment reads its own content. The revision is computed with the SAME
 * `computeRevision` the runtime uses (`src/cms/blockSource.ts`) so a hydrating
 * isolate computes a matching revision and the poller doesn't loop.
 */

import {
  computeRevision,
  DEPLOYMENTS_KEY,
  LIVE_KEY,
  redirectKey,
  redirectPrefix,
  revisionKey,
  snapshotKey,
} from "@decocms/blocks/cms";
import type { ExactRedirect } from "@decocms/blocks/sdk/redirects";
import type { KvRestClient } from "./cf-kv-rest";

export interface Snapshot {
  /** Serialized decofile written to `decofile:<id>`. */
  snapshot: string;
  /** DJB2 revision written to `index:revision:<id>`. */
  revision: string;
  /** Block count, for logging. */
  count: number;
}

/** One entry in the `index:deployments` GC bookkeeping list. */
export interface DeploymentEntry {
  id: string;
  ts: number;
}

export function buildSnapshot(blocks: Record<string, unknown>): Snapshot {
  return {
    snapshot: JSON.stringify(blocks),
    revision: computeRevision(blocks),
    count: Object.keys(blocks).length,
  };
}

/** Write the snapshot + revision for deployment `id`. Snapshot first, then
 * revision, so a poller never sees a new revision pointing at an old snapshot. */
export async function writeSnapshotToKv(
  client: KvRestClient,
  snap: Snapshot,
  id: string,
): Promise<void> {
  await client.put(snapshotKey(id), snap.snapshot);
  await client.put(revisionKey(id), snap.revision);
}

/** Read both keys for deployment `id` back and confirm the revision matches. */
export async function verifySnapshotInKv(
  client: KvRestClient,
  expectedRevision: string,
  id: string,
): Promise<{ ok: boolean; reason?: string }> {
  const [snapshot, revision] = await Promise.all([
    client.get(snapshotKey(id)),
    client.get(revisionKey(id)),
  ]);
  if (snapshot === null) return { ok: false, reason: `${snapshotKey(id)} missing` };
  if (revision !== expectedRevision) {
    return {
      ok: false,
      reason: `${revisionKey(id)} is "${revision}", expected "${expectedRevision}"`,
    };
  }
  return { ok: true };
}

/**
 * Reconcile deployment `id`'s exact redirects in KV: write the ones that are
 * new or changed, delete the ones that no longer exist.
 *
 * KV has no "replace everything under this prefix" operation, so the desired
 * set is diffed against what is actually stored. The source of truth for
 * "what's there now" is a prefix LIST rather than a manifest key — a manifest
 * is one more thing that can drift out of sync with reality, and the list is
 * free enough at build time.
 *
 * Updates are not detected by value: re-PUTting an unchanged key is one bulk
 * write, while reading every current value back to compare would be one GET per
 * key. So every desired rule is written, and only deletions need the diff.
 */
export async function syncRedirectsToKv(
  client: KvRestClient,
  redirects: ExactRedirect[],
  id: string,
): Promise<{ written: number; deleted: number }> {
  const desired = new Map(
    redirects.map((r) => [redirectKey(id, r.path), JSON.stringify({ to: r.to, status: r.status })]),
  );

  const existing = await client.list(redirectPrefix(id));
  const stale = existing.filter((key) => !desired.has(key));

  if (desired.size > 0) {
    await client.putMany([...desired].map(([key, value]) => ({ key, value })));
  }
  if (stale.length > 0) {
    await client.deleteMany(stale);
  }

  return { written: desired.size, deleted: stale.length };
}

/** Point `index:live` at deployment `id` (post-activation, from the deploy step). */
export async function setLiveDeployment(client: KvRestClient, id: string): Promise<void> {
  await client.put(LIVE_KEY, id);
}

async function readDeployments(client: KvRestClient): Promise<DeploymentEntry[]> {
  const raw = await client.get(DEPLOYMENTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (e): e is DeploymentEntry =>
          !!e && typeof e === "object" && typeof (e as DeploymentEntry).id === "string",
      );
    }
  } catch {
    // Corrupt bookkeeping key — start fresh rather than fail the sync.
  }
  return [];
}

/**
 * Record deployment `id` in `index:deployments` (newest last, deduped) and GC
 * snapshots beyond the last `retain`. The currently-live deployment
 * (`index:live`) is never pruned even if it falls outside the window (protects
 * a rollback to an older version). Returns the list of pruned ids.
 */
export async function recordAndGcDeployment(
  client: KvRestClient,
  id: string,
  ts: number,
  retain: number,
): Promise<{ pruned: string[] }> {
  const list = (await readDeployments(client)).filter((e) => e.id !== id);
  list.push({ id, ts });

  const pruned: string[] = [];
  if (list.length > retain) {
    const live = await client.get(LIVE_KEY);
    const excess = list.slice(0, list.length - retain);
    const recent = list.slice(list.length - retain);
    const keptOld: DeploymentEntry[] = [];
    for (const entry of excess) {
      if (entry.id === live) {
        keptOld.push(entry); // never GC the live deployment
        continue;
      }
      await client.delete(snapshotKey(entry.id));
      await client.delete(revisionKey(entry.id));
      // The per-path redirect keys are keyed by deployment too, so they are
      // part of this snapshot and must go with it — otherwise every deploy
      // leaks tens of thousands of orphans into the namespace forever.
      const staleRedirects = await client.list(redirectPrefix(entry.id));
      if (staleRedirects.length > 0) await client.deleteMany(staleRedirects);
      pruned.push(entry.id);
    }
    await client.put(DEPLOYMENTS_KEY, JSON.stringify([...keptOld, ...recent]));
  } else {
    await client.put(DEPLOYMENTS_KEY, JSON.stringify(list));
  }

  return { pruned };
}
