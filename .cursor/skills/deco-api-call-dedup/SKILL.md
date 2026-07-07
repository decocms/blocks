---
name: deco-api-call-dedup
description: Detect and fix N+1 / duplicate API call patterns in Deco storefront section loaders (VTEX Catalog, Intelligent Search, checkout simulation, Shopify). Covers detection (loops calling per-product APIs inside `.map()`/`await`, redundant fetches for data already on the Product object) and fixes (vtexCachedFetch SWR cache, slugCache/cross-selling dedup, usePriceSimulationBatch, PLP path filtering, pageType dedup, site loader registration, cachedLoader in-flight dedup in dev mode, HAR analysis). Use when investigating slow page loads (SSR > 3s), VTEX 429 rate limiting, server logs showing repeated calls to the same endpoint, PDP/PLP loads triggering 20+ API calls, simulation calls happening one-by-one, or "Unhandled resolver" warnings.
---

# API Call Deduplication & N+1 Detection

Finds and fixes N+1 / duplicate VTEX (and Shopify) API call patterns in Deco storefront section loaders — the #1 cause of slow SSR on e-commerce sites. These patterns reduced PDP API calls from 40+ to ~8 and PLP spurious calls from 15+ to near-zero on `espacosmart-storefront`.

## When to Use This Skill

- Page loads are slow (SSR > 3s)
- Terminal logs show many sequential/parallel calls to the same endpoint, or duplicate `search/{slug}/p` calls for the same product
- VTEX returns 429 (Too Many Requests) errors
- Cross-selling endpoints (`similars`, `suggestions`, `showtogether`) are called multiple times with the same ID
- `simulation` POST is called once per product instead of batched
- PDP/PLP page load triggers 20+ VTEX API calls
- HAR analysis shows a waterfall of sequential API calls
- `[CMS] Unhandled resolver: site/loaders/...` warnings appear
- User reports "a troca de pagina ta demorando"
- After migrating loaders or adding new shelf/search sections

## Workflow

```
1. Scan loaders     → Find .map()/forEach + await + API call patterns
2. Classify the API → Catalog, IS, simulation, masterdata, crossselling, pagetype
3. Check if data already exists → Product.additionalProperty, hasVariant, offers, etc.
4. Fix:
   - Redundant call  → remove it, read from existing data
   - Genuinely needed → batch, cache/dedup (vtexCachedFetch), or lazy-load client-side
5. Verify → terminal logs + HAR show the eliminated/deduped calls
```

---

## Step 1: Scan for N+1 Patterns

Search for the telltale pattern: an API call inside a `.map()` or `forEach()` within a loader, or the same endpoint+params fetched from multiple loaders during one request.

### What to Look For

| Pattern | Severity | Example |
|---------|----------|---------|
| **API call inside `.map()`** | Critical | `products.map(p => getSpec(p.id))` |
| **Same slug/ID fetched by multiple loaders** | Critical | PDP main loader + related products + breadcrumb all call `search/{slug}/p` |
| **Missing batch alternative** | High | Individual calls where batch API exists |
| **Redundant data fetch** | High | Fetching data already in the Product object |
| **Sequential awaits in loop** | Medium | `for (p of products) { await fetch(p) }` |
| **Unbounded parallel calls** | Medium | `Promise.all(100items.map(fetch))` |
| **`simulation` called per product** | Medium | Shelf simulates price one product at a time |
| **`pagetype` for asset URLs** | Low-Medium | PLP loader resolving `/image/...`, `/.well-known/...` paths |

### Search Commands

```bash
# Find all loaders that call external APIs inside map/forEach
grep -rn "\.map(.*async" src/components/ src/sections/ --include="*.tsx" --include="*.ts" | grep -i "loader\|export const loader"

# Find getProductSpecification calls (most common N+1)
grep -rn "getProductSpecification" src/

# Find any VTEX API call inside a map
grep -rn "vtexFetch\|vtex.*fetch\|catalog_system\|intelligent-search" src/ --include="*.tsx" --include="*.ts"

# Find simulation calls per product
grep -rn "cartSimulation\|usePriceSimulation" src/ --include="*.tsx" --include="*.ts"
```

### Red Flag Pattern

```typescript
// RED FLAG: API call per product in a map
export const loader = async (props: Props, _req: Request) => {
  const results = props.products?.map(async (product) => {
    const extra = await someApiCall(product.id);  // N+1!
    return { ...product, extra };
  });
  return { ...props, results: await Promise.all(results) };
};
```

