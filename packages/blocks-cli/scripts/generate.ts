#!/usr/bin/env tsx
/**
 * Unified, incremental orchestrator for the blocks-cli generators.
 *
 * One command replaces the 4–6 hand-chained `tsx node_modules/@decocms/
 * blocks-cli/scripts/generate-*.ts` invocations every consumer site carries
 * in package.json, and skips generators whose inputs did not change since
 * the last successful run (the individual generators only do
 * write-if-changed on their OUTPUT — they still redo the full computation
 * every boot; this wrapper avoids invoking them at all).
 *
 * Usage (from site root):
 *   npx tsx node_modules/@decocms/blocks-cli/scripts/generate.ts [options]
 *
 * The individual generate-*.ts scripts remain available and unchanged —
 * use them directly for one-off runs or exotic flags (e.g. --out-file
 * overrides) that this orchestrator deliberately does not re-expose.
 *
 * ## Generators and flag mapping (single surface → per-script argv)
 *
 * | name     | script                      | forwarded flags                              |
 * |----------|-----------------------------|----------------------------------------------|
 * | blocks   | generate-blocks.ts          | --blocks-dir                                 |
 * | manifest | generate-blocks-manifest.ts | --blocks-dir                                 |
 * | sections | generate-sections.ts        | --sections-dir, --registry                   |
 * | loaders  | generate-loaders.ts         | --loaders-dir, --actions-dir, --exclude,     |
 * |          |                             | --prune-by-decofile                          |
 * | invoke   | generate-invoke.ts          | --apps-dir                                   |
 * | schema   | generate-schema.ts          | --sections-dir → --sections, --loaders-dir → |
 * |          |                             | --loaders, --site, --namespace, --platform,  |
 * |          |                             | --skip-apps                                  |
 *
 * Orchestrator-only flags: --only, --skip, --force, --dry-run, --no-registry.
 * Run with --help for the full reference.
 *
 * ## Which generators run by default (sensible per-artifact presence)
 *
 * - blocks:   `.deco/blocks/` exists AND (@decocms/nextjs is NOT installed
 *             OR `.deco/blocks.gen.json` already exists). Next.js sites use
 *             the static-import manifest instead of the JSON snapshot.
 * - manifest: `.deco/blocks/` exists AND (@decocms/nextjs IS installed OR
 *             `.deco/blocksManifest.gen.ts` already exists).
 * - sections: the sections dir exists. `--registry` defaults ON when
 *             @decocms/nextjs is installed or the existing sections.gen.ts
 *             already carries a `sectionImports` map (adopt-what's-there);
 *             override with --registry / --no-registry.
 * - loaders:  the loaders dir or the actions dir exists.
 * - invoke:   an apps invoke.ts is resolvable (--apps-dir or the installed
 *             @decocms/apps-vtex package) AND @tanstack/react-start is
 *             installed (the emitted file imports it — Next.js sites can't
 *             consume it).
 * - schema:   the sections dir exists AND tsconfig.json exists (the
 *             generator hard-requires both).
 *
 * `--dry-run` prints exactly this decision table for the current site,
 * including why each generator would run (fresh) or be skipped (cached).
 *
 * ## Two-stage DAG
 *
 * Stage 1 runs blocks, manifest, sections, loaders, invoke CONCURRENTLY.
 * Verified disjoint by reading each script (2026-07-10):
 *   - blocks    reads .deco/blocks/*.json            writes .deco/blocks.gen.{json,ts}
 *   - manifest  reads .deco/blocks (filenames)       writes .deco/blocksManifest.gen.ts
 *   - sections  reads src/sections/**                writes .deco/sections.gen.ts
 *   - loaders   reads src/loaders,src/actions (+ a   writes .deco/loaders.gen.ts
 *               read-only .deco/blocks scan under
 *               --prune-by-decofile — shared READS
 *               are safe)
 *   - invoke    reads node_modules/.../invoke.ts     writes src/server/invoke.gen.ts
 * No stage-1 generator writes another stage-1 generator's input.
 *
 * Stage 2 runs schema AFTER stage 1 settles. This is a real dependency, not
 * just log hygiene: generate-schema.ts never reads the stage-1 *artifacts*
 * directly (its directory walks exclude *.gen.* via codegenExclusions, and
 * it only walks src/sections, src/loaders, src/apps), BUT its ts-morph type
 * resolution follows imports from those files to ANY reachable module —
 * including src/server/invoke.gen.ts, which sections commonly import and
 * which stage 1's invoke generator REWRITES. Running schema concurrently
 * risks resolving types through a half-written file. It is also by far the
 * heavyweight (full type-check across src/), so sequencing it second keeps
 * the cheap artifacts landing fast and the log ordering deterministic.
 *
 * ## Incremental cache — two tiers, git-index style
 *
 * COMMITTED tier: `.deco/generate.digests.json` — commit it alongside the
 * generated artifacts it vouches for. One compact record per generator:
 *   - v:      CACHE_SCHEMA_VERSION (format changes self-bust),
 *   - args:   the exact argv forwarded to that generator,
 *   - cli:    blocks-cli's own package version,
 *   - deco:   the resolved versions of every @decocms/* package in the
 *             site's node_modules (a lockstep bump invalidates everything),
 *   - inputs: sha256 over the sorted (relPath, contentSha256) pairs of the
 *             generator's input set — CONTENT hashes, machine-independent.
 * Because the record is content-addressed, a FRESH CLONE with unchanged
 * inputs cache-hits every generator (schema's full ts-morph pass becomes a
 * content-hash sweep of src/**). Serialization is deterministic (sorted
 * generator keys, fixed field order, one record per line) so PR diffs stay
 * small; on a merge conflict, resolve either way and rerun `generate` — it
 * reconciles by regenerating whatever the chosen records don't vouch for.
 *
 * LOCAL tier: `.deco/.cache/stat-memo.json` (never committed — the
 * orchestrator writes a `.deco/.cache/.gitignore` containing `*`, since
 * sites commit `.deco/`). Maps (relPath, size, mtimeMs) → contentSha256 so
 * warm local runs skip rehashing unchanged files. It NEVER influences
 * correctness — it is purely a rehash-avoidance layer over the committed
 * tier (like git's index, it trusts size+mtimeMs; a content edit that
 * preserves both is not detected, same as git). Cached log lines gain a
 * `content-verified` marker when the hit required actual content hashing
 * (memo cold / stats moved) rather than pure memo lookups.
 *
 * Skip = the record matches AND every output file still exists (a deleted
 * artifact is a miss even on a clean record). A generator that runs
 * rewrites its record only AFTER success — a crashed run leaves no record,
 * so the next run retries. `--force` bypasses all checks.
 *
 * schema's input set is deliberately BROAD: all of src/**\/*.{ts,tsx} +
 * tsconfig.json + the installed @decocms/apps-* packages' src trees (when
 * not --skip-apps). Do not try to narrow it: any type reachable from a
 * section/loader Props type is an input to the emitted JSON Schema, and
 * import reachability across src/ is not knowable without doing the same
 * ts-morph work the generator itself does.
 */
