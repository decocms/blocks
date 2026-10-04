# Content sync: produção (Fresh/Deno) → repo TanStack

Um site migrado continua com o CMS publicando na loja **legada** por um tempo.
Esse conteúdo precisa chegar no repo novo sem abrir uma porta de escrita nele.

## O que existia antes (e por que sai)

O padrão que rodava nos primeiros pares legado → migrado:

```yaml
# .github/workflows/sync-deco-content.yml, NO REPO LEGADO
on: { push: { branches: [main], paths: ['.deco/**'] } }
- uses: actions/checkout@v4
  with: { repository: <org>/<repo-migrado>, token: ${{ secrets.STOREFRONT_SYNC_TOKEN }} }
- run: rsync -av --delete source/.deco/blocks/ target/.deco/blocks/
- run: git commit -m "sync: .deco content" && git push
```

Problemas, em ordem de gravidade:

1. `STOREFRONT_SYNC_TOKEN` é uma credencial de **escrita no repo novo**, guardada
   no repo legado. Não é um canal de conteúdo: quem tem o token (ou controla o
   legado) commita qualquer arquivo direto na `main` do repo novo — inclusive
   código. É a porta que este documento fecha.
2. Push direto na `main`, sem PR, sem build, sem review — milhares de commits
   de `deco-sync-bot`; se um bloco quebrar o build, quebra em produção.
3. Sem `permissions:` e sem `concurrency:` — o CMS publica em rajada (várias
   vezes por hora), as runs corriam em paralelo.
4. `rsync --delete` espelha tudo, sem filtro: sobrescreve blocos de app do repo
   novo (que é onde a migração coloca as credenciais VTEX) e apaga o que não
   existe upstream.

## O que existe agora

Direção invertida: o repo novo **puxa**. O legado não tem permissão nenhuma.

```
cron diário  →  GET <origin>/.decofile  →  .deco/blocks/*.json  →  guard  →  build  →  PR  →  squash merge
```

- `<origin>/.decofile` é público e sem auth no runtime Deco (numa loja grande
  são alguns MB de JSON). Não há token de leitura para vazar.
- A única credencial em jogo é o `GITHUB_TOKEN` do próprio repo, com
  `contents: write` + `pull-requests: write`, escopo no repo e vida de um job.
- O JSON é grande, então o script materializa **um arquivo por bloco**, no mesmo
  esquema de nome que o runtime espera (`encodeURIComponent(chave).json`), e só
  reescreve o que mudou de fato — o diff do PR mostra as páginas/loaders/seções
  alteradas, não um blob de 3 MB.
- "Mudou de fato" é comparação **semântica**, não de bytes: os escritores de
  `.deco/blocks` discordam de formatação (o daemon do Studio e o bot antigo
  minificam; um PR de sync feito à mão vem pretty) e de ordem de chave. Sem isso,
  a primeira run numa loja real acusava 124 de 432 blocos alterados — sendo 10 de
  conteúdo real e 114 de formatação. Arquivos com conteúdo igual não são tocados;
  os que mudaram são gravados pretty-printed, para o diff ser legível.

Peças: `packages/blocks-cli/scripts/sync-blocks-bot.ts` (bin
`deco-sync-blocks-bot`) e o template
`packages/blocks-cli/scripts/migrate/templates/sync-blocks-bot-yml.ts`, que o
`migrate` escreve em `.github/workflows/sync-blocks-bot.yml`.

## Setup num site (3 passos)

1. Ter o workflow: sites migrados a partir de agora já vêm com
   `.github/workflows/sync-blocks-bot.yml`. Num site que já existe, copie o arquivo
   gerado pelo template. Se o site ainda está numa versão antiga de `@decocms/*`,
   gere com `generateSyncBlocksBotYml(bun, "<versão>")`: o passo de pull roda via
   `bunx -y @decocms/blocks-cli@<versão>`, sem bumpar a runtime contra a qual o
   site builda (o `blocks-cli` pina `@decocms/blocks` em versão exata, então
   bumpar o devDep arrastaria uma segunda runtime para a árvore). Tire o pin
   quando o site subir de versão.
2. Definir a **variável de repo** `SYNC_BLOCKS_ORIGIN` com o origin da loja de
   produção (ex.: `https://www.minhaloja.com.br`). Sem ela o job pula limpo —
   o workflow é inerte até alguém ligar, igual ao `PARITY_PROD_URL` do
   `parity.yml`. Confirme antes que `GET <origin>/.decofile` devolve `200` com
   `content-type: application/json` (alguns hosts respondem `301`; use o host
   final).
