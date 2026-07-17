#!/usr/bin/env tsx
/**
 * @decocms/blocks-cli — loader/action bundle-leak rollout
 *
 * Updates one or more already-in-prod TanStack Start sites so site
 * loaders/actions (and any credential hardcoded in them) stop being emitted
 * into the public client bundle.
 *
 * The actual fix ships in the framework: `@decocms/tanstack`'s vite plugin
 * stubs `.deco/loaders.gen.ts` on the client, so once a site is on a fixed
 * version its NEXT build is safe — no site source change is required. This
 * script therefore just:
 *
 *   1. bumps every `@decocms/*` dependency to the fixed version,
 *   2. installs (updates the lockfile),
 *   3. audits the site source for credentials hardcoded in actions/loaders
 *      (these must be ROTATED by hand — a leaked secret stays compromised even
 *      after it stops shipping), and
 *   4. optionally rebuilds and greps the client output for a known leaked
 *      value to confirm it's gone.
 *
 * It never deploys. After a green run, redeploy with your normal pipeline
 * (e.g. `wrangler deploy`).
 *
 * Usage:
 *   tsx upgrade-loader-leak-fix.ts [siteDir...] [options]
 *   tsx upgrade-loader-leak-fix.ts ./site-a ./site-b --version 7.21.0
 *   tsx upgrade-loader-leak-fix.ts . --dry-run
 *   tsx upgrade-loader-leak-fix.ts . --build --verify-secret "$LEAKED_TOKEN"
 *
 * Options:
 *   --version <v>       Target @decocms/* version (e.g. 7.21.0). Default: resolve
 *                       the latest published @decocms/tanstack via `npm view`.
 *   --exact            Pin exact ("7.21.0") instead of caret ("^7.21.0").
 *   --pm <bun|npm|pnpm> Package manager. Default: detect from lockfile.
 *   --no-install       Don't run install after bumping package.json.
 *   --build            Run the site's build script after install.
 *   --verify-secret <s> After --build, fail if <s> appears in the client output.
 *                       Supply your known-leaked token at runtime; never commit it.
 *   --dry-run          Show what would change; write/run nothing.
 *   --json             Machine-readable summary.
 *   --help, -h         This message.
 *
 * Exit codes:
 *   0  every site updated cleanly (any hardcoded-secret findings are reported
 *      as warnings — rotation is a manual step this script can't do)
 *   1  at least one site failed (install/build/verify error) OR --verify-secret
 *      was still present in a client build
 *   2  bad arguments / no site found
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { auditSourceDir, type Finding } from "./audit-secrets";

export interface SitePkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [k: string]: unknown;
}

const DECO_SCOPE = /^@decocms\//;

/** A site is affected if it depends on the TanStack framework binding. */
export function isAffectedSite(pkg: SitePkg): boolean {
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return Boolean(all["@decocms/tanstack"]);
}

export interface DepBump {
  name: string;
  field: "dependencies" | "devDependencies";
  from: string;
  to: string;
}

/**
 * Compute the version-spec changes needed to move every `@decocms/*` dep to
 * `spec`. Pure — exported for testing. Only returns entries that actually change.
 */
export function planDepBumps(pkg: SitePkg, spec: string): DepBump[] {
  const bumps: DepBump[] = [];
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, from] of Object.entries(deps)) {
      if (!DECO_SCOPE.test(name)) continue;
      if (from === spec) continue;
      bumps.push({ name, field, from, to: spec });
    }
  }
  return bumps;
}

/** Apply bumps in place on a cloned pkg. Pure — returns the new object. */
export function applyDepBumps(pkg: SitePkg, bumps: DepBump[]): SitePkg {
  const next: SitePkg = JSON.parse(JSON.stringify(pkg));
  for (const b of bumps) {
    const deps = next[b.field] as Record<string, string> | undefined;
    if (deps) deps[b.name] = b.to;
  }
  return next;
}

type PkgManager = "bun" | "npm" | "pnpm";

function detectPm(siteDir: string): PkgManager {
  if (
    fs.existsSync(path.join(siteDir, "bun.lock")) ||
    fs.existsSync(path.join(siteDir, "bun.lockb"))
  ) {
    return "bun";
  }
  if (fs.existsSync(path.join(siteDir, "pnpm-lock.yaml"))) return "pnpm";
  return "npm";
}

