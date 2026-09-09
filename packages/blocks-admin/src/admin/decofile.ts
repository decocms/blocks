import {
  baseBlocksKey,
  computeRevision,
  type DecoPage,
  getDeploymentId,
  getRevision,
  hasPageSource,
  isBlocksSplitEnabled,
  loadBlocks,
  pageBlockKey,
  pageIndexKey,
  revisionKey,
  setBlocks,
  setPageSource,
  snapshotKey,
  splitDecofile,
} from "@decocms/blocks/cms";
import { clearLoaderCache } from "@decocms/blocks/sdk/cachedLoader";
import { getRuntimeEnv } from "@decocms/blocks/sdk/otelAdapters";
import { invalidateMetaCache } from "./meta";

interface FastDeployKV {
  get(key: string, options?: { type?: "text"; cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

type FastDeployKVGetter = (env: Record<string, unknown>) => FastDeployKV | null;

let getFastDeployKV: FastDeployKVGetter = () => null;

/**
 * Inject the fast-deploy KV getter. Fast-deploy is Cloudflare/tanstack-only —
 * `admin` cannot depend on `tanstack`'s `sdk/kvHydration`
 * directly (that dependency direction is backwards), so the site's own
 * setup wiring calls this once at startup, e.g.
 * `setFastDeployKVGetter(getFastDeployKV)` from its own
 * `sdk/kvHydration`. `next` never calls it, so the KV write-through
 * below silently no-ops there.
 */
export function setFastDeployKVGetter(getter: FastDeployKVGetter): void {
  getFastDeployKV = getter;
}

/**
 * Serve the WHOLE decofile.
 *
 * In split mode `loadBlocks()` is only the non-page half, so this reads the
 * full snapshot KV keeps alongside the split keys rather than reassembling
 * 1300 page keys. Falls back to memory when there's no KV (dev, Next.js) or
 * the key is gone — a partial decofile is a better answer to the admin than a
 * 500, and the split keys stay the source of truth for rendering either way.
 */
export async function handleDecofileRead(env?: Record<string, unknown>): Promise<Response> {
  const blocks = (await readFullDecofile(env ?? getRuntimeEnv())) ?? loadBlocks();
  const revision = getRevision();

  return new Response(JSON.stringify(blocks), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      ...(revision ? { ETag: `"${revision}"` } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Delta payloads
//
// Studio (admin.deco.cx) and CI can POST a partial update instead of the whole
// decofile. The delta envelope is:
//
//   { "blocks": { "<blockName>": <blockJson> | null, ... } }
//
// where a `null` value deletes that block. A delta is identified by a body that
// has EXACTLY one top-level key, `blocks`, holding an object — a full decofile
// always carries many top-level block keys (Site, pages-*, …), so there is no
// realistic collision. Any other object body is treated as a full decofile
// replacement (backward-compatible with the dev Vite plugin).
// ---------------------------------------------------------------------------

interface DeltaPayload {
  blocks: Record<string, unknown | null>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isDeltaPayload(body: unknown): body is DeltaPayload {
  return isObject(body) && Object.keys(body).length === 1 && isObject(body.blocks);
}

/** Apply a delta over the current decofile: set non-null values, delete nulls. */
function applyDelta(
  base: Record<string, unknown>,
  delta: Record<string, unknown | null>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [name, value] of Object.entries(delta)) {
    if (value === null || value === undefined) {
      delete merged[name];
    } else {
      merged[name] = value;
    }
  }
  return merged;
}

/**
 * Write the current in-memory decofile snapshot to KV so other isolates of the
 * SAME deployment pick it up on their next revision poll. No-op (returns false)
 * when fast-deploy is disabled or no deployment id resolves. Writes this
 * worker's OWN keyed entry (`decofile:<id>`) — it is the live version, so no
 * `index:live` lookup is needed. The revision stored MUST equal the runtime's
 * `getRevision()` so pollers don't see a permanent mismatch.
 */
/**
 * Above this many changed pages a publish stops writing the split layout from
 * inside a Worker: each page is one KV write, and a Worker request has a hard
 * subrequest budget. A Studio publish touches a handful of pages, so this only
 * ever trips on a full re-seed — which is the CI sync script's job.
 */
const MAX_PAGE_WRITES_PER_PUBLISH = 500;

/** Resolve the KV binding + deployment id, or `null` when fast-deploy is off. */
function fastDeployTarget(
  env: Record<string, unknown> | undefined,
): { kv: FastDeployKV; id: string } | null {
  const kv = env ? getFastDeployKV(env) : null;
  if (!kv || !env) return null;
  const id = getDeploymentId(env);
  return id ? { kv, id } : null;
}

/** Read the whole decofile from KV, or `null` when unavailable/malformed. */
async function readFullDecofile(
  env: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | null> {
  const target = fastDeployTarget(env);
  if (!target) return null;
  try {
    const raw = await target.kv.get(snapshotKey(target.id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (e) {
    console.warn("[CMS/KV] could not read the full decofile for a publish:", e);
    return null;
  }
}

/**
 * Persist a published decofile to KV in BOTH layouts and re-apply it locally.
 *
 * Write order is load-bearing: page bodies first, then the base and index that
 * reference them, then the whole snapshot, and the revision LAST. A poller only
 * acts on a changed revision, so it can never observe an index that points at
 * pages which haven't landed yet.
 *
 * Only pages whose JSON actually changed are written — a Studio publish sends
 * the whole decofile but edits one page, and re-uploading 1300 unchanged page
 * keys would blow the request's subrequest budget for nothing.
 */
async function writeSnapshotToKV(
  env: Record<string, unknown> | undefined,
  nextBlocks: Record<string, unknown>,
  previousBlocks: Record<string, unknown>,
): Promise<boolean> {
  const target = fastDeployTarget(env);
  if (!target) return false;
  const { kv, id } = target;

  const revision = getRevision() ?? computeRevision(nextBlocks);
  const { base, index, pages } = splitDecofile(nextBlocks);

  const changed = Object.keys(pages).filter(
    (key) => JSON.stringify(pages[key]) !== JSON.stringify(previousBlocks[key]),
  );

  const splitEnabled = isBlocksSplitEnabled(env);
  if (!splitEnabled || changed.length > MAX_PAGE_WRITES_PER_PUBLISH) {
    // Either the flag is off, or this publish is too big to split from inside a
    // Worker. Both take the same exit: write the whole snapshot and DELETE the
    // split keys, so a reader can't hydrate a stale base under a fresh revision
    // and then stop polling. The CI sync re-seeds the split layout.
    if (splitEnabled) {
      console.warn(
        `[CMS/KV] ${changed.length} pages changed (> ${MAX_PAGE_WRITES_PER_PUBLISH}) — writing the ` +
          `whole snapshot only and clearing the split keys; re-run the KV sync to restore them`,
      );
    }
    await kv.put(snapshotKey(id), JSON.stringify(nextBlocks));
    await Promise.all([kv.delete(baseBlocksKey(id)), kv.delete(pageIndexKey(id))]);
    await kv.put(revisionKey(id), revision);
    setPageSource(null);
    setBlocks(nextBlocks, revision);
    return true;
  }

  for (const key of changed) {
    await kv.put(pageBlockKey(id, key), JSON.stringify(pages[key]));
  }
  await kv.put(baseBlocksKey(id), JSON.stringify(base));
  await kv.put(pageIndexKey(id), JSON.stringify(index));
  await kv.put(snapshotKey(id), JSON.stringify(nextBlocks));
  await kv.put(revisionKey(id), revision);

  // Re-apply locally WITHOUT the pages. Publishing must not be the one request
  // that pins the whole decofile into this isolate for the rest of its life.
  setBlocks(base, revision);
  setPageSource({
    index,
    load: async (key) => {
      const raw = await kv.get(pageBlockKey(id, key));
      return raw === null ? null : (JSON.parse(raw) as DecoPage);
    },
  });
  return true;
}

export async function handleDecofileReload(
  request: Request,
  env?: Record<string, unknown>,
): Promise<Response> {
  // Resolve the runtime env once. Prefer an explicitly-passed env, then the
  // per-request Workers env stashed by workerEntry (`setRuntimeEnv`). Used for
  // both the reload token and the fast-deploy KV binding.
  const runtimeEnv = env ?? getRuntimeEnv();

  // In dev mode the Vite plugin (tanstack) or `next dev` POSTs new blocks
  // here to hot-reload without module invalidation (which breaks TanStack
  // Start/Router state). Skip auth so the plugin can POST from localhost.
  //
  // `import.meta.env?.DEV` was a Vite-ism AND a syntax error for CJS
  // consumers (ts-jest compiles this raw-TS package to CJS, where
  // `import.meta` cannot be represented at all). It was also always `false`
  // under Next.js — Turbopack/webpack never define `import.meta.env` — so
  // this dev-bypass never applied to `next dev` before this change. Checking
  // NODE_ENV instead widens the bypass to any Node process with
  // NODE_ENV=development, including `next dev`. That widening is intentional:
  // dev environments shouldn't need a production reload token, and the check
  // remains fail-closed (auth required) for any other NODE_ENV value (unset,
  // "test", "production").
  const isDevRuntime = typeof process !== "undefined" && process.env.NODE_ENV === "development";
  if (!isDevRuntime) {
    const authHeader = request.headers.get("Authorization") || "";
    const expectedToken =
      (runtimeEnv?.DECO_RELEASE_RELOAD_TOKEN as string | undefined) ??
      (typeof globalThis.process !== "undefined"
        ? globalThis.process.env?.DECO_RELEASE_RELOAD_TOKEN
        : undefined);

    if (!expectedToken || authHeader !== expectedToken) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!isObject(body)) {
    return new Response(JSON.stringify({ error: "Body must be a JSON object" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // The delta base must be the WHOLE decofile. In split mode `loadBlocks()` is
  // only the non-page half, and merging a delta onto that would publish a
  // decofile with every page deleted. Read the full snapshot from KV instead;
  // outside split mode this is null and memory is still the base, as before.
  const previousBlocks =
    (hasPageSource() ? await readFullDecofile(runtimeEnv) : null) ?? loadBlocks();
  const previousBlockCount = Object.keys(previousBlocks).length;

  // Delta merge (partial update) or full decofile replacement.
  let nextBlocks: Record<string, unknown>;
  let isDelta: boolean;
  if (isDeltaPayload(body)) {
    nextBlocks = applyDelta(previousBlocks, body.blocks);
    isDelta = true;
  } else {
    nextBlocks = body;
    isDelta = false;
  }

  // Apply in full first so this isolate is correct even if the KV write below
  // fails. `writeSnapshotToKV` re-applies the split (pages back out of memory)
  // on success.
  setBlocks(nextBlocks);
  // Invalidate the meta ETag so the admin re-fetches the schema on next poll.
  invalidateMetaCache();
  // Clear stale loader cache entries after decofile update
  clearLoaderCache();

  // Fast-deploy: persist the new snapshot to KV so other isolates converge.
  // A failed KV write does NOT fail the request — this isolate is already
  // updated; we surface `kvWritten: false` so the caller can retry.
  let kvWritten = false;
  try {
    kvWritten = await writeSnapshotToKV(runtimeEnv, nextBlocks, previousBlocks);
  } catch (e) {
    console.warn("[CMS/KV] write-through after publish failed:", e);
  }

  const newBlockCount = Object.keys(nextBlocks).length;
  const revision = getRevision();

  return new Response(
    JSON.stringify({
      ok: true,
      mode: isDelta ? "delta" : "full",
      previousBlockCount,
      newBlockCount,
      revision,
      kvWritten,
      timestamp: Date.now(),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
