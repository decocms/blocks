/**
 * Materialize CSV-backed redirects at generate time.
 *
 * A `website/loaders/redirectsFromCsv.ts` block only carries a `from` CSV path
 * plus an empty `redirects: []` — the CSV was read by a Fresh/Deno loader at
 * runtime that was never ported to TanStack. On top of that, these blocks are
 * usually nested inside `site.routes[]`, and the runtime `loadRedirects` only
 * scans TOP-LEVEL decofile entries, so nested CSV loaders are invisible twice
 * over.
 *
 * `generate-blocks` runs in Node with fs access to the site's `public/` dir, so
 * here we read each referenced CSV and emit synthetic TOP-LEVEL redirect blocks
 * (`__csv_redirects__<name>`) with the parsed rules. `loadRedirects` picks those
 * up with no runtime I/O — it stays synchronous and unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { parseRedirectsCsv } from "@decocms/blocks/sdk/redirects";

const CSV_REDIRECT_RESOLVE_TYPE = "website/loaders/redirectsFromCsv.ts";
const REDIRECTS_RESOLVE_TYPE = "website/loaders/redirects.ts";

/** Recursively collect `from` CSV paths referenced by redirectsFromCsv nodes. */
function collectCsvRefs(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectCsvRefs(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.__resolveType === CSV_REDIRECT_RESOLVE_TYPE && typeof obj.from === "string") {
    out.add(obj.from);
  }
  for (const value of Object.values(obj)) collectCsvRefs(value, out);
}

/**
 * Resolve a decofile CSV `from` to an absolute path under the site's `public/`.
 * Accepts `static/foo.csv` (Fresh convention), `public/foo.csv`, or `foo.csv`.
 */
function resolveCsvPath(from: string, publicDir: string): string {
  const rel = from.replace(/^\/?(?:static|public)\//i, "").replace(/^\//, "");
  return path.resolve(publicDir, rel);
}

export interface MaterializeCsvRedirectsOptions {
  /** The `.deco/blocks` directory; `public/` is resolved relative to its root. */
  blocksDir: string;
  /** Suppress info/warn logs. Defaults to false. */
  silent?: boolean;
}

/**
 * Scan `blocks` for CSV redirect loaders and return synthetic top-level redirect
 * blocks (keyed `__csv_redirects__<name>`). Read-only over `blocks`; returns an
 * empty object when no CSV loader is referenced. A missing CSV file warns but
 * never throws, so it cannot break the build.
 *
 * Callers should merge the result with LOWER precedence than the real blocks
 * (`{ ...csvBlocks, ...blocks }`) so a curated CMS redirect always wins over a
 * bulk-migration CSV row for the same `from` (`loadRedirects` is last-write-wins
 * over insertion order).
 */
export function buildCsvRedirectBlocks(
  blocks: Record<string, unknown>,
  options: MaterializeCsvRedirectsOptions,
): Record<string, unknown> {
  const silent = options.silent ?? false;
  const publicDir = path.resolve(options.blocksDir, "../../public");

  const refs = new Set<string>();
  for (const value of Object.values(blocks)) collectCsvRefs(value, refs);
  if (refs.size === 0) return {};

  const csvBlocks: Record<string, unknown> = {};
  for (const from of refs) {
    const csvPath = resolveCsvPath(from, publicDir);
    let csv: string;
    try {
      csv = fs.readFileSync(csvPath, "utf-8");
    } catch {
      if (!silent) {
        console.warn(`[redirects] CSV not found for "${from}" (looked at ${csvPath}) — skipping.`);
      }
      continue;
    }

    // `loadRedirects` reads `entry.type` ("permanent" | "temporary"), while
    // `parseRedirectsCsv` returns a numeric `status` — map it back so 301s stay
    // 301s (a raw status field would be ignored and default to 302).
    const entries = parseRedirectsCsv(csv).map((r) => ({
      from: r.from,
      to: r.to,
      type: r.status === 301 ? "permanent" : "temporary",
    }));

    const key = `__csv_redirects__${path.basename(csvPath)}`;
    csvBlocks[key] = { redirects: entries, __resolveType: REDIRECTS_RESOLVE_TYPE };

    if (!silent) {
      console.log(
        `[redirects] Materialized ${entries.length} redirects from ${path.basename(csvPath)}.`,
      );
    }
  }

  return csvBlocks;
}