function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

/** Resolve the latest published version of a package via `npm view`. */
function resolveLatest(pkgName: string): string {
  const out = execFileSync("npm", ["view", pkgName, "version"], {
    encoding: "utf8",
  }).trim();
  if (!/^\d+\.\d+\.\d+/.test(out)) {
    throw new Error(`could not resolve latest version of ${pkgName} (got "${out}")`);
  }
  return out;
}

// Directories a Vite/TanStack-Start + CF Workers build may emit client assets to.
const CLIENT_OUTPUT_DIRS = ["dist", ".output", "build", ".vercel/output", ".wrangler"];
const CLIENT_ASSET_EXT = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".json", ".map"]);

/** Recursively collect built client asset files under a site dir. */
function collectClientAssets(siteDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(full);
      } else if (e.isFile() && CLIENT_ASSET_EXT.has(path.extname(e.name))) {
        out.push(full);
      }
    }
  };
  for (const d of CLIENT_OUTPUT_DIRS) {
    const full = path.join(siteDir, d);
    if (fs.existsSync(full)) walk(full);
  }
  return out;
}

/** Grep built client assets for a literal. Returns matching file paths. */
export function findSecretInAssets(files: string[], secret: string): string[] {
  const hits: string[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (content.includes(secret)) hits.push(f);
  }
  return hits;
}

export interface SiteResult {
  site: string;
  affected: boolean;
  bumps: DepBump[];
  secretFindings: Finding[];
  built: boolean;
  leakedAssetFiles: string[];
  error?: string;
}

interface CliOpts {
  sites: string[];
  version: string | null;
  exact: boolean;
  pm: PkgManager | null;
  install: boolean;
  build: boolean;
  verifySecret: string | null;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    sites: [],
    version: null,
    exact: false,
    pm: null,
    install: true,
    build: false,
    verifySecret: null,
    dryRun: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--version":
        opts.version = argv[++i] ?? null;
        break;
      case "--exact":
        opts.exact = true;
        break;
      case "--pm": {
        const v = argv[++i];
        if (v !== "bun" && v !== "npm" && v !== "pnpm") {
          console.error(`upgrade: --pm must be bun|npm|pnpm (got "${v ?? ""}")`);
          process.exit(2);
        }
        opts.pm = v;
        break;
      }
      case "--no-install":
        opts.install = false;
        break;
      case "--build":
        opts.build = true;
        break;
      case "--verify-secret":
        opts.verifySecret = argv[++i] ?? null;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`upgrade: unknown option "${a}"`);
          process.exit(2);
        }
        opts.sites.push(a);
    }
  }
  if (opts.sites.length === 0) opts.sites.push(".");
  return opts;
}

function showHelp(): void {
  console.log(`
  @decocms/blocks-cli — loader/action bundle-leak rollout

  Bumps @decocms/* to the fixed framework version, installs, audits for
  hardcoded credentials, and (optionally) rebuilds + verifies the client
  output no longer contains a known leaked value. Never deploys.

  Usage:
    tsx upgrade-loader-leak-fix.ts [siteDir...] [options]

  Options:
    --version <v>        Target @decocms/* version (default: latest published)
    --exact              Pin exact instead of caret
    --pm <bun|npm|pnpm>  Package manager (default: detect)
    --no-install         Skip install
    --build              Run the site build after install
    --verify-secret <s>  Fail if <s> appears in the client build (supply at runtime)
    --dry-run            Show changes; write/run nothing
    --json               Machine-readable summary
    --help, -h           This message
`);
}

