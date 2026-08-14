/**
 * Scaffolds the advisory per-PR performance workflow and its companion tools:
 *   .github/workflows/perf.yml     — GitHub Actions workflow
 *   tools/perf/changed-paths.sh    — maps edited sections → CMS page paths
 *   tools/perf/compare.mjs         — compares two LHCI result dirs, emits markdown
 *   lighthouserc.json              — LHCI collect settings (3 runs, mobile UA, 4 categories)
 *
 * Design rationale:
 *   - CF Workers Builds generates a per-PR preview URL (workers.dev). Both the
 *     PR and main previews are workers.dev — no edge cache — so the delta is
 *     purely code, not cache state.
 *   - Gate signal = CLS + TBT + a11y/best-practices/SEO scores. CLS/TBT are
 *     layout stability / JS work; the three category scores are static-analysis
 *     audits. All cache-insensitive, so a regression is real code, not cold SSR.
 *     LCP and performance score are informational only (noisy on cold SSR).
 *   - Advisory: `continue-on-error: true`. Remove it once the site stabilises.
 *   - LHCI 0.15 does not write manifest.json; compare.mjs reads lhr-*.json
 *     directly and selects the median run by performance score.
 */

/**
 * @param workerName  Cloudflare Worker name (= wrangler `name` field, e.g. "oficina-tanstack").
 *                    Used in the CF check-run name and the main preview base URL.
 */
export function generatePerfFiles(workerName: string): Record<string, string> {
  return {
    ".github/workflows/perf.yml": generatePerfYml(workerName),
    "tools/perf/changed-paths.sh": CHANGED_PATHS_SH,
    "tools/perf/compare.mjs": COMPARE_MJS,
    "lighthouserc.json": LIGHTHOUSERC_JSON,
  };
}

