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
 *     --source ../site-fresh --target ../site-tanstack --snapshot <cut sha>
 *
 * Options:
 *   --source <dir>           Fresh/Deno repo checkout (required)
 *   --target <dir>           Migrated TanStack repo checkout (required)
 *   --snapshot <sha>         Last reconciled source commit — the cut (required)
 *   --target-snapshot <sha>  The migration commit on the target. Defaults to the
 *                            commit that added MIGRATION_REPORT.md, else HEAD.
 *                            Everything after it counts as a hand-fix, so a wrong
 *                            value silently empties the collision list.
 *   --out <dir>              Output dir (default: <target>/.reconcile/<sourceHead:7>)
 *   --verbose                Log every file
 *   --help, -h               Show this help
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
  snapshot: string;
  /** Feed this back as --snapshot on the next round. */
  sourceHead: string;
  targetSnapshot: string;
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
    "usage: deco-reconcile --source <dir> --target <dir> --snapshot <sha> [--target-snapshot <sha>] [--out <dir>] [--verbose]",
  );
  process.exit(msg ? 2 : 0);
}

/**
 * The migration commit on the target — everything after it is a hand-fix.
 * `deco-migrate` leaves no provenance except MIGRATION_REPORT.md, so the commit
 * that added it is the marker. No marker: fall back to HEAD, which makes every
 * collision range empty — loudly, because a silent empty list reads as "nobody
 * touched anything" and that is exactly the wrong thing to believe.
 */
export function detectTargetSnapshot(log: string): string | undefined {
  return log.split("\n").filter(Boolean).pop();
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
  const target = flag("target");
  const snapshot = flag("snapshot");
  if (!source || !target || !snapshot) {
    usage("--source, --target and --snapshot are all required");
  }

  const targetSnapshot = flag("target-snapshot") ??
    detectTargetSnapshot(
      git(target, [
        "log",
        "--diff-filter=A",
        "--format=%H",
        "--",
        "MIGRATION_REPORT.md",
      ]),
    ) ?? git(target, ["rev-parse", "HEAD"]).trim();
  if (!flag("target-snapshot")) {
    console.log(
      `--target-snapshot not given, using ${targetSnapshot.slice(0, 7)} (${
        git(target, ["log", "-1", "--format=%s", targetSnapshot]).trim()
      })`,
    );
  }

  const sourceHead = git(source, ["rev-parse", "HEAD"]).trim();
  if (sourceHead === git(source, ["rev-parse", snapshot]).trim()) {
    console.log("Nothing to reconcile — source HEAD is already the snapshot.");
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
    git(source, ["diff", "--name-status", "-M", `${snapshot}..${sourceHead}`]),
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
        `${snapshot}..${sourceHead}`,
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
        `${targetSnapshot}..HEAD`,
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
    snapshot,
    sourceHead,
    targetSnapshot,
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
      `# Reconcile ${snapshot.slice(0, 7)}..${sourceHead.slice(0, 7)}`,
      "",
      `SOURCE_HEAD \`${sourceHead}\` — feed this back as \`--snapshot\` next round.`,
      "",
      `Target snapshot \`${targetSnapshot}\` — commits after it count as hand-fixes.`,
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