## Step 2: Classify the API Call

| API Endpoint | What It Returns | Already in Product? |
|--------------|-----------------|---------------------|
| `/api/catalog_system/pvt/products/{id}/Specification` | Product specs by numeric ID | Yes — `product.isVariantOf.additionalProperty` |
| `/api/catalog_system/pub/products/crossselling/{id}/*` | Related products | No — but should be 1 call per productId+type, not per section |
| `/api/checkout/pub/orderForms/simulation` | Price simulation | No — needs CEP; batch by SKU instead of one call per product |
| `/api/catalog_system/pub/products/variations/{id}` | SKU variations | Yes — `product.isVariantOf.hasVariant` |
| `/api/catalog_system/pub/portal/pagetype/{term}` | Page type for a path segment | No — but should be cached/deduped per segment, and skipped for asset URLs |
| `/api/dataentities/{entity}/search` | MasterData docs | No — check if can be batched with `_where=id=1 OR id=2` |

## Step 3: Check If Data Already Exists

### Product Specifications (Most Common N+1)

The VTEX Intelligent Search API returns `specificationGroups`, which the `@decocms/apps` transform converts to `product.isVariantOf.additionalProperty`.

**Catalog API format** (what `getProductSpecification` returns):
```json
[{ "Id": 208, "Name": "Rendimento", "Value": ["4.5"] }]
```

**Schema.org format** (already in `product.isVariantOf.additionalProperty`):
```json
[{ "name": "Rendimento", "value": "4.5", "propertyID": "groupName", "valueReference": "PROPERTY" }]
```

To use the existing data, create a bridge helper:

```typescript
// src/sdk/productSpecs.ts
import type { Product } from "@decocms/apps/commerce/types";

const SPEC_NAME_TO_ID: Record<string, number> = {
  // Map exact IS spec names → legacy numeric IDs used by components
  // IMPORTANT: verify exact names via IS API, some have double spaces
};

export function getSpecsFromProduct(product: Product) {
  const props = product.isVariantOf?.additionalProperty ?? [];
  const specs: Array<{ Id: number; Value: string[] }> = [];
  for (const p of props) {
    if (p.valueReference !== "PROPERTY") continue;
    const id = SPEC_NAME_TO_ID[p.name];
    if (id == null) continue;
    const existing = specs.find((s) => s.Id === id);
    if (existing) existing.Value.push(p.value);
    else specs.push({ Id: id, Value: [p.value] });
  }
  return specs;
}
```

### How to Discover Spec Names

```bash
# Hit the IS API directly and inspect specificationGroups
curl -s "https://{account}.vtexcommercestable.com.br/api/io/_v/api/intelligent-search/product_search/?count=3&query={product-type}&sc=1" \
  | python3 -c "
import json, sys
for p in json.load(sys.stdin).get('products', []):
    print(p['productId'], '-', p['productName'][:60])
    for g in p.get('specificationGroups', []):
        if g['name'] == 'allSpecifications':
            for s in g['specifications']:
                print(f'  \"{s[\"name\"]}\": {[v[:40] for v in s[\"values\"]]}')
    print('---')
"
```

### SKU Variations

If calling `/api/catalog_system/pub/products/variations/{id}`:
- Already available in `product.isVariantOf.hasVariant`
- Each variant has `additionalProperty` with variation attributes

### Product Reviews/Ratings

If calling an external review API per product in shelves:
- Consider lazy-loading reviews only on PDP
- Or batch the API if it supports multiple product IDs

---

## Step 4: General Fix Strategies

### Strategy A: Use Existing Data (Best)

Replace the API call with a synchronous read from the Product object.

**Before** (N HTTP calls):
```typescript
const productAdditional = await getProductSpecification(element.inProductGroupWithID);
```

**After** (0 HTTP calls):
```typescript
const productAdditional = getSpecsFromProduct(element);
```

### Strategy B: Create Batch Endpoint

When the data genuinely doesn't exist in the Product:

```typescript
// apps-start/vtex/loaders/catalog.ts
export async function getProductSpecifications(productIds: string[]) {
  return Promise.all(
    productIds.map(id => vtexFetch(`/api/catalog_system/pvt/products/${id}/Specification`))
  );
}
```

Even `Promise.all` with N calls is better than sequential awaits, but a true batch API is ideal.

### Strategy C: Cache + Deduplicate

