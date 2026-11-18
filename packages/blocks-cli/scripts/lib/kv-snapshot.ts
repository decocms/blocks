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
  redirectIndexKey,
  redirectKey,
  redirectPathHash,
  redirectPrefix,
  revisionKey,
  snapshotKey,
} from "@decocms/blocks/cms";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ExactRedirect, splitExactRedirects, storedExactRedirectValue } from "@decocms/blocks/sdk/redirects";
import type { KvRestClient } from "./cf-kv-rest";
import { type ReadDecofileResult, readDecofileFromDir } from "./read-decofile";

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

/**
 * A Fresh + deco site: `deno.json(c)` at the root and no `package.json` — the
 * same rule the cfworkers-builder uses to pick its Deno build. Detected here,
 * not passed as a flag, so the builder and the operator's decofile-syncer keep
 * calling the CLI unchanged for every framework.
 */
export function isFreshRepo(dir: string): boolean {
  const hasDenoConfig = fs.existsSync(path.join(dir, "deno.json")) || fs.existsSync(path.join(dir, "deno.jsonc"));
  return hasDenoConfig && !fs.existsSync(path.join(dir, "package.json"));
}

/**
 * Read `blocksDir` and split it into the KV decofile and its exact redirects.
 * The one place both `sync-blocks-to-kv` and `migrate-blocks-to-kv` build what
 * they write, so the two can never disagree on the snapshot.
 *
 * On a Fresh repo, a redirect block whose rules ALL moved to KV is kept as an
 * empty block instead of dropped: Fresh resolves blocks by name, and a routes
 * config that references a dropped `std/x/redirects` block would fail to
 * resolve. TanStack collects redirects by type, so it keeps dropping them.
 */
export function readKvDecofile(
  blocksDir: string,
  repoDir: string,
): ReadDecofileResult & { exact: ExactRedirect[]; fresh: boolean } {
  const fresh = isFreshRepo(repoDir);
  const { blocks, collisions } = readDecofileFromDir(blocksDir, { fresh });
  if (!fresh) {
    const split = splitExactRedirects(blocks);
    return { blocks: split.blocks, collisions, exact: split.exact, fresh };
  }

  return { ...splitFreshRedirects(blocks), collisions, fresh };
}

const FRESH_REDIRECT = "website/loaders/redirect.ts";
const FRESH_COLLECTOR = `"__resolveType":"website/loaders/redirects.ts"`;

/**
 * Fresh applies a redirect only in two ways: a block its routes config
 * references by name (`std/x/redirects`, a `website/loaders/redirects.ts`
 * with props), or a `website/loaders/redirect.ts` block, which the
 * `website/loaders/redirects.ts` collector gathers BY TYPE. A KV key applies
 * to every request, so only the second kind moves: a referenced block, or an
 * orphan one Fresh never applies, stays exactly as Fresh resolves it today.
 *
 * Moved: `website/loaders/redirect.ts` blocks with an exact source, and only
 * when the collector is in the decofile. Kept: `/:param` sources (URLPatterns
 * in Fresh) and absolute URLs (Fresh keys those by the full URL, which no
 * request path matches). A moved block stays, emptied, in case something
 * references it by name.
 */
function splitFreshRedirects(blocks: Record<string, unknown>): { blocks: Record<string, unknown>; exact: ExactRedirect[] } {
  if (!JSON.stringify(blocks).includes(FRESH_COLLECTOR)) return { blocks, exact: [] };
  const candidates: Record<string, unknown> = {};
  for (const [key, block] of Object.entries(blocks)) {
    if ((block as Record<string, unknown> | null)?.__resolveType === FRESH_REDIRECT) {
      candidates[key] = block;
    }
  }
  const split = splitExactRedirects(candidates, {
    keepInDecofile: (from) => from.includes("/:") || /^https?:\/\//.test(from.trim()),
  });
  const out: Record<string, unknown> = {};
  for (const [key, block] of Object.entries(blocks)) {
    // `Object.hasOwn`: a block named `constructor` must not look moved.
    const moved = Object.hasOwn(candidates, key) && !Object.hasOwn(split.blocks, key);
    if (moved) {
      const { redirect: _moved, ...rest } = block as Record<string, unknown>;
      out[key] = rest;
    } else {
      // Kept verbatim: Fresh's loader reads `props.redirect`, not the
      // `redirects: [..]` the split rewrites a kept singular block to.
      out[key] = block;
    }
  }
  return { blocks: out, exact: split.exact };
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
    redirects.map((r) => [redirectKey(id, r.path), JSON.stringify(storedExactRedirectValue(r))]),
  );

  const existing = await client.list(redirectPrefix(id));
  const stale = existing.filter((key) => !desired.has(key));

  if (desired.size > 0) {
    await client.putMany([...desired].map(([key, value]) => ({ key, value })));
  }
  if (stale.length > 0) {
    await client.deleteMany(stale);
  }
  // After the rules, so the index never names a path whose key isn't there yet.
  // Written even when empty: that is what tells the worker to read nothing.
  const hashes = [...new Set(redirects.map((r) => redirectPathHash(r.path)))].sort((a, b) => a - b);
  await client.put(redirectIndexKey(id), JSON.stringify(hashes));

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
      await client.delete(redirectIndexKey(entry.id));
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
