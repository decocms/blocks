# Migration Known Issues — histórico acumulado

Checklist cumulativo de problemas já enfrentados em migrações Fresh/Deno → TanStack Start
(e na migração de pacote `@decocms/start` → split 7.x). Use como validação ao migrar cada
nova loja: percorra as categorias e confirme que cada sintoma **não** ocorre na loja migrada.

Ao encontrar um problema novo numa migração futura, adicione-o aqui (não em memória solta,
não só num PR) — este arquivo é a fonte única de verdade para "já vimos isso antes".

---

## 1. Async / SSR / Hidratação

| Sintoma | Causa raiz | Onde está documentado | Como validar na próxima loja |
|---|---|---|---|
| `"J is not a function"` seguido de React #419 (falha de hidratação) → React #130 (página inteira não-interativa) | `@tanstack/store@0.9.x` `subscribe()` retorna `{unsubscribe}`, não uma função; `useSyncExternalStore` espera fn bare | `.agents/skills/deco-to-tanstack-migration/references/react-signals-state.md:13-33` | Rodar a home e uma PDP no console do browser, procurar esses erros específicos |
| Badge do carrinho/drawer não atualiza sozinho | Shim de signal não dispara re-render do React — leitura `.value` sem subscription real | mesmo arquivo, linhas 36-72 | Adicionar item ao carrinho e ver se o badge muda sem F5 |
| Banner de cookie-consent morto, `ctx.device` undefined em vários pontos | Loaders de seção com assinatura antiga `(props, req, ctx)` recebem `ctx===undefined` silenciosamente; `runSingleSectionLoaderImpl` engole o crash | `.agents/skills/deco-to-tanstack-migration/references/async-rendering.md:688-722` | Grep por loaders com 3 argumentos posicionais; testar todo componente que lê `ctx.device`/`ctx.cookies` |
| Mesmo bug do item acima reaparecendo com outro nome de seção | Chave de registro no CMS ≠ path do arquivo, ao "adivinhar" a chave | `.../async-rendering.md:726-741` | Conferir que toda chave em `registerSectionLoaders` bate com o resolveType do decofile |
| Branch de render inteiro sumindo sem erro | Guard `typeof Component === "function"` sempre falso — `Section.Component` resolvido é string, nunca função | `.../async-rendering.md:744-769` | Grep por `typeof .* === "function"` em volta de `Component`/seções resolvidas |
| Cookie-consent, cookie de analytics ou redirect de campanha não fazem efeito | Loaders de seção não têm como mutar a resposta: `responseHeaders` nunca é copiado pro response de SSR; `redirect()` é stub que sempre lança | `.../async-rendering.md:772-788` | Testar qualquer loader que precise setar cookie ou redirecionar a partir de uma seção |
| CLS de 0 para 1.34 na transição skeleton→resolvido de seção deferida | `DeferredSectionWrapper` força remount completo | `.../hydration-fixes.md:609-677` (fix em `decocms/blocks#448`) — fix sozinho não basta se há uma segunda seção deferida na página | Medir CLS com 2+ seções deferidas na mesma página, não só uma |
| Fix acima não funciona mesmo com `SectionErrorBoundary` | `LoadingFallback` passado como wrapper function, não alias literal do componente real | `.../hydration-fixes.md:681-705` | Conferir que `LoadingFallback` é `export const LoadingFallback = Real`, não uma função wrapper |
| Busca/login do header param de funcionar | `addEventListener` nativo + `stopPropagation()` mata todo `onClick` React downstream (ex: snippet de analytics) | `.../hydration-fixes.md:709-740` | Testar clique em busca/login após qualquer script de tracking ser injetado |
| Checkbox/toggle não muda de estado ao clicar | `checked={...}` controlado sem `onChange` — React reafirma o valor toda render | `.../hydration-fixes.md:744-765` (recorreu 3x numa mesma migração) | Testar todo input controlado sem handler de mudança |
| Chamada VTEX direto do browser dá CORS | Compilador do `createServerFn` só remove o corpo do handler para `const` de topo — envolver em factory (`createInvokeFn`) faz o "fast path" pular a árvore e vazar o handler cru pro client | `.cursor/skills/deco-server-functions-invoke/problem.md:15-99` | Garantir que todo `createServerFn` é declarado top-level, nunca dentro de uma função fábrica |
| Ações de carrinho perdem sessão, usuário cai em `/checkout` com carrinho vazio | `Headers.entries()` colapsa múltiplos `Set-Cookie` num único header comma-joined, que o browser descarta | `packages/blocks-admin/src/admin/invoke.test.ts:1-15`, `.cursor/skills/deco-server-functions-invoke/troubleshooting.md:1-24` (fix: `getSetCookie()` + `forwardCtxHeadersTo()`/`forwardResponseCookies()`) | Inspecionar headers de resposta de toda action de carrinho — deve haver `Set-Cookie` múltiplo, não um só concatenado |

