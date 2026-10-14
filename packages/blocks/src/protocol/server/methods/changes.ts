/**
 * `changes.list`, `changes.get` and `changes.discard`: a source's content is
 * its base plus its changes, and these three read and drop the changes.
 *
 * - Entries, not files: every spelling of a name (`spellingKey`) is one
 *   entry, on the base side as on the current side, and an entry is changed
 *   when any file of its spelling group differs from the base.
 * - The storage says which files differ (`changes()`) and reads base bodies
 *   (`readBaseFiles()`); the core turns files into entries, resolving the
 *   winning spelling on each side exactly as `blocks.list` does.
 * - `changes.discard` is a write: it restores the base files of the named
 *   entries as the storage reads them, and deletes their files the base
 *   doesn't have, in one commit guarded like `blocks.apply` (optional
 *   `ifMatch`, Conflict, retries), plus the base revision (`expectedBase`),
 *   so a base that moves meanwhile is re-read rather than half-restored.
 */
import { sha256Hex } from "../../canonical.ts";
import {
  type BlockViolation,
  conflict,
  invalidBlock,
  invalidParams,
  limitExceeded,
  readOnly,
  unavailable,
} from "../../errors.ts";
import {
  blockFileName,
  blockNameFromFile,
  checkDeletedName,
  entryHasPath,
  fullyDecodeFileName,
  isBlockFileName,
  resolveSpellings,
  spellingKey,
} from "../../keys.ts";
import type {
  StorageBase,
  StorageChanges,
  StorageFile,
  StorageSnapshot,
  StoredFileBody,
} from "../../storage.ts";
import type {
  BlocksApplyResult,
  Change,
  ChangeDetail,
  ChangeDiagnostic,
  ChangesBase,
  ChangesDiscardParams,
  ChangesGetParams,
  ChangesGetResult,
  ChangesListResult,
  ReadParams,
} from "../../types.ts";
import { type ParsedBody, parseBody } from "../bodyCache.ts";
import { type LoadedContent, loadCurrentContent } from "../content.ts";
import { type Core, MAX_BLOCK_BYTES, MAX_NAMES_PER_GET, MAX_OPS_PER_APPLY } from "../core.ts";
import { checkIfMatch, type EntriesBySpelling, entriesBySpelling } from "./apply.ts";

const keyOf = (file: string) => fullyDecodeFileName(file).name;

const byFile = (a: { file: string }, b: { file: string }) =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : 0;

/** One entry that differs from the base, with the files behind it. */
interface EntryChange {
  name: string;
  kind: "set" | "delete";
  /** The current winner's version; `null` when no file of the entry exists now. */
  version: string | null;
  baseVersion: string | null;
  /** The current winning file, when it was readable as a candidate. */
  currentFile: string | null;
  /** The base's winning file, when the base has the entry. */
  baseFile: string | null;
  /** The entry's files that differ from the base. */
  changedFiles: string[];
  /** The entry's files in the base. */
  baseFiles: StorageFile[];
}

interface ChangesState {
  base: StorageBase;
  revision: string;
  snapshot: StorageSnapshot;
  content: LoadedContent;
  bySpelling: EntriesBySpelling;
  /** Changed entries, by spelling key. */
  changes: Map<string, EntryChange>;
}

const toChangesBase = (base: StorageBase): ChangesBase => ({
  revision: base.revision,
  resolvedRef: base.resolvedRef,
});

/** The changes' revision: it moves when the base, its branch or the content moves. */
function changesRevision(base: StorageBase, snapshot: StorageSnapshot): Promise<string> {
  return sha256Hex(`${base.revision}\n${base.resolvedRef ?? ""}\n${snapshot.revision}`);
}

/** Parses base bodies, caching them like current ones (base versions identify content too). */
async function readBaseBodies(
  core: Core,
  base: StorageBase,
  files: StorageFile[],
): Promise<Map<string, ParsedBody>> {
  const out = new Map<string, ParsedBody>();
  const toRead: StorageFile[] = [];
  for (const file of files) {
    if (file.size !== undefined && file.size > MAX_BLOCK_BYTES) {
      out.set(file.file, {
        ok: false,
        kind: "too-large",
        bytes: file.size,
        message: `the file is over ${MAX_BLOCK_BYTES} bytes`,
      });
      continue;
    }
    toRead.push(file);
  }
  if (toRead.length === 0) return out;
  const bodies = await core.storage.readBaseFiles(
    base,
    toRead.map((f) => f.file),
  );
  for (const file of toRead) {
    const read = bodies[file.file];
    if (read === undefined) continue; // The base moved: the caller notices.
    out.set(file.file, parseBody(read.text, MAX_BLOCK_BYTES));
  }
  return out;
}

