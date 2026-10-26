/**
 * An in-memory `ContentStorage` (internal; not a package subpath).
 *
 * A reference implementation of the storage contract, and a fixture
 * for tests: its state can be dumped and restored to simulate a restart, and
 * hooks let a test change files between a snapshot and a commit. Browser-safe.
 */
import { suffixedAssetName } from "../assets.ts";
import { sha256Hex } from "../canonical.ts";
import { isBlockFileName } from "../keys.ts";
import {
  type CommitAttempt,
  type CommitResult,
  type ContentStorage,
  type StorageDescription,
  StorageInvalidFileError,
  StorageNotFoundError,
  type StorageSnapshot,
  type StoredFileBody,
  type StoredSchema,
} from "../storage.ts";

/** Everything a memory storage holds; JSON-serializable, so it survives a "restart". */
export interface MemoryStorageState {
  /** Saved-block files, by file name, with their content (an overlay's own files, for an overlay). */
  files: Record<string, string>;
  /** The content of `schema.gen.json`, or `null` without one. */
  schema: string | null;
  /** The content of `meta.gen.json`, the fallback schema, or `null`. */
  legacySchema?: string | null;
  assets: Record<string, string>;
  /** `false` simulates an app root with no `.deco` folder at all. */
  hasDecoFolder: boolean;
  /** The base's saved-block files (what `changes.*` compares with), by file name. Default: none. */
  base: Record<string, string>;
  /** The base's revision; moves with every `setBase`/`commitBase`. */
  baseRevision: string;
  /** The base's branch. Default `null`. */
  baseRef: string | null;
  /**
   * An overlay storage (`writeSnapshot()`, `describe.overlay`), like a hosted
   * draft: `files` is then the overlay alone, laid over `base`, and
   * `deleted` the base files it deletes. Default `false`.
   */
  overlay: boolean;
  /** For an overlay: base files the overlay deletes. */
  deleted: string[];
}

export interface MemoryStorageOptions {
  state?: Partial<MemoryStorageState>;
  /** Overrides parts of what `describe` reports. */
  description?: Partial<StorageDescription>;
  /** Runs after each file body is read; a test can change files here, mid-read. */
  afterRead?: (file: string, storage: MemoryStorage) => void | Promise<void>;
  /** Runs before each commit attempt's checks; a test can change files here. */
  beforeCommit?: (attempt: CommitAttempt, storage: MemoryStorage) => void | Promise<void>;
}

export interface MemoryStorage extends ContentStorage {
  /** A deep copy of the current state. */
  dump(): MemoryStorageState;
  /** Writes or deletes (`null`) a file directly, as an outside edit would. */
  setFile(file: string, content: string | null): void;
  /** Replaces `schema.gen.json` (`null` removes it). */
  setSchema(schema: string | object | null): void;
  /** Replaces the base's files, as a publish (or an outside commit) would. */
  setBase(files: Record<string, string>): void;
  /** Makes the current content the base (emptying an overlay), as a commit of every change would. */
  commitBase(): void;
  /** How many commits landed. */
  readonly commits: number;
}

const version = (content: string) => sha256Hex(content);