## 2. Cache

| Sintoma | Causa raiz | Onde está documentado | Como validar |
|---|---|---|---|
| Segmento de dispositivo errado servido do edge cache ocasionalmente | Revalidação em background pode perder o User-Agent da request que disparou (hipótese líder, não 100% confirmada) | `.agents/skills/deco-to-tanstack-migration/references/worker-cloudflare.md:353-369` | Repetir requests mobile/desktop concorrentes contra a mesma URL logo após expirar o cache |
| Uma variante de página é servida para todos os dispositivos/geos | `registerCacheableSections()` não inclui contexto de request na cache key — mesma classe de bug do `layoutCacheRace` histórico, tier diferente | `.../worker-cloudflare.md:373-388` | Nunca registrar uma seção via `withDevice`/`withMobile` E `registerCacheableSections()` ao mesmo tempo |
| Header `Cache-Control` custom não aplica em `/assets/*` | Cloudflare Workers Static Assets serve o path direto da camada CF antes do `fetch()` do Worker rodar | `.../worker-cloudflare.md:332-350` | Fix deve ir em `public/_headers`, não em código; conferir headers reais de resposta pra assets estáticos |
| Redirects/blocks não refletem atualização recente do KV | Consumidor de `loadBlocks()` em module scope (ex: `loadRedirects(loadBlocks())`) lê só o snapshot bundlado, antes da hidratação do KV | `docs/fast-deploy.md` (seção "Known limitations") | Nunca chamar `loadBlocks()` fora do request scope quando fast-deploy está ativo |
| Header/footer de um request vazando pra outro | Cache de layout compartilhado mutado in-place (`.index`) | `packages/blocks/src/cms/layoutCacheRace.test.ts` (histórico: shipped em `@decocms/start@6.12.1`, rollback em produção, corrigido em 6.12.2) | Não relaxar esse teste se ele falhar — é o invariante que já quebrou produção uma vez (ver CLAUDE.md) |

## 3. Split de pacote `@decocms/start` → 7.x

