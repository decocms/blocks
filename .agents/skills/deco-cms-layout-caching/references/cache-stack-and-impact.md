# How layout caching stacks with the other caches, and what it buys

## Integration with `vtexCachedFetch` SWR

Layout caching prevents re-execution of section loaders and CMS resolution for 5 minutes. But the underlying VTEX API calls also benefit from the `vtexCachedFetch` SWR cache (3 min TTL):

```
Request → Layout cache (5 min TTL)
  └→ MISS → resolveDecoPage → section loaders
       └→ vtexCachedFetch → fetchWithCache (3 min TTL)
            └→ MISS → actual VTEX API call
```

This means even after the layout cache expires, the underlying API data may still be fresh in the fetch cache. The two caches work together:

| Layer | TTL | Scope |
|-------|-----|-------|
| Layout resolution cache | 5 min | Full section output (props + enrichment) |
| Layout section loader cache | 5 min | Section loader output only |
| `fetchWithCache` SWR | 3 min | Individual HTTP responses |
| `cachedLoader` SWR | 30-120s | Commerce loader results |

### Cart Cross-Selling on PLP — Not an Issue

Analysis confirmed that cart drawer cross-selling is **CMS-based** (products configured in admin), not API-based. The Header loader only runs `usePriceSimulationBatch` (a POST, which only runs when `userInfo` cookie exists with a CEP). On first visit without the cookie, no simulation runs at all.

---

## Performance Impact

Before layout caching (variant change on PDP):
- **~30 VTEX API calls** per navigation (Header shelves × 2 resolutions)
- **2-3 seconds** delay

After layout caching + `vtexCachedFetch` SWR:
- **~8 VTEX API calls** on first load (only product-specific: PDP loader, cross-selling, simulation)
- **~0-2 VTEX API calls** on subsequent navigations (everything served from SWR caches)
- **<1 second** for cached navigations
