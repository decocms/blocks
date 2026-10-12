# Audit 4 — salesChannel (`sc`) parameter

Missing `sc` causes wrong prices, ORD027, or invisible products.

**Where required**:
- All `/api/checkout/pub/orderForm/*` endpoints → `?sc={sc}`
- `/api/catalog_system/pub/products/search/*` → `?sc={sc}`
- `/buscaautocomplete` → `&sc={sc}`
- Intelligent Search: handled by `client.ts` `intelligentSearch()` automatically

**Injection points**:

| Component | How sc is injected |
|-----------|-------------------|
| `client.ts` intelligentSearch | Auto from `getVtexConfig().salesChannel` |
| `hooks/useCart.ts` | Reads `VTEXSC` cookie via `document.cookie` |
| `loaders/cart.ts` | From `getVtexConfig().salesChannel` |
| `loaders/catalog.ts` | From `getVtexConfig().salesChannel` |
| `loaders/legacy.ts` | `buildSearchParams()` includes `sc` |
| `actions/checkout.ts` | Helper `scParam()` / `appendSc()` |
| `middleware.ts` | Reads `VTEXSC` cookie from request |

**Audit**:

```bash
rg -n -C4 "catalog_system/pub/products/search|buscaautocomplete|orderForm" packages/apps-vtex/src/ --glob '!**/__tests__/**'
```

Read each callsite with its context — `sc` is often added on another line (`appendSc(params)`, `scParam()`, `params.set("sc", …)`, `buildSearchParams()`), so a same-line `sc=` filter flags valid code.


## Fix: Missing salesChannel in catalog

```typescript
// Before
return vtexFetch<T[]>(`/api/catalog_system/pub/products/search/?${params}`);
// After
const { salesChannel } = getVtexConfig();
if (salesChannel) params.set("sc", salesChannel);
return vtexFetch<T[]>(`/api/catalog_system/pub/products/search/?${params}`);
```