export function createMemoryStorage(options: MemoryStorageOptions = {}): MemoryStorage {
  const state: MemoryStorageState = structuredClone({
    files: {},
    schema: null,
    legacySchema: null,
    assets: {},
    hasDecoFolder: true,
    base: {},
    baseRevision: "base-0",
    baseRef: null,
    overlay: false,
    deleted: [],
    ...options.state,
  });
  // structuredClone keeps shared references: the base is never the files object.
  state.base = { ...state.base };
  const description: StorageDescription = {
    kind: "git",
    root: ".",
    readOnly: false,
    assets: { dir: "public/assets", maxBytes: 25 * 1024 * 1024 },
    ...options.description,
  };
  let commits = 0;

  /** The content `snapshot()` lists: the files, or for an overlay its files laid over the base. */
  function content(): Record<string, string> {
    if (!state.overlay) return state.files;
    const out: Record<string, string> = Object.create(null);
    for (const [file, text] of Object.entries(state.base)) {
      if (!state.deleted.includes(file)) out[file] = text;
    }
    return Object.assign(out, state.files);
  }

  async function versionsOf(files: Record<string, string>): Promise<Map<string, string>> {
    const entries = await Promise.all(
      Object.entries(files).map(async ([file, text]) => [file, await version(text)] as const),
    );
    return new Map(entries);
  }

  const currentVersions = () => versionsOf(content());

  /**
   * The revision `snapshot()` reports. An overlay's also moves with the
   * overlay itself, even when the content it shows doesn't (an entry saved
   * with the base's value), so `changes.*` never answers from a stale memo.
   */
  async function contentRevision(): Promise<string> {
    const revision = await revisionOf(await currentVersions());
    if (!state.overlay) return revision;
    const own = await revisionOf(await versionsOf(state.files));
    return sha256Hex(`${revision}\n${own}\n${[...state.deleted].sort().join("\n")}`);
  }

  async function snapshotOf(
    files: Record<string, string>,
    revision?: () => Promise<string>,
  ): Promise<StorageSnapshot> {
    if (!state.hasDecoFolder) throw new StorageNotFoundError("no .deco folder");
    const versions = await versionsOf(files);
    return {
      revision: revision ? await revision() : await revisionOf(versions),
      resolvedRef: null,
      files: [...versions].map(([file, v]) => ({
        file,
        version: v,
        size: new TextEncoder().encode(files[file]).byteLength,
      })),
    };
  }

  /** An overlay's commit: `apply` writes the overlay and records deletions; `discard` drops files from it. */
  function commitToOverlay(attempt: CommitAttempt): void {
    const touched = [...Object.keys(attempt.put), ...attempt.delete];
    state.deleted = state.deleted.filter((file) => !touched.includes(file));
    for (const file of touched) delete state.files[file];
    if (attempt.reason === "discard") return;
    for (const file of attempt.delete) if (file in state.base) state.deleted.push(file);
    for (const [file, text] of Object.entries(attempt.put)) state.files[file] = text;
  }

  async function revisionOf(versions: Map<string, string>): Promise<string> {
    const listing = [...versions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return sha256Hex(listing.map(([file, v]) => `${file}\0${v}`).join("\n"));
  }

  let commitQueue: Promise<unknown> = Promise.resolve();

  async function commitNow(attempt: CommitAttempt): Promise<CommitResult> {
    await options.beforeCommit?.(attempt, storage);
    for (const file of [
      ...Object.keys(attempt.put),
      ...attempt.delete,
      ...Object.keys(attempt.expected),
    ]) {
      if (!isBlockFileName(file)) throw new StorageInvalidFileError(file);
    }
    if (!state.hasDecoFolder) throw new StorageNotFoundError("no .deco folder");
    if (attempt.expectedBase !== undefined && attempt.expectedBase !== state.baseRevision) {
      return { status: "stale" };
    }
    // An overlay's apply is guarded against the overlay; anything else against the content.
    const guarded = state.overlay && attempt.reason !== "discard" ? state.files : content();
    const versions = await versionsOf(guarded);
    for (const [file, expected] of Object.entries(attempt.expected)) {
      if ((versions.get(file) ?? null) !== expected) return { status: "stale" };
    }
    // Validate everything before mutating, so the commit is all or nothing.
    const written: Record<string, string> = {};
    for (const [file, text] of Object.entries(attempt.put)) written[file] = await version(text);
    if (state.overlay) commitToOverlay(attempt);
    else {
      for (const file of attempt.delete) delete state.files[file];
      for (const [file, text] of Object.entries(attempt.put)) state.files[file] = text;
    }
    const revision = await contentRevision();
    commits++;
    return { status: "committed", revision, versions: written };
  }

  const storage: MemoryStorage = {
    get commits() {
      return commits;
    },

    describe: () => description,

    snapshot: () => snapshotOf(content(), contentRevision),

    ...(state.overlay ? { writeSnapshot: () => snapshotOf(state.files) } : {}),

    async readFiles(_snapshot, files) {
      const out: Record<string, StoredFileBody> = Object.create(null);
      const current = content();
      for (const file of files) {
        if (!(file in current)) continue;
        const text = current[file]!;
        out[file] = { text, version: await version(text) };
        await options.afterRead?.(file, storage);
      }
      return out;
    },

    async readSchema(): Promise<StoredSchema | null> {
      if (!state.hasDecoFolder) return null;
      const text = state.schema ?? state.legacySchema ?? null;
      if (text === null) return null;
      return { version: await version(text), text, resolvedRef: null };
    },

    async base() {
      return { revision: state.baseRevision, resolvedRef: state.baseRef };
    },

    async changes(_base, snapshot) {
      const baseFiles = await Promise.all(
        Object.entries(state.base).map(async ([file, content]) => ({
          file,
          version: await version(content),
          size: new TextEncoder().encode(content).byteLength,
        })),
      );
      if (state.overlay) {
        // The overlay's own files are the changes, even one equal to the base.
        const deleted = state.deleted.filter((file) => file in state.base);
        return { files: [...Object.keys(state.files), ...deleted], baseFiles };
      }
      const baseVersion = new Map(baseFiles.map((f) => [f.file, f.version]));
      const current = new Map(snapshot.files.map((f) => [f.file, f.version]));
      const files = new Set<string>();
      for (const [file, v] of current) if (baseVersion.get(file) !== v) files.add(file);
      for (const file of baseVersion.keys()) if (!current.has(file)) files.add(file);
      return { files: [...files], baseFiles };
    },

    async readBaseFiles(_base, files) {
      const out: Record<string, StoredFileBody> = Object.create(null);
      for (const file of files) {
        if (!(file in state.base)) continue;
        const text = state.base[file]!;
        out[file] = { text, version: await version(text) };
      }
      return out;
    },

    commit(attempt): Promise<CommitResult> {
      // Serialized, so a commit's checks and its mutation are one atomic step.
      const run = commitQueue.then(() => commitNow(attempt));
      commitQueue = run.catch(() => {});
      return run;
    },

    async putAsset(name, body) {
      let candidate = name;
      while (candidate in state.assets) candidate = suffixedAssetName(name);
      state.assets[candidate] = Array.from(body, (b) => String.fromCharCode(b)).join("");
      return { name: candidate };
    },

    dump: () => structuredClone(state),

    setFile(file, content) {
      if (content === null) delete state.files[file];
      else state.files[file] = content;
    },

    setBase(files) {
      state.base = { ...files };
      state.baseRevision = `base-${Math.random().toString(36).slice(2, 10)}`;
    },

    commitBase() {
      storage.setBase(content());
      if (state.overlay) {
        state.files = {};
        state.deleted = [];
      }
    },

    setSchema(schema) {
      state.schema =
        schema === null || typeof schema === "string" ? schema : JSON.stringify(schema);
    },
  };
  return storage;
}