import * as cp from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isExcludedCodegenFile } from "./lib/codegenExclusions";

// Bump when the digests file format or digest recipe changes — recorded in
// every digest record so old files self-bust instead of mis-validating.
export const CACHE_SCHEMA_VERSION = 2;

export const GENERATOR_NAMES = [
  "blocks",
  "manifest",
  "sections",
  "loaders",
  "invoke",
  "schema",
] as const;
export type GeneratorName = (typeof GENERATOR_NAMES)[number];

// Accepted aliases for --only/--skip (the script file is called
// generate-blocks-manifest.ts; some sites name the npm script after it).
const NAME_ALIASES: Record<string, GeneratorName> = {
  "blocks-manifest": "manifest",
  blocksmanifest: "manifest",
  meta: "schema",
};

const CACHE_DIR_REL = path.join(".deco", ".cache");
/** COMMITTED tier — content-hash digest records, one per generator. */
const DIGESTS_FILE_REL = path.join(".deco", "generate.digests.json");
/** LOCAL tier — (size, mtimeMs) → contentSha256 memo, never committed. */
const STAT_MEMO_FILE_REL = path.join(CACHE_DIR_REL, "stat-memo.json");
/** Pre-v2 machine-local cache — superseded, deleted on sight. */
const LEGACY_CACHE_FILE_REL = path.join(CACHE_DIR_REL, "generate.json");

const USAGE = `\
Usage: tsx node_modules/@decocms/blocks-cli/scripts/generate.ts [options]

Runs the blocks-cli generators (blocks, manifest, sections, loaders, invoke,
schema) as one incremental command. Generators whose inputs are unchanged
since the last successful run are skipped entirely. Stage 1 (blocks,
manifest, sections, loaders, invoke) runs concurrently; schema runs after.

Selection:
  --only <names>      Comma-separated subset to consider (${GENERATOR_NAMES.join(",")})
  --skip <names>      Comma-separated generators to exclude
  --force             Ignore the cache; run everything selected
  --dry-run           Print what would run / skip / stay disabled, then exit

Forwarded to the individual generators:
  --blocks-dir <dir>       blocks + manifest input        (default .deco/blocks)
  --sections-dir <dir>     sections input + schema --sections (default src/sections)
  --loaders-dir <dir>      loaders input + schema --loaders   (default src/loaders)
  --actions-dir <dir>      loaders actions input          (default src/actions)
  --apps-dir <dir>         invoke's apps package location (default: auto-resolve
                           node_modules/@decocms/apps-vtex)
  --registry               sections: emit the lazy sectionImports registry
  --no-registry            sections: force the registry OFF (overrides the
                           Next.js-detected default)
  --exclude <keys>         loaders: comma-separated loader keys to skip
  --prune-by-decofile <d>  loaders: only emit CMS-referenced entries
  --site <name>            schema: site name              (default storefront)
  --namespace <ns>         schema: section namespace      (default site)
  --platform <name>        schema: platform               (default cloudflare)
  --skip-apps              schema: skip app schema generation

Not re-exposed here (use the individual scripts): --out-file/--out overrides,
schema's --version/--apps, invoke's --out-file. Defaults match the scripts.

Cache: .deco/generate.digests.json holds committed, machine-independent
content-hash records — commit it with the generated artifacts so fresh
clones cache-hit. .deco/.cache/stat-memo.json (auto-gitignored) only speeds
up local rehashing. Pass --force (or delete the digests file) to rebuild.
`;

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export interface CliOptions {
  only: GeneratorName[] | null;
  skip: GeneratorName[];
  force: boolean;
  dryRun: boolean;
  help: boolean;
  blocksDir: string;
  sectionsDir: string;
  loadersDir: string;
  actionsDir: string;
  appsDir: string | null;
  registry: boolean | null; // null = auto-detect
  exclude: string | null;
  pruneByDecofile: string | null;
  site: string | null;
  namespace: string | null;
  platform: string | null;
  skipApps: boolean;
}

