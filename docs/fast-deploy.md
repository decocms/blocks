# Fast Deploy — KV-First Content Delivery

Decouple CMS **content** updates from worker **code** deploys. Content is served
from Cloudflare KV with the bundled `blocks.gen` snapshot as fallback; only code
changes trigger `wrangler deploy`. Studio publishes propagate in seconds instead
of a full CI + redeploy cycle.

## How it works (per-deployment whole-snapshot swap)

The CMS resolver reads `loadBlocks()` **synchronously** in many hot-path places.
Rather than make all of that async, KV stores the **entire decofile as one
value**, keyed by **deployment id** (the git commit sha); each isolate loads its
own deployment's snapshot once on cold start and swaps the in-memory map via
`setBlocks()`. The resolution hot path stays synchronous — KV is touched only on
cold start and during a throttled revision poll.

**Why keyed by deployment id.** A single global key can't stay consistent across
a rolling code deploy: while v2 is going live, v1 is still serving and *also*
reads the same key. Keying by deployment id means each version only ever reads
*its own* content (`decofile:<id>`), so a deploy can seed content at build time
with zero code/content-mismatch window, and rolling back to an old version reads
its still-present snapshot for free.

```
COLD START (per isolate)   first req → await KV decofile:<own id> → setBlocks()
                           (no id resolvable / key missing → bundled snapshot)
EVERY REQUEST              throttled (10s) ctx.waitUntil poll of index:revision:<id>
                           → reload + setBlocks() when it changed
RESOLUTION                 loadBlocks() — in-memory, synchronous (unchanged)
PUBLISH (POST /.decofile)  merge delta → setBlocks() → write decofile:<own id> →
                           sibling isolates converge within one poll interval
KV DOWN / key absent       serve the bundled blocks.gen snapshot (this build's own
                           content — always coherent, never another deploy's)
```

## KV data model (one namespace per site, keyed by deployment id)

| Key | Value | Writer |
|-----|-------|--------|
| `decofile:<id>` | full decofile JSON for deployment `<id>` (`<id>` = commit sha) | build-time sync; content-push sync |
| `index:revision:<id>` | DJB2 hex hash of that snapshot — polled for change detection | same |
| `index:live` | the currently-live `<id>` (pointer) | deploy step, **post-activation** |
| `index:deployments` | JSON `[{id, ts}]` (newest last) — GC bookkeeping | build-time sync |

`index:revision:<id>` **must** equal `computeRevision(blocks)`
(`packages/blocks/src/cms/blockSource.ts`, DJB2 over `JSON.stringify`) — the
runtime, the write-through path, and the CI scripts all use that one function so
a hydrating isolate computes a matching revision and the poller doesn't loop. Key
builders (`snapshotKey`/`revisionKey`) + `LIVE_KEY`/`DEPLOYMENTS_KEY` +
`getDeploymentId` are exported from `@decocms/blocks/cms` as the single source of
truth for the key layout.

## Feature flag

Activation requires **both**, by design:

1. `DECO_FAST_DEPLOY = "1"` (or `"true"`) — an explicit per-site opt-in, and
2. the **`DECO_KV` binding** present on the Worker `env`.

With either missing, behavior is identical to today (bundled snapshot only).
Requiring the explicit flag means simply binding a KV namespace can never
silently flip a site onto the KV read/write path. To disable, unset
`DECO_FAST_DEPLOY` (or set it to `"0"`).

```toml
# wrangler.toml (per migrated site)
[[kv_namespaces]]
binding = "DECO_KV"
id = "<namespace id>"

[vars]
DECO_FAST_DEPLOY = "1"
# DECO_DEPLOYMENT_ID is NOT set statically here — the deploy command passes it
# per deploy (`wrangler deploy --var DECO_DEPLOYMENT_ID:$COMMIT_SHA`).
```

## Read path (runtime)

- `packages/blocks/src/cms/blockSource.ts` (`@decocms/blocks/cms`) — `BlockSource`
  interface, `BundledBlockSource`, `computeRevision`, key builders
  (`snapshotKey`/`revisionKey`) + `LIVE_KEY`/`DEPLOYMENTS_KEY`, `getDeploymentId`,
  minimal `KVNamespace` type. (Generic/framework-agnostic.)
- `packages/tanstack/src/cms/kvBlockSource.ts` — `KVBlockSource(kv, deploymentId)`
  reads `decofile:<id>` + `index:revision:<id>`. (Cloudflare-KV-specific; lives in
  `tanstack` since fast-deploy is a `@decocms/tanstack`-only feature.)
