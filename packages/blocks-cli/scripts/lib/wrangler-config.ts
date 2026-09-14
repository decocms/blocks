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

/**
 * Set the `id` of a `kv_namespaces` entry in a `wrangler.jsonc` SOURCE string,
 * preserving comments and formatting.
 *
 * Deliberately text-level rather than parse-and-restringify: the scaffolded
 * `wrangler.jsonc` carries the comments explaining why each binding exists, and
 * a round-trip through `JSON.parse`/`stringify` would drop every one of them.
 *
 * Returns the original string unchanged when the binding is absent — callers
 * treat that as "nothing to personalize", never as an error, because the
 * builder re-forces the id from `CF_KV_NAMESPACE_ID` on every build anyway.
 */
export function setKvNamespaceIdInJsonc(
  src: string,
  id: string,
  binding = DEFAULT_BINDING,
): string {
  // Match the object literal holding this binding, in either field order, and
  // rewrite only its `id` value. Bounded to a single `{...}` so it cannot reach
  // past the entry into the next one.
  const entry = new RegExp(`\\{[^{}]*?"binding"\\s*:\\s*"${binding}"[^{}]*?\\}`, "s");
  const m = src.match(entry);
  if (!m) return src;

  const patched = m[0].includes('"id"')
    ? m[0].replace(/"id"\s*:\s*"[^"]*"/, `"id": ${JSON.stringify(id)}`)
    : m[0].replace(/\}$/, `, "id": ${JSON.stringify(id)} }`);

  return src.slice(0, m.index) + patched + src.slice(m.index! + m[0].length);
}
