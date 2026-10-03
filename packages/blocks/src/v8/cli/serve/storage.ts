/**
 * The storage `deco serve` edits: the working tree under one root.
 *
 * TODO(N-01): `@decocms/blocks/protocol/storage/fs` is the shared filesystem
 * storage, behind the protocol's own storage interface. This file is the
 * minimal subset the local server needs until then; swap it for the real one
 * when N-01 lands (`createLocalContentHandler` in ./handler.ts takes the same
 * shape: a snapshot, file bodies, the schema, and one atomic apply).
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type ContentDiagnostic, readSavedBlocks } from "../content";
import { canonicalName, nameToFile } from "../keys";
import type { DecoPaths } from "../root";

/** The git blob hash of some bytes: the version of one file, as on GitHub. */
export function gitBlobHash(bytes: Uint8Array | string): string {
  const body = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}

/** A revision for a whole set of entries, from their versions. */
function revisionOf(versions: Record<string, string>): string {
  const lines = Object.keys(versions)
    .sort()
    .map((name) => `${name}\0${versions[name]}\n`)
    .join("");
  return createHash("sha1").update(lines).digest("hex");
}

/**
 * Entry names are any strings, `constructor` and `__proto__`-like ones
 * included, so every map here has no prototype and every lookup is an
 * `Object.hasOwn` check.
 */
export interface BlocksSnapshot {
  revision: string;
  blocks: Record<string, Record<string, unknown>>;
  versions: Record<string, string>;
  /** The file each entry lives in, and every losing spelling of it. */
  files: Record<string, string>;
  spellings: Record<string, string[]>;
  diagnostics: ContentDiagnostic[];
}

export interface SchemaSnapshot {
  version: string;
  bytes: number;
  schema: unknown;
}

export interface ApplyOperations {
  set: Record<string, Record<string, unknown>>;
  delete: string[];
}

export interface ApplyResult {
  revision: string;
  versions: Record<string, string | null>;
}

export interface ContentStorage {
  readonly kind: "working-tree";
  /** False when the root has no `.deco/` at all. */
  exists(): boolean;
  readBlocks(): BlocksSnapshot;
  /** The schema, parsed (a file caught mid-write is never served torn), or null. */
  readSchema(): SchemaSnapshot | null;
  /** Write every set and delete, or none of them. Durable when it returns. */
  apply(ops: ApplyOperations): ApplyResult;
}

/** The file content for one entry (spec: content-protocol › File names). */
export function serializeEntry(entry: unknown): string {
  return `${JSON.stringify(entry, null, 2)}\n`;
}

export function createFsStorage(paths: DecoPaths): ContentStorage {
  const readBlocks = (): BlocksSnapshot => {
    const saved = readSavedBlocks(paths.blocks);
    const versions: Record<string, string> = Object.create(null);
    for (const [name, file] of Object.entries(saved.files)) {
      versions[name] = gitBlobHash(fs.readFileSync(path.join(paths.blocks, file)));
    }
    // Every spelling of each name, so a write can delete the losers.
    const spellings: Record<string, string[]> = Object.create(null);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(paths.blocks).filter((f) => f.endsWith(".json"));
    } catch {
      // no blocks folder yet
    }
    const byCanonical = new Map<string, string[]>();
    for (const file of entries) {
      const key = canonicalName(file).name;
      byCanonical.set(key, [...(byCanonical.get(key) ?? []), file]);
    }
    for (const [name, file] of Object.entries(saved.files)) {
      spellings[name] = byCanonical.get(canonicalName(file).name) ?? [file];
    }
    return {
      revision: revisionOf(versions),
      blocks: saved.blocks,
      versions,
      files: saved.files,
      spellings,
      diagnostics: saved.diagnostics,
    };
  };

  return {
    kind: "working-tree",
    exists: () => fs.existsSync(paths.deco),
    readBlocks,
    readSchema() {
      for (const file of [paths.schema, paths.legacySchema]) {
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(file);
        } catch {
          continue;
        }
        return {
          version: gitBlobHash(bytes),
          bytes: bytes.length,
          schema: JSON.parse(bytes.toString("utf8")),
        };
      }
      return null;
    },
    apply(ops) {
      const before = readBlocks();
      fs.mkdirSync(paths.blocks, { recursive: true });
      const suffix = `.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      const writes: { tmp: string; target: string }[] = [];
      const removals = new Set<string>();
      const versions: Record<string, string | null> = Object.create(null);
      const own = <T>(map: Record<string, T>, name: string): T | undefined =>
        Object.hasOwn(map, name) ? map[name] : undefined;
      try {
        // Stage every write first; nothing is visible until all of them exist.
        for (const [name, entry] of Object.entries(ops.set)) {
          const text = serializeEntry(entry);
          const target = own(before.files, name) ?? nameToFile(name);
          const tmp = path.join(paths.blocks, `${target}${suffix}`);
          fs.writeFileSync(tmp, text);
          const fd = fs.openSync(tmp, "r");
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          writes.push({ tmp, target: path.join(paths.blocks, target) });
          versions[name] = gitBlobHash(text);
          // A write overwrites the winning spelling and deletes the others.
          for (const other of own(before.spellings, name) ?? []) {
            if (other !== target) removals.add(path.join(paths.blocks, other));
          }
        }
        for (const name of ops.delete) {
          if (Object.hasOwn(ops.set, name)) continue; // set wins
          for (const file of own(before.spellings, name) ?? [])
            removals.add(path.join(paths.blocks, file));
          versions[name] = null;
        }
      } catch (error) {
        for (const w of writes) fs.rmSync(w.tmp, { force: true });
        throw error;
      }
      for (const w of writes) fs.renameSync(w.tmp, w.target);
      for (const file of removals) fs.rmSync(file, { force: true });

      return { revision: readBlocks().revision, versions };
    },
  };
}
