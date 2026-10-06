/**
 * `blocks.apply`, the protocol's only write:
 *
 * 1. All or nothing: every name in `set` and `delete` lands in one storage
 *    commit, or none does.
 * 2. Durable when it returns.
 * 3. `set` wins when a name is in both `set` and `delete`.
 * 4. Validated first: names, value shapes, sizes and the secret guard are
 *    checked before anything is written, and every violation is reported.
 * 5. Preconditions are optional: a failed `ifMatch` writes nothing and
 *    returns a Conflict; without one the last writer wins.
 *
 * 6. Two spellings of one name are one entry: a guard compares against the
 *    entry under any spelling, and the result reports `null` for every other
 *    spelling the commit deleted.
 *
 * A commit attempt that finds storage moved (files or the schema) is retried against a new snapshot after a jittered
 * backoff, rechecking every guard, up to `maxCommitAttempts` times.
 */
import {
  type BlockViolation,
  conflict,
  invalidBlock,
  limitExceeded,
  readOnly,
  unavailable,
  type VersionMismatch,
} from "../../errors.ts";
import {
  blockFileName,
  blockNameFromFile,
  checkBlockName,
  checkDeletedName,
  fullyDecodeFileName,
  isBlockFileName,
  serializeBlock,
  spellingKey,
} from "../../keys.ts";
import { checkSecrets } from "../../secrets.ts";
import type { BlocksApplyParams, BlocksApplyResult, DecoMeta } from "../../types.ts";
import { type LoadedContent, type LoadedEntry, loadCurrentContent } from "../content.ts";
import { type Core, MAX_BLOCK_BYTES, MAX_OPS_PER_APPLY } from "../core.ts";
import { parseSchema } from "./read.ts";

const utf8 = new TextEncoder();

interface NormalizedApply {
  set: Array<[name: string, value: unknown]>;
  /** Names to delete that aren't also set. */
  delete: string[];
  ifMatch: Array<[name: string, version: string | null]>;
}

function normalize(params: BlocksApplyParams): NormalizedApply {
  const set = Object.entries(params.set ?? {});
  const setNames = new Set(set.map(([name]) => name));
  const deleteNames = [...new Set(params.delete ?? [])].filter((name) => !setNames.has(name));
  const ops = set.length + deleteNames.length;
  if (ops > MAX_OPS_PER_APPLY) {
    throw limitExceeded(`${ops} names in one blocks.apply; the limit is ${MAX_OPS_PER_APPLY}`, {
      limit: "maxOpsPerApply",
    });
  }
  return { set, delete: deleteNames, ifMatch: Object.entries(params.ifMatch ?? {}) };
}

/** Checks everything that doesn't depend on stored content. */
function validateStatic(apply: NormalizedApply, meta: DecoMeta | null) {
  const violations: BlockViolation[] = [];
  const bodies = new Map<string, string>();
  const bySpelling = new Map<string, string>();
  for (const [name, value] of apply.set) {
    for (const v of checkBlockName(name))
      violations.push({ name, rule: v.reason, message: v.message });
    const key = spellingKey(name);
    const twin = bySpelling.get(key);
    if (twin !== undefined) {
      violations.push({
        name,
        rule: "spelling-collision",
        message: `"${name}" and "${twin}" are spellings of the same entry`,
      });
    } else bySpelling.set(key, name);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      violations.push({ name, rule: "not-an-object", message: "an entry must be a JSON object" });
      continue;
    }
    const body = serializeBlock(value);
    if (utf8.encode(body).byteLength > MAX_BLOCK_BYTES) {
      violations.push({
        name,
        rule: "too-large",
        message: `the entry is over ${MAX_BLOCK_BYTES} bytes`,
      });
      continue;
    }
    bodies.set(name, body);
    violations.push(...checkSecrets(name, value, meta));
  }
  for (const name of apply.delete) {
    for (const v of checkDeletedName(name))
      violations.push({ name, rule: v.reason, message: v.message });
  }
  return { violations, bodies };
}

/** The existing entries, by spelling key: two spellings of one name are one entry. */
type EntriesBySpelling = Map<string, { name: string; entry: LoadedEntry }>;

function entriesBySpelling(content: LoadedContent): EntriesBySpelling {
  const out: EntriesBySpelling = new Map();
  for (const [name, entry] of content.entries) {
    out.set(fullyDecodeFileName(entry.file).name, { name, entry });
  }
  return out;
}

/** Checks the rules that depend on the entries that already exist. */
function validateAgainst(
  content: LoadedContent,
  bySpelling: EntriesBySpelling,
  apply: NormalizedApply,
): BlockViolation[] {
  const violations: BlockViolation[] = [];
  const existing = [...content.entries.keys()];
  for (const [name] of apply.set) {
    // Another spelling of an existing entry updates that entry; it isn't a new name.
    if (bySpelling.has(spellingKey(name))) continue;
    const others = apply.set.filter(([other]) => other !== name).map(([other]) => other);
    for (const v of checkBlockName(name, { existingNames: [...existing, ...others] })) {
      if (v.reason === "case-collision")
        violations.push({ name, rule: v.reason, message: v.message });
    }
  }
  return violations;
}

interface Plan {
  put: Record<string, string>;
  delete: string[];
  expected: Record<string, string | null>;
}

