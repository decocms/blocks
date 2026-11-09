# Worker runtime: memory, shared state, deadlines, observability

A Worker isolate has **128 MB**, serves many requests at once, and can be
recycled at any time. Whatever was fine in a long-lived server process is a
risk here. These checks apply to a TanStack site behind `createDecoWorker`
from `@decocms/tanstack/worker`. On Next.js, see **deco-nextjs-site** for the
runtime it deploys to.

## Memory: 128 MB per isolate

What filled memory on storefronts that went live:

| Symptom | Root cause | Fix |
|---|---|---|
| `exceededMemory` at go-live (~147 MB resident) | the whole content (~9.6 MB of JSON, far more once parsed) in the bundle **and** a second copy loaded at runtime | one copy only. On v8, `createCMS({ site })` keeps content out of the bundle |
| OOM on one landing page | a block asked the commerce API for `count: 100`: an 11 MB response, ~90 MB of objects | cap counts in code (≤ 48) and include the cap in the cache key |
| OOM on the sitemap (two stores) | `await upstream.text()` and `replaceAll` on the whole XML | stream: `new Response(upstream.body)` or a `TransformStream` |
| Redirect table in memory (~18k rows) | the table bundled as code | keep it in the redirects block (content), not in a bundled module |

What v8 itself holds per isolate: hosted block bodies in an LRU bounded at
32 MB of JSON text (parsed objects take more), and the release index. Measure
the rest.

```bash
ls -la dist/server/ 2>/dev/null; find dist -name '*.js' -size +2M 2>/dev/null   # anything big in the bundle?
grep -rnE "\.deco/blocks/[^\"']+\.json|blocks\.gen" src                       # content bundled into the worker
grep -rnE "\.text\(\)" src | grep -iE "sitemap|proxy|upstream"                 # large bodies buffered
grep -rhoE '"count":\s*[0-9]+' .deco/blocks | sort | uniq -c | sort -rn | head  # big counts in content
```

Go-live gate: memory under about 80% of the limit during a load test on the
candidate. Raising the memory limit hides the cause; find what fills memory.

## Module-scope state leaks between users

One isolate serves many users at once. One store leaked **personal data**
because `new QueryClient()` sat at module scope in `src/router.tsx`.

```bash
grep -rn "new QueryClient" src/          # must be inside getRouter(), passed through createDecoRouter({ context })
grep -rnE "^(export )?(const|let) [a-zA-Z_]+ = new (Map|Set|WeakMap)\(" src/ | grep -v test
```

A module-level `Map` or cache may hold only data that is the same for every
user. Test with two session cookies against one warm isolate.

Workers also refuse random values at module scope ("Disallowed operation
called within global scope"). Draw them on the first request, as
`abTestingRoutes` does with its token.

## Deadlines on every await

Symptom: a 524 after about 100 s with ~1 ms of CPU (`outcome=canceled`).

| Cause | Fix |
|---|---|
| upstream fetch without a deadline | `createInstrumentedFetch` from `@decocms/blocks/fetch` retries and breaks circuits (`retry`, `circuitBreaker`), but has no timeout of its own: pass `signal: AbortSignal.timeout(…)` per call (for example 20 s for data, longer for a proxied checkout) |
| site cache or KV read that stalls | race it against a short deadline; a timeout is a miss |
| a module-level single-flight map whose owner request went away | give joiners a deadline and drop the entry past it; keep the owner's work alive with `ctx.waitUntil` |
| background work that needs `env` | capture what it needs during the request |

The framework's own shared content fetches follow these rules: each has 10 s,
stays alive through the platform's `waitUntil` whoever started it, and a
request that joins one waits no longer than its deadline (then the next
request fetches again). The v8 guide's `wrangler.jsonc` sets
`no_handle_cross_request_promise_resolution`; with that flag, a promise one
request awaits from another request's work can hang, so your own shared maps
need the same deadlines.

```bash
grep -n "compatibility_date\|compatibility_flags" wrangler.jsonc
grep -rnE "AbortSignal\.timeout|signal:" src | wc -l       # zero is a finding
grep -rn "createInstrumentedFetch" src
```

## Observability

You cannot see `exceededMemory`, `canceled` or the 524 pattern without it.

- [ ] Workers observability on in `wrangler.jsonc` (`"observability": { "enabled": true }`) and `wrangler tail` works against the candidate.
- [ ] The CMS telemetry on: `createCMS({ site, token })` or a `telemetry.endpoint`. Without either, the request metric and the upstream metric go nowhere ([content-releases.md](./content-releases.md#telemetry)).
- [ ] `telemetry.resource` sets `service.version` to the commit, so a code rollback is visible.

## Framework bumps

- Compare memory P50 and P99 before and after **every** `@decocms/*` bump. On v7 one minor bump added 27 MB.
- Bump all `@decocms/*` packages together, and check that one copy of each is installed (`bun pm ls | grep @decocms`, or your package manager's equivalent). Mixed versions run code the bump was not tested with.
- Re-run `deco schema` and `deco check` after a bump: the schema generator changes with the CLI.

## Portability and CI

- Keep platform bindings behind the site's own small interfaces, so the site can move to another runtime if a platform limit is hit.
- Do not hand out write access to the Worker's dashboard or CI: a commit there can bind another store's namespaces.
- Know how a content-only change reaches production: with `site`, a publish; without it, a deploy.