function generatePerfYml(workerName: string): string {
  return `name: Perf

# Teste de performance por PR (advisory — comenta, não trava; vire gate removendo
# o \`continue-on-error\` do job quando estabilizar, igual react-doctor/typecheck).
#
# Trigger: pull_request (único trigger que roda do branch do PR, não do main).
# Aguarda o check do CF Workers Builds completar via polling, então extrai a
# preview URL do output — sem token CF nem build local.
#
# Baseline: URL fixa da preview do main (https://${workerName}.deco-cx.workers.dev).
# Gate: CLS + TBT + A11y/BP/SEO (estrutura/JS + auditorias estáticas, insensíveis a cache). LCP/score: informativos.

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write
  checks: read

concurrency:
  group: perf-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

env:
  MOBILE_UA: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
  BASE_URL: "https://${workerName}.deco-cx.workers.dev"
  PERF_FALLBACK_PATHS: |
    /

jobs:
  perf:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      # Aguarda o CF Workers Builds completar e extrai a preview URL do output.
      # Timeout: 10 min (builds normalmente terminam em ~3 min).
      - id: cf
        name: Aguardar CF build e extrair preview URL
        env:
          GH_TOKEN: \${{ github.token }}
          SHA: \${{ github.event.pull_request.head.sha }}
        run: |
          echo "Aguardando CF Workers Builds para \$SHA..."
          for i in \$(seq 1 60); do
            summary=\$(gh api \\
              "repos/\$GITHUB_REPOSITORY/commits/\$SHA/check-runs" \\
              --jq '.check_runs[] | select(.name == "Workers Builds: ${workerName}") | .output.summary' \\
              2>/dev/null || true)

            if [ -n "\$summary" ]; then
              conclusion=\$(gh api \\
                "repos/\$GITHUB_REPOSITORY/commits/\$SHA/check-runs" \\
                --jq '.check_runs[] | select(.name == "Workers Builds: ${workerName}") | .conclusion' \\
                2>/dev/null || true)

              if [ "\$conclusion" = "success" ]; then
                url=\$(printf '%s' "\$summary" | grep -oP '(?<=Preview URL: )https://\\S+' | head -1)
                if [ -n "\$url" ]; then
                  echo "url=\$url" >> "\$GITHUB_OUTPUT"
                  echo "run=true"  >> "\$GITHUB_OUTPUT"
                  echo "CF build OK — preview: \$url"
                  exit 0
                fi
              elif [ -n "\$conclusion" ] && [ "\$conclusion" != "null" ]; then
                echo "CF build concluiu com: \$conclusion — pulando perf"
                echo "run=false" >> "\$GITHUB_OUTPUT"
                exit 0
              fi
            fi

            echo "Tentativa \$i/60 — aguardando 10s..."
            sleep 10
          done

          echo "Timeout aguardando CF build — pulando perf"
          echo "run=false" >> "\$GITHUB_OUTPUT"

      - uses: actions/checkout@v4
        if: steps.cf.outputs.run == 'true'
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        if: steps.cf.outputs.run == 'true'
        with:
          node-version: "22.15.0"

      - id: paths
        name: Mapear seções editadas → paths
        if: steps.cf.outputs.run == 'true'
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          # GitHub PR Files API = source of truth (evita problemas de squash merge)
          changed=\$(gh api \\
            "repos/\$GITHUB_REPOSITORY/pulls/\${{ github.event.pull_request.number }}/files" \\
            --paginate --jq '.[].filename' \\
            | grep -E '^src/(sections|previews)/.*\\.tsx\$' || true)
          echo "--- seções alteradas neste PR ---"
          printf '%s\\n' "\$changed"
          chmod +x tools/perf/changed-paths.sh
          CHANGED_FILES="\$changed" tools/perf/changed-paths.sh > perf-paths.txt || true
          echo "--- paths a medir ---"; cat perf-paths.txt
          if [ -s perf-paths.txt ]; then echo "run=true" >> "\$GITHUB_OUTPUT"
          else echo "run=false" >> "\$GITHUB_OUTPUT"; fi

      - name: Warm previews
        if: steps.cf.outputs.run == 'true' && steps.paths.outputs.run == 'true'
        env:
          PR_URL: \${{ steps.cf.outputs.url }}
        run: |
          # --max-time 30: garante que curl não trava num SSR lento
          while IFS= read -r p; do
            [ -n "\$p" ] || continue
            for origin in "\$PR_URL" "\$BASE_URL"; do
              for _ in 1 2; do
                curl -s -o /dev/null --max-time 30 -A "\$MOBILE_UA" \\
                  -w "warm %{http_code} \${origin}\${p} ttfb=%{time_starttransfer}s\\n" \\
                  "\${origin}\${p}" || true
              done
            done
          done < perf-paths.txt

      - name: Lighthouse (PR + base)
        if: steps.cf.outputs.run == 'true' && steps.paths.outputs.run == 'true'
        env:
          PR_URL: \${{ steps.cf.outputs.url }}
        run: |
          collect() {
            local origin="\$1" out="\$2" args=()
            while IFS= read -r p; do [ -n "\$p" ] && args+=(--url="\${origin}\${p}"); done < perf-paths.txt
            rm -rf .lighthouseci "\$out"
            npx @lhci/cli collect --config=lighthouserc.json "\${args[@]}"
            mv .lighthouseci "\$out"
            echo "--- \$out contents ---"; ls -la "\$out" || true
          }
          collect "\$PR_URL" .lhci-pr
          collect "\$BASE_URL" .lhci-base

      - name: Montar comentário
        if: steps.cf.outputs.run == 'true' && steps.paths.outputs.run == 'true'
        run: |
          node tools/perf/compare.mjs .lhci-base .lhci-pr | tee perf-comment.md >> "\$GITHUB_STEP_SUMMARY"

      - name: Comentar no PR
        if: steps.cf.outputs.run == 'true' && steps.paths.outputs.run == 'true'
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: perf
          path: perf-comment.md
`;
}

