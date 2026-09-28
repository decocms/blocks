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
  metaEtagKey,
  metaKey,
  revisionKey,
  snapshotKey,
} from "@decocms/blocks/cms";
import { djb2Hex } from "@decocms/blocks/sdk/djb2";
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

/**
 * Write the admin JSON Schema (`meta.gen.json`) for deployment `id`, so
 * `GET /live/_meta` can stream it out of KV instead of the worker carrying it
 * in-bundle (~40 MB of isolate heap on a large site).
 *
 * Two details the read path depends on:
 *
 *  - The ETag is computed HERE, over the raw schema, and stored under its own
 *    key. `handleMeta` can then answer `If-None-Match` — the common case, admin
 *    polls this endpoint — with one small read instead of pulling ~10 MB.
 *  - The same ETag is merged into the stored payload as an `etag` field,
 *    because the wire format is `{...schema, etag}` and the read path streams
 *    the bytes through verbatim rather than re-serialising them.
 *
 * Payload first, then the ETag key, so a reader never sees a fresh ETag
 * pointing at a stale (or missing) payload — same ordering rule as
 * `writeSnapshotToKv`.
 */
export async function writeMetaToKv(
  client: KvRestClient,
  rawSchema: string,
  id: string,
): Promise<string> {
  const etag = `"meta-${djb2Hex(rawSchema)}"`;
  const trimmed = rawSchema.trimEnd();
  if (!trimmed.endsWith("}")) {
    throw new Error("meta.gen.json is not a JSON object — cannot merge the etag field");
  }
  // Textual merge rather than parse+stringify: the schema is ~10 MB and this
  // runs in CI, but more importantly a round-trip through JSON.parse would
  // reorder nothing yet cost a needless 3x memory spike.
  const separator = trimmed === "{}" ? "" : ",";
  const payload = `${trimmed.slice(0, -1)}${separator}"etag":${JSON.stringify(etag)}}`;

  await client.put(metaKey(id), payload);
  await client.put(metaEtagKey(id), etag);
  return etag;
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
      await client.delete(metaKey(entry.id));
      await client.delete(metaEtagKey(entry.id));
      pruned.push(entry.id);
    }
    await client.put(DEPLOYMENTS_KEY, JSON.stringify([...keptOld, ...recent]));
  } else {
    await client.put(DEPLOYMENTS_KEY, JSON.stringify(list));
  }

  return { pruned };
}
