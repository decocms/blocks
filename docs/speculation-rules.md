# Prerender de HTML pelo browser (Speculation Rules API)

Disponível a partir do `@decocms/tanstack@7.48.0`. **Desligado por padrão.**

A [Speculation Rules API](https://developer.chrome.com/docs/web-platform/prerender-pages)
é um mecanismo nativo do browser: o site declara quais links são candidatos, e o
browser busca (ou renderiza inteiro, num documento oculto) a próxima página antes
do clique. Quando o clique acontece, o documento já está pronto — a navegação é
instantânea. Não há JS do framework no caminho crítico; o `<script
type="speculationrules">` é um payload JSON inerte no `<head>`.

## O que ganha, e o que não ganha

Só ajuda **navegação de documento** — um `<a href>` que sai da SPA e faz o browser
carregar um HTML novo: mega-menu → categoria, rodapé → institucional, breadcrumb.

Links renderizados pelo `<Link>` do TanStack Router **não ganham nada**: o router
intercepta o clique antes de virar navegação de documento. Pior, se eles entrarem
como candidatos o browser gasta prerender que nunca é usado. É exatamente por isso
que o `linkSelector` existe — ele restringe os candidatos aos containers que de
fato fazem hard-nav.

## Como ativar

Duas formas. A opção do worker-entry é a normal (vale pro site todo); a prop do
`DecoRootLayout` sobrescreve por root, quando um layout específico precisa de
config diferente.

```ts
// src/worker-entry.ts
export default createDecoWorkerEntry(serverEntry, {
  speculationRules: {
    action: "prerender",                      // ou "prefetch"
    eagerness: "moderate",                    // hover ~200ms
    linkSelector: "[data-prerender] a[href]", // escopo dos candidatos
  },
});
```

```tsx
// override por root
<DecoRootLayout speculationRules={{ action: "prefetch", eagerness: "conservative" }}>
```

Sem `speculationRules`, o `DecoRootLayout` não emite tag nenhuma.

## Marcando os containers (`data-prerender`)

O `linkSelector` é um seletor CSS comum, avaliado pelo browser contra os anchors
da página. O atributo `data-prerender` não é mágica do framework — é só uma
convenção de nome; o que importa é que o seletor case **apenas** com os `<a>` que
fazem navegação de documento.

Com `linkSelector: "[data-prerender] a[href]"`, marque o container:

```tsx
export function HeaderNav({ categories }: { categories: Category[] }) {
  return (
    // hard-nav: <a> puro, sai da SPA → candidato a prerender
    <nav data-prerender aria-label="Categorias">
      {categories.map((c) => (
        <a key={c.slug} href={`/${c.slug}`}>
          {c.name}
        </a>
      ))}
    </nav>
  );
}
```

```tsx
export function Footer() {
  return (
    <footer>
      <nav data-prerender>
        <a href="/institucional/quem-somos">Quem somos</a>
        <a href="/institucional/trocas">Trocas e devoluções</a>
      </nav>

      {/* SEM data-prerender: o router intercepta, prerender seria desperdiçado */}
      <nav>
        <Link to="/favoritos">Favoritos</Link>
      </nav>
    </footer>
  );
}
```

Um `data-prerender` num wrapper que contém `<Link>`s do router também os
inclui como candidatos (o seletor é descendente). Marque o `<nav>` específico,
não o `<header>` inteiro.

Seletor com `>` funciona — o JSON é emitido via `dangerouslySetInnerHTML`
justamente para o React não escapar o `>` (`"nav > a"` é válido).

## Opções

| Opção | Tipo | Default | Efeito |
|---|---|---|---|
| `action` | `"prerender" \| "prefetch"` | `"prerender"` | `prerender` renderiza a página inteira num documento oculto, executando o JS dela (instantâneo, mais caro, exige analytics com guard). `prefetch` só busca o HTML, sem executar JS |
| `eagerness` | `"immediate" \| "eager" \| "moderate" \| "conservative"` | `"moderate"` | `immediate`: assim que a regra é lida. `eager`: qualquer indício de interação. `moderate`: hover ~200ms / pointerdown. `conservative`: só pointerdown — desça pra cá se a carga especulativa no server subir |
| `linkSelector` | seletor CSS | — | Sem ele, **todos** os links internos (`/*`) entram como candidatos |
| `excludeHrefMatches` | `string[]` | `[]` | URLPatterns de pathname extras a excluir, somados aos defaults. Ex.: `["/*/p"]` pra pular PDPs |
| `overrideDefaultExclusions` | `boolean` | `false` | Substitui os defaults em vez de somar. Só use se souber que nenhum dos paths abaixo existe |

## Exclusões default

Sempre aplicadas, salvo `overrideDefaultExclusions: true`:

```
/checkout*  /account*  /_secure/*  /login*  /logout*  /cart*  /api/*
```

São páginas com efeito colateral de sessão (um prerender de `/cart` pode mexer em
estado) e rotas proxy/API (não cacheáveis, prerender é puro desperdício). Espelha
o perfil de cache `private`.

## Pré-requisito do `prerender`: analytics com guard

`prerender` executa o JS da página no documento oculto — inclusive os pixels. Um
loader sem guard dispara na hora do prerender **e** de novo quando o usuário
ativa a página: pageview duplicada. E se o prerender nunca for ativado, você
contou uma visita que não aconteceu.

Os helpers em `@decocms/blocks/sdk/analytics` já resolvem: checam
`document.prerendering` e adiam via evento `prerenderingchange`.

```ts
import { ANALYTICS_SCRIPT, gtmScript } from "@decocms/blocks/sdk/analytics";

gtmScript("GTM-XXXXXXX"); // guard embutido
// outros pixels: envolva com ANALYTICS_SCRIPT
```

Em dev (`isDevMode()`), com speculation ligado, o framework injeta um script que
dá `console.error` nomeando qualquer loader de analytics que disparou sem guard
durante um prerender. Ligue em dev primeiro e limpe o console antes de ir pra
produção.

`prefetch` não tem esse problema — não executa JS. É o caminho seguro se os
pixels do site ainda não foram auditados.

## Onde mora

- `packages/tanstack/src/sdk/speculationRules.ts` — `buildSpeculationRules`,
  o singleton de ativação, `DEFAULT_EXCLUDED_HREF_MATCHES`
- `packages/tanstack/src/hooks/DecoRootLayout.tsx` — emite a tag no `<head>`
- `packages/tanstack/src/sdk/workerEntry.ts` — opção `speculationRules`
- `packages/blocks/src/sdk/analytics.ts` — `ANALYTICS_SCRIPT`, `gtmScript`,
  `SPECULATION_DEV_WARN_SCRIPT`
