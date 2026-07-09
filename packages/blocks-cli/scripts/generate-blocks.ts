#!/usr/bin/env tsx
/**
 * Reads .deco/blocks/*.json and emits:
 *   1. blocks.gen.json  — compact JSON data (the source of truth)
 *   2. blocks.gen.ts    — thin TypeScript re-export for editor tooling
 *
 * At runtime the Vite plugin (src/vite/plugin.js) intercepts `blocks.gen.ts`
 * imports and replaces them with `JSON.parse(...)` of the .json file. This
 * avoids Vite's SSR module runner hanging on large (13MB+) JS object literals
 * and lets V8 use its fast JSON parser instead of the full JS parser.
 *
 * Usage (from site root):
 *   npx tsx node_modules/@decocms/blocks-cli/scripts/generate-blocks.ts
 *
 * Env / CLI:
 *   --blocks-dir  override input  (default: .deco/blocks)
 *   --out-file    override output (default: .deco/blocks.gen.ts, with a sibling
 *                 .deco/blocks.gen.json — the .json path is always derived from
 *                 --out-file by swapping its extension, so passing --out-file
 *                 moves both artifacts together)
 *
 * If no `--out-file` is passed and the OLD default (src/server/cms/blocks.gen.ts)
 * still exists on disk, a one-line legacy warning is printed to stderr and the
 * NEW default is written anyway — see lib/legacyArtifact.ts.
 *
 * Programmatic:
 *   import { generateBlocks } from "@decocms/blocks-cli/generate-blocks";
 *   await generateBlocks({ blocksDir, outFile });
 *
 * The Vite plugin's dev-mode watcher uses the programmatic entry to keep the
 * generated artifact in sync with `.deco/blocks/` without spawning a child
 * process per change.
 */
import fs from "node:fs";
import path from "node:path";
import {
  blockHasPath,
  type Candidate,
  decodeBlockNameWithPasses,
  mergeCandidates,
  singleDecodeBlockName,
} from "./lib/blocks-dedupe";
import { warnLegacyArtifact } from "./lib/legacyArtifact";

const TS_STUB = [
  "// Auto-generated — thin wrapper around blocks.gen.json.",
  "// The Vite plugin replaces this at load time with JSON.parse(...).",
  "// Do not edit manually.",
  "",
  "export const blocks: Record<string, any> = {};",
  "",
].join("\n");

export interface GenerateBlocksOptions {
  blocksDir: string;
  outFile: string;
  /** Suppress the per-run summary log. Defaults to false. */
  silent?: boolean;
}

export interface GenerateBlocksResult {
  count: number;
  collisions: number;
  jsonFile: string;
  outFile: string;
  /** True when the blocks dir was missing and an empty barrel was emitted. */
  empty: boolean;
  /**
   * The merged decofile map that was written to `jsonFile`. Returned so callers
   * (the dev Vite plugin) can seed an in-memory cache and apply cheap deltas to
   * it without re-reading the whole `.deco/blocks` directory on every edit.
   */
  blocks: Record<string, unknown>;
}

