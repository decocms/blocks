/**
 * The local files of the remote commands (spec: cli › Local files):
 *
 * - `.deco/link.json` `{org, site}`, committed: which site the folder is.
 * - `.deco/blocks/`, git-ignored: one file per block, filled by `deco pull`.
 * - `.deco/pull.json`, git-ignored: what was pulled, per block its content
 *   hash (for `deco diff` and the dirty check) and the draft-relative
 *   precondition `deco push` sends as `ifMatch`.
 */
import fs from "node:fs";
import path from "node:path";
import { blockVersion } from "../../../protocol/canonical.ts";
import { blockFileName, isBlockFileName, serializeBlock } from "../../../protocol/keys.ts";
import { TOMBSTONE_VERSION } from "../../../protocol/storage.ts";
import { readSavedBlocks, type SavedBlocks, writeIfChanged } from "../content.ts";
import { CliError, type DecoPaths, usageError } from "../root.ts";

export interface Link {
  org: string;
  site: string;
}

/** `<org>/<site>`, as `deco link` takes it. */
export function parseLinkTarget(value: string | undefined): Link {
  const parts = value?.split("/") ?? [];
  const valid = (s: string | undefined) => !!s && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s);
  if (parts.length !== 2 || !valid(parts[0]) || !valid(parts[1])) {
    throw usageError(`expected <org>/<site>, such as acme/storefront; got ${value ?? "nothing"}`);
  }
  return { org: parts[0]!, site: parts[1]! };
}

export function writeLink(paths: DecoPaths, link: Link): boolean {
  return writeIfChanged(
    paths.link,
    `${JSON.stringify({ org: link.org, site: link.site }, null, 2)}\n`,
  );
}

/** The folder's site; no `.deco/link.json` is a usage error (run `deco link`). */
export function readLink(paths: DecoPaths): Link {
  let text: string;
  try {
    text = fs.readFileSync(paths.link, "utf8");
  } catch {
    throw usageError("no .deco/link.json: run deco link <org>/<site> first");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new CliError(`.deco/link.json: invalid JSON: ${(error as Error).message}`);
  }
  const { org, site } = (body ?? {}) as Record<string, unknown>;
  if (typeof org !== "string" || typeof site !== "string") {
    throw new CliError('.deco/link.json must be {"org": "...", "site": "..."}');
  }
  return parseLinkTarget(`${org}/${site}`);
}

export interface PullEntry {
  /** `blockVersion` of the pulled value; `null` when the pull holds no such block. */
  hash: string | null;
  /** The precondition, relative to `draft`: its version, the tombstone, or `null`. */
  ifMatch: string | null;
}

export interface PullState {
  format: 1;
  /** The pulled draft, or `null` for production. */
  draft: string | null;
  /** The live revision when it was pulled (`null` before a first publish). */
  revision: string | null;
  pulledAt: string;
  blocks: Record<string, PullEntry>;
}

export function readPull(paths: DecoPaths): PullState | null {
  let text: string;
  try {
    text = fs.readFileSync(paths.pull, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let body: any;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new CliError(
      `.deco/pull.json: invalid JSON (${(error as Error).message}); run deco pull`,
    );
  }
  if (body?.format !== 1 || typeof body.blocks !== "object" || body.blocks === null) {
    throw new CliError(".deco/pull.json isn't one deco pull wrote; run deco pull");
  }
  const blocks: Record<string, PullEntry> = Object.create(null);
  for (const [name, entry] of Object.entries(body.blocks as Record<string, any>)) {
    blocks[name] = { hash: entry?.hash ?? null, ifMatch: entry?.ifMatch ?? null };
  }
  return {
    format: 1,
    draft: typeof body.draft === "string" ? body.draft : null,
    revision: typeof body.revision === "string" ? body.revision : null,
    pulledAt: String(body.pulledAt ?? ""),
    blocks,
  };
}

export function writePull(paths: DecoPaths, state: PullState): void {
  const blocks: Record<string, PullEntry> = {};
  for (const name of Object.keys(state.blocks).sort()) blocks[name] = state.blocks[name]!;
  writeIfChanged(paths.pull, `${JSON.stringify({ ...state, blocks }, null, 2)}\n`);
}

/**
 * Read `.deco/blocks` for a remote command. A file that isn't a valid block
 * stops it: nothing is sent or overwritten from a folder that can't be read.
 */
export function readLocal(paths: DecoPaths): SavedBlocks {
  const saved = readSavedBlocks(paths.blocks);
  const errors = saved.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    throw new CliError(errors.map((d) => `.deco/blocks/${d.file}: ${d.message}`).join("\n"), {
      code: "invalid_local_block",
    });
  }
  return saved;
}

