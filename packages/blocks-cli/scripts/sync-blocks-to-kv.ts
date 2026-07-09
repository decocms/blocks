#!/usr/bin/env tsx
/**
 * CI fast-deploy content sync: push the site's current decofile to KV under a
 * DEPLOYMENT ID, WITHOUT a worker redeploy.
 *
 * Content is keyed per deployment (`decofile:<id>` + `index:revision:<id>`, id =
 * git commit sha) so each running version reads its own snapshot. Two roles:
 *
 *   1. Build-time seed (code deploy): `--write --all --deployment-id <sha>`
 *      writes this build's snapshot up-front, then appends `index:deployments`
 *      and GCs old snapshots. The version reads its content the instant it goes
 *      live — no window where new code sees old content.
 *   2. Content-only fast deploy (operator): `--write --all --deployment-id <liveId>`
 *      against the currently-live id — the live isolate's revision poll picks it
 *      up in ~10s.
 *
 * A separate, cheap `--set-live --deployment-id <sha>` run (post-activation, in
 * the deploy step) flips the `index:live` pointer.
 *
 * The default (non-`--all`) mode first checks whether any `.deco/blocks/*.json`
 * changed since a base ref — nothing changed ⇒ exit 0 without writing.
 *
 * Usage:
 *   # build-time seed (whole snapshot for this commit):
 *   CF_ACCOUNT_ID=... CF_KV_NAMESPACE_ID=... CF_API_TOKEN=... \
 *     npx -p @decocms/start deco-sync-blocks-to-kv --write --all --deployment-id "$COMMIT_SHA"
 *   # post-deploy: flip the live pointer
 *   ... deco-sync-blocks-to-kv --set-live --deployment-id "$COMMIT_SHA"
 *
 * Options:
 *   --deployment-id <id>  Deployment id (git commit sha) to key the write under (required to write)
 *   --set-live            Only write `index:live` = <id> (no blocks read); implies a write
 *   --all                 Always sync (skip the git-diff content check)
 *   --since <ref>         Base git ref for the diff (default: HEAD~1)
 *   --blocks-dir <dir>    Input blocks dir (default: .deco/blocks)
 *   --retain <n>          Deployment snapshots to keep for GC (default: 10)
 *   --purge-url <origin>  Site origin to POST /_cache/purge after sync
 *   --purge-token <tok>   Purge bearer token (or PURGE_TOKEN env)
 *   --write               Perform writes (otherwise dry-run, exit 0)
 *   --help, -h            Show this help
 *
 * Env: CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_API_TOKEN (required with --write)
 *
 * Exit codes: 0 ok / no-op / dry-run; 2 error (bad dir, missing env/args, verify failed)
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import { createKvRestClient, kvConfigFromEnv } from "./lib/cf-kv-rest";
import {
  buildSnapshot,
  recordAndGcDeployment,
  setLiveDeployment,
  verifySnapshotInKv,
  writeSnapshotToKv,
} from "./lib/kv-snapshot";
import { readDecofileFromDir } from "./lib/read-decofile";
import { changedBlockFiles, changedBlockKeys, purgePathsForChangedKeys } from "./lib/sync-helpers";

const DEFAULT_RETAIN = 10;

function parseArgs(argv: string[]) {
  const has = (f: string) => argv.includes(f);
  const val = (f: string, d: string) => {
    const i = argv.indexOf(f);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  return {
    help: has("--help") || has("-h"),
    all: has("--all"),
    write: has("--write"),
    setLive: has("--set-live"),
    deploymentId: val("--deployment-id", ""),
    retain: Number(val("--retain", String(DEFAULT_RETAIN))) || DEFAULT_RETAIN,
    since: val("--since", "HEAD~1"),
    blocksDir: val("--blocks-dir", ".deco/blocks"),
    purgeUrl: val("--purge-url", ""),
    purgeToken: val("--purge-token", process.env.PURGE_TOKEN ?? ""),
  };
}

function gitChangedFiles(since: string, blocksDir: string): string[] {
  const out = execSync(`git diff --name-only ${since} HEAD`, { encoding: "utf-8" });
  return changedBlockFiles(out, blocksDir);
}

async function purgeCache(origin: string, token: string, paths: string[]): Promise<void> {
  const res = await fetch(new URL("/_cache/purge", origin).toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) {
    console.warn(`warning: purge failed: ${res.status} ${await res.text()}`);
  } else {
    console.log(`purged ${paths.length} path(s): ${paths.join(", ")}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Usage: deco-sync-blocks-to-kv --deployment-id <sha> [--all] [--set-live] [--write] [--retain 10] [--purge-url <origin>]",
    );
    process.exit(0);
  }

  // A deployment id is mandatory for any write — content is always keyed.
  if (!opts.deploymentId && (opts.write || opts.setLive)) {
    console.error("error: --deployment-id <sha> is required to write to KV.");
    process.exit(2);
  }

  // --set-live: cheap pointer flip only, no blocks read.
  if (opts.setLive) {
    let client: ReturnType<typeof createKvRestClient>;
    try {
      client = createKvRestClient(kvConfigFromEnv(process.env, { wranglerDir: process.cwd() }));
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
    try {
      await setLiveDeployment(client, opts.deploymentId);
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
    console.log(`set index:live → ${opts.deploymentId}.`);
    return;
  }

  const blocksDir = path.resolve(process.cwd(), opts.blocksDir);
  const blocksDirRel = opts.blocksDir;

  // Decide whether there's anything to sync.
  let changedKeys: string[] = [];
  if (!opts.all) {
    let changed: string[];
    try {
      changed = gitChangedFiles(opts.since, blocksDirRel);
    } catch (e) {
      console.error(`error: git diff failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
    if (changed.length === 0) {
      console.log(`no ${blocksDirRel} changes since ${opts.since} — nothing to sync.`);
      process.exit(0);
    }
    changedKeys = changedBlockKeys(changed);
    console.log(`${changed.length} changed block file(s) since ${opts.since}.`);
  }

  let blocks: Record<string, unknown>;
  try {
    blocks = readDecofileFromDir(blocksDir).blocks;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const snap = buildSnapshot(blocks);
  const purgePaths = opts.all ? ["/"] : purgePathsForChangedKeys(blocks, changedKeys);
  console.log(`decofile: ${snap.count} blocks, revision ${snap.revision} → deployment ${opts.deploymentId}`);

  if (!opts.write) {
    console.log(`\nDry-run only. Would write decofile:${opts.deploymentId} + revision, GC to ${opts.retain}, purge: ${purgePaths.join(", ")}`);
    process.exit(0);
  }

  let client: ReturnType<typeof createKvRestClient>;
  try {
    client = createKvRestClient(kvConfigFromEnv(process.env, { wranglerDir: process.cwd() }));
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  try {
    await writeSnapshotToKv(client, snap, opts.deploymentId);
    const verify = await verifySnapshotInKv(client, snap.revision, opts.deploymentId);
    if (!verify.ok) {
      console.error(`error: KV verify failed — ${verify.reason}`);
      process.exit(2);
    }
    const { pruned } = await recordAndGcDeployment(client, opts.deploymentId, Date.now(), opts.retain);
    if (pruned.length) {
      console.log(`GC: pruned ${pruned.length} old snapshot(s): ${pruned.join(", ")}`);
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  console.log(`synced decofile:${opts.deploymentId} (rev ${snap.revision}) → KV.`);

  if (opts.purgeUrl && opts.purgeToken) {
    await purgeCache(opts.purgeUrl, opts.purgeToken, purgePaths);
  } else if (opts.purgeUrl) {
    console.warn("warning: --purge-url given without a token (PURGE_TOKEN/--purge-token) — skipping purge.");
  }
}

main();