/**
 * Turns names into file operations: write `encode(name)`, delete every other
 * spelling. Deleting any spelling of an entry deletes every spelling. Only
 * guarded entries become commit expectations: without `ifMatch`, the last
 * writer wins, so a concurrent save of the same entry must not turn into a
 * retry storm.
 */
function plan(
  content: LoadedContent,
  bySpelling: EntriesBySpelling,
  apply: NormalizedApply,
  bodies: Map<string, string>,
): Plan {
  const versionOf = new Map(
    content.snapshot.files.filter((f) => isBlockFileName(f.file)).map((f) => [f.file, f.version]),
  );
  const groupFiles = (name: string) =>
    (content.groups.get(spellingKey(name)) ?? []).map((f) => f.file);
  const put: Record<string, string> = Object.create(null);
  const deletes = new Set<string>();
  const expected: Record<string, string | null> = Object.create(null);

  for (const [name] of apply.set) {
    const file = blockFileName(name);
    put[file] = bodies.get(name)!;
    for (const other of groupFiles(name)) if (other !== file) deletes.add(other);
  }
  for (const name of apply.delete) {
    const file = blockFileName(name);
    if (versionOf.has(file)) deletes.add(file);
    if (bySpelling.has(spellingKey(name))) for (const other of groupFiles(name)) deletes.add(other);
  }
  for (const file of Object.keys(put)) deletes.delete(file);
  // A guarded entry must still be exactly what the guard saw when the commit lands:
  // every spelling of it, so a concurrent save under another spelling is caught too.
  for (const [name] of apply.ifMatch) {
    for (const file of [blockFileName(name), ...groupFiles(name)]) {
      if (isBlockFileName(file)) expected[file] = versionOf.get(file) ?? null;
    }
  }
  return { put, delete: [...deletes], expected };
}

/** A guard compares against the entry under any spelling: `null` means no spelling exists. */
function checkIfMatch(bySpelling: EntriesBySpelling, apply: NormalizedApply) {
  const mismatches: Record<string, VersionMismatch> = {};
  let failed = false;
  for (const [name, expected] of apply.ifMatch) {
    const actual = bySpelling.get(spellingKey(name))?.entry.version ?? null;
    if (actual !== expected) {
      mismatches[name] = { expected, actual };
      failed = true;
    }
  }
  return failed ? mismatches : null;
}

/**
 * The result's versions: every name written or deleted, plus `null` for each
 * other spelling the commit deleted, so a client's map never keeps an entry
 * under a name that's gone.
 */
function resultFromVersions(
  apply: NormalizedApply,
  revision: string,
  fileVersions: Record<string, string>,
  deletedFiles: readonly string[],
): BlocksApplyResult {
  const versions: Record<string, string | null> = Object.create(null);
  const touched = new Set<string>();
  for (const [name] of apply.set) {
    versions[name] = fileVersions[blockFileName(name)] ?? null;
    touched.add(spellingKey(name));
  }
  for (const name of apply.delete) {
    versions[name] = null;
    touched.add(spellingKey(name));
  }
  for (const file of deletedFiles) {
    const name = blockNameFromFile(file);
    if (!(name in versions) && touched.has(fullyDecodeFileName(file).name)) versions[name] = null;
  }
  return { revision, versions };
}

async function loadSchema(core: Core) {
  const stored = await core.storage.readSchema();
  if (stored === null) return { version: null, meta: null };
  if (core.parsedSchema?.version !== stored.version) {
    core.parsedSchema = { version: stored.version, meta: parseSchema(stored.text) };
  }
  return { version: stored.version, meta: core.parsedSchema.meta };
}

export async function blocksApply(
  core: Core,
  params: BlocksApplyParams,
): Promise<BlocksApplyResult> {
  const description = await core.description();
  if (description.readOnly) throw readOnly();
  const apply = normalize(params);

  for (let attempt = 1; attempt <= core.maxCommitAttempts; attempt++) {
    const schema = await loadSchema(core);
    const { violations, bodies } = validateStatic(apply, schema.meta);
    const { snapshot, content } = await loadCurrentContent(core.storage, {
      readAll: false,
      cache: core.cache,
    });
    const bySpelling = entriesBySpelling(content!);
    violations.push(...validateAgainst(content!, bySpelling, apply));
    if (violations.length > 0) throw invalidBlock(violations);

    const mismatches = checkIfMatch(bySpelling, apply);
    if (mismatches) throw conflict({ entries: mismatches });

    const { put, delete: deletes, expected } = plan(content!, bySpelling, apply, bodies);
    if (Object.keys(put).length === 0 && deletes.length === 0) {
      return resultFromVersions(apply, snapshot.revision, {}, []);
    }
    // The schema the secret check used must still be current at commit time.
    const result = await core.storage.commit({
      base: snapshot,
      put,
      delete: deletes,
      expected,
      ...(apply.set.length > 0 ? { expectedSchemaVersion: schema.version } : {}),
    });
    if (result.status === "committed") {
      return resultFromVersions(apply, result.revision, result.versions, deletes);
    }
    if (attempt < core.maxCommitAttempts) await core.backoff(attempt);
  }
  throw unavailable(
    `storage kept changing; gave up after ${core.maxCommitAttempts} commit attempts`,
    250,
  );
}