| Sintoma | Causa raiz | Onde está documentado | Como validar |
|---|---|---|---|
| Loaders de um vendor específico ficam pendurados sem erro | `autoconfigApps`/registry agregado 6.x não tem equivalente em 7.x; falta entry de vendor no registro | `.agents/skills/decocms-v6-to-v7-upgrade/SKILL.md:92` | Conferir manualmente que todo vendor usado no site está no registry 7.x |
| PDP funciona em `bun run dev` mas dá "Page not found" em preview/produção | `module: () => import(...)` dinâmico falha só no bundle de produção/workerd; `catch {}` engole o erro | mesmo arquivo, linha 92 | Sempre testar `bun run preview`/build de produção, nunca confiar só no dev server |
| Toda rota admin dá 500 (`"Route cannot have both an 'id' and a 'path' option"`) após HMR | Route-config compartilhado por referência sendo mutado pelo `update()` do router-core | linha 72 | Rodar HMR várias vezes em dev nas rotas admin antes de considerar estável |
| Build de produção falha ao importar `cookiePassthrough` | Shim local importa `@tanstack/react-start/server` em module scope, alcançável por bundle client | linha 94 | Grep por imports de `/server` em arquivos client-bundláveis |
| PDP/PLP "no product" mesmo com conteúdo idêntico ao 6.x | Decofile Fresh referencia loader com `.ts`, manifesto 7.x registra sem extensão — lookup exato falha | linha 99 (fix em `@decocms/blocks@7.11.2`, fallback sem extensão) | Sites que usam `autoconfigApps` são os mais expostos — testar decofiles antigos literalmente, não recriados |
| `/_serverFn/` retorna 500 | `src/server/invoke.gen.ts` movido para `.deco/` — client stub gera ok, metade servidor quebra | linha 84 | Não mover esse arquivo específico de posição sem testar o round-trip client→server |
| Deploy "parece" ter ido pro 7.x mas continua rodando 6.x | `package-lock.json` obsoleto ainda pinado em `@decocms/start@6.x`/`@decocms/apps@5.x`; `npm ci` resolve o antigo | linha 61 | Sempre deletar/regenerar o lockfile e conferir versões instaladas pós-CI, não só o PR mergeado |
| `generate:invoke` falha resolvendo apps-dir (pré-7.7 apenas) | `@decocms/apps-vtex` aninha sources sob `src/`; versão antiga só olhava a raiz do pacote | linha 96 | Confirmar versão `@decocms/blocks-cli` ≥ 7.7 antes de rodar generate |
| Typecheck falha em `neverDefer` (pré-7.7 apenas) | Interface `SectionMetaEntry` gerada não declarava `neverDefer`; toda regeneração apagava patch manual | linha 97 | Mesma verificação de versão acima |
| Import quebrado de `useHydrated` | Removido sem substituto — importar direto de `@tanstack/react-router` | linha 93 | Grep por `useHydrated` de `@decocms/*` |
| Diffs de ~400k linhas ao trocar path de codegen | `src/server/{cms,admin}` → `.deco/` — sites no meio da migração ainda importam o path antigo | `.agents/skills/deco-to-tanstack-migration/references/admin-cms.md:156-176` | Rodar generate uma vez e verificar diff antes de commitar em massa |
| `node:async_hooks` alcançável de bundle client via barrel `cms` completo | Import do barrel inteiro em vez de `@decocms/blocks/cms/client` | `packages/blocks/src/cms/client.browserBundle.test.ts:22-29` | Rodar o teste real de bundle esbuild-browser-target, não só `tsc` |
| Módulo de loader/action de site vira chunk público baixável (incl. credencial hardcoded encontrada 2x) | Vite plugin não estuba `.deco/loaders.gen.ts`/`.deco/actions.gen.ts` no client sem o hook `load()` correto | `packages/tanstack/src/vite/plugin.test.ts:4-16`, `.../worker-cloudflare.md:391-407` | Inspecionar o bundle de produção final por strings de credencial/OAuth secret |

## 4. Build/tooling do script de migração