export type LocalStatus = "changed" | "new" | "deleted";

export interface LocalChange {
  name: string;
  status: LocalStatus;
  /** The local value (absent for a deletion). */
  block?: Record<string, unknown>;
  /** Its hash (absent for a deletion). */
  hash?: string;
}

/**
 * What the folder changes against pull.json, in name order: **changed** when
 * a file's hash differs from the recorded one, **new** when a file has no
 * entry (or the entry's hash is `null`), **deleted** when an entry has a hash
 * and no file remains. No pull.json makes every file new.
 */
export async function localChanges(
  saved: SavedBlocks,
  pull: PullState | null,
): Promise<LocalChange[]> {
  const recorded = pull?.blocks ?? Object.create(null);
  const changes: LocalChange[] = [];
  const names = new Set([...Object.keys(saved.blocks), ...Object.keys(recorded)]);
  for (const name of [...names].sort()) {
    const entry = Object.hasOwn(recorded, name) ? recorded[name] : undefined;
    if (Object.hasOwn(saved.blocks, name)) {
      const block = saved.blocks[name]!;
      const hash = await blockVersion(block);
      if (!entry || entry.hash === null) changes.push({ name, status: "new", block, hash });
      else if (entry.hash !== hash) changes.push({ name, status: "changed", block, hash });
    } else if (entry && entry.hash !== null) {
      changes.push({ name, status: "deleted" });
    }
  }
  return changes;
}

/**
 * Make `.deco/blocks` hold exactly `blocks`: write each (only when its text
 * changed) and remove every other block file, other spellings included.
 */
export function mirrorBlocks(paths: DecoPaths, blocks: Record<string, unknown>): void {
  fs.mkdirSync(paths.blocks, { recursive: true });
  const keep = new Set<string>();
  for (const name of Object.keys(blocks)) {
    const file = blockFileName(name);
    keep.add(file);
    writeIfChanged(path.join(paths.blocks, file), serializeBlock(blocks[name]));
  }
  for (const dirent of fs.readdirSync(paths.blocks, { withFileTypes: true })) {
    if (!dirent.isFile() || !isBlockFileName(dirent.name) || keep.has(dirent.name)) continue;
    fs.rmSync(path.join(paths.blocks, dirent.name));
  }
}

/** Write one block's file, or remove every file of that name (`block` undefined). */
export function writeLocalBlock(
  paths: DecoPaths,
  saved: SavedBlocks,
  name: string,
  block: unknown,
): void {
  const file = blockFileName(name);
  const current = Object.hasOwn(saved.files, name) ? saved.files[name] : undefined;
  if (current && current !== file) fs.rmSync(path.join(paths.blocks, current), { force: true });
  if (block === undefined) {
    fs.rmSync(path.join(paths.blocks, file), { force: true });
    return;
  }
  writeIfChanged(path.join(paths.blocks, file), serializeBlock(block));
}

/** The precondition of a name relative to a draft (spec: write protocol). */
export async function draftVersion(
  draft: { set: Record<string, unknown>; delete: string[] },
  name: string,
): Promise<string | null> {
  if (Object.hasOwn(draft.set, name)) return blockVersion(draft.set[name]);
  if (draft.delete.includes(name)) return TOMBSTONE_VERSION;
  return null;
}

/** A missing `--draft` where one is required. */
export function requireDraftName(value: unknown, command: string): string {
  if (typeof value !== "string" || value === "") {
    throw usageError(`deco ${command} needs --draft=<name>`);
  }
  return checkDraftName(value);
}

/** A draft name: today's branch rule, at most 255 characters. */
export function checkDraftName(value: string): string {
  if (value.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(value)) {
    throw usageError(
      `"${value}" isn't a draft name: letters, digits, and / . _ - after the first, at most 255`,
    );
  }
  return value;
}
