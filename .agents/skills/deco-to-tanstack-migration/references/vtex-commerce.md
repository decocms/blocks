# VTEX Commerce Gotchas

> Section loaders, cart CORS, price specs, facets, URL-blind loaders, cookie handling.


## 1. Section Loaders Don't Execute

Deco sections have `export const loader = async (props, req, ctx) => { ... }` that runs server-side before the component renders. In TanStack Start, these don't execute automatically. Components typed as `SectionProps<typeof loader>` expect the augmented props, but only receive the raw CMS block props.

**Symptom**: Components crash on `.find()`, `.length`, or property access of loader-provided props that are `undefined`.

**Fix**: Register them via `registerSectionLoaders()` in `setup.ts`.

**Safe-default pattern** (most pragmatic for initial migration):

```typescript
// Before: component expects loader-augmented props
function ProductMain({ page, productAdditional, showTogether, priceSimulation, isMobile }: SectionProps<typeof loader>) {

// After: destructure with safe defaults for all loader-only props
function ProductMain(rawProps: any) {
  const {
    page,
    productAdditional = [],         // from section loader
    showTogether = [],               // from section loader
    showTogetherSimulation = [],     // from section loader
    priceSimulation = 0,             // from section loader
    noInterestInstallmentValue = null,
    skuProductsKit = [],             // from section loader
    isMobile = false,                // from section loader (device detection)
  } = rawProps;
```

This lets the core component render while gracefully degrading features that depend on loader data (cross-selling, price simulation, etc.).


## 7. VTEX API Auth on Cloudflare Workers

Env vars are stored as `SECRET_*` GitHub repo secrets (e.g. `SECRET_VTEX_APP_KEY`)
and pushed to the worker via the centralized `Sync worker secrets` workflow
(D6). Locally, use `.dev.vars` (gitignored) for development. Do not run
`npx wrangler secret put` per-site — the central workflow keeps GitHub and
Cloudflare in sync.


## 8. Cookie Handling

In TanStack Start, manage `checkout.vtex.com__orderFormId` cookies manually via `document.cookie`.


## 32. Section Loader Logic Must Not Be Stripped

**Severity**: HIGH — sections render empty/broken

During migration, section loaders (e.g., `sections/Header/Header.tsx`) may have their async data-fetching logic removed. For example, the `ctx.invoke.vtex.loaders.categories.tree()` call that populates navigation menus. Without it, the header renders with no category links.

**Fix**: Keep all section loader logic intact. The loader signature `(props, req, ctx) => {...}` and the `ctx.invoke` calls should be preserved as-is.