3. Rodar `workflow_dispatch` com `dry_run = true` e ler o relatório: quantos
   blocos vieram, quantos seriam adicionados/atualizados/removidos, e quais
   foram negados. Só então deixe o cron rodar.

**No repo legado, apague o `sync-deco-content.yml` e revogue o
`STOREFRONT_SYNC_TOKEN`.** O pull não fecha aquela porta sozinho — enquanto o
token existir, a porta continua aberta.

## O que a sync pode e não pode sobrescrever

Três filtros, nessa ordem:

1. **`--deny <globs>`** — chaves de bloco que nunca são tocadas. Default:
   `Site,site` (SEO/config do site, que costuma divergir de propósito entre a
   loja antiga e a nova). O workflow expõe isso como `DENY_KEYS` no `env`.
2. **Blocos com secret encriptado** — qualquer bloco que carregue um ref
   `{name, encrypted}` em qualquer profundidade é preservado, não sobrescrito,
   e também **não é apagado pelo `--prune`**. É o filtro que protege as
   credenciais que a migração move para o bloco de app do site novo (ex.:
   `deco-vtex`), que não existem com esse layout em produção — sobrescrever ali
   é como um site migrado volta a dar 403 anônimo na VTEX. Desliga com
   `--allow-secret-blocks`.
3. **`--fail-on-plaintext-secret`** (ligado no workflow) — se um bloco aceito
   tiver o que parece ser credencial em texto claro (prop `apiKey`/`appToken`/
   `secret`/`password`… com string crua, em vez do ref encriptado), o job aborta
   em vez de commitar isso no git. Um `key` sozinho **não** conta: conteúdo de
   CMS é cheio de `key` que não é credencial (`selectedFacets[].key` em todo
   loader de PLP VTEX deu 331 falsos positivos numa loja real), e um
   gate que grita à toa é um gate que alguém desliga.

`--prune` (ligado por default) apaga blocos que não existem mais upstream,
respeitando (1) e (2).

## Os dois detalhes não óbvios do workflow

- **O build roda no próprio job, antes do PR.** PR aberto com `GITHUB_TOKEN` não
  dispara workflows de `pull_request`: gatear no CI do PR exigiria um PAT e, sem
  ele, o check nunca rodaria e o auto-merge nunca aconteceria. Então o gate
  (`bun run generate && bun run build`) roda antes de o PR existir; o merge
  automático só acontece depois dele passar. Para revisão humana, mude
  `AUTO_MERGE` para `"false"`; se a branch protection exigir review, o merge
  falha e o PR fica aberto — está logado como `::notice::`.
- **Guard de caminho.** Antes do build, o job falha se qualquer arquivo fora de
  `.deco/blocks/` tiver mudado, e o commit é `git add .deco/blocks` — não
  `git add .deco/`. Conteúdo entra por esse canal; código, não.

## Colisão de nome de arquivo (repos que vieram do bot antigo)

O `deco-sync-bot` escrevia nomes duplo-encodados (`pages-A%2520B.json`) enquanto
a sync manual escrevia single (`pages-A%20B.json`) — os dois decodificam para a
mesma chave. O script indexa o que já está em disco pela chave totalmente
decodificada e:

- **um** arquivo existente → reescreve ele mesmo, sem renomear (diff mínimo);
- **vários** → converge no nome canônico single-encoded e apaga os outros. Não é
  cosmético: `pickWinner` no `generate-blocks` prefere o nome **mais** encodado,
  então um duplicado velho deixado para trás ganharia o build.

Ver `packages/blocks-cli/scripts/lib/blocks-dedupe.ts` para o histórico completo.

## Fora de escopo (por enquanto)

Um cron no Cloudflare Worker escrevendo o snapshot direto no KV (fast-deploy)
seria ainda mais estanque — o conteúdo nunca tocaria o repo, então nem em teoria
haveria caminho para código. Em troca, o git deixa de ser a fonte da verdade do
conteúdo. `scripts/sync-blocks-to-kv.ts` já faz a metade de baixo disso se um dia
valer a pena (ver [`fast-deploy.md`](./fast-deploy.md)).
