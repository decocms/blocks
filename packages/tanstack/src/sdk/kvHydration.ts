/**
 * Fast-deploy KV hydration — the runtime read path.
 *
 * Bridges a Cloudflare KV namespace to the in-memory decofile so CMS content
 * edits propagate WITHOUT a `wrangler deploy`. Two entry points, both called
 * from `workerEntry.ts`:
 *
 * - `ensureBlocksHydrated(env, ctx)` — on the FIRST request per isolate, load
 *   the whole snapshot from KV and swap it in via `setBlocks()`. Awaited, so it
 *   adds one ~10-30ms cold-start hit per isolate but guarantees fresh content
 *   (the bundled `blocks.gen` snapshot is frozen at the last code deploy).
 *
 * - `maybePollRevision(env, ctx)` — on EVERY request, opportunistically (gated
 *   to once per `POLL_INTERVAL_MS`) probe `index:revision` via `ctx.waitUntil`
 *   so it never blocks the response; reload + swap when it changed.
 *
 * Everything is a no-op unless fast-deploy is enabled (`isFastDeployEnabled`),
 * so non-migrated sites behave exactly as before.
 *
 * Why whole-snapshot swap (not per-block async): the resolver reads
 * `loadBlocks()` synchronously in dozens of places. Loading the entire decofile
 * once and swapping the map keeps that hot path synchronous — KV is touched
 * only on cold start and during the throttled poll. Mirrors the
 * `DecofileProvider` pattern from the deco-cx/deco Fresh runtime.
 */

import { DEPLOYMENT_ID_ENV, getDeploymentId, getRevision, setBlocks } from "@decocms/blocks/cms";
import { KVBlockSource } from "../cms/kvBlockSource";
import type { KVNamespace } from "@decocms/blocks/cms";
import { setSpanAttribute } from "@decocms/blocks/sdk/observability";

/** How often (ms) an isolate re-probes its `index:revision:<id>`. */
export const POLL_INTERVAL_MS = 10_000;

/** KV binding name expected on the Worker `env`. */
export const KV_BINDING = "DECO_KV";

/** Opt-in env var — set to "1" (or "true") to enable fast-deploy. The DECO_KV
 * binding must also be present. */
export const FAST_DEPLOY_ENV = "DECO_FAST_DEPLOY";

// Deployment-id resolution lives in `@decocms/blocks/cms` (next to the key
// builders it feeds) so the runtime read path and the admin write-through
// resolve it identically. Re-exported for the existing call sites/tests.
export { getDeploymentId };

// globalThis-backed state so all Vite server-function split-module copies share
// the same hydration flags (same pattern as `loader.ts`).
const G = globalThis as unknown as {
  __deco?: {
    kvHydrated?: boolean;
    kvHydration?: Promise<void> | null;
    kvLastPolledAt?: number;
  };
};
if (!G.__deco) G.__deco = {};

/** Minimal Cloudflare ExecutionContext shape (matches workerEntry.ts). */
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

type Env = Record<string, unknown>;

function getKV(env: Env): KVNamespace | null {
  const binding = env[KV_BINDING];
  // Duck-type the binding: a real KVNamespace has get/put. Guards against a
  // string/secret accidentally named DECO_KV.
  if (binding && typeof (binding as KVNamespace).get === "function") {
    return binding as KVNamespace;
  }
  return null;
}

/**
 * Resolve the KV namespace used to serve the admin schema (`meta:<id>`).
 *
 * Deliberately NOT gated on `DECO_FAST_DEPLOY`: the schema and the decofile are
 * independent artefacts with independent seeds, and a site may well want one
 * from KV and not the other. The real switch is whether the keys exist —
 * `handleMeta` falls back to the bundled schema when they don't, so a bound-but-
 * unseeded KV degrades to today's behaviour instead of 503ing.
 */
export function getMetaKV(env: Env): KVNamespace | null {
  return getKV(env);
}

