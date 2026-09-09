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
  baseBlocksKey,
  computeRevision,
  DEPLOYMENTS_KEY,
  LIVE_KEY,
  type PageIndexEntry,
  pageBlockKey,
  pageIndexKey,
  revisionKey,
  snapshotKey,
  splitDecofile,
} from "@decocms/blocks/cms";
import type { KvRestClient } from "./cf-kv-rest";

export interface Snapshot {
  /** Serialized decofile written to `decofile:<id>`. */
  snapshot: string;
  /** DJB2 revision written to `index:revision:<id>`. */
  revision: string;
  /** Block count, for logging. */
  count: number;
  /** Serialized non-page blocks written to `blocks:<id>` (the resident half). */
  base: string;
  /** Routing index written to `pageindex:<id>`. */
  index: PageIndexEntry[];
  /** Page blocks, one `page:<id>:<key>` write each. Never held by an isolate. */
  pages: Record<string, string>;
}

/** One entry in the `index:deployments` GC bookkeeping list. */
export interface DeploymentEntry {
  id: string;
  ts: number;
}

export function buildSnapshot(blocks: Record<string, unknown>): Snapshot {
  const { base, index, pages } = splitDecofile(blocks);
  const pageJson: Record<string, string> = {};
  for (const [key, page] of Object.entries(pages)) pageJson[key] = JSON.stringify(page);

  return {
    snapshot: JSON.stringify(blocks),
    revision: computeRevision(blocks),
    count: Object.keys(blocks).length,
    base: JSON.stringify(base),
    index,
    pages: pageJson,
  };
}

/** Concurrency for the per-page KV writes — one REST round-trip each. */
const PAGE_WRITE_CONCURRENCY = 16;

/** Run `task` over `items` with a bounded number of in-flight requests. */
async function pool<T>(items: T[], task: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_WRITE_CONCURRENCY, items.length) }, worker));
}

/**
 * Write deployment `id`'s content in both layouts.
 *
 * Order is load-bearing and the revision goes LAST: a polling isolate only acts
 * on a changed revision, so it can never observe a `pageindex:<id>` whose pages
 * haven't landed, nor a new revision pointing at an old snapshot.
 *
 *   page:<id>:<key>   one per page   ─┐ referenced by the index
 *   blocks:<id>       non-page half   │
 *   pageindex:<id>    routing index  ─┘
 *   decofile:<id>     whole snapshot (admin reads, pre-split fallback)
 *   index:revision:<id>               the commit that makes all of it visible
 */
export async function writeSnapshotToKv(
  client: KvRestClient,
  snap: Snapshot,
  id: string,
  split = false,
): Promise<void> {
  if (!split) {
    // Flag off: whole snapshot only, and DELETE any split keys a previous
    // enabled run left behind. Leaving them would let a reader hydrate a stale
    // base under this fresh revision and then stop polling — the split flag has
    // to mean the same thing on both sides.
    await client.put(snapshotKey(id), snap.snapshot);
    await Promise.all([client.delete(baseBlocksKey(id)), client.delete(pageIndexKey(id))]);
    await client.put(revisionKey(id), snap.revision);
    return;
  }

  await pool(Object.entries(snap.pages), ([key, json]) => client.put(pageBlockKey(id, key), json));
  await client.put(baseBlocksKey(id), snap.base);
  await client.put(pageIndexKey(id), JSON.stringify(snap.index));
  await client.put(snapshotKey(id), snap.snapshot);
  await client.put(revisionKey(id), snap.revision);
}

/** Read both keys for deployment `id` back and confirm the revision matches. */
export async function verifySnapshotInKv(
  client: KvRestClient,
  expectedRevision: string,
  id: string,
  split = false,
): Promise<{ ok: boolean; reason?: string }> {
  const [snapshot, revision, base, index] = await Promise.all([
    client.get(snapshotKey(id)),
    client.get(revisionKey(id)),
    client.get(baseBlocksKey(id)),
    client.get(pageIndexKey(id)),
  ]);
  if (snapshot === null) return { ok: false, reason: `${snapshotKey(id)} missing` };
  // Both split keys or neither: an isolate reads them as a pair, and a half
  // written split is the one state that would serve a torn site.
  if (split && base === null) return { ok: false, reason: `${baseBlocksKey(id)} missing` };
  if (split && index === null) return { ok: false, reason: `${pageIndexKey(id)} missing` };
  if (!split && (base !== null || index !== null)) {
    return { ok: false, reason: `split keys still present for ${id} with the split flag off` };
  }
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
      await client.delete(baseBlocksKey(entry.id));
      await client.delete(pageIndexKey(entry.id));
      // Page keys are per-deployment and there are ~1300 of them, so they'd
      // otherwise accumulate forever. Listed rather than derived from an index
      // we just deleted.
      const pageKeys = await client.list(pageBlockKey(entry.id, ""));
      await pool(pageKeys, (key) => client.delete(key));
      pruned.push(entry.id);
    }
    await client.put(DEPLOYMENTS_KEY, JSON.stringify([...keptOld, ...recent]));
  } else {
    await client.put(DEPLOYMENTS_KEY, JSON.stringify(list));
  }

  return { pruned };
}
