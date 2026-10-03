/**
 * Turns a storage snapshot (files and versions) into the entry map, applying
 * the one file-name rule: decode once, resolve spellings, report the rest.
 * Shared by `blocks.list` (which needs every body) and `blocks.apply` (which
 * needs bodies only to break ties between spellings).
 */
import { limitExceeded } from "../errors";
import { entryHasPath, fullyDecodeFileName, isBlockFileName, resolveSpellings } from "../keys";
import type { ContentStorage, StorageFile, StorageSnapshot } from "../storage";
import type { Diagnostic, Limits } from "../types";
import { type BodyCache, type ParsedBody, parseBody } from "./bodyCache";

export interface LoadedEntry {
  file: string;
  version: string;
  /** The parsed entry; absent when the body wasn't needed. */
  value?: Record<string, unknown>;
}

export interface LoadedContent {
  snapshot: StorageSnapshot;
  /** Every entry, by name, in file-name order of the winning files. */
  entries: Map<string, LoadedEntry>;
  /** Every saved-block file, valid or not, by spelling key. */
  groups: Map<string, StorageFile[]>;
  /** Files skipped or shadowed. */
  diagnostics: Diagnostic[];
  /** Uncompressed bytes of the bodies read. */
  bytes: number;
}

interface Options {
  /** Read every body (`blocks.list`), not only the ones that break ties. */
  readAll: boolean;
  limits: Limits;
  cache: BodyCache;
}

export async function loadContent(
  storage: ContentStorage,
  snapshot: StorageSnapshot,
  { readAll, limits, cache }: Options,
): Promise<LoadedContent> {
  const files = snapshot.files.filter((f) => isBlockFileName(f.file));
  const groups = new Map<string, StorageFile[]>();
  for (const file of files) {
    const key = fullyDecodeFileName(file.file).name;
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }

  const diagnostics: Diagnostic[] = [];
  const parsed = new Map<string, ParsedBody>();
  const toRead: StorageFile[] = [];
  let knownBytes = 0;
  for (const group of groups.values()) {
    if (!readAll && group.length < 2) continue;
    for (const file of group) {
      if (file.size !== undefined && file.size > limits.maxBlockBytes) {
        parsed.set(file.file, {
          ok: false,
          kind: "too-large",
          bytes: file.size,
          message: `the file is over ${limits.maxBlockBytes} bytes`,
        });
        continue;
      }
      knownBytes += file.size ?? 0;
      const hit = cache.get(file.file, file.version);
      if (hit) parsed.set(file.file, hit);
      else toRead.push(file);
    }
  }
  if (readAll && knownBytes > limits.maxListBytes) {
    throw limitExceeded(`the block list is over ${limits.maxListBytes} bytes`, {
      limit: "maxListBytes",
    });
  }
  if (toRead.length > 0) {
    const bodies = await storage.readFiles(
      snapshot,
      toRead.map((f) => f.file),
    );
    for (const file of toRead) {
      const text = bodies[file.file];
      if (text === undefined) continue; // vanished since the snapshot
      const body = parseBody(text, limits.maxBlockBytes);
      cache.set(file.file, file.version, body);
      parsed.set(file.file, body);
    }
  }

  let bytes = 0;
  const candidates: Array<StorageFile & { hasPath: boolean; value?: Record<string, unknown> }> = [];
  for (const file of files) {
    const body = parsed.get(file.file);
    if (body === undefined) {
      // Not read: a single spelling whose body wasn't needed, or a file that vanished.
      if (!readAll) candidates.push({ ...file, hasPath: false });
      continue;
    }
    if (!body.ok) {
      diagnostics.push({ file: file.file, kind: body.kind, message: body.message });
      continue;
    }
    bytes += body.bytes;
    candidates.push({ ...file, hasPath: entryHasPath(body.value), value: body.value });
  }
  if (readAll && bytes > limits.maxListBytes) {
    throw limitExceeded(`the block list is over ${limits.maxListBytes} bytes`, {
      limit: "maxListBytes",
    });
  }

  const entries = new Map<string, LoadedEntry>();
  for (const { name, winner, shadowed } of resolveSpellings(candidates).values()) {
    entries.set(name, { file: winner.file, version: winner.version, value: winner.value });
    for (const loser of shadowed) {
      diagnostics.push({
        file: loser.file,
        kind: "shadowed",
        name,
        winner: winner.file,
        message: `another spelling of "${name}" wins: ${winner.file}`,
      });
    }
  }
  diagnostics.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { snapshot, entries, groups, diagnostics, bytes };
}