/** The base's winning file of one spelling group. */
async function baseWinner(
  core: Core,
  base: StorageBase,
  files: StorageFile[],
): Promise<StorageFile | null> {
  if (files.length <= 1) return files[0] ?? null;
  const bodies = await readBaseBodies(core, base, files);
  const candidates = files.map((file) => {
    const body = bodies.get(file.file);
    return { ...file, hasPath: body?.ok === true && entryHasPath(body.value) };
  });
  const [resolved] = resolveSpellings(candidates).values();
  return resolved?.winner ?? null;
}

/** Asks the storage which files differ, unless the memo already knows for this revision. */
async function storageChanges(
  core: Core,
  base: StorageBase,
  snapshot: StorageSnapshot,
  revision: string,
): Promise<StorageChanges> {
  if (core.changesMemo?.revision === revision) return core.changesMemo.changes;
  const answer = await core.storage.changes(base, snapshot);
  const changes: StorageChanges = {
    files: [...new Set(answer.files.filter(isBlockFileName))].sort(),
    baseFiles: answer.baseFiles.filter((f) => isBlockFileName(f.file)),
  };
  core.changesMemo = { revision, changes };
  return changes;
}

/** Reads the base, the content and what differs, as entries. */
async function loadChanges(core: Core): Promise<ChangesState> {
  const base = await core.storage.base();
  const { snapshot, content } = await loadCurrentContent(core.storage, {
    readAll: false,
    cache: core.cache,
  });
  const revision = await changesRevision(base, snapshot);
  const answer = await storageChanges(core, base, snapshot, revision);

  const changedByKey = new Map<string, string[]>();
  for (const file of answer.files) {
    const key = keyOf(file);
    const group = changedByKey.get(key);
    if (group) group.push(file);
    else changedByKey.set(key, [file]);
  }
  const baseByKey = new Map<string, StorageFile[]>();
  for (const file of answer.baseFiles) {
    const key = keyOf(file.file);
    if (!changedByKey.has(key)) continue;
    const group = baseByKey.get(key);
    if (group) group.push(file);
    else baseByKey.set(key, [file]);
  }

  const bySpelling = entriesBySpelling(content!);
  const changes = new Map<string, EntryChange>();
  for (const [key, changedFiles] of changedByKey) {
    const baseFiles = (baseByKey.get(key) ?? []).sort(byFile);
    const current = bySpelling.get(key);
    const currentFiles = content!.groups.get(key) ?? [];
    const winner = await baseWinner(core, base, baseFiles);
    const exists = currentFiles.length > 0;
    changes.set(key, {
      name:
        current?.name ??
        (winner ? blockNameFromFile(winner.file) : blockNameFromFile(changedFiles[0]!)),
      kind: exists ? "set" : "delete",
      version: current?.entry.version ?? (exists ? currentFiles[0]!.version : null),
      baseVersion: winner?.version ?? null,
      currentFile: current?.entry.file ?? null,
      baseFile: winner?.file ?? null,
      changedFiles,
      baseFiles,
    });
  }
  return { base, revision, snapshot, content: content!, bySpelling, changes };
}

export async function changesList(core: Core, params: ReadParams): Promise<ChangesListResult> {
  const state = await loadChanges(core);
  const base = toChangesBase(state.base);
  if (params.ifNoneMatch !== undefined && params.ifNoneMatch === state.revision) {
    return { notModified: true, revision: state.revision, base };
  }
  // Null-prototype, so an entry named like an Object.prototype key stays an entry.
  const changes: Record<string, Change> = Object.create(null);
  const sorted = [...state.changes.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const change of sorted) {
    changes[change.name] = {
      kind: change.kind,
      version: change.version,
      baseVersion: change.baseVersion,
    };
  }
  return { notModified: false, revision: state.revision, base, changes };
}

function checkNames(names: string[], limit: number, limitName: string, method: string) {
  const unique = [...new Set(names)];
  if (unique.length > limit) {
    throw limitExceeded(`${unique.length} names in one ${method}; the limit is ${limit}`, {
      limit: limitName,
    });
  }
  return unique;
}

