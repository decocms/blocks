#!/usr/bin/env tsx
/**
 * @decocms/blocks-cli — hardcoded-secret audit
 *
 * Read-only source scanner. Catches the two ways a credential ends up
 * publicly downloadable from a storefront's client assets:
 *
 *   1. A secret literal hardcoded in a site `action`/`loader` module. In a
 *      TanStack Start build these modules are registered in `.deco/loaders.gen.ts`
 *      behind a dynamic `import()`, and that file is reachable from the client
 *      entry (router -> setup -> commerce-loaders -> loaders.gen). Unless the
 *      framework stubs loaders.gen on the client (it now does — see
 *      packages/tanstack/src/vite/plugin.js), Vite emits each action/loader as a
 *      public chunk, baking the literal into the browser bundle. Even with the
 *      stub, a hardcoded credential in source is a committed-secret problem, so
 *      we flag it at author time.
 *
 *   2. An import of `@decocms/blocks/sdk/crypto` (the secret-decryption SDK)
 *      from a file marked `"use client"`. crypto is server-only; pulling it into
 *      a client module drags decryption code toward the browser bundle.
 *
 * The scanner intentionally only inspects `actions/` and `loaders/` directories
 * for rule (1) — that's where request-time credentials live and where the
 * bundle-leak path exists. Rule (2) applies to any file.
 *
 * CI-friendly: mirrors audit-observability-config.ts (Severity/Finding, --json,
 * --mode warn|block, --github, exit 0/1/2).
 *
 * Usage (from a site or package directory):
 *   tsx audit-secrets.ts --source ./src
 *   tsx audit-secrets.ts --source ./src --mode block   # exit 1 on error findings
 *   tsx audit-secrets.ts --json
 *   tsx audit-secrets.ts --github
 *
 * Exit codes:
 *   0 — no findings, or `--mode warn` (default) regardless of findings
 *   1 — `--mode block` and at least one `error`-severity finding
 *   2 — source directory missing
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  /** Repo-relative file the finding is in. */
  file: string;
  /** 1-indexed line the finding anchors to. */
  line: number;
  message: string;
  /** Suggested remediation. */
  fix?: string;
}

export type GateMode = "warn" | "block";

// A file is in scope for the hardcoded-secret rule if it lives under an
// actions/ or loaders/ directory (Fresh `actions/foo.ts` or TanStack
// `src/actions/foo.ts` both match on the path segment).
export function isActionOrLoaderPath(relPath: string): boolean {
  const norm = relPath.replaceAll("\\", "/");
  return /(^|\/)(actions|loaders)\//.test(norm);
}

// Keys whose value being a plain string literal is a strong secret signal.
const SECRET_KEY =
  "(?:api[_-]?key|token|secret|password|passwd|authorization|auth[_-]?token|access[_-]?token|client[_-]?secret|private[_-]?key)";

// A quoted literal with no `${` interpolation and a token-ish payload.
// Requires length >= 12 to avoid flagging short placeholders like "changeme".
const TOKENISH = "[A-Za-z0-9][A-Za-z0-9._\\-+/=]{11,}";

const BEARER_RE = new RegExp(`["'\`]\\s*Bearer\\s+(${TOKENISH})\\s*["'\`]`, "i");
const KEYED_SECRET_RE = new RegExp(`\\b${SECRET_KEY}\\b\\s*[:=]\\s*["'\`](${TOKENISH})["'\`]`, "i");

// Values that look like a real literal but are safe: obvious placeholders.
const PLACEHOLDER_RE =
  /^(?:x+|y+|z+|changeme|placeholder|example|your[_-]?\w+|todo|xxx+|test|dummy|none|null|undefined)$/i;

/**
 * Scan a single file's source for hardcoded credentials + client crypto import.
 * Pure — exported for unit testing.
 */
