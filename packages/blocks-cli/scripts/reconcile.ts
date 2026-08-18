#!/usr/bin/env tsx
/**
 * Snapshot reconcile — produces a per-file diff of everything that landed on the
 * Fresh/Deno SOURCE repo since the migration cut, plus the context an agent needs
 * to port each change into the already-migrated TanStack TARGET repo.
 *
 * Migrations take weeks. During that window the source team keeps shipping and
 * the migration team hand-fixes what the codemod got wrong. Reconciling is a
 * REBASE, not a re-migration: re-running `deco-migrate` over the tree overwrites
 * the hand-fixes. So this script makes NO judgement and writes NOTHING to the
 * target — it emits one patch per file and lets the agent (see the
 * `deco-reconcile-snapshot` skill) work them one at a time.
 *
 * Usage:
 *   npx -p @decocms/blocks-cli deco-reconcile \
 *     --source ../site-fresh --base <cut sha> \
 *     --target ../site-tanstack --target-base <migration commit sha>
 *
 * Options:
 *   --source <dir>       Fresh/Deno repo checkout (required)
 *   --base <sha>         Last reconciled source commit — the cut (required)
 *   --target <dir>       Migrated TanStack repo checkout (required)
 *   --target-base <sha>  The migration commit on the target (required)
 *   --out <dir>          Output dir (default: <target>/.reconcile/<sourceHead:7>)
 *   --verbose            Log every file
 *   --help, -h           Show this help
 *
 * Output: <out>/manifest.json (machine, also the resume state via `done`),
 *         <out>/INDEX.md (human), <out>/patches/NNN-<slug>.patch (one per file).
 *
 * Exit codes: 0 ok; 2 bad args / git failure.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Paths whose upstream changes never reconcile into the target. */
const SKIP = [
  /^\.deco\//, // CMS content — syncs through its own channel
  /^\.github\//, // target has its own scaffolded workflows
  /^_fresh\//,
  /(^|\/)(deno\.lock|package-lock\.json|bun\.lock|bun\.lockb|yarn\.lock)$/,
  /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|mp4|webm|pdf|zip)$/i,
];

export interface ReconcileFile {
  /** git --name-status letter: A/M/D/R… */
  status: string;
  sourcePath: string;
  /** Previous path, for renames only. */
  oldPath?: string;
  /** Patch file, relative to the output dir. */
  patch: string;
  /** Where this MIGHT live on the target. Candidates, not a verdict. */
  targetCandidates: string[];
  /** Target commits touching a candidate since the migration commit. */
  collision: string[];
  done: boolean;
}

