/**
 * The local files of the remote commands (spec: cli › Local files):
 *
 * - The site is `DECO_SITE` (the environment, else the folder's own config;
 *   see `resolveSite`), not a file of its own.
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

/**
 * Where the remote commands look for `DECO_SITE` after the process
 * environment, in this order, each in the folder that contains `.deco/`:
 * the first one that sets it wins.
 */
export const SITE_SOURCES = [
  ".env",
  ".dev.vars",
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml",
] as const;

const SITE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The value a dotenv-style file (`.env`, `.dev.vars`) gives `key`, the last one winning. */
export function dotenvValue(text: string, key: string): string | undefined {
  let value: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== key) continue;
    const raw = match[2]!;
    const quoted = /^(["'])(.*?)\1/.exec(raw);
    value = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, "").trim();
  }
  return value;
}

/**
 * JSONC (`wrangler.jsonc`) as JSON: `//` and `/* *\/` comments and trailing
 * commas removed, string contents untouched.
 */
export function stripJsonc(text: string): string {
  // Copies a string literal from text[i] (its opening quote) and returns the index after it.
  const literal = (src: string, i: number, into: string[]): number => {
    let j = i + 1;
    while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
    into.push(src.slice(i, j + 1));
    return j + 1;
  };
  const noComments: string[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] === '"') i = literal(text, i, noComments);
    else if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
      noComments.push(" ");
    } else noComments.push(text[i++]!);
  }
  const plain = noComments.join("");
  const out: string[] = [];
  for (let i = 0; i < plain.length; ) {
    if (plain[i] === '"') i = literal(plain, i, out);
    else if (plain[i] === ",") {
      let j = i + 1;
      while (j < plain.length && /\s/.test(plain[j]!)) j++;
      if (plain[j] !== "}" && plain[j] !== "]") out.push(",");
      i++;
    } else out.push(plain[i++]!);
  }
  return out.join("");
}

/** `vars.DECO_SITE` of a `wrangler.toml`: in its `[vars]` table or a top-level inline `vars = {…}`. */
export function wranglerTomlVar(text: string, key: string): string | undefined {
  const string = `(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`;
  let table: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1]!;
      continue;
    }
    if (table === "vars") {
      const match = new RegExp(`^\\s*${key}\\s*=\\s*${string}`).exec(line);
      if (match) return match[1] ?? match[2];
    } else if (table === null) {
      const inline = /^\s*vars\s*=\s*\{(.*)\}/.exec(line);
      const match = inline && new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*${string}`).exec(inline[1]!);
      if (match) return match[1] ?? match[2];
    }
  }
  return undefined;
}

function siteFrom(file: string, text: string): string | undefined {
  if (file === ".env" || file === ".dev.vars") return dotenvValue(text, "DECO_SITE");
  if (file === "wrangler.toml") return wranglerTomlVar(text, "DECO_SITE");
  let body: unknown;
  try {
    body = JSON.parse(file === "wrangler.jsonc" ? stripJsonc(text) : text);
  } catch (error) {
    throw new CliError(`${file}: invalid JSON: ${(error as Error).message}`, {
      code: "invalid_config",
    });
  }
  const vars = (body as { vars?: unknown } | null)?.vars;
  const value =
    typeof vars === "object" && vars !== null
      ? (vars as Record<string, unknown>).DECO_SITE
      : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * The Studio site the remote commands talk to: `DECO_SITE` from the process
 * environment, else from the folder's own config (`SITE_SOURCES`, in order).
 * Studio finds the site's organization; the CLI never names one. No
 * `DECO_SITE` anywhere is a usage error (64).
 */
export function resolveSite(
  paths: DecoPaths,
  env: Record<string, string | undefined>,
): { site: string; from: string } {
  let found: { site: string; from: string } | undefined;
  const fromEnv = env.DECO_SITE?.trim();
  if (fromEnv) found = { site: fromEnv, from: "the environment" };
  for (const file of SITE_SOURCES) {
    if (found) break;
    let text: string;
    try {
      text = fs.readFileSync(path.join(paths.root, file), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new CliError(`${file}: ${(error as Error).message}`, { code: "invalid_config" });
    }
    const value = siteFrom(file, text)?.trim();
    if (value) found = { site: value, from: file };
  }
  if (!found) {
    throw usageError(
      `no Studio site: set DECO_SITE in the environment, or in ${paths.root}'s .env, .dev.vars, ` +
        "or vars.DECO_SITE of wrangler.jsonc, wrangler.json or wrangler.toml (looked in that order)",
    );
  }
  if (!SITE_RE.test(found.site)) {
    throw usageError(`DECO_SITE (from ${found.from}) isn't a site name: "${found.site}"`);
  }
  return found;
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