const CHANGED_PATHS_SH = `#!/usr/bin/env bash
set -euo pipefail

# Map the sections changed in this PR to the CMS page path(s) that render them,
# so the perf workflow only measures pages the PR can actually affect.
#
# How: each edited src/sections/**/*.tsx (or its previews/ twin) becomes a
# resolveType ("site/sections/<subpath>"); we grep the checked-in decofile
# (.deco/blocks/*.json) for that string and emit the \`path\` of every PAGE block
# that references it. Reusable/instance blocks (path == null) and param/wildcard
# paths (/*, /:slug/p, /conta/*) are skipped — they can't be measured as-is.
#
# Outcomes:
#   - No section/preview files changed  → print PERF_FALLBACK_PATHS (home sanity).
#   - Sections changed, page(s) mapped  → print the mapped path(s).
#   - Sections changed, none mapped     → print PERF_FALLBACK_PATHS + log why.
#
# Output: one URL path per line on stdout. Diagnostics go to stderr.
#
# Env:
#   CHANGED_FILES         newline-separated list of changed section/preview files
#                         (from GitHub PR Files API — preferred, avoids squash-merge issues)
#   BASE_REF              git ref/sha to diff against (fallback if CHANGED_FILES unset)
#   PERF_FALLBACK_PATHS   newline-separated fallback paths (default: "/")
#   PERF_MAX_PATHS        max paths to emit (default: 3). Sections used on many
#                         pages (Header/Footer) would otherwise produce 100+ paths;
#                         any page is representative for a shared section.

ROOT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
cd "\$ROOT_DIR"

BASE_REF="\${BASE_REF:-origin/main}"
BLOCKS_DIR=".deco/blocks"

log() { printf '%s\\n' "\$*" >&2; }

emit_fallback() {
  log "perf: sections changed but no page mapped — using PERF_FALLBACK_PATHS"
  printf '%s\\n' "\${PERF_FALLBACK_PATHS:-/}" | sed 's/[[:space:]]*\$//' | sed '/^\$/d'
}

# Prefer CHANGED_FILES (set by the workflow from the GitHub PR Files API) to
# avoid squash-merge ancestry issues where git log A..B shows all historical commits.
# Fall back to git log only when running locally without CHANGED_FILES.
changed=()
if [ -n "\${CHANGED_FILES:-}" ]; then
  while IFS= read -r line; do
    [ -n "\$line" ] && changed+=("\$line")
  done < <(printf '%s\\n' "\$CHANGED_FILES" | grep -E '\\.tsx\$' | sort -u || true)
else
  while IFS= read -r line; do
    [ -n "\$line" ] && changed+=("\$line")
  done < <(git log --name-only --format="" "\$BASE_REF"..HEAD -- src/sections src/previews 2>/dev/null | grep -E '\\.tsx\$' | sort -u || true)
fi

# No sections changed → measure home as a baseline sanity check.
if [ "\${#changed[@]}" -eq 0 ]; then
  log "perf: nenhuma seção alterada — usando PERF_FALLBACK_PATHS como sanity"
  emit_fallback
  exit 0
fi

# Each changed file → the resolveType the decofile references it by.
resolvetypes=()
for f in "\${changed[@]}"; do
  case "\$f" in
    src/sections/*) resolvetypes+=("site/\${f#src/}") ;;
    src/previews/*) resolvetypes+=("site/sections/\${f#src/previews/}") ;;
  esac
done
[ "\${#resolvetypes[@]}" -eq 0 ] && exit 0

# Grep the decofile for each resolveType; collect page paths (non-null).
paths=()
for rt in "\${resolvetypes[@]}"; do
  while IFS= read -r block; do
    [ -n "\$block" ] || continue
    while IFS= read -r p; do
      [ -n "\$p" ] && paths+=("\$p")
    done < <(jq -r 'select(.path != null and (.path | type == "string")) | .path' "\$block" 2>/dev/null || true)
  done < <(grep -Fl "\$rt" "\$BLOCKS_DIR"/*.json 2>/dev/null || true)
done

# Dedupe + drop param/wildcard paths (need a concrete slug; can't measure as-is).
clean=()
if [ "\${#paths[@]}" -gt 0 ]; then
  while IFS= read -r line; do
    [ -n "\$line" ] && clean+=("\$line")
  done < <(printf '%s\\n' "\${paths[@]}" | grep -vE '[:*]' | sort -u)
fi

if [ "\${#clean[@]}" -eq 0 ]; then
  emit_fallback
  exit 0
fi

MAX="\${PERF_MAX_PATHS:-3}"
total="\${#clean[@]}"
if [ "\$total" -gt "\$MAX" ]; then
  log "perf: \${total} pages mapped — capped at \${MAX} (ponytail: PERF_MAX_PATHS). Dropped: \${clean[*]:\$MAX}"
  clean=("\${clean[@]:0:\$MAX}")
fi

log "perf: measuring \${#clean[@]} page(s) mapped from \${#changed[@]} changed file(s)"
printf '%s\\n' "\${clean[@]}"
`;

