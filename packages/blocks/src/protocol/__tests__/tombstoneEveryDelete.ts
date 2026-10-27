/**
 * An overlay storage that records a tombstone for every name `blocks.apply`
 * deletes, even one the base doesn't have, as a hosted draft does when its
 * save never reads the base. Built over an overlay memory storage, which
 * records tombstones only for the base's files; the extra ones live here.
 */

import type { MemoryStorage } from "../storage/memory.ts";
import { type ContentStorage, type StorageFile, TOMBSTONE_VERSION } from "../storage.ts";

export function tombstoneEveryDelete(memory: MemoryStorage): ContentStorage {
  /** Tombstones of files the base doesn't have. */
  const gone = new Set<string>();
  const tombstone = (file: string): StorageFile => ({
    file,
    version: TOMBSTONE_VERSION,
    deleted: true,
  });
  // The overlay moves when its tombstones do, so the revisions do too.
  const withGone = (revision: string) => `${revision}|${[...gone].sort().join(",")}`;

  return {
    ...memory,
    async snapshot() {
      const s = await memory.snapshot();
      return { ...s, revision: withGone(s.revision) };
    },
    async writeSnapshot() {
      const s = await memory.writeSnapshot!();
      return {
        ...s,
        revision: withGone(s.revision),
        files: [...s.files, ...[...gone].map(tombstone)],
      };
    },
    async changes(base, snapshot) {
      const answer = await memory.changes(base, snapshot);
      const extra = [...gone].map(tombstone);
      return {
        ...answer,
        files: [...answer.files, ...extra.map((t) => t.file)],
        tombstones: [...(answer.tombstones ?? []), ...extra],
      };
    },
    async commit(attempt) {
      const touched = [...Object.keys(attempt.put), ...attempt.delete];
      // A discard is guarded against snapshot(), where a tombstone is absent.
      if (attempt.reason === "discard") {
        const result = await memory.commit(attempt);
        if (result.status !== "committed") return result;
        for (const file of touched) gone.delete(file);
        return { ...result, revision: withGone(result.revision) };
      }
      const expected: Record<string, string | null> = {};
      for (const [file, version] of Object.entries(attempt.expected)) {
        if (!gone.has(file)) expected[file] = version;
        else if (version !== TOMBSTONE_VERSION) return { status: "stale" };
      }
      const result = await memory.commit({ ...attempt, expected });
      if (result.status !== "committed") return result;
      for (const file of touched) gone.delete(file);
      const base = memory.dump().base;
      const versions = { ...result.versions };
      for (const file of attempt.delete) {
        if (file in base) continue;
        gone.add(file);
        versions[file] = TOMBSTONE_VERSION;
      }
      return { ...result, revision: withGone(result.revision), versions };
    },
  };
}
