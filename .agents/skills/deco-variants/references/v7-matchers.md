# v7's matchers on v8

`@decocms/compat-v7/matchers` has v7's website matchers with v7's results (`packages/compat-v7/src/matchers/`). They are not registered for you. A site that keeps content with v7 matcher types registers each one in its block map under v7's name. Without that, the rule fails with `UNKNOWN_BLOCK`.

Use them for content migrated from v7. For new A/B tests and dates, prefer the built-in `experiment` and `campaign` (see [`experiments-and-campaigns.md`](./experiments-and-campaigns.md)): they are decided at the edge and the page cache keys on them.

## What is there

| Export | v7 type it stands for | Matches |
|---|---|---|
| `device` | `website/matchers/device.ts` | `mobile`, `tablet`, `desktop` ticks, from the user agent (tablet checked first). No tick matches everyone |
| `cookie` | `website/matchers/cookie.ts` | A cookie `name`, with `value` or any value |
| `host` | `website/matchers/host.ts` | The host (`includes`, `match`, or the older `host`) |
| `pathname` | `website/matchers/pathname.ts` | The page's path (`case`, `pattern`, `includes`, `excludes`) |
| `queryString` | `website/matchers/queryString.ts` | Query parameters, with `Exists`, `Equals`, `Greater`, `GreaterOrEquals`, `Lesser`, `LesserOrEquals`, `Includes` |
| `location` | `website/matchers/location.ts` | Country, region, city or coordinates, included or excluded. Reads the `cf-*` headers, then the Workers `request.cf`, then the `__cf_geo_*` cookies |
| `multi` | `website/matchers/multi.ts` | `op: "and"` or `"or"` over its `matchers`. No rules matches everyone |
| `random` | `website/matchers/random.ts` | v7's sticky random: a `traffic` share (0 to 1, default 0.5) keyed on a `cohort` |
| `environment` | `website/matchers/environment.ts` | Always throws: it read the process environment, which no v8 package does. Register your own rule under that name |

`always` and `never` are v8 built-ins, and v7's names for them are aliases (see [`multivariate.md`](./multivariate.md)). v7's date matcher became the `campaign` rule and the saved block `campaigns`.

Not in v8 at all: v7's `cron`, `userAgent`, `site` and `negate` matchers. Write a custom rule if you need one (see [`custom-matchers.md`](./custom-matchers.md)).

Every matcher except `multi` and `environment` takes the request as a second argument, because a v8 block function gets only its inputs. A matcher that throws counts as not matched, as in v7. `multi` gets its inner rules' results, since v8 resolves them before it runs.

## Wiring on TanStack Start

```ts
// the block map
import type { Blocks } from "@decocms/blocks";
import { device, type DeviceProps, random, type RandomProps } from "@decocms/compat-v7/matchers";
import { matcherContext } from "@decocms/compat-v7/tanstack/server";

export default {
  "website/matchers/device.ts": (props: DeviceProps) => device(props, matcherContext()),
  "website/matchers/random.ts": (props: RandomProps) => random(props, matcherContext()),
} satisfies Blocks;
```

- `matcherContext(pageUrl?)` gives the matcher the request being served (TanStack Start's `getRequest()`), the page's URL and one `flags` array per request.
- On a client-side navigation the request is the server-function call, not the page. Pass the page's URL there: `matcherContext(new URL(href, request.url))`. Without it, the call throws instead of matching `/_serverFn/…`.
- After the page resolved, in the page's server function, call `commitSegmentCookie()` to set `deco_segment` with the decisions `random` made. It sets nothing when the cookie already says the same.
- `cohortSegment(request)` gives v7's A/B split of the cache key (`{ abf: <token> }` for a visitor in a test, `{}` otherwise). Spread it into the segment of the site's page cache.

## Wiring on Next.js

```ts
// the block map
import { matcherContext } from "@decocms/compat-v7/nextjs/server";
"website/matchers/random.ts": async (props: RandomProps) => random(props, await matcherContext()),
```

- The matchers need the page's URL. Forward it from the proxy with `pageUrlRequestHeaders` from `@decocms/compat-v7/nextjs/proxy`, or pass it to `matcherContext(url)`.
- Render `<SegmentCookie />` from `@decocms/compat-v7/nextjs/server` as the last child of the page, after the content resolved. A server component cannot set a cookie, so it renders a one-line script (and an effect after a client-side navigation) that sets it.
- A page that reads the request is dynamic: Next never shares it between visitors. Keep a CDN in front from caching it too.

## The sticky `random`

- A visitor keeps their group through `deco_segment` until the traffic share changes, then is drawn again once. The draw is `Math.random()`, as in v7.
- The cookie is keyed on the **cohort**: in v7, the name of the saved matcher block. A v8 block does not know its own name, so the name travels in the `cohort` prop. Set it to the v7 saved block's name. The migration script does not register `random` or fill `cohort`: it reports each random test to move into `experiments`. A random rule written inline uses `website/matchers/random.ts` as its cohort, as v7 did.
- Keep the cohort when changing the share. Renaming it puts every visitor in a new test.
- `decideRandom(props, request)` returns `{ value, isFresh, setCookie }` when you need the decision and the cookie together.
- A response that sets `deco_segment` must not be cached for other visitors.
- Inside `multi`, a `random` is sticky too. v7 drew it again on every request.

The better path for a v7 random test is to move it into the saved block `experiments` under the same name, so visitors keep their groups and the binding owns the cookie. Do not run both on one site.

## The legacy-origin split

v7's `withABTesting` (a split of traffic between the new site and the site it replaces, driven by a KV entry) is `abTestingRoutes` from `@decocms/compat-v7/tanstack/worker`, a handler for `createDecoWorker`'s `routes`. It is a traffic split between two deployments, not a content variant. `packages/compat-v7/README.md` documents it.