const COMPARE_MJS = `#!/usr/bin/env node
// Compare two Lighthouse CI result dirs (base = main preview, pr = PR preview)
// and emit a markdown table. Both previews run on *.workers.dev with no edge
// cache, same runner/region, same mobile UA — so the delta is the PR's code
// effect, not cache warm/cold.
//
// Gate signal = CLS + TBT + a11y/best-practices/SEO scores. CLS/TBT are page
// structure / JS work; the three category scores are static-analysis audits.
// All are cache-insensitive, so a regression is real code, not cold SSR.
// LCP / performance score are shown but informative only (noisy on cold workers.dev SSR).
//
// LHCI 0.15 does not write manifest.json; we read lhr-*.json directly.
//
// Usage: node compare.mjs <baseDir> <prDir>   → writes markdown to stdout
//        node compare.mjs --selftest          → runs assertions, exits 0/1

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TBT_ABS = 50; // ms — deltas below this are noise
const TBT_REL = 0.15; // 15% relative change
const CLS_ABS = 0.02; // absolute CLS delta that matters
const CLS_FLOOR = 0.1; // only flag CLS regression when PR is above "good"
const SCORE_DROP = 3; // pts — a11y/bp/seo score drop that gates (tolerates 1–2pt audit jitter)
const SCORES = ["a11y", "bp", "seo"]; // gated category scores (0–100)

// base/pr = { tbt, cls, a11y, bp, seo }. Called from selftest with only
// { tbt, cls }: the SCORES deltas become NaN and NaN comparisons are false,
// so score gating is simply inert there.
function verdict(base, pr) {
  const tbtUp = pr.tbt - base.tbt;
  const tbtBad = tbtUp > TBT_ABS && tbtUp > base.tbt * TBT_REL;
  const tbtGood = -tbtUp > TBT_ABS && -tbtUp > base.tbt * TBT_REL;
  const clsUp = pr.cls - base.cls;
  const clsBad = clsUp > CLS_ABS && pr.cls > CLS_FLOOR;
  const clsGood = -clsUp > CLS_ABS && base.cls > CLS_FLOOR;
  const scoreBad = SCORES.some((k) => pr[k] - base[k] <= -SCORE_DROP);
  const scoreGood = !scoreBad && SCORES.some((k) => pr[k] - base[k] >= SCORE_DROP);
  if (tbtBad || clsBad || scoreBad) return { icon: "🔴", gate: true };
  if (tbtGood || clsGood || scoreGood) return { icon: "🟢", gate: false };
  return { icon: "⚪", gate: false };
}

function loadDir(dir) {
  const files = readdirSync(dir).filter((f) => f.startsWith("lhr-") && f.endsWith(".json"));
  const byUrl = {};
  for (const f of files) {
    const lhr = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const url = lhr.finalUrl || lhr.requestedUrl;
    if (!byUrl[url]) byUrl[url] = [];
    byUrl[url].push(lhr);
  }
  const byPath = {};
  for (const [url, runs] of Object.entries(byUrl)) {
    runs.sort((a, b) => a.categories.performance.score - b.categories.performance.score);
    const lhr = runs[Math.floor(runs.length / 2)];
    const a = lhr.audits;
    byPath[new URL(url).pathname] = {
      score: Math.round((lhr.categories.performance?.score ?? 0) * 100),
      a11y: Math.round((lhr.categories.accessibility?.score ?? 0) * 100),
      bp: Math.round((lhr.categories["best-practices"]?.score ?? 0) * 100),
      seo: Math.round((lhr.categories.seo?.score ?? 0) * 100),
      lcp: a["largest-contentful-paint"].numericValue,
      cls: a["cumulative-layout-shift"].numericValue,
      tbt: a["total-blocking-time"].numericValue,
    };
  }
  return byPath;
}

const ms = (v) => \`\${Math.round(v)}ms\`;
const cls = (v) => v.toFixed(3);
const pts = (v) => \`\${Math.round(v)}\`;
function delta(base, pr, fmt) {
  const d = pr - base;
  const arrow = d < 0 ? "↓" : d > 0 ? "↑" : "";
  return \`\${d > 0 ? "+" : ""}\${fmt(d)} \${arrow}\`.trim();
}
// base→PR (Δ) for a 0–100 category score.
const scoreCell = (b, p) => \`\${b}→\${p} (\${delta(b, p, pts)})\`;

function render(base, pr) {
  const paths = [...new Set([...Object.keys(base), ...Object.keys(pr)])].sort();
  let anyGate = false;
  const lines = [
    "### ⚡ Perf — preview do PR × preview do main",
    "",
    "Ambas as previews rodam em \`*.workers.dev\` (sem edge cache), mesmo runner e UA mobile — o delta é efeito do código, não de cache quente/frio.",
    "",
    "**Gate:** CLS + TBT + A11y/BP/SEO (estrutura/JS + auditorias estáticas). LCP e score de performance são informativos (ruído esperado em SSR frio).",
    "",
    "| Página | | CLS (base→PR) | TBT (base→PR) | A11y | BP | SEO | LCP | Score |",
    "|---|:--:|---|---|---|---|---|---|---|",
  ];
  for (const p of paths) {
    const b = base[p];
    const r = pr[p];
    if (!b || !r) {
      lines.push(\`| \\\`\${p}\\\` | ⚠️ | \${b ? "faltou PR" : "faltou base"} | | | | | | |\`);
      continue;
    }
    const v = verdict(b, r);
    anyGate = anyGate || v.gate;
    lines.push(
      \`| \\\`\${p}\\\` | \${v.icon} | \${cls(b.cls)}→\${cls(r.cls)} (\${delta(b.cls, r.cls, cls)}) | \${ms(b.tbt)}→\${ms(r.tbt)} (\${delta(b.tbt, r.tbt, ms)}) | \${scoreCell(b.a11y, r.a11y)} | \${scoreCell(b.bp, r.bp)} | \${scoreCell(b.seo, r.seo)} | \${ms(b.lcp)}→\${ms(r.lcp)} | \${b.score}→\${r.score} |\`,
    );
  }
  lines.push("");
  lines.push(
    anyGate
      ? "🔴 **Regressão detectada em CLS/TBT/A11y/BP/SEO** (advisory — não trava o merge)."
      : "🟢 Sem regressão nas métricas gateadas (CLS/TBT/A11y/BP/SEO).",
  );
  return { md: lines.join("\\n"), anyGate };
}

function selftest() {
  const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); };
  ok(verdict({ tbt: 100, cls: 0.01 }, { tbt: 200, cls: 0.01 }).gate, "tbt +100ms should gate");
  ok(!verdict({ tbt: 100, cls: 0.01 }, { tbt: 130, cls: 0.01 }).gate, "tbt +30ms is noise");
  ok(verdict({ tbt: 100, cls: 0.11 }, { tbt: 100, cls: 0.2 }).gate, "cls 0.11→0.20 should gate");
  ok(!verdict({ tbt: 100, cls: 0.02 }, { tbt: 100, cls: 0.08 }).gate, "cls under 0.1 floor no gate");
  ok(verdict({ tbt: 300, cls: 0.01 }, { tbt: 100, cls: 0.01 }).icon === "🟢", "tbt drop is green");
  ok(verdict({ tbt: 100, cls: 0.01 }, { tbt: 105, cls: 0.01 }).icon === "⚪", "tiny change is neutral");
  // Category-score gating. S() supplies a neutral CLS/TBT baseline plus perfect scores.
  const S = (o) => ({ tbt: 100, cls: 0.01, a11y: 100, bp: 100, seo: 100, ...o });
  ok(verdict(S({}), S({ seo: 96 })).gate, "seo 100→96 (-4) should gate");
  ok(verdict(S({ a11y: 90 }), S({ a11y: 87 })).gate, "a11y -3 should gate");
  ok(!verdict(S({}), S({ bp: 98 })).gate, "bp -2 is jitter, no gate");
  ok(verdict(S({ a11y: 90 }), S({ a11y: 95 })).icon === "🟢", "a11y +5 is green");
  ok(verdict(S({}), S({ a11y: 99, seo: 97 })).icon === "🔴", "seo -3 gates even with a11y -1");
  console.log("compare.mjs selftest: OK");
}

if (process.argv[2] === "--selftest") { selftest(); process.exit(0); }

const [baseDir, prDir] = process.argv.slice(2);
if (!baseDir || !prDir) { console.error("usage: compare.mjs <baseDir> <prDir> | --selftest"); process.exit(2); }
process.stdout.write(render(loadDir(baseDir), loadDir(prDir)).md + "\\n");
`;

const LIGHTHOUSERC_JSON = `{
  "//": "Lighthouse CI config for the per-PR perf workflow (.github/workflows/perf.yml). Mobile UA matches worker-entry.ts buildSegment (MOBILE_RE) so warmup and measurement hit the same device cache key. accessibility/best-practices/seo são análise estática determinística (não sofrem ruído de SSR frio como LCP/score), então compare.mjs os gateia por regressão de score.",
  "ci": {
    "collect": {
      "numberOfRuns": 3,
      "settings": {
        "onlyCategories": ["performance", "accessibility", "best-practices", "seo"],
        "emulatedUserAgent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
      }
    }
  }
}
`;