function parseNames(raw: string, flag: string): GeneratorName[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => {
      const name = (NAME_ALIASES[s] ?? s) as GeneratorName;
      if (!GENERATOR_NAMES.includes(name)) {
        throw new Error(
          `Unknown generator "${s}" in ${flag}. Valid: ${GENERATOR_NAMES.join(", ")}`,
        );
      }
      return name;
    });
}

export function parseCliOptions(argv: string[]): CliOptions {
  const opts: CliOptions = {
    only: null,
    skip: [],
    force: false,
    dryRun: false,
    help: false,
    blocksDir: path.join(".deco", "blocks"),
    sectionsDir: path.join("src", "sections"),
    loadersDir: path.join("src", "loaders"),
    actionsDir: path.join("src", "actions"),
    appsDir: null,
    registry: null,
    exclude: null,
    pruneByDecofile: null,
    site: null,
    namespace: null,
    platform: null,
    skipApps: false,
  };

  const valueOf = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--only":
        opts.only = parseNames(valueOf(i, a), a);
        i++;
        break;
      case "--skip":
        opts.skip = parseNames(valueOf(i, a), a);
        i++;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--blocks-dir":
        opts.blocksDir = valueOf(i, a);
        i++;
        break;
      case "--sections-dir":
        opts.sectionsDir = valueOf(i, a);
        i++;
        break;
      case "--loaders-dir":
        opts.loadersDir = valueOf(i, a);
        i++;
        break;
      case "--actions-dir":
        opts.actionsDir = valueOf(i, a);
        i++;
        break;
      case "--apps-dir":
        opts.appsDir = valueOf(i, a);
        i++;
        break;
      case "--registry":
        opts.registry = true;
        break;
      case "--no-registry":
        opts.registry = false;
        break;
      case "--exclude":
        opts.exclude = valueOf(i, a);
        i++;
        break;
      case "--prune-by-decofile":
        opts.pruneByDecofile = valueOf(i, a);
        i++;
        break;
      case "--site":
        opts.site = valueOf(i, a);
        i++;
        break;
      case "--namespace":
        opts.namespace = valueOf(i, a);
        i++;
        break;
      case "--platform":
        opts.platform = valueOf(i, a);
        i++;
        break;
      case "--skip-apps":
        opts.skipApps = true;
        break;
      default:
        throw new Error(`Unknown option "${a}". Run with --help for usage.`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Filesystem helpers (stat-only — content hashing happens in the hasher,
// where the stat memo can skip it)
// ---------------------------------------------------------------------------

/** [relative path, size, mtimeMs] — the unit of input enumeration. */
type InputEntry = [string, number, number];

function statEntry(cwd: string, absPath: string): InputEntry | null {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return null;
    return [path.relative(cwd, absPath).replaceAll("\\", "/"), st.size, st.mtimeMs];
  } catch {
    return null;
  }
}

/** Top-level *.json files of a directory (the blocks-dir contract). */
function listTopLevelJson(cwd: string, dir: string): InputEntry[] {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: InputEntry[] = [];
  for (const e of names) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const entry = statEntry(cwd, path.join(dir, e.name));
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Recursive walk collecting files with the given extensions. */
function walkTree(
  cwd: string,
  dir: string,
  exts: string[],
  excludeFile?: (name: string) => boolean,
): InputEntry[] {
  const entries: InputEntry[] = [];
  const visit = (d: string) => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of dirents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        visit(full);
      } else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) {
        if (excludeFile?.(e.name)) continue;
        const entry = statEntry(cwd, full);
        if (entry) entries.push(entry);
      }
    }
  };
  visit(dir);
  return entries;
}