export function scanFileForSecrets(relPath: string, content: string): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split("\n");

  // Rule 2: crypto import in a "use client" file (any path).
  const isClient = /^\s*["']use client["'];?\s*$/m.test(content);
  if (isClient) {
    lines.forEach((ln, i) => {
      if (
        /from\s+["']@decocms\/blocks\/sdk\/crypto["']/.test(ln) ||
        /import\s*\(\s*["']@decocms\/blocks\/sdk\/crypto["']\s*\)/.test(ln)
      ) {
        findings.push({
          id: "crypto_imported_in_client",
          severity: "error",
          file: relPath,
          line: i + 1,
          message:
            "`@decocms/blocks/sdk/crypto` (server-only secret decryption) is imported from a " +
            '"use client" module. Decrypt secrets server-side (in an app configure()/loader) and ' +
            "never in client-bundled code.",
          fix: "Move the secret resolution to a server-only module (action/loader/app config).",
        });
      }
    });
  }

  // Rule 1: hardcoded secret literal in an action/loader.
  if (isActionOrLoaderPath(relPath)) {
    lines.forEach((ln, i) => {
      for (const [id, re, label] of [
        ["hardcoded_bearer_token", BEARER_RE, "a Bearer token"],
        ["hardcoded_secret_literal", KEYED_SECRET_RE, "a credential"],
      ] as const) {
        const m = re.exec(ln);
        if (!m) continue;
        const value = m[1];
        if (PLACEHOLDER_RE.test(value)) continue;
        // The regexes only match a literal token (the charset excludes `${}`),
        // so `Bearer ${t}` / `token: process.env.X` never reach here. Both rules
        // therefore only fire on a genuinely hardcoded string.
        findings.push({
          id,
          severity: "error",
          file: relPath,
          line: i + 1,
          message:
            `Hardcoded ${label} in an action/loader. In a TanStack build this source can be ` +
            "emitted as a public client chunk, exposing the credential in the browser assets. " +
            "It is also a committed secret regardless of bundling.",
          fix: "Move the value to an environment variable / CMS Secret and read it via ctx or process.env; then rotate the exposed credential.",
        });
      }
    });
  }

  return findings;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".deco",
  ".vite",
  ".cache",
  "coverage",
]);
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile() && SCAN_EXT.has(path.extname(e.name))) {
      // Don't scan test files or the scanner's own fixtures.
      if (/\.test\.[cm]?[jt]sx?$/.test(e.name)) continue;
      out.push(full);
    }
  }
}

/** Scan a directory tree. Pure-ish (reads the filesystem); returns findings. */
export function auditSourceDir(sourceDir: string): Finding[] {
  const files: string[] = [];
  walk(sourceDir, files);
  const findings: Finding[] = [];
  for (const full of files) {
    const rel = path.relative(sourceDir, full);
    let content: string;
    try {
      content = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    findings.push(...scanFileForSecrets(rel, content));
  }
  return findings;
}

interface CliOpts {
  source: string;
  json: boolean;
  help: boolean;
  mode: GateMode;
  github: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { source: ".", json: false, help: false, mode: "warn", github: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--source":
        opts.source = argv[++i] ?? ".";
        break;
      case "--json":
        opts.json = true;
        break;
      case "--mode": {
        const value = argv[++i];
        if (value !== "warn" && value !== "block") {
          console.error(`audit-secrets: --mode must be "warn" or "block" (got "${value ?? ""}")`);
          process.exit(2);
        }
        opts.mode = value;
        break;
      }
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
  @decocms/blocks-cli — hardcoded-secret audit

  Read-only scan for credentials hardcoded in action/loader source and for
  server-only crypto imported into "use client" modules.

  Usage:
    tsx audit-secrets.ts [options]

  Options:
    --source <dir>   Directory to scan (default: .)
    --json           Emit findings as JSON
    --mode <m>       "warn" (default, exit 0) | "block" (exit 1 on errors)
    --github         Emit ::error::/::warning:: lines for GitHub Actions
    --help, -h       This message

  Exit codes:
    0   no findings, OR --mode warn (default)
    1   --mode block AND at least one error-severity finding
    2   source directory missing
`);
}

function findingsToText(findings: Finding[]): string {
  if (findings.length === 0) return "OK   no hardcoded secrets found";
  const lines = ["Hardcoded-secret findings:"];
  for (const f of findings) {
    lines.push(`  [${f.severity.toUpperCase()}] ${f.id} — ${f.file}:${f.line}`);
    lines.push(`    ${f.message}`);
    if (f.fix) lines.push(`    fix: ${f.fix}`);
  }
  lines.push("");
  return lines.join("\n");
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    showHelp();
    process.exit(0);
  }

  const dir = path.resolve(opts.source);
  if (!fs.existsSync(dir)) {
    console.error(`audit-secrets: ${dir} not found`);
    process.exit(2);
  }

  const findings = auditSourceDir(dir);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ source: dir, mode: opts.mode, findings }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(findingsToText(findings) + "\n");
  }

  if (opts.github) {
    for (const f of findings) {
      const level =
        opts.mode === "block" && f.severity === "error"
          ? "error"
          : f.severity === "info"
            ? "notice"
            : "warning";
      const msg = `${f.message}${f.fix ? ` (fix: ${f.fix})` : ""}`;
      const escaped = msg.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
      process.stdout.write(`::${level} file=${f.file},line=${f.line},title=${f.id}::${escaped}\n`);
    }
  }

  const shouldFail = opts.mode === "block" && findings.some((f) => f.severity === "error");
  process.exit(shouldFail ? 1 : 0);
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
