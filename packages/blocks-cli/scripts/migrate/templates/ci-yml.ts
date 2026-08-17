/**
 * Scaffolds the per-PR quality pipeline and its companion gate script:
 *   .github/workflows/ci.yml                 — GitHub Actions workflow
 *   tools/gates/no-suppressions.sh           — bans NEW type suppressions + preact
 *   tools/gates/suppressions-allowlist.txt   — grandfathered offenders (seeded empty)
 *
 * Design rationale:
 *   - A freshly migrated site carries inherited debt (leftover
 *     @ts-expect-error, not-yet-prettier-clean files, unused exports). So the
 *     only BLOCKING gates are the ones a site MUST pass to run at all:
 *     `generate` (CMS + route artifacts) and `build` (vite). Everything that
 *     depends on migration cleanliness — no-suppressions, typecheck,
 *     format:check, knip — ships ADVISORY (`continue-on-error: true`) so day-one
 *     CI is green. Each carries a comment on how to promote it to blocking as
 *     the debt zeroes out.
 *   - The scripts the steps call (`generate`, `generate:routes`, `typecheck`,
 *     `format:check`, `knip`) are all defined in the scaffolded package.json.
 *
 * @param nodeVersion  Node version for setup-node (lockstep with package.json engines).
 * @param bunVersion   Bun version for setup-bun (= CANONICAL_BUN_VERSION).
 */
export function generateCiFiles(nodeVersion: string, bunVersion: string): Record<string, string> {
  const bun = bunVersion.replace(/^bun@/, "");
  return {
    ".github/workflows/ci.yml": generateCiYml(nodeVersion, bun),
    "tools/gates/no-suppressions.sh": NO_SUPPRESSIONS_SH,
    "tools/gates/suppressions-allowlist.txt": SUPPRESSIONS_ALLOWLIST,
  };
}

function generateCiYml(nodeVersion: string, bunVersion: string): string {
  return `name: CI

# Per-PR quality pipeline. No auto-merge: it only informs the human review.
#
# BLOCKS (the site must run): generate (CMS + routes), build.
# ADVISORY (continue-on-error — inherited migration debt varies per site):
# no-suppressions, typecheck, format:check, knip. Promote each to blocking by
# removing its \`continue-on-error\` once that debt is zero.

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

env:
  NODE_VERSION: "${nodeVersion}"
  BUN_VERSION: "${bunVersion}"

jobs:
  gates:
    name: gates (no-suppressions, generate, typecheck, format, knip, build)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: \${{ env.NODE_VERSION }}

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: \${{ env.BUN_VERSION }}

      - name: bun install --frozen-lockfile
        run: bun install --frozen-lockfile

      # ADVISORY — a fresh migration ships inherited suppressions. Seed the
      # allowlist with the current offenders, then remove \`continue-on-error\`:
      #   git grep -nE '@ts-expect-error|@ts-ignore' -- src/ tools/ \\
      #     > tools/gates/suppressions-allowlist.txt
      - name: Gate — no new suppression + zero preact (advisory)
        run: bash tools/gates/no-suppressions.sh
        continue-on-error: true

      # BLOCKS — CMS artifacts + route tree (the build depends on these). knip
      # also needs routeTree.gen.ts (src/router.tsx imports it).
      - name: Generate artifacts (CMS + routes)
        run: bun run generate && bun run generate:routes

      # ADVISORY — flip to blocking once typecheck is clean.
      - name: Typecheck (advisory)
        run: bun run typecheck
        continue-on-error: true

      # ADVISORY — flip to blocking after a repo-wide \`bun run format\` pass.
      - name: Format check (advisory)
        run: bun run format:check
        continue-on-error: true

      # ADVISORY — dead code / orphan deps.
      - name: Knip (advisory)
        run: bun run knip
        continue-on-error: true

      # BLOCKS — the site must compile (vite build does NOT typecheck).
      - name: Build (vite)
        run: bun run build
`;
}

const NO_SUPPRESSIONS_SH = `#!/usr/bin/env bash
set -euo pipefail

# Gate: NO new type suppression + zero preact import.
#
# A migration leaves behind some @ts-expect-error/@ts-ignore. This gate keeps
# that debt from GROWING: existing suppressions are grandfathered in the
# allowlist (tools/gates/suppressions-allowlist.txt); any suppression outside it
# fails the PR. As the type debt zeroes out, remove entries from the allowlist —
# it only shrinks, never grows.
#
# Allowlist format: "path/file.ts:123" (the exact path:line from \`git grep -n\`).
# Blank lines and "#" are ignored. If you touched a file and an existing
# suppression's line number moved, update its entry — do not add a new one.
#
# Usage: bash tools/gates/no-suppressions.sh

ROOT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
cd "\$ROOT_DIR"

ALLOWLIST="tools/gates/suppressions-allowlist.txt"
SELF_PATH="tools/gates/no-suppressions.sh"
EXIT_CODE=0

SCAN_PATHS=(-- 'src/' 'tools/' ":(exclude)\${SELF_PATH}" ":(exclude)\${ALLOWLIST}")
SUPPRESSION_PATTERN='@ts-expect-error|@ts-ignore'

echo "== gate: no new type suppression (\${SUPPRESSION_PATTERN}) =="
RAW_MATCHES="\$(git grep -nE "\${SUPPRESSION_PATTERN}" "\${SCAN_PATHS[@]}" 2>/dev/null || true)"

if [ -n "\$RAW_MATCHES" ]; then
  VIOLATIONS=""
  while IFS= read -r match; do
    [ -z "\$match" ] && continue
    path_line="\$(echo "\$match" | cut -d: -f1,2)"
    if [ -f "\$ALLOWLIST" ] && grep -qxF "\$path_line" "\$ALLOWLIST"; then
      continue
    fi
    VIOLATIONS="\${VIOLATIONS}\${match}"\$'\\n'
  done <<<"\$RAW_MATCHES"

  if [ -n "\$VIOLATIONS" ]; then
    echo "FAILED: type suppression outside the allowlist:"
    echo "\$VIOLATIONS"
    echo "Fix the type at the source instead of suppressing. If an existing line"
    echo "only changed number, update its allowlist entry (do not create a new one)."
    EXIT_CODE=1
  fi
fi

echo "== gate: zero preact import =="
# Matches REAL import specifiers ("preact", "preact/hooks", "@preact/signals"…),
# not the bare word "preact". Requires straight quotes around the specifier.
PREACT_IMPORT_PATTERN='["'"'"'](@preact/[a-zA-Z0-9_-]+|preact(/[a-zA-Z0-9_-]+)*)["'"'"']'
PREACT_MATCHES="\$(git grep -nE "\${PREACT_IMPORT_PATTERN}" "\${SCAN_PATHS[@]}" 2>/dev/null || true)"
if [ -n "\$PREACT_MATCHES" ]; then
  echo "FAILED: preact import found (this stack is React, not Preact):"
  echo "\$PREACT_MATCHES"
  EXIT_CODE=1
fi

if [ "\$EXIT_CODE" -eq 0 ]; then
  echo "OK: no new suppression, no preact import."
fi

exit "\$EXIT_CODE"
`;

const SUPPRESSIONS_ALLOWLIST = `# Grandfathered type suppressions (path:line from \`git grep -n\`).
# Seed this with the migration's leftover offenders to flip the CI
# no-suppressions gate from advisory to blocking:
#   git grep -nE '@ts-expect-error|@ts-ignore' -- src/ tools/ >> tools/gates/suppressions-allowlist.txt
# This list only shrinks — never add a new entry for new code.
`;