function sortEntries(entries: InputEntry[]): InputEntry[] {
  return entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Version fingerprinting — a lockstep @decocms/* bump must invalidate all
// caches even when no site file changed (generator behavior lives in the
// packages, and generate-invoke/schema read node_modules sources directly).
// ---------------------------------------------------------------------------

function readPkgVersion(pkgDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8");
    const version = (JSON.parse(raw) as { version?: string }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function decoPackageVersions(cwd: string): Record<string, string> {
  const versions: Record<string, string> = {};
  const scopeDir = path.join(cwd, "node_modules", "@decocms");
  let names: string[];
  try {
    names = fs.readdirSync(scopeDir);
  } catch {
    return versions;
  }
  for (const name of names.sort()) {
    const v = readPkgVersion(path.join(scopeDir, name));
    if (v) versions[`@decocms/${name}`] = v;
  }
  return versions;
}

/** blocks-cli's own version — resolved relative to THIS script, so it works
 * both in the monorepo (0.0.0) and installed under a site's node_modules. */
function ownVersion(): string {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  return readPkgVersion(path.resolve(selfDir, "..")) ?? "unknown";
}

function hasPackage(cwd: string, name: string): boolean {
  return fs.existsSync(path.join(cwd, "node_modules", ...name.split("/"), "package.json"));
}

// ---------------------------------------------------------------------------
// Plan — which generators exist, their argv, inputs, outputs, enablement
// ---------------------------------------------------------------------------

export interface GeneratorPlan {
  name: GeneratorName;
  /** Absolute path of the sibling generate-*.ts script. */
  script: string;
  /** Exact argv forwarded to the script (also part of the digest). */
  args: string[];
  /** 1 = concurrent batch, 2 = after stage 1. */
  stage: 1 | 2;
  enabled: boolean;
  disabledReason?: string;
  /** Lazily computed sorted input fingerprint. */
  inputs: () => InputEntry[];
  /** Output artifacts (relative to cwd) — all must exist for a cache hit. */
  outputs: string[];
}

/** Resolve generate-invoke's apps dir exactly like the generator does
 * (minus the legacy ../apps-start/vtex fallback, which is dev-checkout-only). */
function resolveInvokeSource(cwd: string, appsDir: string | null): string | null {
  const roots = appsDir
    ? [path.resolve(cwd, appsDir)]
    : [path.resolve(cwd, "node_modules/@decocms/apps-vtex")];
  for (const root of roots) {
    for (const c of [root, path.join(root, "src")]) {
      if (fs.existsSync(path.join(c, "invoke.ts"))) return path.join(c, "invoke.ts");
    }
  }
  return null;
}

export function buildPlan(cwd: string, opts: CliOptions): GeneratorPlan[] {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const blocksDirAbs = path.resolve(cwd, opts.blocksDir);
  const sectionsDirAbs = path.resolve(cwd, opts.sectionsDir);
  const loadersDirAbs = path.resolve(cwd, opts.loadersDir);
  const actionsDirAbs = path.resolve(cwd, opts.actionsDir);

  const blocksDirExists = fs.existsSync(blocksDirAbs);
  const sectionsDirExists = fs.existsSync(sectionsDirAbs);
  const isNext = hasPackage(cwd, "@decocms/nextjs");
  const hasTanstackStart = hasPackage(cwd, "@tanstack/react-start");

  const blocksGenJson = path.join(".deco", "blocks.gen.json");
  const manifestGen = path.join(".deco", "blocksManifest.gen.ts");
  const sectionsGen = path.join(".deco", "sections.gen.ts");

  // --registry default: Next.js sites need the lazy sectionImports map
  // (webpack has no import.meta.glob); also adopt an existing registry so
  // regenerating never silently drops it. Explicit --registry/--no-registry wins.
  let registry = opts.registry;
  if (registry === null) {
    let existingHasRegistry = false;
    try {
      existingHasRegistry = fs
        .readFileSync(path.resolve(cwd, sectionsGen), "utf-8")
        .includes("export const sectionImports");
    } catch {}
    registry = isNext || existingHasRegistry;
  }

  const invokeSource = resolveInvokeSource(cwd, opts.appsDir);

  const disabled = (reason: string) => ({ enabled: false, disabledReason: reason });
  const enabledIf = (cond: boolean, reason: string) =>
    cond ? { enabled: true } : disabled(reason);

  const plans: GeneratorPlan[] = [
    {
      name: "blocks",
      script: path.join(scriptsDir, "generate-blocks.ts"),
      args: ["--blocks-dir", opts.blocksDir],
      stage: 1,
      ...enabledIf(
        blocksDirExists && (!isNext || fs.existsSync(path.resolve(cwd, blocksGenJson))),
        !blocksDirExists
          ? `${opts.blocksDir} does not exist`
          : `@decocms/nextjs site without an existing ${blocksGenJson} (Next.js uses the manifest)`,
      ),
      inputs: () => sortEntries(listTopLevelJson(cwd, blocksDirAbs)),
      outputs: [blocksGenJson, path.join(".deco", "blocks.gen.ts")],
    },
    {
      name: "manifest",
      script: path.join(scriptsDir, "generate-blocks-manifest.ts"),
      args: ["--blocks-dir", opts.blocksDir],
      stage: 1,
      ...enabledIf(
        blocksDirExists && (isNext || fs.existsSync(path.resolve(cwd, manifestGen))),
        !blocksDirExists
          ? `${opts.blocksDir} does not exist`
          : `not a @decocms/nextjs site and no existing ${manifestGen}`,
      ),
      // The manifest only depends on the FILENAME set, but fingerprinting
      // (path, size, mtime) is a cheap superset — a content-only edit
      // re-runs a generator whose write-if-changed makes that a no-op.
      inputs: () => sortEntries(listTopLevelJson(cwd, blocksDirAbs)),
      outputs: [manifestGen],
    },
    {
      name: "sections",
      script: path.join(scriptsDir, "generate-sections.ts"),
      args: ["--sections-dir", opts.sectionsDir, ...(registry ? ["--registry"] : [])],
      stage: 1,
      ...enabledIf(sectionsDirExists, `${opts.sectionsDir} does not exist`),
      inputs: () =>
        sortEntries(walkTree(cwd, sectionsDirAbs, [".ts", ".tsx"], isExcludedCodegenFile)),
      outputs: [sectionsGen],
    },
    {
      name: "loaders",
      script: path.join(scriptsDir, "generate-loaders.ts"),
      args: [
        "--loaders-dir",
        opts.loadersDir,
        "--actions-dir",
        opts.actionsDir,
        ...(opts.exclude ? ["--exclude", opts.exclude] : []),
        ...(opts.pruneByDecofile ? ["--prune-by-decofile", opts.pruneByDecofile] : []),
      ],
      stage: 1,
      // Always run even when src/loaders and src/actions don't exist yet —
      // generate-loaders.ts handles missing dirs gracefully (emits an empty
      // siteLoaders map). This ensures .deco/loaders.gen.ts is always present
      // so scaffolded commerce-loaders.ts imports resolve on first boot.
      enabled: true,
      inputs: () =>
        sortEntries([
          ...walkTree(cwd, loadersDirAbs, [".ts", ".tsx"]),
          ...walkTree(cwd, actionsDirAbs, [".ts", ".tsx"]),
          // Under --prune-by-decofile the CMS JSONs decide which entries are
          // emitted, so they become inputs too.
          ...(opts.pruneByDecofile
            ? walkTree(cwd, path.resolve(cwd, opts.pruneByDecofile), [".json"])
            : []),
        ]),
      outputs: [path.join(".deco", "loaders.gen.ts")],
    },
    {
      name: "invoke",
      script: path.join(scriptsDir, "generate-invoke.ts"),
      args: opts.appsDir ? ["--apps-dir", opts.appsDir] : [],
      stage: 1,
      ...enabledIf(
        invokeSource !== null && hasTanstackStart,
        invokeSource === null
          ? "no apps invoke.ts found (@decocms/apps-vtex not installed and no --apps-dir)"
          : "@tanstack/react-start not installed (invoke.gen.ts targets TanStack Start)",
      ),
      // invoke.ts is the file the generator parses; the surrounding package's
      // action/type sources are fingerprinted via the @decocms/* version set
      // (node_modules content only changes with a version change in practice).
      inputs: () => sortEntries(invokeSource ? [statEntry(cwd, invokeSource)!].filter(Boolean) : []),
      outputs: [path.join("src", "server", "invoke.gen.ts")],
    },
    {
      name: "schema",
      script: path.join(scriptsDir, "generate-schema.ts"),
      args: [
        "--sections",
        opts.sectionsDir,
        "--loaders",
        opts.loadersDir,
        ...(opts.site ? ["--site", opts.site] : []),
        ...(opts.namespace ? ["--namespace", opts.namespace] : []),
        ...(opts.platform ? ["--platform", opts.platform] : []),
        ...(opts.skipApps ? ["--skip-apps"] : []),
      ],
      stage: 2,
      ...enabledIf(
        sectionsDirExists && fs.existsSync(path.join(cwd, "tsconfig.json")),
        !sectionsDirExists
          ? `${opts.sectionsDir} does not exist`
          : "tsconfig.json not found (generate-schema requires it)",
      ),
      // BROAD BY DESIGN — see the header comment. Any type reachable from a
      // section/loader Props type feeds the emitted schema, so the whole
      // src/ tree + tsconfig + the installed @decocms/apps-* sources (their
      // loaders are scanned when not --skip-apps) are inputs. Narrowing this
      // would require the same import-graph resolution the generator does.
      inputs: () => {
        const entries = [
          ...walkTree(cwd, path.join(cwd, "src"), [".ts", ".tsx"]),
          ...[statEntry(cwd, path.join(cwd, "tsconfig.json"))].filter(
            (e): e is InputEntry => e !== null,
          ),
        ];
        if (!opts.skipApps) {
          const scopeDir = path.join(cwd, "node_modules", "@decocms");
          let names: string[] = [];
          try {
            names = fs.readdirSync(scopeDir).filter((n) => n.startsWith("apps-"));
          } catch {}
          for (const name of names.sort()) {
            entries.push(...walkTree(cwd, path.join(scopeDir, name, "src"), [".ts", ".tsx"]));
          }
        }
        return sortEntries(entries);
      },
      outputs: [path.join(".deco", "meta.gen.json")],
    },
  ];

  // Apply --only / --skip on top of auto-enablement. --only also FORCES a
  // generator on (explicit intent beats detection) unless its hard inputs
  // are missing in a way that would just crash the child.
  for (const plan of plans) {
    if (opts.only && !opts.only.includes(plan.name)) {
      plan.enabled = false;
      plan.disabledReason = "not in --only";
    } else if (opts.only?.includes(plan.name) && !plan.enabled) {
      // Explicitly requested: run it and let the generator report its own
      // error if inputs are truly missing — that is what the user asked for.
      plan.enabled = true;
      plan.disabledReason = undefined;
    }
    if (opts.skip.includes(plan.name)) {
      plan.enabled = false;
      plan.disabledReason = "listed in --skip";
    }
  }

  return plans;
}

// ---------------------------------------------------------------------------
// Committed tier — .deco/generate.digests.json
// ---------------------------------------------------------------------------

/** One committed record per generator. Every field is machine-independent
 * (content hashes, versions, argv) — never stat data. */
interface DigestRecord {
  v: number;
  args: string[];
  cli: string;
  /** Sorted `name@version` pairs of the installed @decocms/* packages. */
  deco: string;
  /** sha256 over the sorted [relPath, contentSha256] pairs of the inputs. */
  inputs: string;
}

type DigestMap = Partial<Record<GeneratorName, DigestRecord>>;

const DIGESTS_NOTE =
  "Generated by @decocms/blocks-cli's generate command - COMMIT this file. " +
  "It records content hashes of each generator's inputs so a fresh clone " +
  "with unchanged inputs skips every generator. On merge conflict, resolve " +
  "either way and rerun generate: it regenerates whatever the kept records " +
  "do not vouch for and rewrites this file.";

function loadDigests(cwd: string): DigestMap {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, DIGESTS_FILE_REL), "utf-8")) as {
      version?: number;
      generators?: DigestMap;
    };
    if (parsed?.version !== CACHE_SCHEMA_VERSION || typeof parsed.generators !== "object") {
      return {};
    }
    return parsed.generators ?? {};
  } catch {
    // Missing file, or unparseable (e.g. a merge conflict left <<<<<<<
    // markers) — treat as empty; regeneration reconciles and rewrites it.
    return {};
  }
}