| Sintoma | Causa raiz | Onde está documentado | Como validar |
|---|---|---|---|
| Erro TS5097 só aparece no Phase 8 (compile), não nas fases anteriores | Rewriter de import deixou extensão `.ts` nos imports | `.agents/skills/deco-migrate-script/SKILL.md:412`, `MIGRATION_TOOLING_PLAN.md` | Sempre rodar `tsc --noEmit` completo pós-bootstrap, não confiar só no `phase-verify` |
| Site precisa de workaround próprio de SEO pós-migração | Bug em `buildPageSeo` de `cmsRoute.ts` | `MIGRATION_TOOLING_PLAN.md:399,409` | Conferir que o site não recriou `applySeoTemplatesFromSiteBlock` como gambiarra |
| Cookies de sessão/segmento/IS silenciosamente não funcionam pós-migração | `rewriteVtexUtilImports` reescreveu imports VTEX corretos para stubs `~/lib/vtex-*` que retornam `{}`/`null`/identity | `MIGRATION_TOOLING_PLAN.md:657-658` | Grep por `~/lib/vtex-*` no site migrado; confirmar que aponta pro pacote real, não pro stub |
| `--dry-run` deixa `src/lib/` vazio no disco | `mkdirSync` roda antes do skip do dry-run | `MIGRATION_TOOLING_PLAN.md:705,716` | Rodar dry-run em pasta limpa e conferir que nada foi criado |
| Regressão silenciosa em cookie de segmento/IS/auth que passa no typecheck | Stubs de migração retornam `{}`/`null`/identity-cast em vez de lançar erro | `.cursor/rules/migration-tooling-policy.mdc:49-60`, `deco-migrate-script/SKILL.md` §"post-migration-cleanup.md" §5 | Stubs de transição devem **lançar** em runtime, nunca fazer no-op silencioso — grep por stubs remanescentes antes de ir a produção |
| Hooks reinventados localmente (`useOffer`, `useSuggestions`, `clx`, matcher de `location`) | Reimplementação site-local de ~50 linhas que já existem no framework | `.../post-migration-cleanup.md` §8, `platform-hooks-factories.md` | Grep por definições locais desses símbolos antes de aceitar como "customização" |
| ~73% das páginas de um site ignoram rascunho do CMS | Chave de bloco percent-encoded vs raw não coexistem sob a mesma semântica de snapshot | `packages/blocks/src/cms/loader.test.ts:228-231` | Testar draft override em página com espaço/acento no nome |

## 5. CSS / Tailwind

| Sintoma | Causa raiz | Onde está documentado | Como validar |
|---|---|---|---|
| Cores DaisyUI trocadas (base-100 invertido, accent inventado) | Conversão de tema mapeia slots semânticos errado — já vazou em 3 migrações antes de ser pego | `.agents/skills/deco-to-tanstack-migration/references/css-styling.md:278-306` | Comparar valor de cada slot DaisyUI (`--p`, `--s`, `--a`, `--b1`...) contra o tema original, não só visualmente |
| Página renderiza escura em browser/headless com preferência dark, mesmo com tema "fixo" | Plugin default do DaisyUI v5 bundla um segundo tema dark via `prefers-color-scheme` | `.../css-styling.md:309-330` | Forçar `prefers-color-scheme: dark` no teste e comparar CSS compilado por `--color-accent` duplicado |
| Banner largo cortado em fatia ilegível | `DEFAULT_ASPECT_RATIO` único não serve banner quase-quadrado e banner 1920×150 ao mesmo tempo | `.../css-styling.md:334-361` | Testar o maior e o menor aspect ratio de banner do site real |
| Padding/margin não aplica na ordem esperada em telas médias | `md:px-6` (shorthand→`padding-inline`) vs `sm:pl-0` (longhand→`padding-inline-start`) são propriedades CSS diferentes no Tailwind v4 | `.../css-styling.md:118-153` | Testar breakpoints intermediários visualmente, não só mobile/desktop |
| Ícones SVG com cor de tema ficam pretos | `oklch(var(--x))` inválido quando `--x` guarda hex, não triplet | `.../css-styling.md:155-192` | Inspecionar CSS computado de qualquer ícone temático |
| Página sem estilo, console cheio de "unknown utility class" | `theme.extend.colors`/`fontFamily` customizado do site não migrado pro `app.css` scaffold | `.../css-styling.md:195-247` | Diff do `tailwind.config` original contra o `app.css` novo |
| Classe de `@layer components` não aplica via `@apply` | Tailwind v4 não suporta mais esse padrão | `.../css-styling.md:250-275` | Grep por `@apply` dentro de `@layer components` |

