import { setFastDeployKVGetter, setMetaKVGetter } from "@decocms/blocks-admin";
import { getFastDeployKV, getMetaKV } from "./sdk/kvHydration";

/**
 * Reconnects packages/blocks-admin's decofile write-through to this
 * package's Cloudflare KV reader. Call once at site startup (from the
 * site's own setup.ts, alongside createSiteSetup()) — without this call,
 * handleDecofileReload's KV write-through silently no-ops (same as it
 * does today for sites that never configure fast-deploy).
 */
export function setupTanstackFastDeploy(): void {
  setFastDeployKVGetter(getFastDeployKV);
  // Also lets `GET /live/_meta` stream the admin schema out of KV instead of
  // holding it in the isolate. Unlike the decofile getter above this one is not
  // gated on DECO_FAST_DEPLOY — see getMetaKV. Registering it is harmless on a
  // site with no schema in KV: handleMeta just falls back to the bundle.
  setMetaKVGetter(getMetaKV);
}