/** Deterministic, diff-friendly serialization: sorted generator keys, fixed
 * field order, ONE compact record per line. Two runs over identical state
 * produce byte-identical files, so conflicts only appear on real drift. */
function serializeDigests(generators: DigestMap): string {
  const names = (Object.keys(generators) as GeneratorName[]).sort();
  const lines = names.map((name) => {
    const r = generators[name] as DigestRecord;
    const record = JSON.stringify({
      v: r.v,
      args: r.args,
      cli: r.cli,
      deco: r.deco,
      inputs: r.inputs,
    });
    return `    ${JSON.stringify(name)}: ${record}`;
  });
  return [
    "{",
    `  "//": ${JSON.stringify(DIGESTS_NOTE)},`,
    `  "version": ${CACHE_SCHEMA_VERSION},`,
    "  \"generators\": {",
    lines.join(",\n"),
    "  }",
    "}",
    "",
  ].join("\n");
}

function saveDigests(cwd: string, generators: DigestMap): void {
  fs.mkdirSync(path.join(cwd, ".deco"), { recursive: true });
  fs.writeFileSync(path.join(cwd, DIGESTS_FILE_REL), serializeDigests(generators));
}

// ---------------------------------------------------------------------------
// Local tier — .deco/.cache/stat-memo.json (rehash avoidance ONLY)
// ---------------------------------------------------------------------------