**The 3rd-arg `ctx` is real now (#305).** The framework builds a compat `ctx` and passes it as the loader's 3rd argument (`@decocms/blocks`'s `buildSectionLoaderContext`, wired through `withSectionLoader`/`withPageContext`). What it provides:

- `ctx.device` — `"mobile" | "tablet" | "desktop"` from the request User-Agent (works in worker, dev, and SPA-nav paths — it's derived from `req`, not the ambient `RequestContext`).
- `ctx.invoke.*` — a nested invoke proxy bound to this request's origin + AbortSignal. `ctx.invoke.vtex.loaders.categories.tree()` works server-side via a self-fetch to `/deco/invoke`.
- `ctx.<appName>` (e.g. `ctx.vtex`, `ctx.salesforce`) — the app's request-scoped state via `RequestContext.getAppState(name)`, or `undefined` if the app isn't configured.
- `ctx.response.headers` — maps to `RequestContext.responseHeaders` (Set-Cookie forwarding) inside the worker request scope; writes are dropped on the dev/SPA serverFn path.

**Still optional-chain app-state reads.** An unconfigured app yields `undefined`, so a non-optional deep read like `ctx.salesforce.cartExtension[0]` throws — and `withSectionLoader`'s try/catch swallows it, dropping the section's props (blank render). The migrator's `ctx-compat` transform auto-rewrites `ctx.*` reads to optional chains (`ctx?.salesforce?.cartExtension?.[0]`); write new/hand-fixed loaders the same way.


## 34. Commerce Loaders Are Blind to the URL

**Severity**: CRITICAL — search and category pages return wrong/no products

When `resolve.ts` processes CMS blocks, it passes only the static CMS block props to commerce loaders (PLP, PDP). The current URL, query string (`?q=`), path (`/drywall`), sort, pagination, and filter parameters are never forwarded.

**Symptom**: Search pages (`/s?q=parafuso`) return zero products. Category pages (`/drywall`) show random/no products. Sort and pagination controls do nothing.

**Root cause**: `resolveValue()` in `resolve.ts` calls commerce loaders with `resolvedProps` (CMS block config only). The `matcherCtx` (containing URL, path, user-agent) is used for matcher evaluation but never passed to commerce loaders.

**Fix**: Pass `matcherCtx` as a second argument to commerce loaders in `resolve.ts`. Then the PLP loader can extract `?q=` for search, path for categories, `?sort=` for sorting, `?page=` for pagination, and `?filter.X=Y` for facets.

This is a change in `@decocms/start` (resolve.ts). Until upstreamed, use patch-package or vendor the file.


## 35. VTEX Product Loaders Ship with Empty priceSpecification

**Severity**: HIGH — no discount badges, no strikethrough prices, no installments

All three VTEX product loaders (`vtexProductList`, `productListingPage`, `productDetailsPage`) build offers with `priceSpecification: []`. The `useOffer()` hook depends on this array to extract `ListPrice` (for discount math + strikethrough), `SalePrice`, and `Installment` entries.

**Symptom**: Product cards show only one price (no strikethrough). No "X% OFF" discount badge. No "Ou em Nx de R$ X sem juros" installment text.

**Fix**: Add a `buildPriceSpecification()` helper to each loader that transforms the VTEX `commertialOffer` data:

```typescript
function buildPriceSpecification(offer: any): any[] {
  const specs: any[] = [];
  if (offer.ListPrice != null) {
    specs.push({ "@type": "UnitPriceSpecification", priceType: "https://schema.org/ListPrice", price: offer.ListPrice });
  }
  if (offer.Price != null) {
    specs.push({ "@type": "UnitPriceSpecification", priceType: "https://schema.org/SalePrice", price: offer.Price });
  }
  // Find best no-interest installment
  const noInterest = (offer.Installments ?? [])
    .filter((i: any) => i.InterestRate === 0)
    .sort((a: any, b: any) => b.NumberOfInstallments - a.NumberOfInstallments);
  if (noInterest.length > 0) {
    const best = noInterest[0];
    specs.push({
      "@type": "UnitPriceSpecification",
      priceType: "https://schema.org/SalePrice",
      priceComponentType: "https://schema.org/Installment",
      billingDuration: best.NumberOfInstallments,
      billingIncrement: best.Value,
      price: best.TotalValuePlusInterestRate,
    });
  }
  return specs;
}
```

This is a change in `@decocms/apps`. Until upstreamed, patch or vendor the loader files.


## 36. VTEX Facets API Response Structure Mismatch

The VTEX Intelligent Search facets endpoint returns `{ facets: ISFacetGroup[] }`, NOT a direct `ISFacetGroup[]` array. Accessing `response` directly as an array yields no filter data.

Additionally, `PRICERANGE` facets must be converted to `FilterToggle` format (with `value: "min:max"` strings) for the existing `Filters.tsx` component to render them. The component's `isToggle()` filter drops anything that isn't `FilterToggle`.

**Fix**: Unwrap with `const facetGroups = response.facets ?? [];` and convert price ranges:

```typescript
if (group.type === "PRICERANGE") {
  return { "@type": "FilterToggle" as const, key: "price", label: group.name, quantity: 0,
    values: group.values.map((v) => ({
      value: `${v.range.from}:${v.range.to}`, label: `R$ ${v.range.from} - R$ ${v.range.to}`,
      quantity: v.quantity, selected: false, url: `?filter.price=${v.range.from}:${v.range.to}`,
    })),
  };
}
```


## 39. Cart Requires Server-Side Proxy for VTEX API (CORS)

**Severity**: HIGH — add-to-cart, minicart, and checkout flow completely broken

The storefront domain (e.g., `espacosmart-tanstack.deco.site`) differs from the VTEX checkout domain (`lojaespacosmart.vtexcommercestable.com.br`). Direct browser `fetch()` calls to VTEX are blocked by CORS. Additionally, the `checkout.vtex.com__orderFormId` cookie is scoped to the VTEX domain and inaccessible from the storefront.

**Fix**: Use TanStack Start `createServerFn` to create server-side proxy functions:

```typescript
// src/lib/vtex-cart-server.ts
import { createServerFn } from "@tanstack/react-start";

export const getOrCreateCart = createServerFn({ method: "GET" })
  .validator((orderFormId: string) => orderFormId)
  .handler(async ({ data: orderFormId }) => {
    const url = orderFormId
      ? `https://${ACCOUNT}.vtexcommercestable.com.br/api/checkout/pub/orderForm/${orderFormId}`
      : `https://${ACCOUNT}.vtexcommercestable.com.br/api/checkout/pub/orderForm`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VTEX-API-AppKey": API_KEY, "X-VTEX-API-AppToken": API_TOKEN },
      body: JSON.stringify({ expectedOrderFormSections: ["items", "totalizers", "shippingData", "clientPreferencesData", "storePreferencesData", "marketingData"] }),
    });
    return res.json();
  });
