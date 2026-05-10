#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { join } from "node:path";

interface Violation {
  file: string;
  imported: string;
  reason: string;
}

interface Options {
  distDir: string;
}

const FORBIDDEN_IN_CORE = [
  /@tanstack\/react-start/,
  /@tanstack\/react-router/,
  /^next$/,
  /^next\//,
  // Both the prefixed (`node:async_hooks`) and unprefixed (`async_hooks`)
  // forms must be flagged. tsup emits the unprefixed form when it appears
  // in the `external` list without the prefix.
  /^node:async_hooks$/,
  /^async_hooks$/,
  // Node-only modules — must not appear anywhere in dist/core/, even via
  // dynamic await import(), because webpack statically analyzes literal-
  // string specifiers and fails to resolve them for browser targets.
  // Both `node:` prefixed and unprefixed forms must be matched: tsup with
  // `platform: "neutral"` strips the `node:` prefix from dynamic imports
  // when the module appears externalized without the prefix.
  /^node:fs$/,
  /^fs$/,
  /^node:fs\/promises$/,
  /^fs\/promises$/,
  /^node:path$/,
  /^path$/,
  /^node:os$/,
  /^os$/,
  /^node:child_process$/,
  /^child_process$/,
  /^node:stream$/,
  /^node:net$/,
  /^net$/,
  /^node:tls$/,
  /^tls$/,
  // crypto is debatable — Web Crypto exists; flag if it appears, surface
  // and decide. Allowlist if a Web Crypto-compatible call is needed.
  /^node:crypto$/,
  /^crypto$/,
];

const FORBIDDEN_IN_NEXT = [/@tanstack\/react-start/, /@tanstack\/react-router/];

// Match `from "spec"`, `import("spec")`, and `import(/* webpackIgnore: true */ "spec")`.
// The `(?:\/\*[\s\S]*?\*\/\s*)?` segment skips an optional block comment after `import(`,
// which esbuild preserves when the source uses `await import(/* webpackIgnore: true */ "x")`.
const IMPORT_RE = /(?:from|import\()\s*(?:\/\*[\s\S]*?\*\/\s*)?["']([^"']+)["']/g;

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    // Skip test artifacts — they import test-only setup helpers that
    // legitimately cross tier boundaries (e.g. an ALS-backed RequestStore
    // installer) and never ship to consumers.
    else if (/\.test\.(js|cjs|mjs)$/.test(entry.name)) continue;
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) yield path;
  }
}

function tierOf(path: string): "core" | "tanstack" | "next" | "other" {
  if (path.includes("/core/") || path.includes("\\core\\")) return "core";
  if (path.includes("/tanstack/") || path.includes("\\tanstack\\")) return "tanstack";
  if (path.includes("/next/") || path.includes("\\next\\")) return "next";
  return "other";
}

export async function checkTierBoundaries(
  opts: Options,
): Promise<{ violations: Violation[] }> {
  const violations: Violation[] = [];
  for await (const path of walk(opts.distDir)) {
    const content = await fs.readFile(path, "utf8");
    const tier = tierOf(path);
    const imports: string[] = [];
    for (const m of content.matchAll(IMPORT_RE)) imports.push(m[1]);

    for (const imp of imports) {
      // Only consider relative imports for cross-tier path detection. We
      // match `./foo` and `../foo` (any depth) — bare specifiers and
      // absolute URLs are out of scope here. This avoids false positives
      // from packages or runtime URLs that happen to contain `/tanstack/`
      // or `/next/` in their path.
      const isRelative = imp.startsWith("./") || imp.startsWith("../");
      const crossesInto = (target: "tanstack" | "next" | "core"): boolean => {
        if (!isRelative) return false;
        return new RegExp(`(?:^|/)${target}/`).test(imp);
      };

      if (tier === "core") {
        for (const re of FORBIDDEN_IN_CORE) {
          if (re.test(imp)) {
            violations.push({ file: path, imported: imp, reason: `core forbids ${imp}` });
          }
        }
        // Core must not reach into other tiers via relative paths.
        if (crossesInto("tanstack")) {
          violations.push({
            file: path,
            imported: imp,
            reason: `core forbids relative path into tanstack: ${imp}`,
          });
        }
        if (crossesInto("next")) {
          violations.push({
            file: path,
            imported: imp,
            reason: `core forbids relative path into next: ${imp}`,
          });
        }
      } else if (tier === "next") {
        for (const re of FORBIDDEN_IN_NEXT) {
          if (re.test(imp)) {
            violations.push({ file: path, imported: imp, reason: `next forbids ${imp}` });
          }
        }
        if (crossesInto("tanstack")) {
          violations.push({
            file: path,
            imported: imp,
            reason: `next must not import from tanstack: ${imp}`,
          });
        }
      } else if (tier === "tanstack") {
        if (crossesInto("next")) {
          violations.push({
            file: path,
            imported: imp,
            reason: `tanstack must not import from next: ${imp}`,
          });
        }
      }
    }
  }
  return { violations };
}

// CLI entrypoint
const isMain = (() => {
  try {
    const argv = process.argv?.[1];
    return Boolean(argv && import.meta.url === `file://${argv}`);
  } catch {
    return false;
  }
})();

if (isMain) {
  const result = await checkTierBoundaries({ distDir: "dist" });
  if (result.violations.length === 0) {
    console.log("✓ tier boundaries clean");
    process.exit(0);
  }
  console.error("✗ tier boundary violations:");
  for (const v of result.violations) console.error(`  ${v.file}: ${v.imported} (${v.reason})`);
  process.exit(1);
}
