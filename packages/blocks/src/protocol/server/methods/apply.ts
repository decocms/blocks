/**
 * `blocks.apply`, the protocol's only write:
 *
 * 1. All or nothing: every name in `set` and `delete` lands in one storage
 *    commit, or none does.
 * 2. Durable when it returns.
 * 3. `set` wins when a name is in both `set` and `delete`.
 * 4. Validated first: names, value shapes, sizes and the secret guard are
 *    checked before anything is written, and every violation is reported.
 * 5. Preconditions are optional: a failed `ifMatch` (or `ifSchemaMatch`)
 *    writes nothing and returns a Conflict; without them the last writer wins.
 *
 * A commit attempt that finds storage moved is retried against the new
 * snapshot, rechecking every guard, up to `maxCommitAttempts` times.
 */
import { applyRequestDigest, canonicalJson } from "../../canonical";
import {
  type BlockViolation,
  conflict,
  invalidBlock,
  invalidParams,
  limitExceeded,
  readOnly,
  unavailable,
  unsupported,
  type VersionMismatch,
} from "../../errors";
import {
  blockFileName,
  checkBlockName,
  checkDeletedName,
  serializeBlock,
  spellingKey,
} from "../../keys";
import { checkSecrets } from "../../secrets";
import type { StorageDescription, StoredReceipt } from "../../storage";
import type { BlocksApplyParams, BlocksApplyResult, DecoMeta, Limits } from "../../types";
import { type LoadedContent, loadContent } from "../content";
import type { Core } from "../core";
import { parseSchema, readSchema } from "./read";

const utf8 = new TextEncoder();

interface NormalizedApply {
  set: Array<[name: string, value: unknown]>;
  /** Names to delete that aren't also set. */
  delete: string[];
  ifMatch: Array<[name: string, version: string | null]>;
}

function normalize(params: BlocksApplyParams, limits: Limits): NormalizedApply {
  const set = Object.entries(params.set ?? {});
  const setNames = new Set(set.map(([name]) => name));
  const deleteNames = [...new Set(params.delete ?? [])].filter((name) => !setNames.has(name));
  const ops = set.length + deleteNames.length;
  if (ops > limits.maxOpsPerApply) {
    throw limitExceeded(`${ops} names in one blocks.apply; the limit is ${limits.maxOpsPerApply}`, {
      limit: "maxOpsPerApply",
    });
  }
  return { set, delete: deleteNames, ifMatch: Object.entries(params.ifMatch ?? {}) };
}