function upgradeSite(siteDir: string, opts: CliOpts, spec: string): SiteResult {
  const result: SiteResult = {
    site: siteDir,
    affected: false,
    bumps: [],
    secretFindings: [],
    built: false,
    leakedAssetFiles: [],
  };

  const pkgPath = path.join(siteDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    result.error = "no package.json";
    return result;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as SitePkg;

  result.affected = isAffectedSite(pkg);
  if (!result.affected) return result; // not a TanStack deco site — skip

  // 1. Plan + apply dependency bumps.
  result.bumps = planDepBumps(pkg, spec);
  if (result.bumps.length > 0 && !opts.dryRun) {
    const next = applyDepBumps(pkg, result.bumps);
    fs.writeFileSync(pkgPath, JSON.stringify(next, null, 2) + "\n");
  }

  // 2. Install (updates the lockfile so the fixed framework is resolved).
  const pm = opts.pm ?? detectPm(siteDir);
  if (result.bumps.length > 0 && opts.install && !opts.dryRun) {
    run(pm, ["install"], siteDir);
  }

  // 3. Audit source for hardcoded credentials — must be rotated manually.
  //    Scan the whole site tree (root actions/ + src/).
  result.secretFindings = auditSourceDir(siteDir);

  // 4. Optional rebuild + verify the leaked value is gone from the client output.
  if (opts.build && !opts.dryRun) {
    run(pm, ["run", "build"], siteDir);
    result.built = true;
    if (opts.verifySecret) {
      const assets = collectClientAssets(siteDir);
      result.leakedAssetFiles = findSecretInAssets(assets, opts.verifySecret);
    }
  }

  return result;
}

function printReport(results: SiteResult[]): void {
  for (const r of results) {
    console.log(`\n── ${r.site} ──`);
    if (r.error) {
      console.log(`  ERROR: ${r.error}`);
      continue;
    }
    if (!r.affected) {
      console.log("  skipped — not a @decocms/tanstack site");
      continue;
    }
    if (r.bumps.length === 0) {
      console.log("  deps already at target version");
    } else {
      console.log(`  bumped ${r.bumps.length} @decocms/* dep(s):`);
      for (const b of r.bumps) console.log(`    ${b.name}: ${b.from} -> ${b.to}`);
    }
    if (r.built) {
      console.log("  rebuilt client");
      if (r.leakedAssetFiles.length > 0) {
        console.log(`  ✗ LEAK STILL PRESENT in ${r.leakedAssetFiles.length} asset(s):`);
        for (const f of r.leakedAssetFiles) console.log(`      ${f}`);
      } else {
        console.log("  ✓ verify-secret not found in client build");
      }
    }
    const errors = r.secretFindings.filter((f) => f.severity === "error");
    if (errors.length > 0) {
      console.log(`  ⚠ ${errors.length} hardcoded-credential finding(s) — ROTATE these:`);
      for (const f of errors) console.log(`    ${f.file}:${f.line} — ${f.id}`);
    }
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    showHelp();
    process.exit(0);
  }

  // Resolve the target spec.
  let version = opts.version;
  if (!version) {
    try {
      version = resolveLatest("@decocms/tanstack");
      console.log(`Resolved latest @decocms/tanstack: ${version}`);
    } catch (e) {
      console.error(`upgrade: ${(e as Error).message}. Pass --version explicitly.`);
      process.exit(2);
    }
  }
  const spec = opts.exact ? version : `^${version.replace(/^[\^~]/, "")}`;

  const results: SiteResult[] = [];
  for (const site of opts.sites) {
    const dir = path.resolve(site);
    try {
      results.push(upgradeSite(dir, opts, spec));
    } catch (e) {
      results.push({
        site: dir,
        affected: true,
        bumps: [],
        secretFindings: [],
        built: false,
        leakedAssetFiles: [],
        error: (e as Error).message,
      });
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ spec, dryRun: opts.dryRun, results }, null, 2) + "\n");
  } else {
    printReport(results);
    console.log(
      "\nNext steps: rotate any flagged credential, then redeploy each site " +
        "with your pipeline (e.g. `wrangler deploy`).",
    );
  }

  const failed = results.some((r) => r.error || r.leakedAssetFiles.length > 0);
  process.exit(failed ? 1 : 0);
}

const isCjsEntry =
  typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;
let isEsmEntry = false;
try {
  isEsmEntry =
    typeof process !== "undefined" &&
    Array.isArray(process.argv) &&
    process.argv[1] !== undefined &&
    import.meta.url === `file://${process.argv[1]}`;
} catch {
  // ignore in CJS
}
if (isCjsEntry || isEsmEntry) {
  main();
}
