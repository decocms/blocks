/**
 * Scaffolds `.github/workflows/content-sync.yml` — the secure content channel
 * from the still-live Fresh/Deno storefront into the migrated repo.
 *
 * Replaces the legacy push-based sync (a workflow in the *legacy* repo holding a
 * cross-repo PAT, `rsync --delete` + `git push` straight into this repo's main).
 * That token is a code-write door, not a content channel: whoever controls the
 * legacy repo or the token can land arbitrary files here, unreviewed.
 *
 * Direction is inverted — this repo pulls, on its own schedule, with its own
 * `GITHUB_TOKEN`, and gates the result:
 *   - `pull-decofile.ts` fetches `<origin>/.decofile` (public, unauthenticated)
 *     and writes `.deco/blocks/`, denying the `Site` block and anything holding
 *     encrypted credentials, and aborting on a plaintext credential;
 *   - a path guard fails the run if anything outside `.deco/blocks/` changed;
 *   - `bun run generate && bun run build` runs IN THIS JOB, before the PR. It
 *     has to be here: a PR opened with `GITHUB_TOKEN` does not trigger
 *     `pull_request` workflows, so gating on the PR's own CI would need a PAT
 *     and would never fire on its own.
 *
 * Inert until the operator sets the repo variable `CONTENT_SYNC_ORIGIN` (same
 * one-knob pattern as parity.yml's `PARITY_PROD_URL`) — the job skips cleanly.
 *
 * Docs: docs/content-sync.md
 *
 * @param bunVersion  Pinned bun version, in lockstep with package.json.
 */
export function generateContentSyncYml(bunVersion: string): string {
  const bun = bunVersion.replace(/^bun@/, "");
  return `name: content-sync

# Puxa o conteúdo publicado na loja de produção (Fresh/Deno) para \`.deco/blocks\`
# e abre um PR. Sem token cross-repo: o repo legado não tem permissão nenhuma
# aqui — este repo busca sozinho, valida e só então mergeia.
#
# Configuração (uma vez): variável de repo \`CONTENT_SYNC_ORIGIN\` = origin da
# loja de produção (ex.: https://www.minhaloja.com.br). Sem ela o job pula limpo.
# Para revisão humana em vez de merge automático, mude \`AUTO_MERGE\` para "false".
#
# Depois de ligar isto, APAGUE o workflow de push no repo legado e REVOGUE o
# token cross-repo — o pull não fecha aquela porta sozinho. Ver docs/content-sync.md.

on:
  schedule:
    # 06:00 UTC = 03:00 BRT, fora do horário de publicação do CMS.
    - cron: "0 6 * * *"
  workflow_dispatch:
    inputs:
      origin:
        description: "Origin da loja de produção (sobrepõe CONTENT_SYNC_ORIGIN)"
        required: false
      prune:
        description: "Apagar blocos que não existem mais em produção"
        type: boolean
        default: true
      dry_run:
        description: "Só relatório, não escreve nem abre PR"
        type: boolean
        default: false

permissions:
  contents: write
  pull-requests: write

# Publicações do CMS acontecem em rajada; uma sync por vez, sem cancelar a que
# já está no gate de build.
concurrency:
  group: content-sync
  cancel-in-progress: false

env:
  BUN_VERSION: "${bun}"
  AUTO_MERGE: "true"
  # Chaves de bloco que a sync NUNCA sobrescreve. Blocos com secret encriptado
  # já são protegidos por shape pelo script (as credenciais deste repo vivem no
  # bloco de app dele, que não existe nesse layout em produção).
  DENY_KEYS: "Site,site"

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Resolve origin
        id: cfg
        env:
          INPUT_ORIGIN: \${{ github.event.inputs.origin }}
          VAR_ORIGIN: \${{ vars.CONTENT_SYNC_ORIGIN }}
        run: |
          origin="\${INPUT_ORIGIN:-$VAR_ORIGIN}"
          if [ -z "$origin" ]; then
            echo "::notice::variável de repo CONTENT_SYNC_ORIGIN não configurada — content-sync inerte."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          else
            echo "origin=$origin" >> "$GITHUB_OUTPUT"
          fi

      - uses: actions/checkout@v4
        if: steps.cfg.outputs.skip != 'true'

      - uses: oven-sh/setup-bun@v2
        if: steps.cfg.outputs.skip != 'true'
        with:
          bun-version: \${{ env.BUN_VERSION }}

      - name: Install
        if: steps.cfg.outputs.skip != 'true'
        run: bun install --frozen-lockfile

      - name: Pull decofile de produção
        if: steps.cfg.outputs.skip != 'true'
        env:
          ORIGIN: \${{ steps.cfg.outputs.origin }}
          PRUNE: \${{ github.event.inputs.prune == 'false' && ' ' || '--prune' }}
          DRY_RUN: \${{ github.event.inputs.dry_run == 'true' && '--dry-run' || ' ' }}
        run: |
          bunx tsx node_modules/@decocms/blocks-cli/scripts/pull-decofile.ts \\
            --origin "$ORIGIN" \\
            --out .deco/blocks \\
            --deny "$DENY_KEYS" \\
            --fail-on-plaintext-secret \\
            --github $PRUNE $DRY_RUN

      - name: Guard — só .deco/blocks pode mudar
        id: guard
        if: steps.cfg.outputs.skip != 'true' && github.event.inputs.dry_run != 'true'
        run: |
          {
            git -c core.quotepath=false diff --name-only HEAD
            git -c core.quotepath=false ls-files --others --exclude-standard
          } | sort -u > /tmp/content-sync-changed.txt
          offending="$(grep -v '^\\.deco/blocks/' /tmp/content-sync-changed.txt || true)"
          if [ -n "$offending" ]; then
            echo "::error::a sync mexeu fora de .deco/blocks — abortando:"
            echo "$offending"
            exit 1
          fi
          if [ ! -s /tmp/content-sync-changed.txt ]; then
            echo "::notice::conteúdo já está em dia, nada a sincronizar."
            echo "changed=false" >> "$GITHUB_OUTPUT"
          else
            echo "changed=true" >> "$GITHUB_OUTPUT"
            echo "$(wc -l < /tmp/content-sync-changed.txt) arquivo(s) de bloco alterado(s)"
          fi

      # Gate de verdade. Roda AQUI porque PR aberto com GITHUB_TOKEN não dispara
      # o workflow de \`pull_request\` — gatear no CI do PR exigiria um PAT.
      - name: Validar (generate + build)
        if: steps.guard.outputs.changed == 'true'
        run: bun run generate && bun run build

      - name: Abrir PR (e mergear se AUTO_MERGE)
        if: steps.guard.outputs.changed == 'true'
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          ORIGIN: \${{ steps.cfg.outputs.origin }}
        run: |
          branch="content-sync/$(date -u +%Y-%m-%dT%H%M%SZ)"
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git checkout -b "$branch"
          git add .deco/blocks
          git commit -m "chore(content): sync .deco/blocks de $ORIGIN"
          git push origin "$branch"
          url="$(gh pr create \\
            --title "chore(content): sync .deco/blocks de produção" \\
            --body "Conteúdo puxado de \\\`$ORIGIN/.decofile\\\` pelo workflow \\\`content-sync\\\`. Só \\\`.deco/blocks/**\\\` mudou (guard) e \\\`generate + build\\\` passou antes deste PR existir." \\
            --head "$branch")"
          echo "PR: $url"
          if [ "$AUTO_MERGE" = "true" ]; then
            gh pr merge "$url" --squash --delete-branch || \\
              echo "::notice::merge automático bloqueado (branch protection?) — PR aberto para revisão: $url"
          fi
`;
}