For data that changes infrequently, or that multiple loaders request independently during the same request. See Step 5 for the concrete `vtexCachedFetch`-based patterns this project already uses — prefer those over a bespoke cache.

```typescript
const specCache = new Map<string, any>();

export async function getCachedSpec(productId: string) {
  if (specCache.has(productId)) return specCache.get(productId)!;
  const result = await getProductSpecification(productId);
  specCache.set(productId, result);
  return result;
}
```

### Strategy D: Lazy Load on Client

Move enrichment to client-side for non-critical data:

```typescript
// Component fetches specs only when visible
const [specs, setSpecs] = useState(null);
useEffect(() => {
  if (inView) fetchSpecs(productId).then(setSpecs);
}, [inView]);
```

---

## Step 5: Apply Dedup & Batching Patterns

These are the concrete, already-adopted implementations of Strategy C above — reach for these first before building a bespoke cache.

### Pattern 1: Slug Search Deduplication (`slugCache`) via `vtexCachedFetch`

**Problem:** Multiple section loaders call `search/{slug}/p` for the same product — `productDetailsPage.ts` (main PDP loader), `relatedProducts.ts` (needs `productId` from slug), and any section that resolves a product by slug.

**Solution:** `slugCache.ts` delegates to `vtexCachedFetch`, which provides both in-flight deduplication AND SWR caching (3 min TTL for 200 responses). No manual inflight Map needed:

```typescript
// vtex/utils/slugCache.ts
import { vtexCachedFetch, getVtexConfig } from "../client";
import type { LegacyProduct } from "./types";

export function searchBySlug(linkText: string): Promise<LegacyProduct[] | null> {
  const config = getVtexConfig();
  const sc = config.salesChannel;
  const scParam = sc ? `?sc=${sc}` : "";

  return vtexCachedFetch<LegacyProduct[]>(
    `/api/catalog_system/pub/products/search/${linkText}/p${scParam}`,
  ).catch((err) => {
    console.error(`[VTEX] searchBySlug error for "${linkText}":`, err);
    return null;
  });
}

export async function resolveProductIdBySlug(slug: string): Promise<string | null> {
  const products = await searchBySlug(slug);
  return products?.length ? products[0].productId : null;
}
```

Previously this used a manual `inflight` Map with `setTimeout(() => inflight.delete(...), 5_000)`; `vtexCachedFetch` now handles dedup + SWR automatically via `fetchWithCache` (see `deco-vtex-fetch-cache` skill).

```typescript
// In productDetailsPage.ts
import { searchBySlug } from "../utils/slugCache";
const products = await searchBySlug(linkText);

// In relatedProducts.ts
import { resolveProductIdBySlug } from "../utils/slugCache";
const productId = await resolveProductIdBySlug(slug);
```

**Impact:** Before: 3-4 calls to `search/{slug}/p` per PDP load. After: 1 call, cached for 3 min across all loaders and subsequent page loads.

### Pattern 2: Cross-Selling via `vtexCachedFetch`

**Problem:** Multiple loaders request cross-selling data for the same product:

```
GET /crossselling/similars/58
GET /crossselling/suggestions/58
GET /crossselling/whoboughtalsobought/58
GET /crossselling/showtogether/58
```

When `relatedProducts.ts` runs multiple times (e.g., for a "similars" shelf AND a "suggestions" shelf), the same productId+type gets fetched twice.

**Solution:** `relatedProducts.ts` uses `vtexCachedFetch` instead of a manual `crossSellingInflight` Map. The SWR cache handles both dedup and 3-min TTL:

```typescript
import { vtexCachedFetch, getVtexConfig } from "../client";

function fetchCrossSelling(
  type: CrossSellingType,
  productId: string,
): Promise<LegacyProduct[]> {
  return vtexCachedFetch<LegacyProduct[]>(
    `/api/catalog_system/pub/products/crossselling/${type}/${productId}`,
  ).catch((err) => {
    console.error(`[VTEX] crossselling/${type}/${productId} error:`, err);
    return [] as LegacyProduct[];
  });
}
```

Always `.catch(() => [])` on cross-selling — VTEX returns 404 for products without cross-selling data, and an unhandled 404 crashes the entire section loader:

```typescript
// BAD — 404 kills the PDP
const related = await vtexFetch(`/crossselling/showtogether/${id}`);

// GOOD — graceful fallback
const related = await fetchCrossSelling("showtogether", id);
// vtexCachedFetch throws for non-ok responses, .catch returns []
```

### Pattern 3: Price Simulation Batching