- `packages/tanstack/src/sdk/kvHydration.ts` — `ensureBlocksHydrated(env, ctx)`
  (cold start), `maybePollRevision(env, ctx)` (throttled `waitUntil` poll),
  `isFastDeployEnabled` (re-exports `getDeploymentId`).
- Wired into `packages/tanstack/src/sdk/workerEntry.ts` `handleRequest`, before admin routes.

**Deployment id resolution** (`getDeploymentId`): `env.DECO_DEPLOYMENT_ID` →
`env.BUILD_HASH` → the build-time `__DECO_BUILD_HASH__` constant. If none
resolves, the worker serves the **bundled** snapshot and never touches KV — so it
can only ever read *its own* content, never another deployment's.

Cold start **awaits** this deployment's KV snapshot (one ~10–30ms hit per
isolate) to pick up any content published since the build; the bundled snapshot
(same commit) is the fallback if the key is absent.

## Write path (publish)

`POST /.decofile` (`packages/blocks-admin/src/admin/decofile.ts` → `handleDecofileReload`) accepts:

- **Delta** envelope (preferred): `{ "blocks": { "<name>": <json> | null } }` —
  `null` deletes a block. Identified by a body with exactly one top-level key,
  `blocks`, holding an object.
- **Full** decofile map (backward-compatible; dev Vite plugin path).

It merges → `setBlocks()` (immediate local visibility + revision bump), then
writes `decofile:<id>` + `index:revision:<id>` for **this worker's own
deployment** (`getDeploymentId(env)`) to `DECO_KV` (resolved via
`getRuntimeEnv()`) — it's the live version, so no `index:live` lookup is needed.
Response includes `mode` (`"delta"`/`"full"`), `revision`, and `kvWritten`. A
failed KV write does not fail the request (`kvWritten:false`); the caller may
retry. `kvWritten` is also `false` when no deployment id resolves. Cache purge is
a **separate** `POST /_cache/purge` call.

## CI scripts

- `deco-migrate-blocks-to-kv` (`packages/blocks-cli/scripts/migrate-blocks-to-kv.ts`) — one-shot KV
  population from `.deco/blocks/*.json` for a given `--deployment-id`. Dry-run by
  default; `--write` applies and verifies. Run once to seed the first deployment.
- `deco-sync-blocks-to-kv` (`packages/blocks-cli/scripts/sync-blocks-to-kv.ts`) — content sync, keyed
  by `--deployment-id <sha>` (required to write):
  - `--write --all` writes the whole snapshot under `decofile:<id>`, bumps
    `index:revision:<id>`, appends `index:deployments`, and GCs snapshots beyond
    the last `--retain` (default 10; the currently-live id is never pruned).
  - `--set-live` writes only the `index:live` pointer (cheap; run post-deploy).
  - default (no `--all`) skips when no `.deco/blocks/*.json` changed since
    `--since`; `--all` always writes. Optionally `POST`s `/_cache/purge`.

Both use the KV REST API (no Worker binding at sync time) — env `CF_ACCOUNT_ID`,
`CF_KV_NAMESPACE_ID`, `CF_API_TOKEN`. Running `deco-sync-blocks-to-kv` (rather than a
re-implementation in another language) is **required for correctness**: the runtime
recomputes the revision as `djb2Hex(JSON.stringify(blocks))` on `setBlocks()` and the poll
compares against KV's `index:revision:<id>`, so the writer must produce a byte-identical
serialization. This script is that writer.

## Per-site build & deploy commands (Cloudflare Workers Builds)

Content is seeded at **build time** (keyed to this commit) and the live pointer is
flipped at **deploy time** (post-activation), so a code deploy never has a window
where new code reads old content:

```bash
# Build command — seed this commit's content BEFORE it goes live:
<your build> && npx -p @decocms/blocks-cli deco-sync-blocks-to-kv \
  --write --all --deployment-id "$WORKERS_CI_COMMIT_SHA"

# Deploy command — activate, then flip the live pointer:
wrangler deploy --var DECO_DEPLOYMENT_ID:"$WORKERS_CI_COMMIT_SHA" \
  && npx -p @decocms/blocks-cli deco-sync-blocks-to-kv \
       --set-live --deployment-id "$WORKERS_CI_COMMIT_SHA"
```

