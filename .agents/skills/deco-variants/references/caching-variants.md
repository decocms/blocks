# Keeping variant pages cacheable

A page with variants can be cached when its cache key holds everything its rules read. v8 is built so that the two content rules, `experiment` and `campaign`, are always in the key. Other rules are the site's job.

This page covers the variant side of caching. The `deco-storefront-caching` skill covers the site's `pageCache` in full.

## What the binding decides

On every page and server-function request, before any cache lookup, the binding:

1. reads the visitor (`readVisitor`: the `deco_vid` cookie, or a new visitor with a fresh id);
2. decides every test of `experiments` and every campaign of `campaigns` for that visitor and that moment;
3. hands those **assignments** to the cache and to the page, which renders exactly them and decides nothing again.

**TanStack** (`createDecoWorker` in `@decocms/tanstack/worker`): the site's `pageCache(page)` gets `page.assignments`. Put `assignmentsKey(page.assignments)` in the key. It is `x=<tests on>|c=<campaigns running>` with names sorted, and `""` when none are on, so visitors on the same side of every test share one entry. The visitor's id is never in it. The visitor's first-visit cookie is added after `pageCache` answers, so a stored copy never carries one visitor's cookie, and a new visitor served from the cache still gets theirs.

**Next.js** (`@decocms/nextjs/proxy`): `rewriteToAssignmentsRoute` rewrites a CMS page to `/_assignments/<assignments>/<path>`. That route renders with `assignedClient(cms, segment)` from `@decocms/nextjs/server`, reads no request, and is cached by ISR once per path and set of assignments. When the content has tests or campaigns, the response to the visitor's own URL is marked `Cache-Control: private, no-cache`, so a CDN in front does not share it by URL alone. A test at 0% stays off on that route even if the segment says on. Answer a direct request to `/_assignments/…` with a 404 (`isAssignmentsRoutePath`).

## Costs to plan for

- **Each running test doubles the entries per page.** With `n` tests the key can take `2^n` values. `liveAssignmentKeys(cms)` lists them all (with the running campaigns and with none). Hit rate falls with every test left running: remove finished tests from `experiments`.
- **A campaign starting or ending moves every page to new entries.** Expect a cold cache at that moment.
- **A test at 0% costs nothing**: nobody is in it, so it never adds a key value in live traffic.

## The cold-visitor problem is gone for `experiment`

On v7, a cached page decided the variant for every new visitor who hit it until the entry expired. All cold visitors in that window saw the same arm, and a busy page could show one arm to hundreds of visitors in a row.

v8's `experiment` rule does not have this problem. Each new visitor gets an id and a roll at the edge before the cache lookup, and the lookup uses their assignments. Two new visitors on different sides read different entries.

## Rule by rule

| Rule | In the key? | What to do |
|---|---|---|
| `always`, `never` | Not needed | Same result for everyone |
| `experiment`, `campaign` | Yes, through `assignmentsKey` | Nothing |
| `device` (compat) | Only if your key has the device | The worker-entry example keys on `detectDevice`; keep it |
| `pathname` (compat) | The path is in the key | Nothing |
| `queryString` (compat) | Depends on your key | The example drops tracking parameters (`utm_*` and the like) from the key, so a rule on them shows one visitor's variant to another |
| `host` (compat) | Depends on your key | The example keys on the full URL, host included. Safe only when your key does too |
| `cookie`, `location` (compat) | No | Add the value to the key, skip caching for those pages, or personalize in the browser |
| A custom rule that reads the request | No | Same as `cookie` |
| A custom rule on `currentClient().date` | No | The page keeps the variant of the moment it was cached until it expires. Use a campaign instead |

## Three ways out for a request-reading rule

1. **Put it in the key.** Add the value to your segment (on TanStack, the segment parts your worker entry builds; the example's `buildSegment` has a region and a sales channel). Keep the number of values small: each one multiplies the entries.
2. **Do not cache those pages.** Return without storing for requests the rule cares about. Fine for low-traffic pages; expensive on the home page.
3. **Personalize in the browser.** Render a neutral page that caches for everyone, then pick the variant in a client component (a location banner, a returning-visitor message). The first paint cannot show the variant, so keep it below the fold or make the swap small.

Signed-in, cart and account content belongs in option 3 or uncached. Never put a shopper's identity in a shared key.

## Checklist: a variant page misses the cache or shows the wrong arm

1. **Is it a preview?** A `?__draft=` link or the draft cookie never reaches `pageCache` (see [`draft-preview.md`](./draft-preview.md)).
2. **Does the response set a cookie?** The worker-entry example never stores a response that sets one (other than `_deco_bucket`). The worker adds the visitor's own cookie after `pageCache`, so that one does not count.
3. **Does a rule read the request?** List the rules on the page (follow saved rule blocks too) and check each against the table above.
4. **How many tests are running?** `2^n` entries per page split the hits.
5. **Is the wrong arm stable for one URL?** A rule reads something that is not in the key. Compare the same URL with two different values of the suspect cookie or header.
6. **Old arm after a change to a test?** Publishing a release changes the content revision in `cacheVersion`, so pages move to new entries on their own. If an old arm persists, check that your key carries `cacheVersion(cms, buildHash, page.url)`. The example's purge (`POST /_cache/purge`) drops a path under every assignments key when you need it sooner.
