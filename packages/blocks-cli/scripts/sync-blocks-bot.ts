#!/usr/bin/env tsx
/**
 * @decocms/blocks-cli — pull the production decofile into `.deco/blocks/`
 *
 * Secure replacement for the legacy push-based content sync, where a workflow
 * in the *legacy* Fresh repo held a cross-repo PAT and pushed straight into the
 * migrated repo's `main` (`rsync --delete` + `git push`). That token is a code
 * -write door into the new repo, not a content channel.
 *
 * This inverts the direction: the migrated repo *pulls* the decofile from the
 * live site (`GET <origin>/.decofile`, public and unauthenticated) on a daily
 * cron, materialises one file per block, and opens a PR. No cross-repo token,
 * no write permission handed to anyone, and the content passes a build gate
 * before reaching `main`. See `docs/sync-blocks-bot.md`.
 *
 * Three filters decide what may be overwritten:
 *   1. `--deny <globs>`      — deny by block key (default: the `Site` block).
 *   2. encrypted-secret shape — any block carrying a `{name, encrypted}` secret
 *      ref anywhere in its tree is left alone. That is what protects the
 *      credentials the migration moves onto the new site's own app block
 *      (e.g. `deco-vtex`), which do not exist in that layout upstream.
 *      Opt out with `--allow-secret-blocks`.
 *   3. `--fail-on-plaintext-secret` — aborts if an accepted block carries what
 *      looks like a *plaintext* credential, so a leak upstream is never
 *      committed into git.
 *
 * Usage (from a site root):
 *   tsx sync-blocks-bot.ts --origin https://www.minhaloja.com.br --prune
 *   tsx sync-blocks-bot.ts --url https://www.minhaloja.com.br/.decofile --dry-run --json
 *
 * Exit codes:
 *   0 — done (with or without changes)
 *   1 — `--fail-on-plaintext-secret` and at least one plaintext finding
 *   2 — usage / network / payload validation error (nothing was written)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBlockNameWithPasses } from "./lib/blocks-dedupe";

/** Block keys never overwritten by a sync unless `--deny` is overridden. */
export const DEFAULT_DENY = ["Site", "site"];

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Property names whose *string* value would be a credential in the clear.
 * A bare `key` is deliberately NOT here: CMS content is full of `key` props
 * that are nothing of the sort (`selectedFacets[].key` on every VTEX PLP
 * loader — 331 false positives on a real site), and a gate that cries wolf is a
 * gate nobody keeps on.
 * `key` only counts when qualified (`apiKey`, `appKey`, `privateKey`, …).
 */
const SECRET_PROP_RE =
  /(?:^|_)(?:(?:api|app|access|private|public|client|secret|auth)_?keys?|tokens?|secrets?|passwords?|passwd|pwd)$/;

