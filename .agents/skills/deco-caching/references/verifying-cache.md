# Verifying cache behavior — headers, purge, Stats Lake

## Debugging Cache

```bash
# Check profile and cache status
curl -s -D - -o /dev/null "https://site.com/category-slug" | grep -iE "cache-control|x-cache"

# Expected first hit:
# cache-control: public, max-age=30, s-maxage=120, stale-while-revalidate=300, stale-if-error=1800
# x-cache: MISS
# x-cache-profile: listing

# Expected second hit (served from the Worker's Cache API; HTML is sent with
# CDN-Cache-Control: no-store, so cf-cache-status will not say HIT):
# x-cache: HIT

# Purge cache
curl -X POST "https://site.com/_cache/purge" \
  -H "Authorization: Bearer $PURGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths": ["/", "/vedacao-externa"]}'
```

**Important**: Use GET requests for testing (not `curl -I` which sends HEAD). The worker-entry only caches GET requests.


## Cache Analysis & Debugging with Stats Lake

Deco sites emit CDN usage data to a ClickHouse stats-lake. This enables cache performance analysis:

```sql
-- Cache status breakdown for a site
SELECT
  JSONExtractString(extra, 'cacheStatus') AS cache_status,
  count() AS requests,
  round(count() * 100.0 / sum(count()) OVER (), 2) AS pct
FROM fact_usage_daily
WHERE site_id = <site_id>
  AND date >= today() - 7
GROUP BY cache_status
ORDER BY requests DESC;
```

### Understanding "unknown" Cache Status

When the Cloudflare Worker uses `caches.default.match()/put()` to serve cached responses internally, the outer CDN reports `cf-cache-status: DYNAMIC` because the Worker is the origin. The stats-lake logs this as "unknown" or empty.

So "unknown" says nothing about the Worker's cache: it accompanies Worker HITs, MISSes and BYPASSes alike (HTML is sent with `CDN-Cache-Control: no-store`). A high "unknown" share is not a caching problem, but it is not a hit rate either.

To measure the Worker's cache, use its own decision:
1. Check the `X-Cache` header (set by the worker-entry): `HIT`, `STALE-HIT`, `STALE-ERROR`, `MISS` or `BYPASS`
2. Check `X-Cache-Profile` header (shows which profile was detected)
3. Query stats-lake grouping by `cacheStatus` AND response status codes

### Comparing Staging vs Production Cache

When migrating to TanStack Workers, compare cache metrics:
- Production (Deno/Fresh on Kubernetes) typically shows high HIT rates because traffic volume keeps caches warm
- Staging Workers may show lower HIT rates due to lower traffic, plus "unknown" status from internal Cache API
- Do not count "unknown" requests on Workers as hits — they include Worker misses and bypasses; compare `X-Cache` (or `deco.cache.requests{layer="edge"}`) instead
