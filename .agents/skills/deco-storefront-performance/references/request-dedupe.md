# Duplicate upstream calls in one page

Load when: the same upstream operation runs several times for one page; two sections
fetch the same product; you need to count calls before and after a change.

On a v7 storefront, removing duplicates cut a product page from 40+ VTEX calls to about 8.
v8 already removes some duplicates for you. Know which ones before you write code.

## What the client dedupes for you

A client (`cms.client(...)`, or `contentClient(cms, request)` on TanStack) runs each
block function **once per distinct input**. The memo key is the function plus its inputs
in canonical form (key order does not matter). Every other occurrence in the same client
gets the same promise and the same result object. So a product loader named by the PDP
section and by the SEO block, with equal props, runs once.

It stops working when:

| Case | Why | Fix |
|---|---|---|
| Inputs differ by one prop (`count: 12` vs `count: 24`, an extra facet) | Different key | Make them equal, or have one block take the larger result and slice |
| Code calls a client or a helper directly instead of naming a block in content | The memo only sees blocks the resolver runs | Make the shared data a block, or memoize per request (below) |
| Two clients for one request (one in the page loader, one in another loader or server function) | The memo belongs to one client | Create one client per request and pass it down |
| Two requests (hover prefetch then click, the page then a server function) | Nothing is shared between requests | An upstream cache: `deco-storefront-caching` |
| An input holds a value with no canonical form (a function, a class instance) | No key, so no memo | Keep block inputs plain JSON |

Results are shared, so they are read-only. Copy before you change one: an in-place edit
changes every other place that got the same object.

## Make equal blocks equal: save the loader once

When several sections call the same loader with the same props, save that loader as one
named block and reference it from each section, instead of repeating the props inline:

```jsonc
// the saved block "Shelf - Best sellers"
{ "__resolveType": "product-list", "collection": "334", "count": 12 }

// in each section that needs it
"products": { "__resolveType": "Shelf - Best sellers" }
```

A reference resolves to `{ ...saved, ...overrides }`. With no overrides, every reference
reaches the loader with identical inputs, so the client runs it once. An override in one
place (a different `count`) makes a second call there, which is what you want.

This also stops the copies drifting apart when someone edits one of them in Studio.

## Memoize code that is not a block, per request

A helper called from several block functions (`getProductBySlug` used by the PDP section
and the breadcrumb) does not go through the memo. Key a memo on the current client, which
is one per request:

```ts
// src/perRequest.ts
import { currentClient, type Client } from "@decocms/blocks";

const memos = new WeakMap<Client, Map<string, Promise<unknown>>>();

/** Runs `load` once per request for `key`. Call it from inside a block function. */
export function oncePerRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  const client = currentClient();
  let memo = memos.get(client);
  if (!memo) memos.set(client, (memo = new Map()));
  let pending = memo.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = load();
    memo.set(key, pending);
  }
  return pending;
}
```

`currentClient()` returns the client that is running the block function. It works before
the function's first `await` everywhere, and across `await` where the runtime has
`AsyncLocalStorage` (Workers with `nodejs_compat`). Outside a block function it throws.
The `WeakMap` lets the memo go with the client at the end of the request. Do not use a
module-level `Map` keyed by URL instead: it is shared by every request in the isolate,
never expires, and mixes shoppers.

Do not memoize shopper-scoped calls (cart, session, anything sent with the shopper's
cookie) under a key that leaves the cookie out.

## Count the calls

Do this before and after every change. Three ways, from quickest to most complete.

**Dev: log every upstream call.** The thin clients take a `fetch` option. Pass a wrapper:

```ts
// src/clients/vtex.ts
import { createVtexClient } from "@decocms/apps-vtex";

const logged: typeof fetch = async (input, init) => {
  const t0 = performance.now();
  const response = await fetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  console.log(`[upstream] ${init?.method ?? "GET"} ${url.pathname} ${response.status} ${Math.round(performance.now() - t0)}ms`);
  return response;
};

export const vtex = createVtexClient({ account: "mystore", fetch: import.meta.env.DEV ? logged : undefined });
```

The option is documented as the fetch underneath, for tests. It sits below the client's
retry, so a retried call logs one line per attempt. Load one page and sort the lines:
`sort | uniq -c | sort -rn`. One line per operation is
the goal. Several lines with the same path is a duplicate; one line per product is an N+1
([`loaders-n-plus-1.md`](./loaders-n-plus-1.md)). Never log query strings or cookies to a
shared log.

**Production: the client metric.** Every `@decocms/apps-*` client measures each request
once as `http.client.request.duration`, labelled `provider`, `operation` (for VTEX, a
stable name such as `intelligent-search.product_search` or `catalog.crossselling.similars`),
`status_class`, `cached` and `retries`. The worker records `http.server.request.duration`
with `http.route`. Over the same window, calls of one operation divided by page requests
of one route is the calls-per-page ratio. It is an estimate when several routes use the
operation. Both metrics need a telemetry destination on `createCMS` (a `token`, or a
`telemetry.endpoint`).

**Browser: a HAR.** Upstream calls made on the server never appear in the browser. A HAR
shows the other half: `/_serverFn/` requests (one per client-side navigation or prefetch)
and calls client components make straight to the commerce API (cart, simulation).

```python
import json, collections, sys
entries = json.load(open(sys.argv[1]))["log"]["entries"]
count = collections.Counter(
    e["request"]["url"].split("?")[0] for e in entries
    if "/_serverFn/" in e["request"]["url"] or "/api/" in e["request"]["url"]
)
for url, n in count.most_common(20):
    print(f"{n:4}x {url}")
```

Record the HAR with a script (Playwright's `recordHar`) rather than by hand, so the before
and after runs do the same clicks. Do not wait on `networkidle`; wait for a selector.

## Typical duplicates on a VTEX store

| Symptom | Usual cause | Fix |
|---|---|---|
| Same product search 2-4 times on a PDP | PDP section, related products and breadcrumb each resolve the product | One loader block, referenced by each (above), or `oncePerRequest` |
| Same cross-selling call twice | Two shelves for the same product and type | Same block, same inputs |
| Simulation once per card | Per-item call | Batch into one `items` array ([`loaders-n-plus-1.md`](./loaders-n-plus-1.md)) |
| `/_serverFn/` twice for one click | Hover prefetch with different search params than the click | [`navigation-ux.md`](./navigation-ux.md) |
