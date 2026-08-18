/**
 * Scaffolds `.github/workflows/parity.yml` — validates the migrated storefront
 * against the ORIGINAL live site on every PR, using `@decocms/parity`.
 *
 * Why day-one: a fresh migration is exactly when parity earns its keep — it
 * catches the sections/SEO/journey steps that silently didn't survive the
 * VTEX IO → blocks port, comparing the PR preview against the source of truth
 * (the still-live original storefront).
 *
 * Shape (mirrors perf.yml):
 *   - Advisory (`continue-on-error: true`) so day-one CI is green; comments,
 *     never blocks. Flip to a gate by removing continue-on-error once stable.
 *   - cand = the CF Workers Builds preview URL, discovered by polling the
 *     check-run output (same block as perf.yml — no CF token, no local build).
 *   - prod = repo variable `PARITY_PROD_URL` (the original storefront). The one
 *     calibration knob the operator sets once; the job SKIPS cleanly if unset,
 *     so the workflow is inert until wired.
 *   - Runs `parity journey` (the tightest loop: purchase journey only, JUnit +
 *     GitHub annotations, no LLM aggregation). ANTHROPIC_API_KEY is an OPTIONAL
 *     secret — parity runs without it (issues severity-sorted, not LLM-ranked).
 *
 * Docs: https://docs.decocms.com/v2/en/parity/ci
 *
 * @param workerName  Cloudflare Worker name (= wrangler `name`, e.g. "loja-tanstack").
 *                    Used to match the "Workers Builds: <name>" check run.
 */
export function generateParityYml(workerName: string): string {
  return `name: Parity

# Valida a loja migrada contra a loja ORIGINAL (source of truth) a cada PR, com
# @decocms/parity. Advisory (comenta, não trava) — vire gate removendo o
# \`continue-on-error\` do job quando estabilizar, igual perf/react-doctor.
#
# Requer a variável de repo \`PARITY_PROD_URL\` = URL da loja original (ex.:
# https://www.minhaloja.com.br). Sem ela, o job pula limpo. \`ANTHROPIC_API_KEY\`
# é secret OPCIONAL (ranqueia issues com IA; parity roda sem ele).
#
# cand = preview URL do CF Workers Builds (mesmo polling do perf.yml).

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write
  checks: read

concurrency:
  group: parity-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  parity:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      # Pula tudo se a URL da loja original não foi configurada.
      - id: guard
        name: Checar PARITY_PROD_URL
        env:
          PROD_URL: \${{ vars.PARITY_PROD_URL }}
        run: |
          if [ -z "$PROD_URL" ]; then
            echo "PARITY_PROD_URL não configurada — pulando parity." >> "$GITHUB_STEP_SUMMARY"
            echo "Configure em Settings → Variables → Actions para ativar." >> "$GITHUB_STEP_SUMMARY"
            echo "run=false" >> "$GITHUB_OUTPUT"
          else
            echo "run=true" >> "$GITHUB_OUTPUT"
          fi

      # Aguarda o CF Workers Builds completar e extrai a preview URL do output.
      # Timeout: 10 min (builds normalmente terminam em ~3 min).
      - id: cf
        name: Aguardar CF build e extrair preview URL
        if: steps.guard.outputs.run == 'true'
        env:
          GH_TOKEN: \${{ github.token }}
          SHA: \${{ github.event.pull_request.head.sha }}
        run: |
          echo "Aguardando CF Workers Builds para $SHA..."
          for i in $(seq 1 60); do
            summary=$(gh api \\
              "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs" \\
              --jq '.check_runs[] | select(.name == "Workers Builds: ${workerName}") | .output.summary' \\
              2>/dev/null || true)

            if [ -n "$summary" ]; then
              conclusion=$(gh api \\
                "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs" \\
                --jq '.check_runs[] | select(.name == "Workers Builds: ${workerName}") | .conclusion' \\
                2>/dev/null || true)

              if [ "$conclusion" = "success" ]; then
                url=$(printf '%s' "$summary" | grep -oP '(?<=Preview URL: )https://\\S+' | head -1)
                if [ -n "$url" ]; then
                  echo "url=$url" >> "$GITHUB_OUTPUT"
                  echo "run=true"  >> "$GITHUB_OUTPUT"
                  echo "CF build OK — preview: $url"
                  exit 0
                fi
              elif [ -n "$conclusion" ] && [ "$conclusion" != "null" ]; then
                echo "CF build concluiu com: $conclusion — pulando parity"
                echo "run=false" >> "$GITHUB_OUTPUT"
                exit 0
              fi
            fi

            echo "Tentativa $i/60 — aguardando 10s..."
            sleep 10
          done

          echo "Timeout aguardando CF build — pulando parity"
          echo "run=false" >> "$GITHUB_OUTPUT"

      - uses: oven-sh/setup-bun@v2
        if: steps.cf.outputs.run == 'true'
        with:
          bun-version: "1.3.5"

      # parity journey dirige um browser real — precisa do binário do chromium.
      - name: Instalar chromium
        if: steps.cf.outputs.run == 'true'
        run: bunx playwright install --with-deps chromium

      - name: Rodar parity journey (prod × preview)
        if: steps.cf.outputs.run == 'true'
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          bunx @decocms/parity journey \\
            --prod "\${{ vars.PARITY_PROD_URL }}" \\
            --cand "\${{ steps.cf.outputs.url }}" \\
            --junit parity-results.xml \\
            --github
`;
}