KV creds in Workers Builds come from the CI env (`CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_API_TOKEN`; the default build token includes *Workers KV Storage:
Edit*) — map them to `CF_ACCOUNT_ID`/`CF_API_TOKEN` and set `CF_KV_NAMESPACE_ID`
to the site's namespace. Use the commit-sha var your builder exposes
(`WORKERS_CI_COMMIT_SHA` in Cloudflare Workers Builds). The `--var
DECO_DEPLOYMENT_ID` at deploy tells the running worker which key to read; if
omitted it falls back to `BUILD_HASH` / `__DECO_BUILD_HASH__` (also the commit
sha), so the build-time seed is still found.

## Cross-repo contracts (implemented elsewhere)

Content sync to KV is driven by **git push**, handled end-to-end by the **deco operator** —
no GitHub Actions, no studio, no admin. The operator runs the `deco-sync-blocks-to-kv` script
inside a short-lived, self-cleaning Kubernetes Job.

**deco operator** (entry point + executor):
1. Hosts a signature-verified `POST /webhooks/github`. On a push that touches only
   `.deco/blocks/**` for a `cloudflare-worker` site with fast-deploy enabled, a
   `DeploymentTarget` impl (`cloudflare-workers`) resolves the site's KV config
   (`kvNamespaceId`, `siteOrigin`) from the repo's `Deco` CR and creates/updates a `Decofile`
   CR (`target: tanstack-kv`, `repo`, `commit`). Code changes take the normal build path.
2. Watches the `Decofile` CR. A `FastDeployment` impl (`tanstack-kv`, dispatched by the CR's
   target) first resolves the site's **live deployment id** (reads `index:live` from the KV
   namespace via REST) — if the pointer is unset (no code deploy yet) it reports `Waiting` and
   requeues. Otherwise it creates a self-cleaning `batch/v1` Job (the minimal `decofile-syncer`
   image) with `DEPLOYMENT_ID=<liveId>` that clones `repo@commit` and runs `npx -p
   @decocms/blocks-cli deco-sync-blocks-to-kv --write --all --deployment-id "$DEPLOYMENT_ID"
   --purge-url … --purge-token …`, updating the **live** version's `decofile:<liveId>`.
   `ttlSecondsAfterFinished` reaps the Job/pod; status lands on the CR.

Both the webhook→CR step and the CR→effect step are **interfaces**, so new deploy targets and
new execution strategies (e.g. a future warm-pool sandbox impl behind `FastDeployment`) plug
in without reworking the flow.

**Studio live-edit path (parallel, unchanged):** an in-Studio publish still `POST`s a delta
envelope to the site's `/.decofile` (worker write-through) + `/_cache/purge`. The worker writes
its OWN deployment's key (`decofile:<its id>`) — the live version — so a live edit lands on the
same key the operator's content-push targets; last-write-wins on the djb2 revision.

**Site prerequisites:** provision a KV namespace + `DECO_KV` binding + `DECO_FAST_DEPLOY=1`;
set the build/deploy commands above (seed keyed content, pass `DECO_DEPLOYMENT_ID`, flip
`index:live`); record `kvNamespaceId`/`fastDeployEnabled`/`siteOrigin` on the site's `Deco` CR;
configure the repo's GitHub webhook (push on `main`) → operator `/webhooks/github`.
`regen-blocks.yml` (bundled snapshot) is unchanged.

## Rollout & rollback

Greenfield — no migration. 1. Ship the framework (flag off everywhere → inert).
2. On one playground site set the build/deploy commands + `DECO_FAST_DEPLOY=1` + binding; deploy
and verify `decofile:<sha>`/`index:revision:<sha>`/`index:live`, reads, latency. 3. One
production site; monitor a week. 4. Set `fastDeployEnabled` on the site's `Deco` CR + configure
its GitHub webhook. 5. Batch-roll out. First deploy per site seeds its keyed content — no legacy
keys to clean up.

**Rollback (content):** re-deploying an older commit reads its still-present
`decofile:<oldSha>` (code + content coherent) — near-free, no re-sync. **Rollback (disable):**
unset `DECO_FAST_DEPLOY` / set it to `"0"` (or remove the `DECO_KV` binding) → the worker serves
the bundled snapshot immediately.

## Known limitations

- **Module-level `loadBlocks()` consumers** (e.g. `loadRedirects(loadBlocks())`
  at the top of a worker-entry) read the *bundled* snapshot at module init,
  before KV hydration — they won't see KV updates. Move such reads into the
  request path (or re-run on `onChange`) to fast-deploy them.
- Sub-ms revision polling via the Cache API and per-block granular KV reads are
  possible future optimizations; the `BlockSource` interface leaves room for them.