## 6. VTEX / commerce

| Sintoma | Causa raiz | Onde está documentado | Como validar |
|---|---|---|---|
| Mega-menu com poucos links, wrappers de flag não resolvidos | Resolver hardcoda só 2 de 7 flags multivariate possíveis | `.agents/skills/deco-to-tanstack-migration/references/vtex-commerce.md:182-224` (caso real: 17→291 links pós-fix) | Testar toda flag multivariate custom do site, não só as 2 conhecidas |
| `ERR_TOO_MANY_REDIRECTS` num path específico | Normalização lowercase da URL faz `from`/`to` colidirem consigo mesmos | `.../vtex-commerce.md:228-254` (recorreu 2x na mesma migração) | Testar redirects que têm letra maiúscula no path original |
| Paginação trava na página 0/1 mesmo com `?page=3` na URL | `resolve.ts` injeta search param como string crua sem coerção; `Number.isFinite('3')` é `false` | `.../vtex-commerce.md:258-283` (issue `decocms/blocks#391`) | Testar navegação de paginação/filtro comparando produtos da página 1 vs `?page=3` |
| Swatches de cor/tamanho ausentes na PDP com 2+ variantes | Loader legado de PDP é 1-linha de re-export sem `similars`/crossselling | `.../vtex-commerce.md:286-317` | Testar PDP com produto de múltiplas variantes especificamente |
| Payload de hidratação de 2.7-4MB na PDP | Todo SKU irmão vem como `toProduct()` completo | `.../vtex-commerce.md:320-357` (fix: `leanVariants`, cuidado: filtrar por `"@type"` em vez de `priceComponentType` não faz nada) | Medir `$_TSR` bytes antes/depois do trim |
| URL malformada em JSON-LD/autocomplete (`https/slug/p`) | `config.publicUrl` já vem com `https://`, call sites concatenam de novo | `.../vtex-commerce.md:360-380` | Grep por concatenação de `publicUrl` + protocolo |
| Busca/categoria retorna zero ou produtos errados | `resolve.ts` não repassa `matcherCtx` (URL/query/sort/paginação) pro loader de commerce | `.../vtex-commerce.md:69-82` | Testar busca com query string real, não só a home |
| Sem badge de desconto, sem parcelamento na PDP | Loaders VTEX chegam com `priceSpecification` vazio | `.../vtex-commerce.md:84-122` | Conferir produto com desconto ativo especificamente |
| Filtro de faixa de preço quebrado | Resposta de facets VTEX é `{facets: [...]}`, não array direto; `PRICERANGE` precisa conversão manual | `.../vtex-commerce.md:125-142` | Testar filtro de preço na PLP |
| Produto de vendedor regional aparece OutOfStock | Cookie `vtex_segment` não é repassado nas chamadas de saída | `packages/apps-vtex/src/__tests__/client-segment-cookie.test.ts:1-6` | Testar produto regional com segmento setado |
| Carrinho vazio em `/checkout` | Cadeia de `Set-Cookie` do checkout.vtex.com não chega no browser via `createServerFn` | `packages/apps-vtex/src/__tests__/client-set-cookie-forward.test.ts:1-8` | Fluxo completo add-to-cart → checkout, inspecionando cookies do domínio VTEX |
| Link de filtro/paginação quebra navegação client-side | Chave de query string duplicada (`?filter.category-1=x&filter.category-1=y`) não representável em `Record<string,string>` do TanStack Router | `.agents/skills/deco-to-tanstack-migration/references/search.md:365-387` | Usar `<a href>` puro pra esses links, não `navigate({search})` |
| Busca retorna zero resultados | `q` acidentalmente em `ignoreSearchParams` | mesmo arquivo, "Common Pitfalls" | Grep `ignoreSearchParams` por `q` |
| PLP VTEX sem fallback de `__pageUrl` (Shopify tinha, VTEX não) | Loader de PLP não lia o fallback | mesmo arquivo, item 5 | Testar PLP sem parâmetros de URL explícitos |