/** `appToken` -> `app_token`, so one snake_case regex covers both styles. */
function normalizeProp(prop: string): string {
  return prop
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

export interface PullOptions {
  /** Directory that holds one JSON file per block (usually `.deco/blocks`). */
  out: string;
  /** Glob patterns (`*` wildcard) matched against the block key. */
  deny?: string[];
  /** Overwrite blocks that carry an encrypted secret ref (default: false). */
  allowSecretBlocks?: boolean;
  /** Delete local blocks that no longer exist upstream (default: false). */
  prune?: boolean;
  /** Compute the report without touching the filesystem. */
  dryRun?: boolean;
}

export interface PullReport {
  added: string[];
  updated: string[];
  unchanged: number;
  removed: string[];
  /** Keys skipped by the deny glob. */
  denied: string[];
  /** Keys skipped because the local/remote block carries an encrypted secret. */
  protectedSecretBlocks: string[];
  /** Keys skipped because the payload value was not a JSON object. */
  skipped: string[];
  /** `<key>.<prop path>` of every plaintext credential found in a written block. */
  plaintextSecrets: string[];
  /** Blocks present in the remote payload. */
  remoteBlocks: number;
  revision?: string;
  bytes?: number;
}

export interface FetchResult {
  blocks: Record<string, unknown>;
  revision?: string;
  bytes: number;
}

// ---------------------------------------------------------------- pure helpers

/** `*`-only glob match against a whole block key. */
export function matchesGlob(key: string, pattern: string): boolean {
  const rx = new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? "[\\s\\S]*" : `\\${c}`))}$`,
  );
  return rx.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True iff the block carries a Deco encrypted-secret ref anywhere in its tree.
 * Prod serves those as `{"name": "MY_TOKEN", "encrypted": "3a714de1c8…"}`.
 */
export function hasEncryptedSecretRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasEncryptedSecretRef);
  if (!isPlainObject(value)) return false;
  if (typeof value.name === "string" && typeof value.encrypted === "string" && value.encrypted) {
    return true;
  }
  return Object.values(value).some(hasEncryptedSecretRef);
}

/**
 * Property paths whose name looks credential-shaped and whose value is a raw
 * string — i.e. a secret in the clear rather than an `{name, encrypted}` ref.
 * URLs and values with whitespace are excluded (endpoints, prose, templates).
 */
export function findPlaintextSecrets(value: unknown, prefix = ""): string[] {
  const found: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) walk(item, `${at}[${i}]`);
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [prop, child] of Object.entries(node)) {
      const at2 = at ? `${at}.${prop}` : prop;
      if (
        typeof child === "string" &&
        child.length >= 12 &&
        SECRET_PROP_RE.test(normalizeProp(prop)) &&
        !/\s/.test(child) &&
        !/^https?:\/\//i.test(child) &&
        !/^\{\{.*\}\}$/.test(child)
      ) {
        found.push(at2);
        continue;
      }
      walk(child, at2);
    }
  };
  walk(value, prefix);
  return found;
}

/** Fully URL-decode a block key or filename stem, for cross-scheme matching. */
function canonicalKey(keyOrFile: string): string {
  return decodeBlockNameWithPasses(keyOrFile).name;
}

/**
 * Serialised on-disk form of a block: pretty-printed, so a PR diff shows the
 * sections/props that actually changed instead of one 3 MB line.
 */
function serialize(block: unknown): string {
  return `${JSON.stringify(block, null, 2)}\n`;
}

/**
 * Key-sorted JSON, for *comparison only*. Writers of `.deco/blocks` disagree on
 * formatting (the Studio daemon and the old bot minify, a hand-made sync PR
 * pretty-prints) and on key order, so a byte compare reports a diff on a block
 * whose content is identical — 124 of 432 blocks on a real site's first run.
 * Compare semantically, write only real content changes.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!isPlainObject(value)) return JSON.stringify(value) ?? "null";
  const entries = Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${entries.join(",")}}`;
}

// ------------------------------------------------------------------ fetch side

/** Download and validate the remote decofile. Throws on any bad payload. */
export async function fetchDecofile(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<FetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const res = await fetch(url, {
    redirect: "follow",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status} ${res.statusText}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new Error(`${url} served "${contentType || "no content-type"}", expected JSON`);
  }
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${url} is ${declared} bytes, over the ${maxBytes} byte cap`);
  }

  const body = await res.text();
  if (body.length > maxBytes) {
    throw new Error(`${url} is ${body.length} bytes, over the ${maxBytes} byte cap`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`${url} did not return valid JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `${url} returned ${Array.isArray(parsed) ? "an array" : typeof parsed}, expected a decofile object`,
    );
  }

  return { blocks: parsed, revision: res.headers.get("etag") ?? undefined, bytes: body.length };
}

// ------------------------------------------------------------------ write side

/**
 * Materialise `remote` into `opts.out`, one file per block.
 *
 * Filenames are `encodeURIComponent(key) + ".json"` — the single-decode scheme
 * the runtime's `parseBlockId` expects. When a file for the same *logical* key
 * already exists under a different encoding (the `deco-sync-bot` wrote
 * double-encoded names), that existing file is overwritten in place instead of
 * a second, colliding one being created.
 */