/** mkdir .deco/.cache and drop a `.gitignore` containing `*` — sites commit
 * `.deco/`, and the memo (machine-local mtimes) must never land in git. */
function ensureCacheDir(cwd: string): void {
  const dir = path.join(cwd, CACHE_DIR_REL);
  fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, "*\n");
}

interface ContentHasher {
  /** contentSha256 of an enumerated input, via the memo when stats match. */
  hashEntry(entry: InputEntry): string;
  /** Whether THIS RUN had to read the file's bytes (memo cold / stats moved).
   * Sticky for the whole run, so every generator sharing that input reports
   * `content-verified`, not just whichever one hashed it first. */
  wasRehashed(relPath: string): boolean;
  /** Persist the memo (skipped when nothing was rehashed). */
  save(): void;
}

/** The stat memo trusts (size, mtimeMs) exactly like git's index trusts its
 * stat cache: a content edit that preserves BOTH size and mtimeMs is not
 * detected. That is the same trade git makes, and touching the file (or
 * deleting .deco/.cache) recovers. Correctness never depends on the memo —
 * it only decides whether we re-read bytes to compute the same sha256. */
function createContentHasher(cwd: string): ContentHasher {
  let files: Record<string, [size: number, mtimeMs: number, sha256: string]> = {};
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(cwd, STAT_MEMO_FILE_REL), "utf-8"),
    ) as { version?: number; files?: typeof files };
    if (parsed?.version === CACHE_SCHEMA_VERSION && typeof parsed.files === "object") {
      files = parsed.files ?? {};
    }
  } catch {}
  let dirty = false;
  const rehashedPaths = new Set<string>();
  return {
    hashEntry([rel, size, mtimeMs]: InputEntry): string {
      const memo = files[rel];
      if (memo && memo[0] === size && memo[1] === mtimeMs) return memo[2];
      let sha: string;
      try {
        sha = createHash("sha256").update(fs.readFileSync(path.join(cwd, rel))).digest("hex");
      } catch {
        // Vanished between stat and read — a sentinel that can never equal a
        // recorded sha256 forces a re-run without poisoning the memo.
        return `unreadable:${rel}`;
      }
      files[rel] = [size, mtimeMs, sha];
      dirty = true;
      rehashedPaths.add(rel);
      return sha;
    },
    wasRehashed(relPath: string): boolean {
      return rehashedPaths.has(relPath);
    },
    save() {
      if (!dirty) return;
      ensureCacheDir(cwd);
      fs.writeFileSync(
        path.join(cwd, STAT_MEMO_FILE_REL),
        `${JSON.stringify({ version: CACHE_SCHEMA_VERSION, files })}\n`,
      );
    },
  };
}