export async function generateBlocks(
  options: GenerateBlocksOptions,
): Promise<GenerateBlocksResult> {
  const blocksDir = path.resolve(options.blocksDir);
  const outFile = path.resolve(options.outFile);
  const jsonFile = outFile.replace(/\.ts$/, ".json");
  const silent = options.silent ?? false;

  if (!fs.existsSync(blocksDir)) {
    if (!silent) {
      console.warn(`Blocks directory not found: ${blocksDir} — generating empty barrel.`);
    }
    await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
    await fs.promises.writeFile(jsonFile, "{}");
    await fs.promises.writeFile(outFile, TS_STUB);
    return { count: 0, collisions: 0, jsonFile, outFile, empty: true, blocks: {} };
  }

  const files = (await fs.promises.readdir(blocksDir)).filter((f) => f.endsWith(".json"));

  // Read each file into a Candidate, then let the dedupe lib pick the winner
  // per decoded key and report any collisions. See `lib/blocks-dedupe.ts` for
  // the priority order and the rationale behind it (TL;DR: never use file size,
  // don't trust mtime alone in CI clones).
  //
  // Reads run as bounded-concurrency async I/O (not a synchronous
  // readFileSync/statSync loop) so this whole-directory scan yields the event
  // loop between batches. On dev cold-start the Vite plugin fires this
  // fire-and-forget alongside Vite's own startup; a synchronous scan of a few
  // hundred `.deco/blocks` files blocked the loop long enough to delay `ready`
  // by ~1s (materially worse under a CPU quota, e.g. a sandbox pod). Batched to
  // keep the open-fd count bounded (avoid EMFILE on large decofiles).
  const candidatesWithKeys: Array<{ candidate: Candidate; key: string }> = [];
  const READ_BATCH = 64;
  for (let i = 0; i < files.length; i += READ_BATCH) {
    const batch = await Promise.all(
      files.slice(i, i + READ_BATCH).map(async (file) => {
        const fp = path.join(blocksDir, file);
        try {
          const [raw, stat] = await Promise.all([
            fs.promises.readFile(fp, "utf-8"),
            fs.promises.stat(fp),
          ]);
          return { file, raw, mtimeMs: stat.mtimeMs };
        } catch (e) {
          if (!silent) console.warn(`Failed to read ${file}:`, e);
          return null;
        }
      }),
    );
    for (const entry of batch) {
      if (!entry) continue;
      const { name, passes } = decodeBlockNameWithPasses(entry.file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.raw);
      } catch (e) {
        if (!silent) console.warn(`Failed to parse ${entry.file}:`, e);
        continue;
      }
      candidatesWithKeys.push({
        key: name,
        candidate: {
          file: entry.file,
          passes,
          mtimeMs: entry.mtimeMs,
          hasPath: blockHasPath(parsed),
          parsed,
        },
      });
    }
  }

  const { winners, collisions } = mergeCandidates(candidatesWithKeys);

  if (!silent && collisions.length > 0) {
    console.warn(
      `Detected ${collisions.length} filename collision(s) in ${path.relative(process.cwd(), blocksDir)}:`,
    );
    for (const c of collisions) {
      const losers = c.files.filter((f) => f !== c.winner);
      console.warn(`  - ${c.key}`);
      console.warn(`      winner: ${c.winner}`);
      for (const l of losers) console.warn(`      ignore: ${l}`);
    }
    console.warn("    Cause: multiple writers (manual sync vs deco-sync-bot) producing");
    console.warn("    different filename encodings for the same logical key. Delete the");
    console.warn("    stale file(s) listed under 'ignore' to silence this warning.");
  }

  // Use single-decoded stem of the winning file as the decofile key.
  // This matches the Deno runtime's `parseBlockId` (one decodeURIComponent)
  // so that studio's `encodeURIComponent(blockKey)` round-trips back to the
  // exact filename on disk.
  const blocks: Record<string, unknown> = {};
  for (const [_name, c] of Object.entries(winners)) {
    blocks[singleDecodeBlockName(c.file)] = c.parsed;
  }

  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });

  // 1. Compact JSON — the real data (no pretty-printing to save ~40% size)
  const jsonStr = JSON.stringify(blocks);
  await fs.promises.writeFile(jsonFile, jsonStr);

  // 2. Thin TS wrapper — just for TypeScript tooling and as a Vite load target.
  // Only write if content differs to avoid triggering Vite's file watcher,
  // which would cascade module invalidation to the route tree and crash
  // TanStack Router during dev hot-reload.
  let existingTs: string | undefined;
  try {
    existingTs = await fs.promises.readFile(outFile, "utf-8");
  } catch {}
  if (existingTs !== TS_STUB) {
    await fs.promises.writeFile(outFile, TS_STUB);
  }

  if (!silent) {
    const jsonSizeMB = (Buffer.byteLength(jsonStr) / 1_048_576).toFixed(1);
    console.log(
      `Generated ${Object.keys(blocks).length} blocks → ${path.relative(process.cwd(), jsonFile)} (${jsonSizeMB} MB)`,
    );
  }

  return {
    count: Object.keys(blocks).length,
    collisions: collisions.length,
    jsonFile,
    outFile,
    empty: false,
    blocks,
  };
}

