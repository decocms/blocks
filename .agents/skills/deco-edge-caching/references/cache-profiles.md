# Cache profiles and URL→profile detection

Source of truth: `PROFILES`, `builtinPatterns`, `detectCacheProfile` in `packages/blocks/src/sdk/cacheHeaders.ts` (`@decocms/blocks/sdk/cacheHeaders`).

## Cache Profiles

| Profile | Browser `max-age` | Edge `s-maxage` | Header SWR / SIE (browser) | Edge SWR / SIE (worker) | Client `gcTime` (prod) |
|---------|------------------|-----------------|-----|-----|---------------------|
| `static` | 2 min | 15 min | 30 min / 2 h | 2 h / 6 h | 30 min |
| `product` | 60s | 5 min | 10 min / 1 h | 30 min / 2 h | 5 min |
| `listing` | 30s | 2 min | 5 min / 30 min | 15 min / 1 h | 5 min |
| `search` | 0 | 60s | 2 min / 10 min | 5 min / 30 min | 2 min |
| `cart` | private | — | — | — | 0 |
| `private` | private | — | — | — | 0 |
| `none` | private | — | — | — | 0 |

Client `staleTime` is `Infinity` in production for every profile (5s in dev) — see `route-cache.md`. An earlier version of this table listed per-profile staleTimes and much longer static/product TTLs (1 day edge for `static`, 1 h SWR for `product`); those never matched `PROFILES`. The `Cache-Control` header `cacheHeaders(profile)` emits is `public, max-age=<browser.fresh>, s-maxage=<edge.fresh>, stale-while-revalidate=<browser.swr>, stale-if-error=<browser.sie>` plus `Vary: Accept-Encoding`; the edge SWR/SIE windows are used by the worker's own Cache API logic (`edgeCacheConfig`). Non-public profiles get `private, no-cache, no-store, must-revalidate`. Sites tune any value with `setCacheProfile(name, overrides)`; turning `private`/`cart`/`none` public is refused unless `allowPublicPrivateProfile()` was called first.

## URL-to-Profile Detection (built-in)

| URL Pattern | Detected Profile |
|-------------|-----------------|
Evaluated in this order (first match wins):

| URL Pattern | Detected Profile |
|-------------|-----------------|
| Private segments: `/cart`, `/carrinho`, `/checkout`, `/account`, `/myaccount`, `/my-account`, `/minha-conta`, `/meus-pedidos`, `/pedidos`, `/orders`, `/order-placed`, `/login`, `/logout`, `/sair`, `/cadastro`, `/signup`, `/register`, `/profile`, `/perfil`, `/wishlist`, `/favoritos`, `/listadedesejos`, `/lista-de-desejos`, `/minha-lista`, `/assinaturas`, `/subscriptions`, `/troca(s)`, `/devolucao`, `/devolucoes` — case-insensitive, optional locale prefix (`/pt/checkout`), plus anything from `registerPrivatePaths` | `private` |
| `/api/*`, `/deco/*`, `/_build*` | `none` |
| `/s`, `/s/*`, `?q=` | `search` |
| `*/p` (ends with /p) | `product` |
| `/` | `static` |
| Everything else | `listing` (conservative default) |

A missing private entry is a live content leak, not a missed optimization — anything unmatched falls through to the cacheable `listing`. To add private paths, prefer `registerPrivatePaths(["/trocas"])`: it can only restrict. TanStack server-fn GETs (`/_serverFn/...`) are classified by the page path embedded in their payload (`serverFnPagePath`), so SPA-navigation data inherits the page's profile.


## Registering Custom Patterns

```ts
// In setup.ts or worker-entry.ts
import { registerCachePattern } from "@decocms/blocks/sdk/cacheHeaders";

registerCachePattern({
  test: (pathname) => pathname.startsWith("/blog"),
  profile: "static",
});
```

Custom patterns evaluate before built-in ones — except that a custom pattern resolving to a public profile can never override the built-in private check (a broad site pattern would otherwise capture `/checkout`).


## Site-Level Cache Pattern Registration

For sites with known institutional/static pages that would otherwise get the conservative 2-min "listing" TTL, register explicit patterns in `setup.ts`:

```ts
// setup.ts
import { registerCachePattern } from "@decocms/blocks/sdk/cacheHeaders";

// Institutional pages — content changes rarely, promote to 24h edge TTL
registerCachePattern({
  test: (p) =>
    p.startsWith("/institucional") ||
    p.startsWith("/central-de-atendimento") ||
    p.startsWith("/politica-de-") ||
    p.startsWith("/termos-") ||
    p === "/fale-conosco" ||
    p === "/trabalhe-conosco" ||
    p === "/cadastro" ||
    p === "/televendas",
  profile: "static",
});

// Promotional/collection pages — already listing-like, but explicit is better
registerCachePattern({
  test: (p) =>
    p.startsWith("/ofertas") ||
    p.startsWith("/b/") ||
    p.startsWith("/festival-"),
  profile: "listing",
});
```

Custom patterns are evaluated before built-in ones. This is the recommended way to tune caching per-site without modifying the framework.