/** How many times `changes.get` reads when files keep changing under it. */
const MAX_GET_READS = 3;

export async function changesGet(core: Core, params: ChangesGetParams): Promise<ChangesGetResult> {
  const names = checkNames(params.names, MAX_NAMES_PER_GET, "maxNamesPerGet", "changes.get");
  const empty = names.findIndex((name) => name.length === 0);
  if (empty !== -1) throw invalidParams(`names.${empty}: the name is empty`);

  for (let read = 1; read <= MAX_GET_READS; read++) {
    const state = await loadChanges(core);
    const plans: Array<{
      name: string;
      kind: ChangeDetail["kind"];
      version: string | null;
      baseVersion: string | null;
      currentFile: string | null;
      baseFile: string | null;
    }> = [];
    for (const name of names) {
      const key = spellingKey(name);
      const change = state.changes.get(key);
      if (change) {
        plans.push({
          name,
          kind: change.kind,
          version: change.version,
          baseVersion: change.baseVersion,
          currentFile: change.currentFile,
          baseFile: change.baseFile,
        });
        continue;
      }
      const current = state.bySpelling.get(key);
      if (!current) continue; // In neither side.
      plans.push({
        name,
        kind: null,
        version: current.entry.version,
        baseVersion: current.entry.version,
        currentFile: current.entry.file,
        baseFile: null,
      });
    }

    const currentFiles = [...new Set(plans.flatMap((p) => (p.currentFile ? [p.currentFile] : [])))];
    const current = await readCurrentBodies(core, state.snapshot, currentFiles);
    if (current === null) continue; // A file changed while being read: read again.
    const baseFiles = plans.flatMap((p) => {
      if (!p.baseFile) return [];
      const change = state.changes.get(spellingKey(p.name));
      return change?.baseFiles.filter((f) => f.file === p.baseFile) ?? [];
    });
    const baseBodies = await readBaseBodies(core, state.base, baseFiles);

    const entries: Record<string, ChangeDetail> = Object.create(null);
    const diagnostics: ChangeDiagnostic[] = [];
    const side = (
      body: ParsedBody | undefined,
      file: string | null,
      which: ChangeDiagnostic["side"],
    ) => {
      if (file === null || body === undefined) return null;
      if (body.ok) return body.value;
      diagnostics.push({ file, kind: body.kind, message: body.message, side: which });
      return null;
    };
    for (const plan of plans) {
      const after = side(
        plan.currentFile ? current.get(plan.currentFile) : undefined,
        plan.currentFile,
        "after",
      );
      // An unchanged entry's base is its current body: no base read.
      const before =
        plan.kind === null
          ? after
          : side(
              plan.baseFile ? baseBodies.get(plan.baseFile) : undefined,
              plan.baseFile,
              "before",
            );
      entries[plan.name] = {
        kind: plan.kind,
        before,
        after,
        version: plan.version,
        baseVersion: plan.baseVersion,
      };
    }
    diagnostics.sort((a, b) => byFile(a, b) || (a.side < b.side ? -1 : a.side > b.side ? 1 : 0));
    return { base: toChangesBase(state.base), entries, diagnostics };
  }
  throw unavailable("saved blocks kept changing while being read; retry shortly", 250);
}

/** Reads current bodies; `null` when one changed since the snapshot. */
async function readCurrentBodies(
  core: Core,
  snapshot: StorageSnapshot,
  files: string[],
): Promise<Map<string, ParsedBody> | null> {
  const out = new Map<string, ParsedBody>();
  const versionOf = new Map(snapshot.files.map((f) => [f.file, f]));
  const toRead: string[] = [];
  for (const file of files) {
    const info = versionOf.get(file);
    if (!info) return null;
    if (info.size !== undefined && info.size > MAX_BLOCK_BYTES) {
      out.set(file, {
        ok: false,
        kind: "too-large",
        bytes: info.size,
        message: `the file is over ${MAX_BLOCK_BYTES} bytes`,
      });
      continue;
    }
    const hit = core.cache.get(file, info.version);
    if (hit) out.set(file, hit);
    else toRead.push(file);
  }
  if (toRead.length === 0) return out;
  const bodies: Record<string, StoredFileBody> = await core.storage.readFiles(snapshot, toRead);
  for (const file of toRead) {
    const read = bodies[file];
    if (read === undefined) return null;
    const body = parseBody(read.text, MAX_BLOCK_BYTES);
    core.cache.set(file, read.version, body);
    if (read.version !== versionOf.get(file)!.version) return null;
    out.set(file, body);
  }
  return out;
}

