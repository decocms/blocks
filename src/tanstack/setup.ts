import { setBlocksOverrideStore } from "../core/cms/loader";
import { createAlsRequestStore } from "./runtime/alsRequestStore";

let installed = false;

/**
 * Install ALS-backed runtime stores for the TanStack/Cloudflare Worker host.
 * Idempotent — safe to call multiple times.
 */
export function installTanStackRuntime(): void {
  if (installed) return;
  installed = true;
  setBlocksOverrideStore(createAlsRequestStore<Record<string, unknown>>());
}
