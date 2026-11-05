/**
 * The remote content commands (spec: cli › The deco CLI): `login`, `pull`,
 * `diff`, `push`, `publish`, `drafts`, `releases`, the remote sources of
 * `check`, and `schema push`. The site is `DECO_SITE` (`resolveSite`). Writes go through the Studio API;
 * only public reads go straight to the CDN. Nothing here retries and nothing
 * publishes as a side effect: only `deco publish` goes live.
 */
import fs from "node:fs";
import { blockVersion } from "../../../protocol/canonical.ts";
import { ErrorCode } from "../../../protocol/errors.ts";
import { serializeBlock } from "../../../protocol/keys.ts";
import {
  MAX_BLOCK_BYTES,
  MAX_OPS_PER_APPLY,
  MAX_REQUEST_BYTES,
} from "../../../protocol/server/core.ts";
import { TOMBSTONE_VERSION } from "../../../protocol/storage.ts";
import { isRevisionId } from "../../revisionId.ts";
import { paint } from "../color.ts";
import type { SavedBlocks } from "../content.ts";
import type { Reporter } from "../log.ts";
import { CliError, type DecoPaths, EXIT, usageError } from "../root.ts";
import { formatBlockDiff } from "./diff.ts";
import {
  type CommandRunner,
  deliveryUrl,
  type Env,
  loginCommand,
  resolveToken,
  studioUrl,
} from "./env.ts";
import {
  type ApplyParams,
  applyRequestBody,
  Delivery,
  type DraftBody,
  exitCodeForRpc,
  type Fetch,
  layer,
  RpcError,
  Studio,
  toMap,
} from "./http.ts";
import {
  draftVersion,
  type LocalChange,
  localChanges,
  mirrorBlocks,
  type PullEntry,
  type PullState,
  readLocal,
  readPull,
  resolveSite,
  writeLocalBlock,
  writePull,
} from "./local.ts";

/** What a command hands back: its exit code and its `--json` result. */
export interface Outcome {
  exitCode: number;
  result: Record<string, unknown>;
}

const ok = (result: Record<string, unknown>): Outcome => ({ exitCode: EXIT.ok, result });

export interface RemoteContext {
  paths: DecoPaths;
  reporter: Reporter;
  env: Env;
  fetch: Fetch;
  runCommand?: CommandRunner;
}

