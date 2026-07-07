import { setFastDeployKVGetter } from "@decocms/blocks-admin";
import { getFastDeployKV } from "./sdk/kvHydration";

/**
 * Reconnects packages/blocks-admin's decofile write-through to this
 * package's Cloudflare KV reader. Call once at site startup (from the
 * site's own setup.ts, alongside createSiteSetup()) — without this call,
 * handleDecofileReload's KV write-through silently no-ops (same as it
 * does today for sites that never configure fast-deploy).
 */
export function setupTanstackFastDeploy(): void {
  setFastDeployKVGetter(getFastDeployKV);
}