```

The `useCart` hook manages the `orderFormId` in a client-side cookie and calls these server functions.

**Checkout URL**: The minicart's "Finalizar Compra" link must append the `orderFormId` as a query parameter since the VTEX checkout domain can't read the storefront's cookies:

```typescript
const checkoutUrl = `https://secure.${STORE_DOMAIN}/checkout/?orderFormId=${orderFormId}`;
```

---

## #59 CMS resolver hardcodes only 2 of 7 possible multivariate-flag resolveTypes — wrapped content silently vanishes

**Severity**: BLOCKER — eager/sync-rendered content wrapped by any multivariate flag other than the resolver's two hardcoded strings resolves to `undefined`, with zero error or console warning.

`@decocms/blocks/src/cms/resolve.ts` special-cases exactly two "well-known" resolveType strings across 7 internal call sites (`internalResolve`, `resolvesToCommerceLoader`, the deferred/lazy detector, `resolveSectionsList`, etc.) when unwrapping a `{variants: [...]}` wrapper:

```typescript
// node_modules/@decocms/blocks/src/cms/resolve.ts
MULTIVARIATE: "website/flags/multivariate.ts",
MULTIVARIATE_SECTION: "website/flags/multivariate/section.ts",
```

Two other legitimate wrapper classes are both invisible to the resolver: (a) any site's own custom multivariate flag bakes a site-prefixed resolveType (`site/flags/multivariate/<name>.ts`) into CMS content; (b) `@decocms/blocks` itself ships five typed multivariate helpers (`flags/multivariate`, `.../image`, `.../message`, `.../page`, `.../section`), but the resolver only recognizes 2 of the resulting resolveType strings — even the canonical, correctly-namespaced `website/flags/multivariate/image.ts` is invisible to it.

**Symptom**: a whole subtree of CMS content — e.g. a mega-menu nav tree, or every `banners[].image` field wrapped for a date-scheduled rotation — silently resolves to empty/default, indistinguishable from missing CMS content.

**Fix (app-level workaround, since the installed package can't be patched from a consuming site)**: a content post-process step, wired as the last step of `generate`, that relabels any `__resolveType` matching `(site|website)/flags/multivariate/<name>.ts` (excluding `section.ts`, already recognized) — only when the object has a `variants` array — to the plain recognized `website/flags/multivariate.ts`:

```typescript
// scripts/fix-multivariate-flags.ts (chained into `generate`, runs on every content refresh)
const RECOGNIZED = new Set([
  "website/flags/multivariate.ts",
  "website/flags/multivariate/section.ts",
]);
function relabel(node: unknown): number {
  // recursively walk .deco/blocks.gen.json;
  // if node.__resolveType matches /^(site|website)\/flags\/multivariate\/.+\.ts$/
  //   and !RECOGNIZED.has(node.__resolveType) and Array.isArray(node.variants):
  //   node.__resolveType = "website/flags/multivariate.ts"
}
```

This is a pure string relabel — `variants`/`rule` stay untouched, so the framework's own `evaluateVariantRule` + matcher logic (never the actual bug) still runs. Running it on every `generate` means the fix survives future CMS content pulls automatically.

**Discovery command**:
```bash
grep -rn "__resolveType" .deco/blocks.gen.json | grep "flags/multivariate" | grep -v 'multivariate\.ts"\|multivariate/section\.ts"'
grep -n "MULTIVARIATE" node_modules/@decocms/blocks/src/cms/resolve.ts   # confirm which strings the installed resolver accepts
```

**Empirical evidence (farmrio-storefront)**: 74 total wrappers relabeled (18 site-specific + 56 blocks-native `image.ts`). Header mega-menu descendant elements 170→1998 post-fix (prod: 2329), `<a>` tags 17→291 (prod: 401); whole-page link counts roughly tripled on every sampled page type. See `migration/learnings/T45.md`, `migration/scripts/fix-multivariate-flags.ts`.

**Proposed fix (upstream)**: recognize any resolveType matching `/flags\/multivariate(\/(image|message|page|section))?\.ts$/` regardless of the `site/`/`website/` namespace prefix, instead of two exact literal strings.

---

## #60 Redirect `from`/`to` normalization lowercases both sides — a case-variant redirect collides with itself into an infinite loop

**Severity**: CRITICAL — `ERR_TOO_MANY_REDIRECTS` on the affected path; recurred twice independently in one migration on two different paths.

`sdk/redirects.ts`'s `normalizePath()` lowercases the `from` path when building the exact-match redirect map, and `matchRedirect()` also lowercases the incoming request path before lookup. A redirect block intended to canonicalize a mis-capitalized backlink (`{"from": "/Novidades", "to": "/novidades"}`) collapses, once both sides are normalized, onto the map key `"/novidades" → {to: "/novidades", 301}` — so any request to `/novidades` matches its own rule and loops forever. The same collision occurs whenever two separately-authored redirect blocks both normalize to the same `from` key (e.g. `/REPOSICAO`→`/reposicao` and `/reposiCAo`→`/reposicao`).

**Fix**: delete the offending block(s) from `.deco/blocks/redirects-*.json`, regenerate. To find every latent instance instead of waiting for a report, scan for any redirect block where `normalize(from) === normalize(to)`:

```javascript
const norm = (p) => {
  let s = p.trim();
  if (!s.startsWith("/")) s = "/" + s;
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s.toLowerCase();
};
// flag any redirect block where norm(from) === norm(to)
```

**Discovery command**:
```bash
rg '"from":|"to":' .deco/blocks/redirects-*.json
```
then run the `norm()` scan above over every `{from, to}` pair found.

**Empirical evidence (farmrio-storefront)**: running the scan after the first reported instance (`/novidades`) found **two more** live instances (both for `/reposicao`) that hadn't been reported yet. See `migration/learnings/T31.md`, `T36.md`.

**Proposed audit rule** (`packages/blocks-cli` strict-audit, against `blocks.gen.json`): flag any redirect block where `norm(from) === norm(to)` at build/CI time, before it ever reaches a live request.

---

## #61 `resolve.ts` auto-injects every unset URL search param onto commerce-loader props as a raw, uncoerced string

**Severity**: HIGH — silently breaks any numeric canonical prop (page number, page size, etc.) that a loader also tries to parse from the URL itself.

`packages/blocks/src/cms/resolve.ts` auto-injects every unset URL search param onto a commerce loader's top-level props as a raw string, with no type coercion — `?page=3` arrives as `props.page === '3'`, not `3`. A loader that validates with `Number.isFinite(rawPage)` (the non-coercing global, correctly used to reject genuinely invalid input) then rejects the defined-but-string value and silently falls back to page 0 — `Number.isFinite('3')` is `false`. A naive `Number(props.page)` coercion is *also* wrong if the loader's own URL-parsing fallback branch treats the value as 0-indexed while the URL itself is 1-indexed — producing an off-by-one instead of a silent no-op.

**Symptom**: `?page=N` on a paginated listing always renders page 1 (or page 0) regardless of `N`, with no error.

**Fix**: in the site's own loader, destructure and drop the framework-auto-injected prop before delegating, making the loader's own URL-based parsing the single source of truth:
```typescript
export const loader = (props: Props, req: Request) => {
  const { page: _autoInjectedPage, ...rest } = props; // drop the raw-string auto-injection
  const pageFromUrl = new URL(req.url).searchParams.get("page");
  return vtexLoader({ ...rest, page: pageFromUrl ? Number(pageFromUrl) - 1 : 0 });
};
```

**Discovery command**:
```bash
rg "props\.\w+ \?\? .*[Pp]age" packages/apps-vtex/src
rg "Number\.isFinite\(props\." packages/apps-vtex/src
```
Any loader with a `props.<name> ?? parseFromUrl()` pattern for a numeric canonical prop hits the identical landmine — not specific to `page` or to VTEX.

**Empirical evidence (farmrio-storefront)**: page1 vs `?page=3` product-overlap check went 24/24 → 0/24 matching after the fix; upstream issue already filed: **[decocms/blocks#391](https://github.com/decocms/blocks/issues/391)**. See `migration/learnings/T25.md`.

---

## #62 Legacy VTEX PDP loader is a bare re-export missing `similars`/crossselling support — `isSimilarTo` always `undefined`

**Severity**: BLOCKER — color/size-variant swatches missing on every PDP with 2+ variant siblings, regardless of the block's own `"similars": true` config.

`vtex/loaders/legacy/productDetailsPage.ts` is a 1-line re-export of `intelligentSearch/productDetailsPage.ts`:
```typescript
export { default, type PDPProps } from "../intelligentSearch/productDetailsPage";
```
`PDPProps` has no `similars` field and never calls the crossselling/`isSimilarTo` resolution prod's older loader performed — the config prop is silently ignored as unknown, not rejected.

**Fix (site-level workaround)**: hit VTEX's crossselling endpoint directly and attach the result:
```typescript
// src/sdk/vtex/similarProducts.ts
export async function fetchSimilarProducts(productGroupId: string) {
  const res = await fetch(
    `https://${ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pub/products/crossselling/similars/${productGroupId}`,
  );
  return (await res.json()).map((p) => toProduct(p)); // toProduct, NOT toProductShelf — see below
}
// wire into the PDP section loader:
page.product.isSimilarTo = await fetchSimilarProducts(page.product.inProductGroupWithID);
```
Use `toProduct` (full image array), not `toProductShelf` (caps `image[]` at 2 entries) — this catalog's convention often places the swatch-tagged image at index 2/3.

**Discovery command**:
```bash
grep -rn "^export { default" node_modules/@decocms/apps-vtex/vtex/loaders/legacy/
```
Any re-export alias in this family may be dropping other config-driven features the same way.

**Empirical evidence (farmrio-storefront)**: sampled ~120 prod PDPs, confirmed a real pair (`camisa-atoalhada-azul-346889-003`/`-off-white-...`) rendering 2 swatches on prod vs. 1 on candidate; VTEX's public crossselling API confirmed the data exists. Post-fix: 2 swatches match prod exactly, 3 unrelated single-color products unregressed. See `migration/learnings/T50.md`.

---

## #63 VTEX loaders ship every adjacent SKU/sibling as a full `toProduct()` result — 2.7-4.1MB hydration payload nobody reads

**Severity**: HIGH — single largest driver of Lighthouse `bootup-time` and FCP/LCP on PLP/PDP in one migration.

`vtex/loaders/intelligentSearch/productListingPage.ts`, a site's own `similarProducts.ts`, and `vtex/loaders/legacy/relatedProductsLoader.ts` each build every adjacent SKU/sibling as a full `toProduct()` result (full `description`, `brand`, `category`, every VTEX cluster tag, full per-installment `priceSpecification` matrix) even though consumers (variant selectors, color swatches) only read a handful of scalar fields. None of the call sites used the framework's own `toProduct({ leanVariants: true })` option, which the PDP loader already exposes but this call chain never set.

**Fix**: a small trim helper applied at every call site that builds sibling/variant data:
```typescript
// src/sdk/leanPlpVariants.ts
export function leanVariant(v: Product) {
  return {
    ...v,
    additionalProperty: v.additionalProperty?.filter(isVariantDifferentiating),
    offers: {
      ...v.offers,
      offers: v.offers?.offers?.map((o) => ({
        ...o,
        // filter on priceComponentType, NOT "@type" — every installment entry's
        // "@type" is "UnitPriceSpecification" (see buildPriceSpecification, gotcha #35);
        // filtering on "@type" matches nothing and silently no-ops the trim
        priceSpecification: o.priceSpecification?.filter(
          (p) => p.priceComponentType !== "https://schema.org/Installment",
        ),
      })),
    },
  };
}
```
Applied at the PLP/region loader, `similarProducts.ts` (`toProduct(p, { leanVariants: true })` + an explicit field allowlist), and a `commerce-loaders.ts` wrapper around the related-products loader.

**Discovery command**:
```bash
rg "toProduct\(" vtex/loaders src/sdk --type ts
rg "leanVariants" node_modules/@decocms/apps-vtex
```

**Empirical evidence (farmrio-storefront)**: `$_TSR` hydration script bytes — PLP 4,633,101→1,950,963 (−57.9%), PDP 3,365,540→1,407,623 (−58.2%); Lighthouse FCP/LCP −24% to −26% in the same environment; product ID count unchanged (144), confirming no data loss. See `migration/learnings/T59.md`.

---

## #64 `config.publicUrl` convention mismatch — a value stored *with* protocol breaks every call site that assumes a bare hostname

**Severity**: HIGH — silent malformed URLs (JSON-LD, autocomplete, related products, similars — 9+ call sites in `@decocms/apps-vtex`), no error until something happens to inspect the output.

Every call site in `@decocms/apps-vtex` builds the VTEX secure-domain URL as `` `https://${config.publicUrl}` ``, assuming `publicUrl` is a bare hostname. If a site's `deco-vtex.json` stores `publicUrl` *with* the protocol already included (`"https://secure.example.com"` instead of `"secure.example.com"`), every one of those 9+ call sites produces a malformed URL (`"https://https/<slug>/p"`) — silently, since nothing validates the shape.

**Fix**: correct the one config value, not the 9 call sites:
```diff
- "publicUrl": "https://secure.farmrio.com.br",
+ "publicUrl": "secure.farmrio.com.br",
```

**Discovery command**:
```bash
rg '`https://\$\{.*publicUrl' node_modules/@decocms/apps-vtex/src   # enumerate every assuming call site
```
Check `config.publicUrl` for a leading `http` prefix before ruling this out.

**Empirical evidence (farmrio-storefront)**: confirmed via `new URL()` producing the malformed `https/` artifact in product JSON-LD; fixed at the config source, verified at PDP/PLP JSON-LD emission. See `migration/learnings/T22.md`.

**Proposed fix (upstream)**: a runtime assertion/warning in `configureVtex()` if `publicUrl` starts with `http`, so the misconfiguration surfaces at startup instead of downstream in malformed output.
