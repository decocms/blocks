# The worker page cache

`@decocms/tanstack/worker` gives you `createDecoWorker` and the helpers a cache needs. It stores
nothing itself. The cache is a function you pass as `pageCache`. The repo ships a complete one in
`examples/tanstack-worker-smoke/src/worker-entry.ts` (the package README links it): v7's edge
cache rebuilt on the Cloudflare Cache API. Copy it to `src/worker-entry.ts` and own it.

## Wiring

```ts
// src/worker-entry.ts — wrangler.jsonc "main": "./src/worker-entry.ts"
import { createDecoWorker } from "@decocms/tanstack/worker";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { cms } from "./cms";

const worker = createDecoWorker<Env>({
  serverEntry: createServerEntry({ fetch: handler.fetch }),
  cms,
  dev: import.meta.env.DEV,
  pageCache, // your function; without it every request renders
});
```

- `wrangler.jsonc` `main` must point at this file. If it points at TanStack Start's entry, the
  worker and your cache never run.
- `__BUILD_HASH__` comes from `decoTanstack({ buildHash })` in `vite.config.ts`
  (`@decocms/tanstack/vite`): the CI's sha when given, else `git`, else the time; `"dev"` in
  `vite dev`.
- `pageCache` is never called in `vite dev`. Test caching on a build: `vite build`, then
  `vite preview` (Miniflare). The example's `bun run smoke` does exactly that.
- `createStart(() => ({ serverFns: { fetch: decoServerFnFetch } }))` (`@decocms/tanstack/start`)
  is what sends the `__cseg` token back on navigation data. See `deco-tanstack-site`.

## What the worker already does

You do not write these. Do not add a second copy of them in `pageCache`.

| Behavior | Detail |
|---|---|
| Calls `pageCache` only for cacheable requests | `isCacheable`: `GET`, current release (`version === null`), no `?__draft=` (`off` included) and no draft cookie, no `Authorization`, not `/_build`, not dev. A `HEAD` never reaches it. |
| Previews | Always render. Answer `Cache-Control: max-age=0, no-cache, must-revalidate`, `Vary: Cookie`, `noindex`, and `CDN-Cache-Control: no-store`. |
| `Authorization` | The page renders and answers `private, no-cache, no-store, must-revalidate`, whatever the app set. |
| Default CDN header | Any response without `CDN-Cache-Control` leaves with `CDN-Cache-Control: no-store`. |
| Visitor cookie | `deco_segment` is set on a first visit only, and appended after `pageCache` answers. A stored copy never carries it; a visitor served from the cache still gets theirs. |
| `Set-Cookie` | One header per cookie (name + Domain + Path). |
| Fingerprinted assets | `public, max-age=31536000, immutable`, `Vary: Accept-Encoding`. Also under `/fonts/`. |
| CMS redirects | Answered before your `routes` and before `pageCache`. See `egress-traps.md`. |
| v7 admin paths | `/deco/*`, `/live/*`, `/.decofile` answer 404 with a private header. |
| Metric | `http.server.request.duration` with a `cache` label: `HIT` for your `HIT`, `STALE-HIT`, `STALE-ERROR`; `MISS`; `DRAFT` for previews; `BYPASS` otherwise. |

## What `pageCache` receives

`PageCache<Env> = (page: PageRequest<Env>) => Promise<Response>`, where `page` has:

- `request`: as the app gets it (visitor and assignments on their headers).
- `url`, `device` (`detectDevice`: `mobile`, `tablet`, `desktop`), `env`, `ctx`.
- `visitor`: the visitor the worker read.
- `assignments`: each test and campaign on or off, as the page renders them.
- `render(scope?)`: renders the page, with `x-page-status` applied and without the visitor
  cookie. Pass `{ csegToken }` so `DecoDocument` publishes the token.

Set `X-Cache` on your answer (`HIT`, `STALE-HIT`, `STALE-ERROR`, `MISS`, or anything else for a
bypass). The request metric reads it.

## The helpers

All from `@decocms/tanstack/worker`:

| Helper | Use |
|---|---|
| `cacheVersion(cms, buildHash, url?)` | `<build>.<content revision>`. With the URL, the revision that page renders. Right after a publish a page whose new blocks are not loaded yet renders on the previous index, and this pins the same way, so a page is never stored under a revision it did not render. Without the URL (the purge), the current revision. Falls back to the build alone if the content can't be read. |
| `assignmentsKey(assignments)` | `x=<tests on>\|c=<campaigns running>`, names sorted, `""` for none. Never the visitor id. |
| `liveAssignmentKeys(cms)` | Every assignments key a live request can carry now: each subset of the saved tests, with and without the running campaigns. For the purge. Grows as 2^tests. |
| `detectDevice(ua)`, `segmentKey(segment)` | Device class; a segment as one stable string (parts sorted, values URL-encoded, empty parts dropped). |
| `segmentToken(segment, version)` | The `__cseg` token (DJB2 hex of segment and version). `null` when the version is empty or `"dev"`. |
| `CSEG_PARAM` | `"__cseg"`, the query param `decoServerFnFetch` adds. Drop it from the key. |
| `isServerFnPath(pathname)`, `serverFnPagePath(url)` | Server-function URLs (`/_serverFn/`, `/_server/`) and the page a GET page load asks for (first local path in `payload`). |
| `isCacheable(request, { version, dev })`, `requestVersion(request)` | The worker's own gate and the version header. You rarely need them inside `pageCache`. |
| `DEGRADED_HEADER` | `"x-deco-degraded"`. Your page sets it to `true` when a loader it needs failed. Nothing in the framework sets it for you. Also exported from `@decocms/tanstack/server`. |