function services(ctx: RemoteContext): { site: string; studio: Studio; delivery: Delivery } {
  const { site } = resolveSite(ctx.paths, ctx.env);
  let token: Promise<string> | undefined;
  const studio = new Studio({
    base: studioUrl(ctx.env),
    site,
    fetch: ctx.fetch,
    token: () => {
      token ??= resolveToken(ctx.env, ctx.runCommand);
      return token;
    },
  });
  return { site, studio, delivery: new Delivery(deliveryUrl(ctx.env), site, ctx.fetch) };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function at(seconds: number | undefined): string {
  return typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : "an unknown time";
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

export function login(ctx: { env: Env; reporter: Reporter }): Outcome {
  const command = loginCommand(ctx.env);
  ctx.reporter.info(
    `The deco CLI uses Studio's login. Log in once with:\n\n  ${command}\n\n` +
      "In CI or a sandbox, set DECO_TOKEN to a Studio API key instead.",
  );
  return ok({ command });
}

// ---------------------------------------------------------------------------
// Reading content: a draft or production, as blocks
// ---------------------------------------------------------------------------

interface Source {
  draft: string | null;
  revision: string | null;
  blocks: Record<string, unknown>;
  /** The draft object, when the source is a draft. */
  body?: DraftBody;
}

async function readSource(
  studio: Studio,
  delivery: Delivery,
  draft: string | null,
): Promise<Source> {
  if (draft === null) {
    const production = await delivery.production();
    return { draft, ...production };
  }
  // Resolve first: a missing login or draft is reported before the CDN is read.
  const resolved = await studio.resolveDraft(draft);
  const [production, body] = await Promise.all([
    delivery.production(),
    delivery.draft(resolved.slug, resolved.etag),
  ]);
  return { draft, revision: production.revision, blocks: layer(production.blocks, body), body };
}

function describeSource(source: { draft: string | null; revision: string | null }): string {
  const revision = source.revision ? `revision ${source.revision}` : "no release yet";
  return source.draft === null
    ? `production (${revision})`
    : `draft ${source.draft} (over ${revision})`;
}

/**
 * What `deco diff` compared against. A draft is read as it is now (pull.json
 * keeps only hashes), which can differ from what was pulled: the label says so.
 */
function describeDiffSource(source: { draft: string | null; revision: string | null }): string {
  if (source.draft === null) return describeSource(source);
  const revision = source.revision ? `revision ${source.revision}` : "no release yet";
  return `draft ${source.draft} as it is now (over ${revision})`;
}

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

export async function pull(
  ctx: RemoteContext,
  options: { draft: string | null; force: boolean },
): Promise<Outcome> {
  const { studio, delivery } = services(ctx);
  if (!options.force) {
    const previous = readPull(ctx.paths);
    const changes = await localChanges(readLocal(ctx.paths), previous);
    if (changes.length > 0) {
      throw new CliError(
        `.deco/blocks has ${plural(changes.length, "change")} not pushed (${changes
          .slice(0, 5)
          .map((c) => c.name)
          .join(
            ", ",
          )}${changes.length > 5 ? ", …" : ""}); push them, or pull with --force to overwrite them`,
        { code: "unpushed_changes", details: { changes: changes.map(changeRow) } },
      );
    }
  }
  const source = await readSource(studio, delivery, options.draft);
  const blocks: Record<string, PullEntry> = Object.create(null);
  for (const name of Object.keys(source.blocks)) {
    blocks[name] = {
      hash: await blockVersion(source.blocks[name]),
      ifMatch: source.body ? await draftVersion(source.body, name) : null,
    };
  }
  for (const name of source.body?.delete ?? []) {
    if (!Object.hasOwn(blocks, name)) blocks[name] = { hash: null, ifMatch: TOMBSTONE_VERSION };
  }
  mirrorBlocks(ctx.paths, source.blocks);
  writePull(ctx.paths, {
    format: 1,
    draft: source.draft,
    revision: source.revision,
    pulledAt: new Date().toISOString(),
    blocks,
  });
  const count = Object.keys(source.blocks).length;
  ctx.reporter.info(`pulled ${plural(count, "block")} from ${describeSource(source)}`);
  return ok({ draft: source.draft, revision: source.revision, blocks: count });
}

function changeRow(change: LocalChange) {
  return { name: change.name, status: change.status };
}

const STATUS_MARK: Record<LocalChange["status"], string> = { changed: "M", new: "A", deleted: "D" };

function printChange(
  reporter: Reporter,
  name: string,
  status: LocalChange["status"],
  from: unknown,
  to: unknown,
) {
  const c = paint(reporter.color);
  const body = formatBlockDiff(from, to, { color: reporter.color });
  reporter.info(`${c.bold(`${STATUS_MARK[status]} ${name}`)}${body ? `\n${body}` : ""}`);
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

/** What differs between two sets of blocks, in name order (`to` is the newer side). */
async function compare(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
): Promise<{ name: string; status: LocalChange["status"] }[]> {
  const rows: { name: string; status: LocalChange["status"] }[] = [];
  for (const name of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
    const inFrom = Object.hasOwn(from, name);
    const inTo = Object.hasOwn(to, name);
    if (inFrom && inTo) {
      if ((await blockVersion(from[name])) !== (await blockVersion(to[name])))
        rows.push({ name, status: "changed" });
    } else rows.push({ name, status: inTo ? "new" : "deleted" });
  }
  return rows;
}

export async function diff(
  ctx: RemoteContext,
  options: { draft: string | null },
): Promise<Outcome> {
  const saved = readLocal(ctx.paths);
  const local = saved.blocks as Record<string, unknown>;
  const { studio, delivery } = services(ctx);
  let rows: { name: string; status: LocalChange["status"] }[];
  let source: { draft: string | null; revision: string | null; blocks: Record<string, unknown> };
  if (options.draft !== null) {
    source = await readSource(studio, delivery, options.draft);
    rows = await compare(source.blocks, local);
  } else {
    const state = readPull(ctx.paths);
    if (!state) throw new CliError("nothing pulled yet: run deco pull", { code: "not_pulled" });
    rows = (await localChanges(saved, state)).map(changeRow);
    if (state.draft !== null) {
      source = await readSource(studio, delivery, state.draft);
    } else {
      const blocks =
        state.revision === null ? Object.create(null) : await delivery.revision(state.revision);
      if (blocks === null) {
        throw new CliError(`the CDN has no revision ${state.revision}`, {
          code: "revision_not_found",
        });
      }
      source = { draft: null, revision: state.revision, blocks };
    }
  }
  for (const row of rows) {
    printChange(ctx.reporter, row.name, row.status, source.blocks[row.name], local[row.name]);
  }
  ctx.reporter.info(
    rows.length === 0
      ? `no changes against ${describeDiffSource(source)}`
      : `${plural(rows.length, "change")} against ${describeDiffSource(source)}`,
  );
  return ok({ draft: source.draft, revision: source.revision, changes: rows });
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

interface Item {
  name: string;
  /** The local value, or undefined for a deletion. */
  block?: Record<string, unknown>;
  hash: string | null;
  ifMatch: string | null;
}

const ENVELOPE_BYTES = Buffer.byteLength(applyRequestBody({ set: {}, delete: [], ifMatch: {} }));

function itemBytes(item: Item): { set: number; delete: number; ifMatch: number } {
  const key = JSON.stringify(item.name);
  return {
    set: item.block === undefined ? 0 : Buffer.byteLength(`${key}:${JSON.stringify(item.block)}`),
    delete: item.block === undefined ? Buffer.byteLength(key) : 0,
    ifMatch: Buffer.byteLength(`${key}:${JSON.stringify(item.ifMatch)}`),
  };
}

/**
 * Packs items, in order, into batches whose serialized `blocks.apply`
 * request stays at most `limit` bytes and that hold at most `maxNames`
 * names (set plus delete): the two caps the content handler puts on one
 * call. The byte count is exact: the size of a JSON object is its entries
 * plus one comma between each two. A block whose stored form is over the
 * handler's per-entry cap (`MAX_BLOCK_BYTES`) can never be saved, so it
 * fails here, before anything is sent.
 */
export function packBatches(
  items: Item[],
  limit = MAX_REQUEST_BYTES,
  maxNames = MAX_OPS_PER_APPLY,
): Item[][] {
  const batches: Item[][] = [];
  let current: Item[] = [];
  let size = ENVELOPE_BYTES;
  let counts = { set: 0, delete: 0, ifMatch: 0 };
  const added = (bytes: ReturnType<typeof itemBytes>, c: typeof counts) =>
    (bytes.set ? bytes.set + (c.set > 0 ? 1 : 0) : 0) +
    (bytes.delete ? bytes.delete + (c.delete > 0 ? 1 : 0) : 0) +
    bytes.ifMatch +
    (c.ifMatch > 0 ? 1 : 0);
  for (const item of items) {
    if (
      item.block !== undefined &&
      Buffer.byteLength(serializeBlock(item.block)) > MAX_BLOCK_BYTES
    ) {
      throw new CliError(
        `block "${item.name}" is larger than a save can carry (${MAX_BLOCK_BYTES} bytes a block)`,
        { code: "too_large", details: { name: item.name } },
      );
    }
    const bytes = itemBytes(item);
    if (ENVELOPE_BYTES + added(bytes, { set: 0, delete: 0, ifMatch: 0 }) > limit) {
      throw new CliError(
        `block "${item.name}" alone is larger than a save can carry (${limit} bytes)`,
        { code: "too_large", details: { name: item.name } },
      );
    }
    if (current.length >= maxNames || (current.length > 0 && size + added(bytes, counts) > limit)) {
      batches.push(current);
      current = [];
      size = ENVELOPE_BYTES;
      counts = { set: 0, delete: 0, ifMatch: 0 };
    }
    size += added(bytes, counts);
    current.push(item);
    counts = {
      set: counts.set + (bytes.set ? 1 : 0),
      delete: counts.delete + (bytes.delete ? 1 : 0),
      ifMatch: counts.ifMatch + 1,
    };
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function applyParams(items: Item[]): ApplyParams {
  const set: Record<string, unknown> = {};
  const deleted: string[] = [];
  const ifMatch: Record<string, string | null> = {};
  for (const item of items) {
    // defineProperty, so a block named "__proto__" is sent as a name.
    if (item.block !== undefined)
      Object.defineProperty(set, item.name, {
        value: item.block,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else deleted.push(item.name);
    Object.defineProperty(ifMatch, item.name, {
      value: item.ifMatch,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { set, delete: deleted, ifMatch };
}

interface ConflictEntry {
  expected: string | null;
  actual: string | null;
  theirs: unknown;
  editor: { userId: string; at: number } | null;
}

function readConflicts(data: unknown): Record<string, ConflictEntry> {
  const d = (data ?? {}) as {
    entries?: Record<string, { expected: string | null; actual: string | null }>;
    draft?: Record<
      string,
      { block: unknown; version: string; editor: ConflictEntry["editor"] } | null
    >;
  };
  const out: Record<string, ConflictEntry> = Object.create(null);
  for (const [name, entry] of Object.entries(d.entries ?? {})) {
    const held = d.draft && Object.hasOwn(d.draft, name) ? d.draft[name] : null;
    out[name] = {
      expected: entry?.expected ?? null,
      actual: entry?.actual ?? null,
      theirs: held ? held.block : null,
      editor: held?.editor ?? null,
    };
  }
  return out;
}

export async function push(
  ctx: RemoteContext,
  options: { draft: string; side: "ours" | "theirs" | null },
): Promise<Outcome> {
  const { studio, delivery } = services(ctx);
  let saved = readLocal(ctx.paths);
  const pulled = readPull(ctx.paths);
  // Pushing to a draft other than the one pulled: every precondition is
  // relative to the pulled draft, so none of them hold for this one.
  let state: PullState;
  if (pulled && pulled.draft === options.draft) state = pulled;
  else {
    const blocks: Record<string, PullEntry> = Object.create(null);
    for (const [name, entry] of Object.entries(pulled?.blocks ?? {}))
      blocks[name] = { hash: entry.hash, ifMatch: null };
    state = {
      format: 1,
      draft: options.draft,
      revision: pulled?.revision ?? null,
      pulledAt: pulled?.pulledAt ?? new Date().toISOString(),
      blocks,
    };
    if (pulled) writePull(ctx.paths, state);
  }
  const changes = await localChanges(saved, state);
  const items: Item[] = changes.map((change) => ({
    name: change.name,
    block: change.block,
    hash: change.hash ?? null,
    ifMatch: Object.hasOwn(state.blocks, change.name) ? state.blocks[change.name]!.ifMatch : null,
  }));
  const batches = packBatches(items);
  const ensured = await studio.ensureDraft(options.draft);
  if (ensured.created) ctx.reporter.info(`created draft ${options.draft}`);

  let production: Promise<Record<string, unknown>> | undefined;
  const productionBlocks = () => {
    production ??= delivery.production().then((p) => p.blocks);
    return production;
  };
  const record = (batch: Item[], versions: Record<string, string | null>) => {
    for (const item of batch) {
      state.blocks[item.name] = {
        hash: item.block === undefined ? null : item.hash,
        ifMatch: Object.hasOwn(versions, item.name) ? (versions[item.name] ?? null) : null,
      };
    }
    writePull(ctx.paths, state);
  };

  let pushed = 0;
  let taken = 0;
  for (const [index, original] of batches.entries()) {
    let batch = original;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await studio.apply(options.draft, applyRequestBody(applyParams(batch)));
        record(batch, result.versions ?? {});
        pushed += batch.length;
        break;
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        if (error.code !== ErrorCode.Conflict) {
          const busy = error.code === ErrorCode.Unavailable;
          throw new CliError(
            busy
              ? `Studio is busy (${error.message}); nothing of this batch was saved, run deco push again`
              : `Studio refused the save: ${error.message}`,
            {
              exitCode: exitCodeForRpc(error.code),
              code: busy ? "unavailable" : `rpc_${-error.code}`,
              details: { pushed, batch: index + 1, batches: batches.length, rpc: error.data },
            },
          );
        }
        const conflicts = readConflicts(error.data);
        if (options.side === null || attempt > 0) {
          reportConflicts(ctx.reporter, conflicts, saved);
          throw new CliError(
            `${plural(Object.keys(conflicts).length, "block")} changed in draft ${options.draft} since you pulled; nothing of this batch was saved. ` +
              "Pull again, or push with --ours (keep yours) or --theirs (take theirs)",
            {
              exitCode: EXIT.conflict,
              code: "conflict",
              details: { pushed, batch: index + 1, batches: batches.length, conflicts },
            },
          );
        }
        if (options.side === "ours") {
          batch = batch.map((item) =>
            Object.hasOwn(conflicts, item.name)
              ? { ...item, ifMatch: conflicts[item.name]!.actual }
              : item,
          );
          continue;
        }
        // --theirs: take each conflicting block into .deco/blocks as the draft holds it.
        const prod = Object.values(conflicts).some((c) => c.theirs === null && c.actual === null)
          ? await productionBlocks()
          : null;
        for (const [name, conflict] of Object.entries(conflicts)) {
          let value: unknown;
          let hash: string | null = null;
          if (conflict.actual === TOMBSTONE_VERSION) value = undefined;
          else if (conflict.theirs !== null) value = conflict.theirs;
          else value = prod && Object.hasOwn(prod, name) ? prod[name] : undefined;
          if (value !== undefined) hash = await blockVersion(value);
          writeLocalBlock(ctx.paths, saved, name, value);
          state.blocks[name] = { hash, ifMatch: conflict.actual };
          taken++;
        }
        writePull(ctx.paths, state);
        saved = readLocal(ctx.paths);
        batch = batch.filter((item) => !Object.hasOwn(conflicts, item.name));
        if (batch.length === 0) break;
      }
    }
  }
  const resolved = await studio.resolveDraft(options.draft);
  const link = resolved.previewUrl ?? resolved.pointer;
  ctx.reporter.info(
    `pushed ${plural(pushed, "block")} to draft ${options.draft}` +
      (batches.length > 1 ? ` in ${batches.length} saves` : "") +
      (taken > 0 ? `; took theirs for ${plural(taken, "block")}` : ""),
  );
  if (link) ctx.reporter.info(`preview: ${link}`);
  return ok({
    draft: options.draft,
    pushed,
    batches: batches.length,
    tookTheirs: taken,
    previewUrl: resolved.previewUrl,
    pointer: resolved.pointer,
  });
}

function reportConflicts(
  reporter: Reporter,
  conflicts: Record<string, ConflictEntry>,
  saved: SavedBlocks,
) {
  const c = paint(reporter.color);
  for (const [name, conflict] of Object.entries(conflicts)) {
    const who = conflict.editor
      ? `changed by ${conflict.editor.userId} at ${at(conflict.editor.at)}`
      : "changed by someone else";
    const theirs =
      conflict.actual === TOMBSTONE_VERSION
        ? "theirs deletes it"
        : conflict.theirs === null
          ? "the draft no longer holds it (production's value applies)"
          : "theirs (-) against yours (+)";
    const yours = Object.hasOwn(saved.blocks, name) ? saved.blocks[name] : undefined;
    const body =
      conflict.theirs === null
        ? ""
        : formatBlockDiff(conflict.theirs, yours, { color: reporter.color });
    reporter.error(`${c.bold(`conflict: ${name}`)}: ${who}; ${theirs}${body ? `\n${body}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

export async function publish(
  ctx: RemoteContext,
  options: { draft: string; message: string | undefined },
): Promise<Outcome> {
  const { studio, delivery } = services(ctx);
  const resolved = await studio.resolveDraft(options.draft);
  const [production, body] = await Promise.all([
    delivery.production(),
    delivery.draft(resolved.slug, resolved.etag),
  ]);
  const rows = await compare(production.blocks, layer(production.blocks, body));
  const after = layer(production.blocks, body);
  for (const row of rows) {
    printChange(ctx.reporter, row.name, row.status, production.blocks[row.name], after[row.name]);
  }
  ctx.reporter.info(
    `draft ${options.draft} changes ${plural(rows.length, "block")} of ${describeSource({ draft: null, revision: production.revision })}`,
  );
  const result = await studio.publish(options.draft, options.message);
  if (result.result === "published") {
    ctx.reporter.info(`published revision ${result.revision}; it is live`);
  } else {
    ctx.reporter.info(
      `nothing to publish: production already has every block of draft ${options.draft}`,
    );
  }
  if (!result.draftEmptied && result.result === "published") {
    ctx.reporter.warn(
      `draft ${options.draft} was saved during the publish, so it wasn't emptied: it still holds its blocks`,
    );
  }
  return ok({ draft: options.draft, ...result, changes: rows });
}

// ---------------------------------------------------------------------------
// drafts, releases
// ---------------------------------------------------------------------------

export async function drafts(
  ctx: RemoteContext,
  options: { action: string | undefined; name: string | null },
): Promise<Outcome> {
  const { studio } = services(ctx);
  const need = () => {
    if (options.name === null) throw usageError(`deco drafts ${options.action} needs a draft name`);
    return options.name;
  };
  switch (options.action) {
    case "list": {
      if (options.name !== null) throw usageError("deco drafts list takes no name");
      const rows = await studio.listDrafts();
      if (rows.length === 0) ctx.reporter.info("no drafts");
      for (const row of rows) {
        ctx.reporter.info(`${row.name}  ${row.createdBy} via ${row.via}, ${row.createdAt}`);
      }
      return ok({ drafts: rows });
    }
    case "new": {
      const draft = await studio.ensureDraft(need());
      ctx.reporter.info(
        draft.created ? `created draft ${draft.name}` : `draft ${draft.name} already exists`,
      );
      if (draft.previewUrl) ctx.reporter.info(`preview: ${draft.previewUrl}`);
      return ok({ draft });
    }
    case "discard": {
      const name = need();
      await studio.discardDraft(name);
      ctx.reporter.info(`discarded draft ${name}`);
      return ok({ draft: name, discarded: true });
    }
    case "url": {
      const draft = await studio.resolveDraft(need());
      if (draft.previewUrl) ctx.reporter.info(draft.previewUrl);
      else if (draft.pointer)
        ctx.reporter.info(
          `${draft.pointer}\n(the site has no preview address in Studio: open the site with ?__draft=<this pointer>)`,
        );
      else ctx.reporter.info(`draft ${draft.name} has no object yet: push to it first`);
      return ok({ draft: draft.name, previewUrl: draft.previewUrl, pointer: draft.pointer });
    }
    default:
      throw usageError(
        `deco drafts needs list, new <name>, discard <name> or url <name>${options.action ? `, not "${options.action}"` : ""}`,
      );
  }
}

export async function releases(
  ctx: RemoteContext,
  options: { cursor: string | undefined },
): Promise<Outcome> {
  const { studio } = services(ctx);
  const page = await studio.releases(options.cursor);
  const c = paint(ctx.reporter.color);
  if (page.revisions.length === 0) ctx.reporter.info("no releases yet");
  for (const row of page.revisions) {
    const meta = row.meta ?? {};
    const status =
      row.status === "current"
        ? c.green("live")
        : row.status === "was-live"
          ? "was live"
          : c.dim("never live");
    const what =
      typeof meta.reapplyOf === "string"
        ? `rollback to ${meta.reapplyOf}`
        : typeof meta.draft === "string"
          ? `draft ${meta.draft}`
          : "";
    ctx.reporter.info(
      `${row.id}  ${status}  ${meta.publishedAt ?? ""}  ${meta.author ?? ""} via ${meta.via ?? "?"}` +
        `${what ? `  ${what}` : ""}${meta.message ? `  ${JSON.stringify(meta.message)}` : ""}`,
    );
  }
  if (page.nextCursor) ctx.reporter.info(`more: deco releases --cursor=${page.nextCursor}`);
  return ok({ ...page });
}

// ---------------------------------------------------------------------------
// check's remote sources, schema push
// ---------------------------------------------------------------------------

/** The blocks `deco check --draft` or `--revision` validates. */
export async function remoteBlocks(
  ctx: RemoteContext,
  options: { draft: string | null; revision: string | null },
): Promise<{ label: string; blocks: Record<string, unknown> }> {
  const { studio, delivery } = services(ctx);
  if (options.revision !== null) {
    if (!isRevisionId(options.revision)) {
      throw usageError(`"${options.revision}" isn't a revision id (deco releases lists them)`);
    }
    const blocks = await delivery.revision(options.revision);
    if (blocks === null) {
      throw new CliError(`no revision ${options.revision} on the CDN`, {
        code: "revision_not_found",
      });
    }
    return { label: `revision ${options.revision}`, blocks };
  }
  const source = await readSource(studio, delivery, options.draft);
  return { label: describeSource(source), blocks: toMap(source.blocks) };
}

export async function schemaPush(ctx: RemoteContext): Promise<Outcome> {
  const { studio } = services(ctx);
  let text: string;
  try {
    text = fs.readFileSync(ctx.paths.schema, "utf8");
  } catch {
    throw new CliError("no .deco/schema.gen.json; run deco schema first", { code: "no_schema" });
  }
  try {
    JSON.parse(text);
  } catch (error) {
    throw new CliError(`.deco/schema.gen.json: invalid JSON: ${(error as Error).message}`, {
      code: "invalid_schema",
    });
  }
  const result = await studio.pushSchema(text);
  ctx.reporter.info(
    `pushed .deco/schema.gen.json (${result.blocksMajor === 8 ? "a v8 schema" : "not a v8 schema"})`,
  );
  return ok({ etag: result.etag, blocksMajor: result.blocksMajor });
}
