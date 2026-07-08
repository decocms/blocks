/**
 * Resolve the fast-deploy KV namespace id from the site's own wrangler config.
 *
 * The worker's `DECO_KV` binding (in `wrangler.jsonc`/`.json`/`.toml`) already
 * names the namespace the runtime reads — so the sync/migrate scripts can use
 * it as the write target instead of requiring a separate `CF_KV_NAMESPACE_ID`
 * env var. Single source of truth: the sync destination can never drift from
 * the binding the worker reads.
 *
 * This makes the scripts near-zero-config inside Cloudflare Workers Builds,
 * where the checkout contains the wrangler config and the build environment
 * already carries account credentials for `wrangler deploy`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonc } from "./jsonc";

interface WranglerKvNamespace {
  binding?: string;
  id?: string;
}

interface WranglerConfig {
  kv_namespaces?: WranglerKvNamespace[];
}

/**
 * Find the KV namespace id bound as `binding` in the wrangler config under
 * `dir`. Checks `wrangler.jsonc`, `wrangler.json`, then `wrangler.toml`.
 * Returns `null` when no config file exists or the binding isn't declared —
 * callers treat that as "no fallback available" and keep their env-var error.
 */
export function kvNamespaceIdFromWrangler(
  dir: string,
  binding = "DECO_KV",
): string | null {
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      const cfg = parseJsonc<WranglerConfig>(fs.readFileSync(file, "utf-8"));
      const entry = cfg.kv_namespaces?.find((ns) => ns.binding === binding);
      if (entry?.id) return entry.id;
    } catch {
      // Malformed config — fall through to other formats / env-var error.
    }
  }

  const tomlFile = path.join(dir, "wrangler.toml");
  if (fs.existsSync(tomlFile)) {
    const id = kvNamespaceIdFromToml(fs.readFileSync(tomlFile, "utf-8"), binding);
    if (id) return id;
  }

  return null;
}

/**
 * Minimal TOML extraction for `[[kv_namespaces]]` tables — enough for the
 * wrangler shape without a TOML dependency:
 *
 *   [[kv_namespaces]]
 *   binding = "DECO_KV"
 *   id = "..."
 */
export function kvNamespaceIdFromToml(src: string, binding: string): string | null {
  const blocks = src.split(/^\s*\[\[kv_namespaces\]\]\s*$/m).slice(1);
  for (const block of blocks) {
    // A block ends at the next table header; only scan up to it.
    const body = block.split(/^\s*\[/m)[0];
    const bindingMatch = body.match(/^\s*binding\s*=\s*"([^"]+)"/m);
    if (bindingMatch?.[1] !== binding) continue;
    const idMatch = body.match(/^\s*id\s*=\s*"([^"]+)"/m);
    if (idMatch?.[1]) return idMatch[1];
  }
  return null;
}
