/**
 * The storage interface a content-protocol backend implements.
 *
 * A storage is deliberately small: a snapshot of file names and versions,
 * reading file bodies, reading the schema, one atomic commit attempt, and its
 * base (what `changes.*` compares the content with: the files that differ
 * from it, and reading base bodies).
 * The protocol core (`createContentHandler`) owns everything else: the
 * JSON-RPC layer, validation, the file-name rule, limits and retries. Storages deal in *files* inside `<root>/.deco/blocks`; entry names
 * are the core's business.
 *
 * Browser-safe: types and small error classes only.
 */
import type { StorageKind } from "./types.ts";

/** What a storage tells `describe`. */
export interface StorageDescription {
  kind: StorageKind;
  /** The app root, relative to the repository root (`"."` when they're the same). */
  root: string;
  readOnly: boolean;
  /** Where uploads go; `null` when read-only or uploads go elsewhere. */
  assets: null | { dir: string; maxBytes: number };
  /** Overrides the poll interval (default: 2000 for a working tree, 30000 for git). */
  pollIntervalMs?: number;
}

/** One saved-block file in a snapshot. */
export interface StorageFile {
  /** The file name inside `.deco/blocks`, such as `pages-Home.json`. */
  file: string;
  /** An opaque version of the file's content, compared only for equality. */
  version: string;
  /** The file's size in bytes, when the storage knows it without reading the body. */
  size?: number;
  /**
   * `true` for a tombstone: a deletion an overlay storage records over its
   * base, listed only by `writeSnapshot()`. It has no body, and its
   * `version` is the tombstone's (see `TOMBSTONE_VERSION`).
   */
  deleted?: true;
}

/**
 * The version an overlay storage reports for a deletion it records (a
 * tombstone), in `writeSnapshot()`, `changes()` and a commit's result. Any
 * value no file content has works; the reference storage uses this one, and
 * a storage that shares clients with it should too.
 */
export const TOMBSTONE_VERSION = "tombstone";

/** Every saved-block file at one point in time. */
export interface StorageSnapshot {
  /** An opaque revision of the whole set, compared only for equality. */
  revision: string;
  /** The branch actually read, for a storage that reads one; `null` for a working tree. */
  resolvedRef: string | null;
  files: StorageFile[];
}

/** A file body as read, with the version of the bytes actually read. */
export interface StoredFileBody {
  /** The file's UTF-8 content. */
  text: string;
  /**
   * The version of exactly these bytes, computed the way snapshots compute
   * versions. It differs from the snapshot's when the file changed in between.
   */
  version: string;
}

/** The schema file, as stored. */
export interface StoredSchema {
  /** An opaque version of the schema bytes. */
  version: string;
  /** The raw file content (`schema.gen.json`, else `meta.gen.json`). */
  text: string;
  resolvedRef: string | null;
}

/** One atomic commit attempt. */
export interface CommitAttempt {
  /**
   * The snapshot the core validated against: `writeSnapshot()`'s for an
   * overlay storage (`blocks.apply`), `snapshot()`'s otherwise.
   */
  base: StorageSnapshot;
  /** Files to write, by file name, with their full content. */
  put: Record<string, string>;
  /**
   * Files to delete. A file that's already gone is fine. For an overlay
   * storage, `blocks.apply` also names files the overlay doesn't hold: the
   * storage records the deletion over its base (a file only the base has
   * must disappear from `snapshot()`, and `writeSnapshot()` lists it as a
   * tombstone). One neither side has it may drop, or record as a tombstone
   * too (a storage whose write never reads the base can't tell them apart);
   * the core treats such a tombstone like any other.
   */
  delete: string[];
  /**
   * Versions the files must still have for the commit to land (`null` = must
   * not exist), in the snapshot `base` came from (the overlay, for an overlay
   * storage's `blocks.apply`, where a tombstone has its tombstone version
   * and so is not `null`). A storage MUST reject the attempt as stale
   * when any of them changed, and MAY reject it when anything else changed
   * since `base`.
   */
  expected: Record<string, string | null>;
  /**
   * The base revision (`StorageBase.revision`) the core computed the write
   * from, when the write depends on it (`changes.discard` restores base
   * bytes). When set, a storage MUST reject the attempt as stale if its base
   * revision at commit time differs, checked atomically with `expected`.
   */
  expectedBase?: string;
  /**
   * Why the core commits: `apply` (default) or `discard`. For logs, and a
   * storage with a staging area (the fs storage's git index) also unstages
   * the files a `discard` writes or deletes, in the same commit. An overlay
   * storage applies a `discard` by dropping those files from the overlay, so
   * the base shows through (`put` holds the base's own bytes).
   */
  reason?: "apply" | "discard";
}

/** What a storage's content is compared against (`changes.*`). */
export interface StorageBase {
  /** An opaque revision of the base, compared only for equality (a commit sha). */
  revision: string;
  /** The branch the base was read from; `null` when there's none. */
  resolvedRef: string | null;
}