/**
 * Fast-deploy is active only when BOTH hold: `DECO_FAST_DEPLOY` is set to "1"
 * (or "true") — an explicit, per-site opt-in — AND the `DECO_KV` binding is
 * present. Either missing ⇒ bundled-snapshot behavior, identical to
 * pre-fast-deploy. Requiring the explicit flag means simply binding a KV
 * namespace can't silently flip a site onto the KV read/write path.
 */
export function isFastDeployEnabled(env: Env): boolean {
  const flag = env[FAST_DEPLOY_ENV];
  if (flag !== "1" && flag !== "true") return false;
  return getKV(env) !== null;
}

/**
 * Resolve the KV namespace for the write-through path, or `null` when
 * fast-deploy is disabled. Shared by `decofile.ts` so the enablement rule
 * lives in exactly one place.
 */
export function getFastDeployKV(env: Env): KVNamespace | null {
  if (!isFastDeployEnabled(env)) return null;
  return getKV(env);
}

// Build-time constant injected by `decoVitePlugin({ fastDeploy: true })`: true
// when `blocks.gen` was stubbed out of THIS server bundle. Declared with a
// `typeof` guard so it's inert wherever the define isn't applied (this
// package's own tsc output, the Next.js build, tests).
declare const __DECO_BLOCKS_STUBBED__: boolean | undefined;

/**
 * Does this bundle ship no decofile of its own?
 *
 * When true, KV is the ONLY source of content, so the "warn and serve bundled"
 * recovery below would serve an EMPTY site — 200s with no pages, which then get
 * edge-cached and outlive the KV failure that caused them. Those cases fail
 * loudly instead.
 *
 * This is deliberately a BUILD-time answer rather than "is the in-memory map
 * empty". The runtime check is not equivalent in three ways:
 *   - `loadBlocks()` composes request-scoped draft/preview overrides, and
 *     `bindRequestDraft` runs before hydration — a draft-preview first request
 *     would make a stubbed bundle look populated, latch, and then serve the
 *     empty base decofile for the isolate's life.
 *   - A legitimately-empty decofile (new site, missing `blocks.gen.json`) would
 *     look stubbed, turning a previously-warning default site into 5xx.
 *   - An empty snapshot in KV can't be distinguished from a healthy one.
 */
function bundleHasNoDecofile(): boolean {
  return typeof __DECO_BLOCKS_STUBBED__ !== "undefined" && __DECO_BLOCKS_STUBBED__ === true;
}

/**
 * Cold-start hydration. Awaits the KV snapshot once per isolate and swaps it
 * into the in-memory block map. Concurrent first requests share a single
 * in-flight load.
 *
 * On failure (KV outage, bad JSON, snapshot not seeded) the behavior depends on
 * whether a bundled snapshot exists:
 *
 * - Bundled present (default): warn, serve bundled, mark hydration done —
 *   `maybePollRevision` recovers once KV is reachable again.
 * - Bundled stubbed out (`fastDeploy`): throw. There is no content to serve, so
 *   a 5xx is the only honest answer; hydration is left unlatched so the next
 *   request retries instead of pinning the isolate to an empty decofile.
 */
