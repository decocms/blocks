# Cache storage

The app chooses storage once per request. Framework response, loader, fetch,
section, layout, site-global and deferred-prop caches use that adapter through
`RequestContext`. The core does not discover Cloudflare bindings.

```ts
import { createKVCacheStorage, type CacheKVNamespace } from "@decocms/blocks/sdk/cacheStorage";
import { createDecoWorkerEntry } from "@decocms/tanstack";

export default createDecoWorkerEntry(serverEntry, {
  cacheStorage: (env) => createKVCacheStorage(env.CACHE as CacheKVNamespace),
  // Keep the site's existing buildSegment implementation: it identifies
  // authenticated visitors and separates public catalog variants.
  buildSegment,
});
```

Bind `CACHE` to a KV namespace in Wrangler. An existing namespace can be reused;
`createKVCacheStorage` prefixes its hashed keys with `deco-cache:v1:`. Its second
argument supplies a different prefix when multiple apps share a namespace.

The portable contract is:

```ts
interface CacheStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiresAt: number): Promise<void>;
  delete(key: string): Promise<void>;
}
```

`expiresAt` is an absolute Unix timestamp in milliseconds. Adapters must return
`null` for expired entries. `get` returns serialized data; framework consumers
handle JSON or HTTP response serialization. An S3 adapter can implement the same
contract by storing an expiration alongside the value and checking it on reads.
It need not support listing, locks, transactions or namespace purging.

Built-in adapters are `createKVCacheStorage`, `createWebCacheStorage` and
`createMemoryCacheStorage`. The Web Cache API adapter receives a native cache and
origin explicitly. Only the TanStack composition layer checks `caches.default`
for the backwards-compatible default. Omitting `cacheStorage` retains Web Cache
API response caching and memory-only data caching. Returning `null` opts out of
shared storage without selecting a different backend.

For another server integration, call `bindCacheStorage({ storage, scope,
waitUntil })` inside `RequestContext.run`. Scope must identify the site and code
version; include content revision and any public request variants as needed.
Bindings must not be assigned to a process-wide mutable variable.

## TTL and freshness

All shared entries have a finite TTL. KV enforces at least 60 seconds of physical
retention; the adapter also stores the exact expiration timestamp, so a five-second
entry stops being served after five seconds. Reads never renew that timestamp.
Cloudflare documents the [expiration minimum and write limits](https://developers.cloudflare.com/kv/api/write-key-value-pairs/).

HTTP retention is `fresh + max(swr, sie)` from the existing cache profile. Upstream
fetches retain their configured fresh and stale windows. Cached loaders and
cacheable sections have a bounded `staleWhileRevalidate` option, defaulting to five
minutes after their fresh period. Layouts and site globals retain five minutes;
deferred raw props retain two minutes.

TanStack scopes data entries by origin, deployment, CMS revision and public
segment/geo information. Existing response keys retain their URL, segment, geo and
request-body variation. A deployment or CMS edit selects new keys; old entries
expire by TTL. There is no distributed invalidation coordinator.

`/_cache/purge` deletes the requested response keys through the configured
adapter. KV deletion/update visibility follows [KV's eventual consistency](https://developers.cloudflare.com/kv/api/read-key-value-pairs/).
The existing `clearLoaderCache`, `clearFetchCache` and `/_cache/purge-loaders`
operations clear the local memory tier only. KV can hydrate it again until TTL
expires. They are not global purges.

## Memory and request safety

`createCacheStore` holds a bounded decoded memory tier in front of the injected
adapter. Its defaults are 200 entries and 4 MiB of estimated JSON bytes. The
commerce loader cache keeps its existing configurable byte cap. Cache statistics
refer to local entries, not the entire KV namespace.

Refresh promises and in-flight deduplication remain local. Storage writes and
refreshes are registered with `waitUntil`; storage failures become misses or
skipped writes. The framework does not require KV to coordinate concurrent
refreshes across isolates.

Loader/section payloads must be JSON-compatible to persist. Dates, class instances,
functions and cyclic objects remain local rather than silently changing type in
KV. HTTP responses preserve their body bytes, headers and status through a
separate serializer, with an 8 MiB body limit for buffering. Authenticated and preview requests bypass shared and local
data caches. The site's `buildSegment` must continue identifying its auth cookies;
the framework cannot infer arbitrary application sessions.

CMS block definitions remain under `BlockSource`. They are the source of content,
not disposable computed cache entries. Registries and request-local resolver memo
maps likewise do not go through shared storage.