export function writeDecofileToDir(remote: Record<string, unknown>, opts: PullOptions): PullReport {
  const out = path.resolve(opts.out);
  const deny = opts.deny ?? DEFAULT_DENY;
  const report: PullReport = {
    added: [],
    updated: [],
    unchanged: 0,
    removed: [],
    denied: [],
    protectedSecretBlocks: [],
    skipped: [],
    plaintextSecrets: [],
    remoteBlocks: Object.keys(remote).length,
  };

  fs.mkdirSync(out, { recursive: true });

  // Index what is already on disk by fully-decoded key, so we overwrite legacy
  // double-encoded filenames instead of duplicating them. A key can map to
  // several files (the `deco-sync-bot` wrote `pages-A%2520B.json` where the
  // manual sync wrote `pages-A%20B.json`).
  const existingByKey = new Map<string, string[]>();
  for (const file of fs.readdirSync(out)) {
    if (!file.endsWith(".json")) continue;
    const key = canonicalKey(file);
    const list = existingByKey.get(key);
    if (list) list.push(file);
    else existingByKey.set(key, [file]);
  }

  const seen = new Set<string>();

  for (const [key, block] of Object.entries(remote)) {
    const canonical = canonicalKey(key);
    seen.add(canonical);

    if (deny.some((p) => matchesGlob(key, p) || matchesGlob(canonical, p))) {
      report.denied.push(key);
      continue;
    }
    if (!isPlainObject(block)) {
      report.skipped.push(key);
      continue;
    }
    if (!opts.allowSecretBlocks && hasEncryptedSecretRef(block)) {
      report.protectedSecretBlocks.push(key);
      continue;
    }

    // One existing file → write it in place (smallest diff, no rename churn).
    // Several → converge on the canonical single-encoded name and drop the
    // others: leaving a stale duplicate behind is not cosmetic, `pickWinner`
    // in generate-blocks prefers the *more*-encoded filename, so the stale one
    // would win the build.
    const existing = existingByKey.get(canonical) ?? [];
    const canonicalFile = `${encodeURIComponent(key)}.json`;
    const file = existing.length === 1 ? existing[0] : canonicalFile;
    const target = path.join(out, file);
    // encodeURIComponent cannot emit a separator, but assert the boundary
    // anyway: this writes to a git repo from a remote payload.
    if (path.dirname(path.resolve(target)) !== out) {
      throw new Error(`refusing to write block "${key}" outside ${out}`);
    }

    const secrets = findPlaintextSecrets(block);
    for (const at of secrets) report.plaintextSecrets.push(`${key}.${at}`);

    const duplicates = existing.filter((f) => f !== file);
    if (!opts.dryRun) {
      for (const dup of duplicates) fs.rmSync(path.join(out, dup));
    }

    const next = serialize(block);
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : null;
    let currentParsed: unknown;
    try {
      currentParsed = current === null ? undefined : JSON.parse(current);
    } catch {
      currentParsed = undefined; // unparseable local file — overwrite it
    }
    const sameContent =
      current !== null && stableStringify(currentParsed) === stableStringify(block);
    if (sameContent && duplicates.length === 0) {
      report.unchanged++;
      continue;
    }
    if (!opts.dryRun) fs.writeFileSync(target, next);
    (current === null ? report.added : report.updated).push(key);
  }

  if (opts.prune) {
    for (const [key, files] of existingByKey) {
      if (seen.has(key)) continue;
      if (deny.some((p) => matchesGlob(key, p))) {
        report.denied.push(key);
        continue;
      }
      // A local-only block holding credentials is site-owned (the migration put
      // them there); upstream never had it, so its absence must not delete it.
      if (!opts.allowSecretBlocks) {
        const local = files.map((f) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(out, f), "utf-8")) as unknown;
          } catch {
            return null;
          }
        });
        if (local.some(hasEncryptedSecretRef)) {
          report.protectedSecretBlocks.push(key);
          continue;
        }
      }
      if (!opts.dryRun) {
        for (const f of files) fs.rmSync(path.join(out, f));
      }
      report.removed.push(key);
    }
  }

  return report;
}

// -------------------------------------------------------------------- CLI

interface CliOptions extends PullOptions {
  url?: string;
  maxBytes: number;
  timeoutMs: number;
  failOnPlaintextSecret: boolean;
  json: boolean;
  github: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    out: ".deco/blocks",
    maxBytes: DEFAULT_MAX_BYTES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    failOnPlaintextSecret: false,
    json: false,
    github: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--url":
        opts.url = argv[++i];
        break;
      case "--origin": {
        const origin = (argv[++i] ?? "").replace(/\/+$/, "");
        opts.url = origin ? `${origin}/.decofile` : undefined;
        break;
      }
      case "--out":
        opts.out = argv[++i] ?? opts.out;
        break;
      case "--deny":
        opts.deny = (argv[++i] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--allow-secret-blocks":
        opts.allowSecretBlocks = true;
        break;
      case "--prune":
        opts.prune = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--fail-on-plaintext-secret":
        opts.failOnPlaintextSecret = true;
        break;
      case "--max-bytes":
        opts.maxBytes = Number(argv[++i]);
        break;
      case "--timeout-ms":
        opts.timeoutMs = Number(argv[++i]);
        break;
      case "--json":
        opts.json = true;
        break;
      case "--github":
        opts.github = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
    }
  }
  return opts;
}