## 7. Matchers / A-B testing

| Sintoma | Causa raiz | Onde está documentado | Como validar |
|---|---|---|---|
| CLS por remount de subtree inteira (maior causa documentada de CLS nesta referência) | Matchers custom (`location`, `userAgent`, `environment`, `multi`, `negate`) não estão em `registerBuiltinMatchers()` por padrão — retornam `false` pra toda variante, servidor renderiza A, cliente reavalia B | `.agents/skills/deco-to-tanstack-migration/references/matchers.md:60,404,521` | Listar todo matcher usado no decofile e confirmar registro explícito |
| Matcher nunca casa mesmo com condição visualmente idêntica ao Fresh | Shape de props do builtin TanStack (`pathname.ts`/`queryString.ts`) é mais simples que o `case`/`conditions[]` do Fresh | mesmo arquivo, linhas 792-906 | Comparar shape de props esperado, não só nome do matcher |
| Matcher não recebe URL/cookies | `MatcherContext.request` não populado de forma confiável — usar `ctx.cookies`/`ctx.headers` | mesmo arquivo | Testar matcher que depende de cookie, não só de path |

## 8. HTMX / Islands

| Sintoma | Causa raiz | Onde está documentado | Como validar |
|---|---|---|---|
| ~14% dos usos de htmx (`oob-swap` + `unmatched`) não têm codemod automático | Sem equivalente limpo em React para swap out-of-band de múltiplos nós desconectados | `.agents/skills/deco-to-tanstack-migration/references/htmx-rewrite.md` (inventário real: 210 ocorrências / 133 arquivos, 86% mecanizável) | Fazer inventário de uso de htmx no site antes de estimar prazo de migração |
| Estado perde-se ao dar F5, otimizações do React Compiler não entram | Handler reescrito ainda muta DOM direto (`button.dataset.loading = "true"`) em vez de estado React | mesmo arquivo | Grep por mutação direta de `dataset`/`style`/`classList` em handlers migrados |
| Memory leak de listener | `removeEventListener` chamado com uma função anônima nova, não a referência original | `.agents/skills/deco-to-tanstack-migration/references/islands.md` | Grep por `addEventListener`/`removeEventListener` com funções inline diferentes |
| Comportamento ambíguo de listener sob SSR | `addEventListener` bare (sem `window.`) em module scope | mesmo arquivo | Grep por `addEventListener(` sem prefixo de objeto |

## 9. CMS / Studio / decofile

| Sintoma | Causa raiz | Onde está documentado | Como validar |
|---|---|---|---|
| Edição feita direto em `blocks.gen.json` desaparece no próximo build | Studio edita o source `.deco/blocks/<key>.json`; `blocks.gen.json` é compilado e sobrescrito | memória `decocms-studio-edits-source-decofile-not-kv` | Nunca editar `blocks.gen.json` a mão; editar via Studio ou o source JSON |
| Projeção `renderJson` sem nenhum efeito no `?renderJson` | `applySectionConventions()` chamado sem passar `renderJsons` (de `.deco/sections.gen.ts`) | memória `renderjson-projecoes-ignoradas-em-silencio` | Conferir wiring do `setup.ts` antes de suspeitar do serializer, especialmente em sites montados antes do blocks v7.40 |
| Build CF Workers não dispara após mudar conteúdo | Commit só toca `.deco/*.json`, CF Workers Builds só builda em mudança de código | memória acima, nota lateral | Se precisar forçar build, tocar também um `.ts` |
| Draft override não aplica em página com nome acentuado/espaço | Chave de bloco percent-encoded vs raw não coexistem (ver item na seção 4) | `packages/blocks/src/cms/loader.test.ts:228-231` | — |
| Seção/bloco não aparece pra editar no Studio, ou aparece com props faltando/vazias; config de site/app não carrega | Gap no schema gerado (`generate-schema.ts`) ou no manifesto que não expõe a prop/bloco pro `/live/_meta`; alguns casos já corrigidos direto no `@decocms/blocks`, mas há peculiaridade de código do site (loader/seção custom mal tipada, JSDoc ausente, `__resolveType` não registrado) que reproduz o mesmo sintoma mesmo com o framework já corrigido | relatado pelo usuário, sem file:line ainda — cruzar com `@decocms/blocks-cli`'s `generate-schema.ts` e `composeMeta()` (`@decocms/blocks/cms`) quando for isolar | Em toda seção/bloco/app do site migrado: abrir no Studio e conferir que TODAS as props aparecem e vêm preenchidas (não só que o bloco existe); se faltar, checar primeiro se o framework já tem o fix (versão do `@decocms/blocks`) antes de suspeitar do código do site — e se o framework já corrigiu, checar JSDoc/tipagem/`__resolveType` da seção/loader custom do site |