/** The files a guarded entry has now (every spelling), as commit expectations. */
function guardExpectations(
  state: ChangesState,
  ifMatch: Array<[string, string | null]>,
): Record<string, string | null> {
  const versionOf = new Map(
    state.snapshot.files.filter((f) => isBlockFileName(f.file)).map((f) => [f.file, f.version]),
  );
  const expected: Record<string, string | null> = Object.create(null);
  for (const [name] of ifMatch) {
    const group = (state.content.groups.get(spellingKey(name)) ?? []).map((f) => f.file);
    for (const file of [blockFileName(name), ...group]) {
      if (isBlockFileName(file)) expected[file] = versionOf.get(file) ?? null;
    }
  }
  return expected;
}

export async function changesDiscard(
  core: Core,
  params: ChangesDiscardParams,
): Promise<BlocksApplyResult> {
  const description = await core.description();
  if (description.readOnly) throw readOnly();
  const names = checkNames(params.names, MAX_OPS_PER_APPLY, "maxOpsPerDiscard", "changes.discard");
  const violations: BlockViolation[] = [];
  for (const name of names) {
    for (const v of checkDeletedName(name))
      violations.push({ name, rule: v.reason, message: v.message });
  }
  if (violations.length > 0) throw invalidBlock(violations);
  const ifMatch = Object.entries(params.ifMatch ?? {});

  for (let attempt = 1; attempt <= core.maxCommitAttempts; attempt++) {
    const state = await loadChanges(core);
    const mismatches = checkIfMatch(state.bySpelling, { ifMatch });
    if (mismatches) throw conflict({ entries: mismatches });

    const restore = new Map<string, StorageFile>();
    const deletes: string[] = [];
    const discarded: EntryChange[] = [];
    for (const name of names) {
      const change = state.changes.get(spellingKey(name));
      if (!change || discarded.includes(change)) continue;
      discarded.push(change);
      const inBase = new Map(change.baseFiles.map((f) => [f.file, f]));
      for (const file of change.changedFiles) {
        const baseFile = inBase.get(file);
        if (baseFile) restore.set(file, baseFile);
        else deletes.push(file);
      }
    }

    const currentVersions = () => {
      const versions: Record<string, string | null> = Object.create(null);
      for (const name of names) {
        versions[name] = state.bySpelling.get(spellingKey(name))?.entry.version ?? null;
      }
      return versions;
    };
    if (restore.size === 0 && deletes.length === 0) {
      return { revision: state.snapshot.revision, versions: currentVersions() };
    }

    const bodies = await core.storage.readBaseFiles(state.base, [...restore.keys()]);
    const put: Record<string, string> = Object.create(null);
    let baseMoved = false;
    for (const file of restore.keys()) {
      const body = bodies[file];
      if (body === undefined) baseMoved = true;
      else put[file] = body.text;
    }
    if (!baseMoved) {
      const result = await core.storage.commit({
        base: state.snapshot,
        put,
        delete: deletes,
        expected: guardExpectations(state, ifMatch),
        expectedBase: state.base.revision,
        reason: "discard",
      });
      if (result.status === "committed") {
        const versions = currentVersions();
        const snapshotVersion = new Map(state.snapshot.files.map((f) => [f.file, f.version]));
        for (const name of names) {
          const change = state.changes.get(spellingKey(name));
          if (!change) continue;
          const file = change.baseFile;
          versions[name] =
            file === null ? null : (result.versions[file] ?? snapshotVersion.get(file) ?? null);
        }
        const touched = new Set(discarded.map((c) => spellingKey(c.name)));
        for (const file of deletes) {
          const name = blockNameFromFile(file);
          if (!(name in versions) && touched.has(keyOf(file))) versions[name] = null;
        }
        return { revision: result.revision, versions };
      }
    }
    if (attempt < core.maxCommitAttempts) await core.backoff(attempt);
  }
  throw unavailable(
    `storage kept changing; gave up after ${core.maxCommitAttempts} commit attempts`,
    250,
  );
}
