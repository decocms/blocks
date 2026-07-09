/**
 * Read the KV namespace id for a binding straight out of a site's wrangler
 * config, so the fast-deploy sync scripts need no `CF_KV_NAMESPACE_ID` env when
 * run at the repo root (e.g. inside Cloudflare Workers Builds). Supports
 * `wrangler.jsonc` / `wrangler.json` (preferred) and `wrangler.toml`.
 *
 * The namespace id is the one value CF Workers Builds does NOT inject into the
 * build env — but it's declared right here in the worker config, next to the
 * `DECO_KV` binding.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonc } from "./jsonc";

const DEFAULT_BINDING = "DECO_KV";

interface KvNamespaceEntry {
  binding?: string;
  id?: string;
}

/** Resolve the KV namespace id for `binding` from the wrangler config in `dir`,
 * or `null` when no config / binding is found. */
export function kvNamespaceIdFromWrangler(dir: string, binding = DEFAULT_BINDING): string | null {
  for (const file of ["wrangler.jsonc", "wrangler.json"]) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) {
      try {
        const parsed = parseJsonc<{ kv_namespaces?: KvNamespaceEntry[] }>(
          fs.readFileSync(p, "utf-8"),
        );
        const id = findKvId(parsed.kv_namespaces, binding);
        if (id) return id;
      } catch {
        // Malformed config — fall through to the next candidate / return null.
      }
    }
  }
  const toml = path.join(dir, "wrangler.toml");
  if (fs.existsSync(toml)) {
    return kvNamespaceIdFromToml(fs.readFileSync(toml, "utf-8"), binding);
  }
  return null;
}

function findKvId(entries: KvNamespaceEntry[] | undefined, binding: string): string | null {
  if (!Array.isArray(entries)) return null;
  for (const e of entries) {
    if (e && e.binding === binding && typeof e.id === "string" && e.id) return e.id;
  }
  return null;
}

/** Parse `[[kv_namespaces]]` table-array blocks from a `wrangler.toml` string
 * and return the id whose `binding` matches. Exported for unit tests. */
export function kvNamespaceIdFromToml(src: string, binding = DEFAULT_BINDING): string | null {
  // Split on the [[kv_namespaces]] header; each following chunk is one block
  // until the next table header ("\n[").
  const blocks = src.split(/\[\[\s*kv_namespaces\s*\]\]/).slice(1);
  for (const block of blocks) {
    const body = block.split(/\n\s*\[/)[0];
    if (matchTomlString(body, "binding") === binding) {
      const id = matchTomlString(body, "id");
      if (id) return id;
    }
  }
  return null;
}

function matchTomlString(body: string, key: string): string | null {
  const m = body.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*["']([^"']+)["']`));
  return m ? m[1] : null;
}