function computeDigestRecord(
  plan: Pick<GeneratorPlan, "name" | "args" | "inputs">,
  versions: Record<string, string>,
  cliVersion: string,
  hasher: ContentHasher,
): DigestRecord {
  const pairs = plan.inputs().map((e) => [e[0], hasher.hashEntry(e)]);
  return {
    v: CACHE_SCHEMA_VERSION,
    args: plan.args,
    cli: cliVersion,
    deco: Object.entries(versions)
      .map(([name, version]) => `${name}@${version}`)
      .join(" "),
    inputs: createHash("sha256").update(JSON.stringify(pairs)).digest("hex"),
  };
}

/** First differing field, most-global first — the log's re-run reason. */
function recordMismatch(prev: DigestRecord | undefined, next: DigestRecord): string | null {
  if (!prev) return "no committed digest";
  if (prev.v !== next.v) return "digest schema changed";
  if (prev.cli !== next.cli) return "blocks-cli version changed";
  if (prev.deco !== next.deco) return "@decocms versions changed";
  if (JSON.stringify(prev.args) !== JSON.stringify(next.args)) return "flags changed";
  if (prev.inputs !== next.inputs) return "inputs changed";
  return null;
}

// ---------------------------------------------------------------------------
// Child process execution
// ---------------------------------------------------------------------------

// The generators are argv-driven scripts (sections/loaders/invoke run at
// module top-level), so each runs as its own child process via the tsx CLI
// that ships as a blocks-cli dependency. This also gives stage 1 real
// multi-core parallelism and makes "skip" literally "never invoked".
function resolveTsxCli(): string {
  return createRequire(import.meta.url).resolve("tsx/cli");
}

interface RunResult {
  name: GeneratorName;
  code: number;
  ms: number;
  stdout: string;
  stderr: string;
}