export interface ReadBlockDeltaOptions {
  blocksDir: string;
  /**
   * Changed block files as basenames within `blocksDir` (e.g.
   * `pages-Home%2520(principal)-287364.json`), each tagged with whether the
   * event was a delete.
   */
  files: Array<{ name: string; isDelete: boolean }>;
  /** Suppress per-file read warnings. Defaults to false. */
  silent?: boolean;
}

/**
 * Read ONLY the changed block files and return a delta map keyed by decofile
 * key: `{ [key]: value }` for upserts, `{ [key]: null }` for deletes. The map
 * is meant to be wrapped as `{ blocks: <delta> }` and POSTed to `/.decofile`,
 * which applies it over the in-memory snapshot (see `applyDelta` in
 * `src/admin/decofile.ts`).
 *
 * This is the incremental counterpart to `generateBlocks`. `generateBlocks`
 * re-reads and re-merges the ENTIRE `.deco/blocks` directory and re-stringifies
 * the whole snapshot — O(whole decofile), tens of MB of synchronous fs + JSON
 * work that blocks the Node/Vite event loop for seconds on large sites (a CMS
 * toggle that writes one 1 MB block file would otherwise re-process a 10 MB+
 * decofile). `readBlockDelta` touches only the files that actually changed, so
 * the dev watcher's hot path is O(changed files).
 *
 * Key derivation matches `generateBlocks` (`singleDecodeBlockName`). The
 * cross-file collision dedupe that `generateBlocks` runs (see
 * `lib/blocks-dedupe.ts`) is intentionally skipped here — the just-written
 * file is treated as current truth ("newest write wins"), which is what a CMS
 * editor expects. The full restart-time bootstrap regen reconciles any
 * lingering collision via the dedupe logic.
 */
export function readBlockDelta(options: ReadBlockDeltaOptions): Record<string, unknown | null> {
  const blocksDir = path.resolve(options.blocksDir);
  const silent = options.silent ?? false;
  const delta: Record<string, unknown | null> = {};

  for (const { name, isDelete } of options.files) {
    if (!name.endsWith(".json")) continue;
    const key = singleDecodeBlockName(name);

    if (isDelete) {
      delta[key] = null;
      continue;
    }

    const fp = path.join(blocksDir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch (e) {
      // File vanished mid-event or is a partial write in progress — skip it.
      // A later watcher event (or the restart bootstrap) picks up the settled
      // content, so dropping it here never permanently loses an update.
      if (!silent) console.warn(`Failed to read changed block ${name}:`, e);
      continue;
    }
    delta[key] = parsed;
  }

  return delta;
}

// ---------------------------------------------------------------------------
// CLI shim — preserved so `npm run generate:blocks` and migration scripts
// keep working unchanged.
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  // tsx/node ESM: import.meta.url matches process.argv[1] when invoked directly.
  // Use a forgiving comparison so it works under both `tsx script.ts` and
  // `node --import tsx script.ts`.
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryUrl = new URL(`file://${path.resolve(entry)}`).href;
    return import.meta.url === entryUrl;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const arg = (name: string, fallback: string): string => {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };

  const blocksDir = path.resolve(process.cwd(), arg("blocks-dir", ".deco/blocks"));
  const OUT_FILE_EXPLICIT = args.includes("--out-file");
  const NEW_DEFAULT_OUT_FILE = ".deco/blocks.gen.ts";
  const OLD_DEFAULT_OUT_FILE = "src/server/cms/blocks.gen.ts";
  const outFile = path.resolve(process.cwd(), arg("out-file", NEW_DEFAULT_OUT_FILE));
  if (!OUT_FILE_EXPLICIT && fs.existsSync(path.resolve(process.cwd(), OLD_DEFAULT_OUT_FILE))) {
    warnLegacyArtifact(OLD_DEFAULT_OUT_FILE, NEW_DEFAULT_OUT_FILE);
  }

  generateBlocks({ blocksDir, outFile }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