export interface ReconcileManifest {
  source: string;
  target: string;
  base: string;
  /** Feed this back as --base on the next round. */
  sourceHead: string;
  targetBase: string;
  files: ReconcileFile[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function slug(p: string): string {
  return p.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

/** Parse `git diff --name-status -M` output. Renames carry two tab-separated paths. */
export function parseNameStatus(
  out: string,
): Array<{ status: string; path: string; oldPath?: string }> {
  return out.split("\n").filter(Boolean).map((line) => {
    const [status, a, b] = line.split("\t");
    return b ? { status, path: b, oldPath: a } : { status, path: a };
  });
}

export function isSkipped(relPath: string): boolean {
  return SKIP.some((re) => re.test(relPath));
}

/**
 * Guess where a source file lives on the target. The migration moved things
 * around (islands/→src/components/, static/→public/, sections stay under src/),
 * so this is basename matching plus the conventional `src/` prefix — deliberately
 * a shortlist for the agent to confirm against the target tree, not a mapping.
 */
export function targetCandidates(
  relPath: string,
  byBasename: Map<string, string[]>,
): string[] {
  const guesses = [
    `src/${relPath}`,
    `src/${relPath.replace(/^islands\//, "components/")}`,
    relPath.replace(/^static\//, "public/"),
  ];
  const found = byBasename.get(path.basename(relPath)) ?? [];
  // Only real target paths survive; the guesses just rank the likely one first.
  return [...new Set([...guesses.filter((g) => found.includes(g)), ...found])];
}

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: deco-reconcile --source <dir> --base <sha> --target <dir> --target-base <sha> [--out <dir>] [--verbose]",
  );
  process.exit(msg ? 2 : 0);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) usage();
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const verbose = argv.includes("--verbose");

  const source = flag("source");
  const base = flag("base");
  const target = flag("target");
  const targetBase = flag("target-base");
  if (!source || !base || !target || !targetBase) {
    usage("--source, --base, --target and --target-base are all required");
  }

  const sourceHead = git(source, ["rev-parse", "HEAD"]).trim();
  if (sourceHead === git(source, ["rev-parse", base]).trim()) {
    console.log("Nothing to reconcile — source HEAD is already the base.");
    return;
  }

  const outDir = flag("out") ??
    path.join(target, ".reconcile", sourceHead.slice(0, 7));
  fs.mkdirSync(path.join(outDir, "patches"), { recursive: true });

  const byBasename = new Map<string, string[]>();
  for (const p of git(target, ["ls-files"]).split("\n").filter(Boolean)) {
    const key = path.basename(p);
    byBasename.set(key, [...(byBasename.get(key) ?? []), p]);
  }

  const changes = parseNameStatus(
    git(source, ["diff", "--name-status", "-M", `${base}..${sourceHead}`]),
  );
  const files: ReconcileFile[] = [];

  for (const change of changes) {
    if (isSkipped(change.path)) {
      if (verbose) console.log(`  skip  ${change.path}`);
      continue;
    }
    const n = String(files.length + 1).padStart(3, "0");
    const patch = `patches/${n}-${slug(change.path)}.patch`;
    fs.writeFileSync(
      path.join(outDir, patch),
      git(source, [
        "diff",
        "-M",
        `${base}..${sourceHead}`,
        "--",
        ...(change.oldPath ? [change.oldPath, change.path] : [change.path]),
      ]),
    );

    const candidates = targetCandidates(change.path, byBasename);
    // A target file touched since the migration commit is a hand-fix. The agent
    // must reconcile hunk by hunk instead of applying the upstream change whole.
    const collision = candidates.flatMap((c) =>
      git(target, [
        "log",
        "--format=%h %s",
        `${targetBase}..HEAD`,
        "--",
        c,
      ]).split("\n").filter(Boolean).map((l) => `${c}: ${l}`)
    );

    files.push({
      status: change.status,
      sourcePath: change.path,
      oldPath: change.oldPath,
      patch,
      targetCandidates: candidates,
      collision,
      done: false,
    });
    if (verbose) {
      console.log(
        `  ${change.status.padEnd(4)} ${change.path} → ${
          candidates.join(", ") || "(no target match — new file?)"
        }${collision.length ? `  [COLLISION x${collision.length}]` : ""}`,
      );
    }
  }

  const manifest: ReconcileManifest = {
    source,
    target,
    base,
    sourceHead,
    targetBase,
    files,
  };
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  const collided = files.filter((f) => f.collision.length);
  fs.writeFileSync(
    path.join(outDir, "INDEX.md"),
    [
      `# Reconcile ${base.slice(0, 7)}..${sourceHead.slice(0, 7)}`,
      "",
      `SOURCE_HEAD \`${sourceHead}\` — feed this back as \`--base\` next round.`,
      "",
      `${files.length} files, ${collided.length} with collisions.`,
      "",
      "| # | status | source | target candidates | collision |",
      "|---|---|---|---|---|",
      ...files.map((f, i) =>
        `| ${i + 1} | ${f.status} | \`${f.sourcePath}\` | ${
          f.targetCandidates.map((c) => `\`${c}\``).join("<br>") || "—"
        } | ${f.collision.length || ""} |`
      ),
      "",
    ].join("\n"),
  );

  console.log(
    `${files.length} files (${collided.length} colliding) → ${outDir}\nSOURCE_HEAD ${sourceHead}`,
  );
}

if (process.argv[1] && /reconcile\.ts$/.test(process.argv[1])) main();