## 10. Deploy / CI / secrets

| Sintoma | Causa raiz | Onde está documentado | Como validar |
|---|---|---|---|
| Fast-deploy nunca liga mesmo com `DECO_FAST_DEPLOY=1` setado | Control-plane só sobrescreve o **id** de um binding (`DECO_KV`) já declarado em `wrangler.jsonc` — se o template do site não declara o binding, o passo é pulado em silêncio | memória `control-plane-nao-adiciona-bindings-wrangler` | Template/scaffold do site precisa declarar `DECO_KV` + `DECO_FAST_DEPLOY` explicitamente no `wrangler.jsonc` |
| Secrets de app (VTEX appKey/token etc.) funcionam local mas dão 401/403 em preview/prod sem log de erro | `DECO_CRYPTO_KEY` só existe via `env` do CF Workers em runtime, não em `process.env`/`.dev.vars`; `autoconfigApps()` roda no module-init antes da 1ª request, ALS vazio | memória `crypto-key-cf-workers-env`, `packages/blocks/src/sdk/crypto.test.ts:1-7` | Conferir `wrangler secret list` tem `DECO_CRYPTO_KEY` real, e que `reconfigureAppsOnce()` está sendo chamado em `workerEntry.ts` |
| VTEX MasterData retorna 403 mesmo com creds "certas" | Creds ficaram no bloco legado (ex: app custom antigo), não no bloco `deco-vtex` que o registry realmente lê | memória `vtex-creds-must-be-on-deco-vtex-block` | Se 403 só em write (reads funcionam), checar `getVtexConfig().appKey` populado, e qual bloco tem `appKey`/`appToken` |
| Histórico do pipeline centralizado de deploy: 3 reverts seguidos (D6→D6.3) | `secrets: inherit` resolve do repo caller não do called; GitHub Free não propaga secrets de org pra repo privado | `MIGRATION_TOOLING_PLAN.md:120-123` | Não reintroduzir um pipeline de deploy centralizado sem reler essa história — solução atual é CF Workers Builds por worker |
| Dashboard CF mostra warning e abre PR de fix sozinho | Comportamento esperado: CF ignora `name` malicioso em `wrangler.jsonc` | mesma referência | Não é bug — não "consertar" isso revertendo o PR automático sem entender por quê |
| Nenhum dado capturado em Workers Observability apesar de sub-flags configuradas | `observability.enabled: true` no topo do `wrangler.jsonc` é master-switch obrigatório | `.agents/skills/deco-to-tanstack-migration/references/worker-cloudflare.md:298-301` | Conferir esse flag específico antes de assumir que a telemetria está ativa |
| Workflow perde eventos de OTel no fim da execução | Cloudflare Workflow só tem 1 tentativa de flush por leg, sem próxima request pra reter; cooldown de ~5s por isolate | `packages/blocks/src/sdk/otel.test.ts:616-623` | Conferir `instrumentWorkflowRun` força flush no exit, não confiar no flush padrão |