/** The files of a snapshot that differ from the base. */
export interface StorageChanges {
  /**
   * Saved-block file names that differ from the base: in the snapshot and not
   * in the base, in the base and not in the snapshot, or in both with
   * different content. A file whose content equals the base's (the storage
   * decides equality, such as honouring git's eol conversion) MUST NOT be
   * listed, so a file a discard just restored is never listed again. An
   * overlay storage instead lists exactly the files its overlay holds, and
   * the deletions it records of files the base has, even a file equal to the
   * base's: the overlay's own entries are the changes.
   */
  files: string[];
  /**
   * An overlay storage: the tombstones among `files` (the deletions it
   * records), with the versions `writeSnapshot()` lists them with, which
   * `changes.list` reports as the deletions' versions. Absent otherwise.
   */
  tombstones?: StorageFile[];
  /**
   * The base's files, with their versions in the base: at least every file
   * whose spelling group (`spellingKey`) a file in `files` belongs to; more
   * is fine.
   */
  baseFiles: StorageFile[];
}

export type CommitResult =
  | {
      status: "committed";
      /** The revision `snapshot()` reports right after the commit (`blocks.list`'s). */
      revision: string;
      /**
       * The new version of every file in `put`, and for an overlay storage
       * the tombstone version of every file in `delete` it recorded as a
       * tombstone (not one it dropped because neither side has it).
       */
      versions: Record<string, string>;
    }
  | { status: "stale" };

export interface ContentStorage {
  describe(): StorageDescription | Promise<StorageDescription>;
  /**
   * Lists the saved-block files. Throws `StorageNotFoundError` when there's no
   * `.deco` folder at all.
   */
  snapshot(): Promise<StorageSnapshot>;
  /**
   * Reads file bodies (UTF-8 text) from a snapshot, each with the version of
   * the bytes read. A file that vanished is left out. A storage that can't
   * read at the snapshot (a working tree) returns current bytes; the core
   * compares versions to notice.
   */
  readFiles(snapshot: StorageSnapshot, files: string[]): Promise<Record<string, StoredFileBody>>;
  /** Reads `schema.gen.json`, falling back to `meta.gen.json`; `null` when neither exists. */
  readSchema(): Promise<StoredSchema | null>;
  /**
   * An overlay storage's own files: what it holds over its base (a hosted
   * draft's blocks over the published branch), read without reading the
   * base. Its presence makes the endpoint an overlay (`describe.overlay`):
   * `blocks.apply` validates and checks `ifMatch` against this snapshot
   * instead of `snapshot()`, and commits with it as `base`; `readFiles`
   * reads its files too. A deletion the overlay records is listed as a
   * tombstone (`deleted: true`, with its tombstone version): for a guard the
   * overlay holds it, so `ifMatch: null` on it fails and its tombstone
   * version passes. The
   * revision `snapshot()` reports must move whenever the overlay does, even
   * when the content it shows doesn't (an entry saved with the base's
   * value). Absent
   * for a storage that writes its content directly (a working tree, a
   * branch).
   */
  writeSnapshot?(): Promise<StorageSnapshot>;
  /** One all-or-nothing commit attempt; durable when it resolves. */
  commit(attempt: CommitAttempt): Promise<CommitResult>;
  /**
   * The current base, cheaply: the core calls it on every `changes.list`
   * poll. Throws `StorageUnavailableError` when the base can't be read now.
   */
  base(): Promise<StorageBase>;
  /** The files of `snapshot` that differ from `base`, and the base files they touch. */
  changes(base: StorageBase, snapshot: StorageSnapshot): Promise<StorageChanges>;
  /**
   * Reads base file bodies, as a checkout would write them (a leading BOM
   * kept: a discard writes the text back as is), each with its version in the
   * base. A file the base doesn't have is left out.
   */
  readBaseFiles(base: StorageBase, files: string[]): Promise<Record<string, StoredFileBody>>;
  /** Stores an uploaded file, never overwriting one; returns the stored file name. */
  putAsset?(name: string, body: Uint8Array): Promise<{ name: string }>;
}

/** Thrown by a storage when there's no `.deco` folder. */
export class StorageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageNotFoundError";
  }
}

/**
 * Thrown by a storage asked to touch a file that can't be a saved block (a
 * dotfile, a path). The core refuses those names first; this is the backstop.
 */
export class StorageInvalidFileError extends Error {
  constructor(readonly file: string) {
    super(`not a saved-block file name: ${JSON.stringify(file)}`);
    this.name = "StorageInvalidFileError";
  }
}

/** Thrown by a storage when it failed or is rate-limited. */
export class StorageUnavailableError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "StorageUnavailableError";
    this.retryAfterMs = retryAfterMs;
  }
}