**Problem:** Product shelves call `simulation` POST once per product (N+1):

```
POST /orderForms/simulation  (item: sku-1)
POST /orderForms/simulation  (item: sku-2)
POST /orderForms/simulation  (item: sku-3)
...
```

**Solution:** A batch simulation function that sends all SKUs in one call:

```typescript
// hooks/usePriceSimulationBatch.ts
import { simulateCart } from "@decocms/apps/vtex/actions/checkout";

interface SimulationResult {
  priceSimulation: number;
  noInterestInstallmentValue: string | null;
  installmentsObject: { value: number; numberOfInstallments: number } | null;
}

export async function usePriceSimulationBatch(
  skuIds: (string | undefined)[],
  request: Request,
): Promise<SimulationResult[]> {
  const validIds = skuIds.filter(Boolean) as string[];
  if (!validIds.length) return skuIds.map(() => defaultResult());

  const items = validIds.map((id) => ({
    id: Number(id),
    quantity: 1,
    seller: "1",
  }));

  const cookieHeader = request.headers.get("cookie") ?? undefined;
  const simulation = await simulateCart(items, "", "BRA", 0, cookieHeader);

  const resultMap = new Map<string, SimulationResult>();
  for (const item of simulation.items ?? []) {
    resultMap.set(String(item.id), extractPriceData(item));
  }

  return skuIds.map((id) => resultMap.get(id ?? "") ?? defaultResult());
}
```

```typescript
// In section loaders — batch all IDs
const allIds = [mainProductId, ...relatedProductIds];
const allSimulations = await usePriceSimulationBatch(allIds, request);
const mainSim = allSimulations[0];
const relatedSims = allSimulations.slice(1);
```

**Impact:** Before: N `simulation` POST calls (one per product in shelf). After: 1 `simulation` POST call with all items batched.

### Pattern 4: `cachedLoader` In-Flight Dedup in Dev Mode

**Problem:** `createCachedLoader` completely disables caching in dev mode. This means even concurrent calls for the same key hit the API independently — during SSR, multiple sections resolve concurrently, so the PDP loader can run 2-3 times for the same slug (ProductMain section, Related Products section, Breadcrumb all call `cachedPDP({ slug })`).

**Solution:** Keep SWR cache disabled in dev, but enable in-flight deduplication:

```typescript
// In cachedLoader.ts
export function createCachedLoader<T>(name: string, loaderFn: LoaderFn<T>, opts: CacheOptions) {
  const inflight = new Map<string, Promise<T>>();

  return async (props: any): Promise<T> => {
    const key = `${name}:${JSON.stringify(props)}`;

    if (isDev) {
      // Dev: skip SWR cache but deduplicate concurrent calls
      const existing = inflight.get(key);
      if (existing) return existing;

      const promise = loaderFn(props).finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    }

    // Production: full SWR cache
    return swr(key, () => loaderFn(props), opts);
  };
}
```

With inflight dedup, only 1 actual API call happens; other callers await the same Promise.

### Pattern 5: PLP Path Filtering — Avoid Spurious `pageType` Calls

**Problem:** The PLP loader's `pageTypesFromPath(__pagePath)` receives invalid paths like `/image/checked.png`, `/.well-known/appspecific/...`, `/assets/sprite.svg`. Each path segment triggers a VTEX `pagetype` API call, wasting 5+ calls on non-page URLs.

**Solution:** Filter invalid paths before calling `pageTypesFromPath`:

```typescript
// In productListingPage.ts
const INVALID_PLP_PREFIXES = [
  "/image/", "/.well-known/", "/assets/", "/favicon",
  "/_serverFn/", "/_build/", "/node_modules/",
];

function isValidPLPPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (INVALID_PLP_PREFIXES.some((p) => lower.startsWith(p))) return false;
  const ext = lower.split("/").pop()?.split(".")?.pop();
  if (ext && ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "css", "js", "woff", "woff2", "ttf"].includes(ext)) {
    return false;
  }
  return true;
}

// Usage:
if (facets.length === 0 && __pagePath && __pagePath !== "/" && __pagePath !== "/*" && isValidPLPPath(__pagePath)) {
  const allPageTypes = await pageTypesFromPath(__pagePath);
  // ...
}
```

**Impact:** Eliminates 5+ spurious VTEX API calls on PLP pages that have asset URLs in the path resolution pipeline.

### Pattern 6: `pageTypesFromPath` Dedup via `vtexCachedFetch`