## 11. SEO

| Sintoma | Causa raiz | Onde está documentado | Como validar |
|---|---|---|---|
| `sitemap.xml` não existe/não atualiza | TanStack não tem renderizador nativo de sitemap; peças existem nos pacotes instalados mas nada as conecta em `worker-entry.ts` por padrão | `.agents/skills/deco-to-tanstack-migration/references/storefront-patterns.md:1013-1044` | Testar `GET /sitemap.xml` explicitamente em toda migração — fácil de passar batido no QA manual |
| Seções somem ou aparecem fora de ordem numa prateleira | `mergeSections()` assumia 1 entrada CMS → 1 seção renderizada; loader que retorna 0 ou várias seções desalinha os índices | mesma referência, linhas 841-878 (fix: index-stamping, regressão v0.16.3→v0.16.4) | Testar prateleiras/loaders que podem retornar 0 ou N seções, não só 1 |
| Páginas paginadas de PLP (`?page=2`, `?page=3`...) indexadas/rankeadas errado pelo Google pós-migração | Tags de SEO de paginação (`rel="next"`/`rel="prev"` e/ou `canonical` apontando pra página certa) não foram preservadas na migração do head da página | relatado pelo usuário, sem file:line ainda — adicionar referência quando a causa exata for isolada no código | Comparar o `<head>` de uma URL paginada real (`?page=2`+) entre o site Fresh antigo e o TanStack migrado: `canonical`, `rel=next/prev`, `meta robots` |
| Tags do Google Tag Manager sumiram do site migrado, precisaram ser readicionadas depois | Script/snippet do GTM (head + noscript do body) não foi carregado no scaffold/migração — não é auto-portado do `root.tsx`/head antigo | relatado pelo usuário, sem file:line ainda | Conferir GTM ativo via Tag Assistant / `dataLayer` no console em toda página migrada (home, PLP, PDP, checkout), não só a home |

## 12. App nativo (companion) — só relevante se a loja tiver app React Native

| Sintoma | Causa raiz | Onde está documentado | Como validar |
|---|---|---|---|
| Metro quebra com `"failed to deserialize; expected an object-like struct named Specifier, found ()"` | `nativewind@5.0.0-preview.4`/`react-native-css@3.0.7` só bundlam com `lightningcss@1.30.1`; 1.31+/1.33 mudou ABI napi | memória `nativewind-lightningcss-pin` | Pinar `"overrides": { "lightningcss": "1.30.1" }`; erro aponta pro `.css` errado — não é bug de CSS |
| `bg-primary` compila mas não pinta nada no app | DaisyUI v5 emite variáveis de tema com seletor `:has()`, que NativeWind descarta silenciosamente; precisa também de um bloco `@theme` | memória `nativewind-daisyui-theme-vars` | Conferir tabela `"vr":` no bundle dev do Metro — valores aparecem em minúsculas, grep case-sensitive dá falso negativo |
| Imagem de produto pesa MBs no app (medido: 1.3-1.6MB por foto) | `?width=` no domínio `decoims.com` não faz nada — precisa da sintaxe `?fit=&width=&height=&src=` | memória `imagem-cms-crua-no-app` | Usar `DecoImage`/`getOptimizedMediaUrl`; medir bytes reais com `curl -o /dev/null -w '%{size_download}'`, não confiar na URL "parecer" certa |

---

*Fontes: `.agents/skills/deco-to-tanstack-migration/references/*`, `.agents/skills/decocms-v6-to-v7-upgrade/`, `.cursor/skills/deco-server-functions-invoke/`, `MIGRATION_TOOLING_PLAN.md`, `.cursor/rules/migration-tooling-policy.mdc`, testes de regressão com histórico documentado, e memória persistente do assistente (VTEX/Studio/crypto-key/wrangler/renderJson/NativeWind/imagem).*