function runGeneratorProcess(plan: GeneratorPlan, cwd: string): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [resolveTsxCli(), plan.script, ...plan.args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      resolve({
        name: plan.name,
        code: 1,
        ms: Date.now() - started,
        stdout,
        stderr: `${stderr}\n${err.message}`,
      });
    });
    child.on("close", (code) => {
      resolve({ name: plan.name, code: code ?? 1, ms: Date.now() - started, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

type Decision =
  | { kind: "disabled"; reason: string }
  | { kind: "cached"; ms: number; verified: boolean }
  | { kind: "run"; reason: string; record: DigestRecord };

function decide(
  plan: GeneratorPlan,
  digests: DigestMap,
  cwd: string,
  force: boolean,
  versions: Record<string, string>,
  cliVersion: string,
  hasher: ContentHasher,
): Decision {
  if (!plan.enabled) return { kind: "disabled", reason: plan.disabledReason ?? "disabled" };
  const started = Date.now();
  const record = computeDigestRecord(plan, versions, cliVersion, hasher);
  // Was any of THIS generator's inputs validated by reading bytes this run
  // (memo cold / stats moved) rather than pure stat-memo lookups? Sticky per
  // run — shared inputs mark every generator that fingerprints them. Only
  // affects the log marker.
  const verified = plan.inputs().some(([rel]) => hasher.wasRehashed(rel));
  if (force) return { kind: "run", reason: "--force", record };
  const mismatch = recordMismatch(digests[plan.name], record);
  if (mismatch) return { kind: "run", reason: mismatch, record };
  const missing = plan.outputs.find((o) => !fs.existsSync(path.resolve(cwd, o)));
  if (missing) return { kind: "run", reason: `output missing (${missing})`, record };
  return { kind: "cached", ms: Date.now() - started, verified };
}

function indent(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return "";
  return `${trimmed
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n")}\n`;
}

export async function runGenerate(argv: string[], cwd = process.cwd()): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseCliOptions(argv);
  } catch (e) {
    console.error(`[generate] ${(e as Error).message}`);
    return 1;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const totalStarted = Date.now();
  const plans = buildPlan(cwd, opts);
  const versions = decoPackageVersions(cwd);
  const cliVersion = ownVersion();
  const digests = loadDigests(cwd);
  const hasher = createContentHasher(cwd);

  if (opts.dryRun) {
    console.log("[generate] dry run — nothing will be written");
    for (const plan of plans) {
      // NOTE: stage-2 predictions here are made against the CURRENT tree; a
      // real run computes stage-2 digests only after stage 1 lands (see
      // runStage), because stage-1 outputs like src/server/invoke.gen.ts are
      // part of schema's src/** input set.
      const d = decide(plan, digests, cwd, opts.force, versions, cliVersion, hasher);
      if (d.kind === "disabled") {
        console.log(`[generate] ${plan.name}: skip — ${d.reason}`);
      } else if (d.kind === "cached") {
        console.log(`[generate] ${plan.name}: skip — cached`);
      } else {
        console.log(
          `[generate] ${plan.name}: would run (${d.reason}) — ${path.basename(plan.script)} ${plan.args.join(" ")}`,
        );
      }
    }
    // Dry run writes NOTHING — not even the stat memo it warmed in memory.
    return 0;
  }

  let fresh = 0;
  let cached = 0;
  let failed = 0;
  let digestsDirty = false;

  const finish = (plan: GeneratorPlan, record: DigestRecord, result: RunResult): void => {
    if (result.stdout.trim()) process.stdout.write(indent(result.stdout));
    if (result.stderr.trim()) process.stderr.write(indent(result.stderr));
    if (result.code === 0) {
      // Rewrite the record only AFTER success — a crashed run must leave no
      // record so the next run retries instead of trusting a poisoned cache.
      digests[plan.name] = record;
      digestsDirty = true;
      fresh++;
      console.log(`[generate] ${plan.name} ${result.ms}ms (fresh)`);
    } else {
      if (digests[plan.name]) {
        delete digests[plan.name];
        digestsDirty = true;
      }
      failed++;
      console.error(`[generate] ${plan.name} ${result.ms}ms FAILED (exit ${result.code})`);
    }
  };

  // Decisions are made per stage, at stage start: stage-1 generators WRITE
  // files that sit inside stage-2 input sets (invoke emits
  // src/server/invoke.gen.ts, which schema fingerprints as part of src/**).
  // Digesting everything upfront would store a pre-stage-1 record for schema
  // and guarantee a spurious "inputs changed" re-run on the next boot.
  const runStage = async (stage: 1 | 2): Promise<void> => {
    const runnable: Array<{ plan: GeneratorPlan; record: DigestRecord }> = [];
    for (const plan of plans) {
      if (plan.stage !== stage) continue;
      const d = decide(plan, digests, cwd, opts.force, versions, cliVersion, hasher);
      if (d.kind === "disabled") {
        console.log(`[generate] ${plan.name} skipped (${d.reason})`);
      } else if (d.kind === "cached") {
        cached++;
        // content-verified = this hit re-read at least one file's bytes
        // (fresh clone / touched mtimes) instead of pure stat-memo lookups.
        console.log(
          `[generate] ${plan.name} ${d.ms}ms (cached${d.verified ? ", content-verified" : ""})`,
        );
      } else {
        runnable.push({ plan, record: d.record });
      }
    }
    // Stage-1 generators have disjoint inputs/outputs (verified — see the
    // header comment), so they run concurrently.
    const results = await Promise.all(
      runnable.map(async ({ plan, record }) => ({
        plan,
        record,
        result: await runGeneratorProcess(plan, cwd),
      })),
    );
    for (const { plan, record, result } of results) finish(plan, record, result);
  };

  await runStage(1);
  if (failed > 0) {
    // schema reads types through files stage 1 just (re)wrote; don't build a
    // schema on top of a broken generation pass.
    for (const plan of plans) {
      if (plan.stage === 2 && plan.enabled) {
        console.error(`[generate] ${plan.name} skipped (stage 1 failed)`);
      }
    }
  } else {
    await runStage(2);
  }

  try {
    if (digestsDirty) saveDigests(cwd, digests);
    hasher.save();
    // The pre-v2 machine-local cache file is superseded; drop it quietly.
    fs.rmSync(path.join(cwd, LEGACY_CACHE_FILE_REL), { force: true });
  } catch (e) {
    console.warn(`[generate] could not write cache: ${(e as Error).message}`);
  }

  const totalMs = Date.now() - totalStarted;
  console.log(
    `[generate] total ${totalMs}ms (${fresh} fresh, ${cached} cached${failed ? `, ${failed} FAILED` : ""})`,
  );
  return failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CLI shim — realpath comparison, same pattern as generate-schema.ts (works
// through tsx / pnpm / macOS tmp symlinks).
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryPath = fs.realpathSync(path.resolve(entry));
    const selfPath = fs.realpathSync(fileURLToPath(import.meta.url));
    return entryPath === selfPath;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runGenerate(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