function showHelp(): void {
  console.log(`
  @decocms/blocks-cli — pull the production decofile into .deco/blocks/

  Usage:
    tsx sync-blocks-bot.ts --origin https://www.minhaloja.com.br [options]

  Options:
    --origin <url>               Site origin; fetches <origin>/.decofile
    --url <url>                  Full decofile URL (alternative to --origin)
    --out <dir>                  Blocks directory (default: .deco/blocks)
    --deny <globs>               Comma-separated key globs never overwritten
                                 (default: ${DEFAULT_DENY.join(",")})
    --allow-secret-blocks        Also overwrite blocks holding encrypted secrets
    --prune                      Delete local blocks absent upstream
    --dry-run                    Report only, write nothing
    --fail-on-plaintext-secret   Exit 1 if a written block holds a raw credential
    --max-bytes <n>              Payload cap (default: ${DEFAULT_MAX_BYTES})
    --timeout-ms <n>             Fetch timeout (default: ${DEFAULT_TIMEOUT_MS})
    --json                       Emit the report as JSON
    --github                     Emit ::notice::/::error:: lines for Actions
    --help, -h                   This message

  Exit codes:
    0   done          1   plaintext secret gate          2   usage/network error
`);
}

function reportToText(report: PullReport): string {
  const lines = [
    `remote blocks: ${report.remoteBlocks}${report.bytes ? ` (${report.bytes} bytes)` : ""}${report.revision ? ` revision ${report.revision}` : ""}`,
    `added ${report.added.length}  updated ${report.updated.length}  unchanged ${report.unchanged}  removed ${report.removed.length}`,
    `denied ${report.denied.length}  secret-protected ${report.protectedSecretBlocks.length}  skipped ${report.skipped.length}`,
  ];
  for (const [label, keys] of [
    ["added", report.added],
    ["updated", report.updated],
    ["removed", report.removed],
  ] as const) {
    for (const key of keys.slice(0, 50)) lines.push(`  ${label}: ${key}`);
    if (keys.length > 50) lines.push(`  ${label}: … and ${keys.length - 50} more`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    showHelp();
    process.exit(0);
  }
  if (!opts.url) {
    console.error("sync-blocks-bot: --origin or --url is required (see --help)");
    process.exit(2);
  }

  let fetched: FetchResult;
  try {
    fetched = await fetchDecofile(opts.url, { maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs });
  } catch (e) {
    console.error(`sync-blocks-bot: ${(e as Error).message}`);
    process.exit(2);
  }

  let report: PullReport;
  try {
    report = writeDecofileToDir(fetched.blocks, opts);
  } catch (e) {
    console.error(`sync-blocks-bot: ${(e as Error).message}`);
    process.exit(2);
  }
  report.revision = fetched.revision;
  report.bytes = fetched.bytes;

  process.stdout.write(
    `${opts.json ? JSON.stringify({ url: opts.url, ...report }, null, 2) : reportToText(report)}\n`,
  );

  if (opts.github) {
    process.stdout.write(
      `::notice::decofile sync — +${report.added.length} ~${report.updated.length} -${report.removed.length} (${report.remoteBlocks} blocks upstream)\n`,
    );
    for (const at of report.plaintextSecrets) {
      process.stdout.write(
        `::error title=plaintext-secret::${at} looks like a credential in the clear\n`,
      );
    }
  }

  if (report.plaintextSecrets.length > 0 && opts.failOnPlaintextSecret) {
    console.error(
      `sync-blocks-bot: ${report.plaintextSecrets.length} plaintext credential(s) in the pulled content — refusing to commit it. Move them to encrypted secrets upstream, or deny the block with --deny.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

/**
 * Entry detection must resolve symlinks. Invoked through the package `bin`
 * (`npx --package=@decocms/blocks-cli deco-sync-blocks-bot`), `process.argv[1]`
 * is the `node_modules/.bin/...` symlink while `import.meta.url` is the real
 * file — a plain string compare fails, `main()` never runs, and the CLI exits 0
 * having printed nothing. Observed on a real CI run; the workflow's report
 * assertion is what surfaced it.
 */
function isMainModule(): boolean {
  if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
    return true;
  }
  try {
    const arg = process.argv?.[1];
    if (!arg) return false;
    return fs.realpathSync(arg) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
