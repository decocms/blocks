---
name: deco-variants
description: "Variants on @decocms/blocks 8: the built-in multivariate block ({ rule, value } with lazy values, first true rule wins, later rules never run), the built-in rules always, never, experiment and campaign, A/B tests as the saved block experiments (split-traffic: a percentage per test, a sticky visitor id in the deco_vid cookie, @decocms/blocks/experiments) and scheduled content as the saved block campaigns (calendar), v7's matchers from @decocms/compat-v7/matchers (device, cookie, host, pathname, queryString, location, multi; v7's random moves to experiments), custom rules in the block map, previewing a variant, a test or a moment from a Studio draft link (__variant, __test, __campaign, __at), and keeping variant pages cacheable (assignmentsKey, one cache entry per set of assignments). Load it for A/B tests, scheduled or segmented content, a variant that never shows or always shows, matcher bugs after a v7 migration, or a variant page that misses the cache."
---

# Variants on @decocms/blocks 8

A variant is a value picked per request by a rule. In v8 that is the built-in block `multivariate`: a list of `{ rule, value }`, where the first rule that resolves to `true` wins and its value is the result. Rules are block functions that return a boolean. Four are built in (`always`, `never`, `experiment`, `campaign`). A site adds more in its block map, or registers v7's from `@decocms/compat-v7/matchers`.

A/B tests and campaign dates are content, not code. The saved block `experiments` (type `split-traffic`) holds each test's percentage. The saved block `campaigns` (type `calendar`) holds each campaign's window. The binding decides both once per request at the edge, and the page cache keys on what it decided.

Code is in `packages/blocks/src/v8/builtins/` (`multivariate.ts`, `matchers.ts`, `experiments.ts`, `campaigns.ts`, `legacy.ts`), `packages/blocks/src/v8/experiments.ts` (the `@decocms/blocks/experiments` export), `packages/blocks/src/v8/variants.ts` and `draft.ts` (previews), and `packages/compat-v7/src/matchers/`.

## When to load what

| Reference | Load it when |
|---|---|
| [`references/multivariate.md`](./references/multivariate.md) | Writing or reading variant JSON; a variant never shows, always shows, or a slot is empty; `deco check` says "a variant's value must be a lazy block"; v7 `website/flags/multivariate*.ts` content |
| [`references/experiments-and-campaigns.md`](./references/experiments-and-campaigns.md) | Setting up an A/B test or a scheduled promotion; ramping a test; a campaign that never starts; `deco check` says "no test" or "no campaign"; tagging analytics with the test arm |
| [`references/v7-matchers.md`](./references/v7-matchers.md) | Content migrated from v7 uses `website/matchers/device.ts`, `cookie.ts`, `location.ts`, `random.ts` and others; `UNKNOWN_BLOCK` on a v7 matcher; wiring `matcherContext`; moving a v7 random test to `experiments` |
| [`references/custom-matchers.md`](./references/custom-matchers.md) | Writing a site's own rule; a rule that needs the request, the visitor or the date; a rule that does not appear in Studio's rule picker |
| [`references/draft-preview.md`](./references/draft-preview.md) | Previewing one variant, a test switched on, or a future date from a Studio link; a preview link that shows the saved content instead |
| [`references/caching-variants.md`](./references/caching-variants.md) | A page with variants misses the cache or shows the wrong variant from cache; deciding whether a rule is safe behind a page cache; purging variant pages |

## The model in one example

```json
{
  "__resolveType": "multivariate",
  "variants": [
    { "rule": { "__resolveType": "experiment", "name": "promo-copy" },
      "value": { "__resolveType": "lazy", "value": { "__resolveType": "promo-banner", "title": "Free shipping on every order" } } },
    { "rule": { "__resolveType": "always" },
      "value": { "__resolveType": "lazy", "value": { "__resolveType": "promo-banner", "title": "Free shipping over $50" } } }
  ]
}
```

With the saved block `experiments` set to `{ "__resolveType": "split-traffic", "promo-copy": 50 }`, half the visitors see the first banner. Each visitor keeps their side across visits.

## Rules of thumb

- Order is the logic. Put narrow rules first and `always` last. With no `always`, a visitor that matches no rule gets `undefined` for that slot.
- Prefer `experiment` and `campaign` over request-reading rules. The binding decides them once at the edge and the page cache keys on them. A rule that reads a cookie, a header or the location changes the page by something the cache key does not hold (see [`caching-variants.md`](./references/caching-variants.md)).
- Keep a test's name stable. A visitor's side is a hash of the test name and their id, so renaming a test re-draws everyone.
- A/B tests live only in the saved block `experiments`. v7's `random` has no port: move each v7 random test there, with `experiment` rules.

## Reading results

v8 decides who is in a test. It does not count conversions. Send the arm with your analytics events (see [`experiments-and-campaigns.md`](./references/experiments-and-campaigns.md#reading-the-results)), then use the `ab-testing` skill in decocms/skills for sample size, significance and sample-ratio checks.

## Related skills

- `deco-v7-to-v8-migration`: registers v7's matchers in the block map, renames legacy flag types, and reports random tests and date rules to move by hand into `experiments` and `campaigns`.
- `deco-storefront-caching`: the site's `pageCache` and its key in full.
- `deco-tanstack-site` and `deco-nextjs-site`: where the worker or proxy that decides assignments is wired.
- `deco-cms-schema`: how a rule's props become its Studio form.