export function ensureBlocksHydrated(env: Env, _ctx?: ExecutionContextLike): Promise<void> {
  if (!isFastDeployEnabled(env)) return Promise.resolve();
  if (G.__deco!.kvHydrated) return Promise.resolve();
  if (G.__deco!.kvHydration) return G.__deco!.kvHydration;

  const kv = getKV(env);
  if (!kv) return Promise.resolve();

  // No resolvable deployment id ⇒ keep the bundled snapshot (this build's own
  // content). Never read another deployment's key.
  const deploymentId = getDeploymentId(env);
  if (!deploymentId) {
    if (bundleHasNoDecofile()) {
      return Promise.reject(
        new Error(
          `[CMS/KV] no deployment id (set ${DEPLOYMENT_ID_ENV}) and this bundle ships no decofile`,
        ),
      );
    }
    setSpanAttribute("deco.block.source", "bundled");
    G.__deco!.kvHydrated = true;
    return Promise.resolve();
  }

  const load = (async () => {
    // Held rather than rethrown inline so the `finally` below can decide
    // whether to latch — latching on a fatal path would serve an empty
    // decofile for the isolate's entire life.
    let fatal: Error | null = null;
    try {
      const snapshot = await new KVBlockSource(kv, deploymentId).loadSnapshot();
      // An empty snapshot is treated as a failure, not a success: with no
      // bundled decofile it would otherwise latch and serve exactly the empty,
      // edge-cached site this guard exists to prevent. A site legitimately has
      // blocks; `{}` means the seed wrote nothing.
      const empty = !snapshot || Object.keys(snapshot.blocks).length === 0;
      if (!empty) {
        setBlocks(snapshot!.blocks);
        setSpanAttribute("deco.block.source", "kv");
      } else if (!bundleHasNoDecofile()) {
        setSpanAttribute("deco.block.source", "bundled");
      } else {
        fatal = new Error(
          `[CMS/KV] decofile:${deploymentId} ${snapshot ? "is empty" : "not found"} and this ` +
            `bundle ships no decofile — seed it before activating this version`,
        );
      }
    } catch (e) {
      if (!bundleHasNoDecofile()) {
        // Non-fatal: serve the bundled snapshot. The poll loop recovers later.
        console.warn("[CMS/KV] cold-start hydration failed, using bundled snapshot:", e);
        setSpanAttribute("deco.block.source", "bundled");
      } else {
        fatal = e instanceof Error ? e : new Error(String(e));
      }
    } finally {
      G.__deco!.kvHydrated = !fatal;
      G.__deco!.kvHydration = null;
    }
    if (fatal) throw fatal;
  })();

  G.__deco!.kvHydration = load;
  return load;
}

/**
 * Opportunistic revision poll. Throttled to once per `POLL_INTERVAL_MS` and run
 * through `ctx.waitUntil` so it never adds latency to the response. Reloads the
 * snapshot and swaps it in when KV's revision differs from the in-memory one.
 */
export function maybePollRevision(env: Env, ctx?: ExecutionContextLike): void {
  if (!isFastDeployEnabled(env)) return;
  if (!G.__deco!.kvHydrated) return; // wait until cold-start hydration finished

  const now = Date.now();
  if (now - (G.__deco!.kvLastPolledAt ?? 0) < POLL_INTERVAL_MS) return;
  G.__deco!.kvLastPolledAt = now;

  const kv = getKV(env);
  if (!kv) return;

  const deploymentId = getDeploymentId(env);
  if (!deploymentId) return; // bundled-only; nothing to poll

  const poll = pollRevisionOnce(kv, deploymentId);
  // Prefer waitUntil so the work outlives the response; fall back to a
  // fire-and-forget promise (dev / tests) with its rejection swallowed.
  if (ctx?.waitUntil) ctx.waitUntil(poll);
  else void poll.catch(() => {});
}

async function pollRevisionOnce(kv: KVNamespace, deploymentId: string): Promise<void> {
  try {
    const source = new KVBlockSource(kv, deploymentId);
    const remoteRevision = await source.getRevision();
    if (!remoteRevision || remoteRevision === getRevision()) return;

    const snapshot = await source.loadSnapshot();
    if (snapshot) {
      setBlocks(snapshot.blocks);
      console.info(`[CMS/KV] decofile refreshed → revision ${snapshot.revision}`);
    }
  } catch (e) {
    // Swallow — a failed poll must never affect the request. Next tick retries.
    console.warn("[CMS/KV] revision poll failed:", e);
  }
}

/** Test-only: reset the isolate-level hydration flags. */
export function __resetKvHydrationStateForTests(): void {
  G.__deco!.kvHydrated = false;
  G.__deco!.kvHydration = null;
  G.__deco!.kvLastPolledAt = 0;
}