**Problem:** `pageTypesFromPath` calls VTEX's `pagetype` API for each path segment (cumulative). When multiple PLP sections resolve the same path, each segment gets fetched multiple times.

**Solution:** Each individual `pagetype` call goes through `vtexCachedFetch` with SWR:

```typescript
function cachedPageType(term: string): Promise<PageType> {
  return vtexCachedFetch<PageType>(`/api/catalog_system/pub/portal/pagetype/${term}`);
}

export async function pageTypesFromPath(pagePath: string): Promise<PageType[]> {
  const segments = pagePath.split("/").filter(Boolean);
  return Promise.all(
    segments.map((_, index) => {
      const term = segments.slice(0, index + 1).join("/");
      return cachedPageType(term);
    }),
  );
}
```

**Impact:** Page type results are cached for 3 min. Concurrent and subsequent calls for the same segment share the same cached response.

### Pattern 7: Register All Site Loaders

**Problem:** Custom site loaders like `site/loaders/Layouts/ProductCard.tsx` and `site/loaders/Search/colors.ts` appear in CMS blocks but aren't registered in `setup.ts`. This causes `[CMS] Unhandled resolver: site/loaders/...` warnings and missing data — not itself an N+1, but a common companion issue found during the same audits.

**Solution:** Register passthrough loaders in `COMMERCE_LOADERS` in `setup.ts`:

```typescript
const COMMERCE_LOADERS: Record<string, (props: any) => Promise<any>> = {
  // ... existing commerce loaders ...
  "site/loaders/Layouts/ProductCard.tsx": async (props: any) => props.layout ?? props,
  "site/loaders/Search/colors.ts": async (props: any) => ({ colors: props.colors ?? [] }),
};
```

Search server logs for "Unhandled resolver":
```bash
rg "Unhandled resolver" # in terminal output
```

Then check if the referenced loader exists in `src/loaders/` and add a corresponding entry in `setup.ts`.

---

## Step 6: Verify the Fix

### Instrument and Check Terminal Logs

Add prefixed logging to VTEX fetch:

```typescript
console.log(`[vtex] GET ${url}`);
const result = await fetch(url);
console.log(`[vtex] ${result.status} GET ${url} ${Date.now() - start}ms`);
```

After fixing, the terminal should show **zero** (or deduped) calls to the eliminated endpoint:

```bash
# Before: dozens of these per page load
[vtex] GET .../api/catalog_system/pvt/products/123/Specification
[vtex] GET .../api/catalog_system/pvt/products/456/Specification
# ... 20+ more

# After: none of these, only intelligent-search calls
[vtex] GET .../api/io/_v/api/intelligent-search/product_search/...
```

### HAR Analysis

```python
import json
with open('localhost.har') as f:
    har = json.load(f)

# Count VTEX API calls by endpoint
from collections import Counter
vtex_calls = Counter()
for e in har['log']['entries']:
    url = e['request']['url']
    if 'vtexcommercestable' not in url:
        continue
    # Extract endpoint pattern
    path = url.split('.com.br')[1].split('?')[0] if '.com.br' in url else url
    vtex_calls[path] += 1

for path, count in vtex_calls.most_common(20):
    print(f"  {count}x  {path}")
```

### Measure Response Time

```bash
# Cold start
curl -s -o /dev/null -w "%{http_code} %{time_total}s" http://localhost:5173/

# Warm request
curl -s -o /dev/null -w "%{http_code} %{time_total}s" http://localhost:5173/
```

Expected improvement: 2-15 seconds faster on pages with multiple shelves.

### Impact Reference (N+1 Latency Cost)

| Products on Page | N+1 Calls | Latency per Call | Total Added Latency |
|------------------|-----------|------------------|---------------------|
| 12 (1 shelf) | 12 | ~370ms | ~4.4s |
| 24 (PLP) | 24 | ~370ms | ~8.9s |
| 48 (PLP + 2 shelves) | 48 | ~370ms | ~17.8s |
| 100 (homepage) | 100 | ~370ms | ~37s |

Even with parallelism, VTEX rate limits kick in after ~20 concurrent calls, serializing the rest.

---

## Common N+1 Patterns to Watch For