/** Checks everything that doesn't depend on stored content. */
function validateStatic(apply: NormalizedApply, limits: Limits, meta: DecoMeta | null) {
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
    if (utf8.encode(body).byteLength > limits.maxBlockBytes) {
      violations.push({
        name,
        rule: "too-large",
        message: `the entry is over ${limits.maxBlockBytes} bytes`,
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

/** Checks the rules that depend on the entries that already exist. */
function validateAgainst(content: LoadedContent, apply: NormalizedApply): BlockViolation[] {
  const violations: BlockViolation[] = [];
  const existing = [...content.entries.keys()];
  for (const [name] of apply.set) {
    if (content.entries.has(name)) continue;
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
 * spelling. Only guarded entries become commit expectations: without
 * `ifMatch`, the last writer wins, so a concurrent save of the same entry must
 * not turn into a retry storm.
 */
function plan(content: LoadedContent, apply: NormalizedApply, bodies: Map<string, string>): Plan {
  const versionOf = new Map(content.snapshot.files.map((f) => [f.file, f.version]));
  const put: Record<string, string> = Object.create(null);
  const deletes = new Set<string>();
  const expected: Record<string, string | null> = Object.create(null);

  for (const [name] of apply.set) {
    const file = blockFileName(name);
    put[file] = bodies.get(name)!;
    for (const other of content.groups.get(spellingKey(name)) ?? []) {
      if (other.file !== file) deletes.add(other.file);
    }
  }
  for (const name of apply.delete) {
    const file = blockFileName(name);
    if (versionOf.has(file)) deletes.add(file);
    if (content.entries.has(name)) {
      for (const other of content.groups.get(spellingKey(name)) ?? []) deletes.add(other.file);
    }
  }
  for (const file of Object.keys(put)) deletes.delete(file);
  // A guarded entry must still be exactly what the guard saw when the commit lands.
  for (const [name] of apply.ifMatch) {
    const entry = content.entries.get(name);
    const files = entry
      ? [entry.file]
      : [blockFileName(name), ...(content.groups.get(spellingKey(name)) ?? []).map((f) => f.file)];
    for (const file of files) expected[file] = versionOf.get(file) ?? null;
  }
  return { put, delete: [...deletes], expected };
}

function checkIfMatch(content: LoadedContent, apply: NormalizedApply) {
  const mismatches: Record<string, VersionMismatch> = {};
  let failed = false;
  for (const [name, expected] of apply.ifMatch) {
    const actual = content.entries.get(name)?.version ?? null;
    if (actual !== expected) {
      mismatches[name] = { expected, actual };
      failed = true;
    }
  }
  return failed ? mismatches : null;
}

function resultFromVersions(
  apply: NormalizedApply,
  revision: string,
  fileVersions: Record<string, string>,
): BlocksApplyResult {
  const versions: Record<string, string | null> = Object.create(null);
  for (const [name] of apply.set) versions[name] = fileVersions[blockFileName(name)] ?? null;
  for (const name of apply.delete) versions[name] = null;
  return { revision, versions };
}

function receiptResult(apply: NormalizedApply, receipt: StoredReceipt): BlocksApplyResult {
  return resultFromVersions(apply, receipt.revision, receipt.versions);
}

async function loadSchema(core: Core, params: BlocksApplyParams, limits: Limits) {
  const stored = await readSchema(core, params.ref, limits.maxSchemaBytes);
  if (stored === null) return { version: null, meta: null };
  if (core.parsedSchema?.version !== stored.version) {
    core.parsedSchema = { version: stored.version, meta: parseSchema(stored.text) };
  }
  return { version: stored.version, meta: core.parsedSchema.meta };
}

function checkFeatures(description: StorageDescription, core: Core, params: BlocksApplyParams) {
  if (description.readOnly) throw readOnly();
  core.checkRef(description, params.ref);
  if (params.requestKey !== undefined && (!description.idempotency || !core.storage.getReceipt)) {
    throw unsupported("this endpoint doesn't support request keys; omit requestKey");
  }
}

export async function blocksApply(
  core: Core,
  params: BlocksApplyParams,
  scope: string,
): Promise<BlocksApplyResult> {
  const description = await core.description();
  checkFeatures(description, core, params);
  if (params.requestKey === undefined) return applyOnce(core, params, description, null);

  const digest = await applyRequestDigest(params);
  const key = canonicalJson([scope, description.root, params.ref ?? null, params.requestKey]);
  // Simultaneous duplicates: wait for the first, then find its receipt.
  for (let pending = core.inflight.get(key); pending; pending = core.inflight.get(key)) {
    await pending.catch(() => {});
  }
  const run = applyOnce(core, params, description, { key, digest });
  core.inflight.set(key, run);
  try {
    return await run;
  } finally {
    if (core.inflight.get(key) === run) core.inflight.delete(key);
  }
}

async function applyOnce(
  core: Core,
  params: BlocksApplyParams,
  description: StorageDescription,
  receipt: { key: string; digest: string } | null,
): Promise<BlocksApplyResult> {
  const limits = core.limits(description);
  const apply = normalize(params, limits);

  for (let attempt = 1; attempt <= core.maxCommitAttempts; attempt++) {
    // Receipts for completed identical requests resolve before any guard is rechecked.
    if (receipt) {
      const stored = await core.storage.getReceipt!(receipt.key);
      if (stored) {
        if (stored.digest !== receipt.digest) {
          throw invalidParams("requestKey was already used for a different request");
        }
        return receiptResult(apply, stored);
      }
    }

    const schema = await loadSchema(core, params, limits);
    if (params.ifSchemaMatch !== undefined && params.ifSchemaMatch !== schema.version) {
      throw conflict({ schema: { expected: params.ifSchemaMatch, actual: schema.version } });
    }
    const { violations, bodies } = validateStatic(apply, limits, schema.meta);
    const snapshot = await core.storage.snapshot({ ref: params.ref });
    const content = await loadContent(core.storage, snapshot, {
      readAll: false,
      limits,
      cache: core.cache,
    });
    violations.push(...validateAgainst(content, apply));
    if (violations.length > 0) throw invalidBlock(violations);

    const mismatches = checkIfMatch(content, apply);
    if (mismatches) throw conflict({ entries: mismatches });

    const { put, delete: deletes, expected } = plan(content, apply, bodies);
    if (Object.keys(put).length === 0 && deletes.length === 0 && !receipt) {
      return resultFromVersions(apply, snapshot.revision, {});
    }
    const result = await core.storage.commit({
      ref: params.ref,
      base: snapshot,
      put,
      delete: deletes,
      expected,
      receipt: receipt ?? undefined,
    });
    if (result.status === "committed") {
      return resultFromVersions(apply, result.revision, result.versions);
    }
  }
  throw unavailable(
    `storage kept changing; gave up after ${core.maxCommitAttempts} commit attempts`,
    250,
  );
}
