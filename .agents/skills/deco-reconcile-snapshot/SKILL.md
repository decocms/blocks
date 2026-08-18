---
name: deco-reconcile-snapshot
description: Reconcile a migrated TanStack repo against upstream changes that landed on the Fresh/Deno source repo after the migration cut. Runs `deco-reconcile` to produce one diff per changed file, then ports each one by hand — a rebase, not a re-migration. Use when a migration has been running for weeks and the source repo kept moving, or when the user says "reconcile", "trazer as mudanças de origem", "o Deno mudou desde o corte", "snapshot diff", or "sincronizar com a origem".
---

# Reconciliação de snapshot

Você reconcilia um repositório migrado contra novas mudanças do repositório de origem.

Entre o commit de corte e hoje, duas coisas aconteceram em paralelo: o time de
origem continuou desenvolvendo, e o time de migração corrigiu à mão o que o
codemod cuspiu errado. Seu trabalho é trazer a primeira sem destruir a segunda.

É um **rebase**, não uma re-migração. Rodar o codemod sobre a árvore inteira é
sempre a resposta errada: sobrescreve correção manual e reintroduz defeito já
consertado.

## Passo 0 — gerar o insumo

```bash
npx -p @decocms/blocks-cli deco-reconcile \
  --source <clone Fresh/Deno> --target <clone TanStack> \
  --snapshot <SHA do corte> --verbose
```

Um hash só. `--target-snapshot` é opcional: por padrão o script acha o commit de
migração pelo `MIGRATION_REPORT.md` que o `deco-migrate` deixou, e imprime qual
escolheu. Passe explícito se a migração veio por squash ou rebase e o marcador
não bater — tudo depois desse commit conta como correção manual, então valor
errado esvazia a lista de colisão em silêncio.

Saída em `<target>/.reconcile/<sourceHead:7>/`:

- `manifest.json` — a lista de trabalho **e** o estado de retomada
- `INDEX.md` — a mesma tabela, para humano
- `patches/NNN-<slug>.patch` — um diff por arquivo

O script não escreve nada no alvo e não emite julgamento. `targetCandidates` é
palpite (basename + convenção), não mapeamento — confirme.

Se `--snapshot` não for conhecido: é o `SOURCE_HEAD` do relatório da rodada
anterior. Primeira rodada, é o commit de origem em que a migração foi feita.

## O loop

Um arquivo por vez, na ordem do manifest. Delegue um subagente por arquivo — o
patch, os candidatos e o log de colisão cabem num prompt. Ao terminar um arquivo,
marque `done: true` no `manifest.json`; é assim que a sessão retoma.

**Gate, antes de aplicar qualquer coisa:** conte as entradas com
`collision.length > 0`. Se passar do que cabe em revisão humana numa sentada,
**pare e reporte**. Reconciliação grande demais para revisar é sinal de que falta
data de convergência combinada com o cliente — é conversa, não problema para
resolver aqui.

Para cada arquivo, na ordem:

**1. Onde ele cai no alvo?** O layout mudou na migração. Confira os
`targetCandidates` contra a árvore do alvo; se não bater, descubra o mapeamento
comparando o commit do snapshot com o commit de migração do alvo — não presuma convenção.
Lista vazia normalmente é arquivo novo: migre inteiro.

**2. Alguém já mexeu nele?** `collision` já responde (`git log` do alvo, do commit
de migração para cá). Vazio, o caminho é livre. Não-vazio, você está numa colisão
e precisa entender por quê antes de aplicar qualquer linha.

**3. Traduza.** Nenhuma linha da stack antiga chega crua ao alvo.

**4. Aplique.** Em colisão, hunk a hunk.

## Aprenda as regras de tradução antes de usá-las

Não parta de lista decorada. Compare o commit de corte com o commit de migração
do alvo: o par mostra como **este projeto** converteu cada idioma. Extraia as
regras de lá e declare-as no relatório antes de aplicar.

Classes que costumam aparecer — confirme cada uma no par antes de assumir:

- reatividade e estado compartilhado, incluindo se ler valor no render ainda inscreve o componente
- efeito colateral em fase de render, legal na stack antiga e ilegal na nova
- `key` no elemento retornado por `.map()`
- detecção de browser, tipos de framework, imports de CDN, APIs de runtime
- o salto de versão do Tailwind: utilitários removidos, configuração que virou CSS-first
- APIs do framework antigo que viraram no-op no novo — modo de falha silencioso, então procure as que o alvo já reescreveu e trate igual

Referência das regras já catalogadas: `.agents/skills/deco-to-tanstack-migration/`
(`references/gotchas.md` e o índice de learnings). Use como pista, não como
verdade — o par de commits deste projeto manda.

## Colisão

É onde você gasta o tempo. Para cada hunk, responda antes de aplicar:

> A correção local existe por causa da stack nova, ou por causa de um defeito que
> a mudança upstream já resolve?

Primeiro caso, a correção manda. Segundo, a mudança upstream manda. Leia a
mensagem do commit que corrigiu — ela vem no `collision` justamente porque
costuma dizer qual dos dois é.

## Verifique a tradução, não confie nela

Codemod já apagou tokens de seletor CSS em migração anterior: 40 fragmentos, uma
única palavra sumindo de `#id`, `label[for=""]` e combinadores, gerando regra
inválida que derrubava a declaração inteira. Ninguém tinha tocado no arquivo desde
a migração e o defeito sobreviveu semanas.

Depois de aplicar, varra o que entrou procurando id ou classe começando com
hífen, atributo com valor vazio, combinador sem alvo, classe vazia, seletor que
não casa com nada.

Rode a verificação do alvo — typecheck, testes, build.

## Regras que não se negociam

**Paridade é o critério de aceite.** Se a mudança upstream traz um bug, ele é
portado como está. Corrigir é decisão do dono do produto. Vale inclusive para bug
que você tem certeza de que é bug.

**Migração não é refatoração.** Código que parece morto é migrado. Provar que está
morto custa análise, aprovação e risco; migrar custa perto de zero. Única exceção:
o que impede compilar — e aí a resposta é fazer compilar, não remover.

**Conteúdo de CMS não entra aqui.** Blocos publicados chegam por sincronização
própria (o `deco-reconcile` já filtra `.deco/`). Arquivo removido upstream que é
referenciado por bloco: não remova, sinalize.

**Não invente escopo.** Você aplica o que mudou entre os dois commits. Melhoria
que você enxergar vira nota, não commit.

## Saída

Relatório, antes de qualquer commit:

1. `SOURCE_HEAD` — vira o `--snapshot` da próxima rodada
2. As regras de tradução que você extraiu do par de commits
3. Arquivos aplicados sem colisão: origem → alvo → regras usadas
4. **Uma seção por colisão**: hunk upstream, correção local, qual prevaleceu, por quê
5. O que exige decisão humana — arquivo removido com referência de CMS, mudança que depende de endpoint novo, conflito que você não resolveu com confiança
6. Verificações rodadas e resultado

Nunca dê push no remoto do alvo sem confirmação explícita do usuário.