| Pattern | Symptom | Fix |
|---------|---------|-----|
| `search/{slug}/p` called N times | Multiple section loaders resolve same product | `vtexCachedFetch` via `slugCache` (Pattern 1) |
| `crossselling/{type}/{id}` duplicated | Same product ID across multiple related-products sections | `vtexCachedFetch` in `relatedProducts.ts` (Pattern 2) |
| `simulation` called per product | Product shelves simulate one-by-one | `usePriceSimulationBatch` (Pattern 3) |
| `intelligent-search` for Header shelves | Header re-resolved on every navigation | Layout caching + `fetchWithCache` for IS |
| `orderForm` called multiple times | Multiple components check cart state | `useCart` singleton |
| `pagetype` for asset URLs | PLP loader resolving `/image/...` paths | `isValidPLPPath` filter (Pattern 5) |
| `pagetype` called N times for same segment | Multiple PLP sections resolve same path | `vtexCachedFetch` in `cachedPageType` (Pattern 6) |
| `getProductSpecification` per product | Shelf/search result enrichment loop | Read from `product.isVariantOf.additionalProperty` (Step 3) |
| `Unhandled resolver: site/loaders/...` | Custom site loaders not registered | Register in `setup.ts` COMMERCE_LOADERS (Pattern 7) |

## Common N+1 Locations in Deco Sites

| Component | File Pattern | Typical N+1 |
|-----------|-------------|-------------|
| ProductShelf | `components/product/ProductShelf.tsx` | `getProductSpecification` per product |
| SearchResult | `components/search/SearchResult.tsx` | `getProductSpecification` per product |
| ProductTabbedShelf | `components/product/ProductTabbedShelf/` | Specs per product per tab |
| BuyTogether | `components/product/BuyTogether/` | Cross-selling + specs per suggestion |
| HouseCatalog | `components/search/HouseCatalog/` | Specs + simulation per product |
| ProductShelfDinamica | `components/product/ProductShelfDinamica.tsx` | Specs per product in dynamic shelf |

## Quick Audit Checklist

- [ ] Search for `getProductSpecification` — replace with `getSpecsFromProduct` in shelf loaders
- [ ] Search for `.map(async` inside `export const loader` — each is a potential N+1
- [ ] Check for `usePriceSimulation` in loops — legitimate but verify it's parallelized or batched via `usePriceSimulationBatch`
- [ ] Check for `getCrossSelling` in loops — should only be on PDP, not shelves, and go through `vtexCachedFetch`
- [ ] Verify `Promise.all` wraps parallel calls — not sequential `await` in `for` loop
- [ ] Confirm slug lookups go through `slugCache` (`searchBySlug` / `resolveProductIdBySlug`), not raw `vtexFetch`
- [ ] Confirm PLP path resolution filters asset URLs via `isValidPLPPath` before calling `pageTypesFromPath`
- [ ] Check terminal logs for repeated API patterns during page load
- [ ] Check server logs for `Unhandled resolver: site/loaders/...` and register missing loaders in `setup.ts`
- [ ] Measure SSR time before and after changes

## Common Errors

### `ERR_MODULE_NOT_FOUND` for slugCache

**Note**: This error has been resolved. Imports within `@decocms/apps` now use extensionless paths (standard for Node/Vite). If you see this error, ensure the import doesn't have `.ts` extension:

```typescript
// GOOD (current)
import { searchBySlug } from "../utils/slugCache";
import { vtexCachedFetch } from "../client";
import { fetchWithCache } from "./utils/fetchCache";
```

### `crossselling//showtogether` (empty productId)

The productId was `undefined`. Always guard:

```typescript
if (!mainProduct) return { ...props };
const productGroupId = mainProduct.inProductGroupWithID ?? mainProduct.productID ?? "";
if (!productGroupId) return { ...props };
```

### `config is not defined` in productDetailsPage

If `getVtexConfig()` is removed during refactoring, the `salesChannel` query param is lost:

```typescript
const config = getVtexConfig();
const sc = config.salesChannel;
// Use sc in API URLs: `?sc=${sc}`
```

## Related Skills

| Skill | Purpose |
|-------|---------|
| `deco-vtex-fetch-cache` | SWR fetch cache for VTEX APIs (`fetchWithCache`, `vtexCachedFetch`) |
| `deco-variant-selection-perf` | Eliminate server calls for variant selection |
| `deco-cms-layout-caching` | Cache layout sections to prevent Header API calls |
| `deco-tanstack-storefront-patterns` | General runtime patterns + loader `cache`/`cacheKey` exports |
| `deco-performance-audit` | CDN-level metrics and cache analysis |
| `deco-full-analysis` | Full site architecture analysis |
| `deco-edge-caching` | Cache headers and edge configuration |