`markPrivate()` from `@decocms/tanstack/server` sets `Cache-Control: private, no-store` on a server
function called over HTTP (cart, user, wishlist). The example never stores such a response.

## Profiles and TTLs (the example's values)

The example picks a profile per URL, first match wins. These are v7's numbers. Change them in
`PROFILES` and `pageProfile`.

| Profile | Matches | Edge fresh / swr / sie (s) | Browser `Cache-Control` |
|---|---|---|---|
| `private` | `/cart`, `/checkout`, `/account`, `/login`, `/my-account` | never stored | `private, no-cache, no-store, must-revalidate` |
| `none` | `/api/*`, `/deco/*` | never stored | same |
| `static` | `/`, `/sitemap.xml` | 900 / 7200 / 21600 | `public, max-age=120, s-maxage=900, stale-while-revalidate=1800, stale-if-error=7200` |
| `search` | `/s`, `/s/*`, any `?q=` | 60 / 300 / 1800 | `public, max-age=0, s-maxage=60, stale-while-revalidate=120, stale-if-error=600` |
| `product` | path ends in `/p` | 300 / 1800 / 7200 | `public, max-age=60, s-maxage=300, stale-while-revalidate=600, stale-if-error=3600` |
| `listing` | everything else | 120 / 900 / 3600 | `public, max-age=30, s-maxage=120, stale-while-revalidate=300, stale-if-error=1800` |

A GET server function takes its page's profile (`serverFnPagePath`). Any other server function
is `private`.

Why profiles at all (the v7 rationale still holds): product pages change on price and stock, so
they get a short fresh window and a long stale one; listings change with the catalog; search is
long-tail and mostly unique, so it gets the shortest window; `/` is the hottest URL and safest to
keep longest. `listing` is the default because it is the cautious middle.

## How the example serves

- Fresh copy (age < `fresh`): `X-Cache: HIT`.
- Stale copy (age < `fresh + swr`): served as `STALE-HIT` with `X-Cache-Age`, and the page renders
  again in `ctx.waitUntil`. The new render is stored only if it is a clean 200.
- The render throws, or answers 5xx or 429, or is degraded, and a copy younger than `fresh + sie`
  exists: `STALE-ERROR` with `X-Cache-Reason`.
- Otherwise it renders: a clean 200 is stored and answered `MISS`; anything else is `BYPASS`.

The stored copy gets `Cache-Control: public, max-age=<fresh + max(swr, sie)>` so the Cache API
keeps it through the stale windows; the age comes from an `X-Deco-Stored-At` header that is
removed before the answer goes out. `HIT`, `STALE-*` and `MISS` answers carry
`X-Cache-Profile`, `X-Cache-Segment`, `X-Cache-Version` and `Vary: Accept-Encoding`. `BYPASS`
answers carry only `X-Cache` and `X-Cache-Reason`.

What the example never stores:

| `X-Cache-Reason` on a `BYPASS` | Cause |
|---|---|
| `private` | `buildSegment` returned `loggedIn: true` |
| `profile:<name>` | The URL's profile is not public, or its edge `fresh` is 0 |
| `status:<code>` | The render was not a 200 (a CMS 404 page included) |
| `private-response` | `Cache-Control` has `private` or `no-store`, or a `Set-Cookie` outside `SAFE_COOKIES` (`_deco_bucket` in the example) |
| `degraded` | `x-deco-degraded: true` on the render |

A cookie in `SAFE_COOKIES` is stripped from the stored copy, so another visitor never gets it.

## Server functions and the CDN (`__cseg`)

Client-side navigation loads page data with a GET server function. The example keys it like the
page (its payload canonicalized, variant params `skuId` and `idsku` dropped) and stores it in the
Cache API like any page.

It also lets the CDN in front keep that response, which is the only `CDN-Cache-Control: public`
the example sends. That happens only when the request's `__cseg` equals the token recomputed from
this request's segment, version and assignments. `decoServerFnFetch` adds the token the page
published. A stale or forged token gets `CDN-Cache-Control: no-store`. HTML pages always get
`CDN-Cache-Control: no-store` in the example: they are cached in the Worker's Cache API only.

## Purge

The example answers `POST /_cache/purge` with `Authorization: Bearer <PURGE_TOKEN>` (a Worker
secret) and a body `{ "paths": ["/", "/shoes"], "segments"?: [{ "device": "desktop" }] }`.

- It drops each exact path (`/shoes` never drops `/shoes?page=2`) under the current version, for
  each segment (each device when the body names none), each live assignments key, as a navigation
  and as a programmatic fetch. Answer: `{ "purged": [...], "total": n }`.
- It reuses the same `cacheKey` function as the lookup, so the keys match byte for byte. Keep it
  that way when you change the key.
- The Cache API is per data center. A purge reaches the copies in the data center that serves it.
- Each delete is a Cache API call; a request has a limit (the example's comment: 50 on Workers
  Free, 1,000 on Paid). Past it the example answers 503 with `notPurged` to send again.
- You rarely need it for content: a publish changes the content revision, so every key moves.
  Purge is for upstream data (a price change) on pages whose fresh window is long.
