# A/B tests and campaigns

Two kinds of rule are content in v8, each read from one saved block:

| Rule | Saved block | Its type | What it holds |
|---|---|---|---|
| `experiment { name }` | `experiments` | `split-traffic` | Each test's name and the whole percentage of visitors in it (0 to 100) |
| `campaign { name }` | `campaigns` | `calendar` | Each campaign's name and one window, `{ start?, end? }` |

Code: `packages/blocks/src/v8/builtins/experiments.ts`, `builtins/campaigns.ts`, and `packages/blocks/src/v8/experiments.ts` (exported as `@decocms/blocks/experiments`).

## A/B tests

In `.deco/blocks/experiments.json`:

```json
{ "__resolveType": "split-traffic", "promo-copy": 30, "new-header": 0 }
```

```json
{ "rule": { "__resolveType": "experiment", "name": "promo-copy" },
  "value": { "__resolveType": "lazy", "value": "…variant B…" } }
```

Put the control last, under `always`.

### How a visitor is assigned

- A visitor has an id: 16 random bytes as 22 base64url characters, stored in the `deco_vid` cookie for a year. The cookie is not `HttpOnly`, so an analytics script can read it.
- For each test, the visitor's roll is a hash of `<test name>:<id>` (MurmurHash3, in `bucketing.ts`), a fixed number from 0 to 99.99. The visitor is in the test when the roll is below the percentage.
- Nothing per test is stored. One id serves every test, a new test needs no new state, and two tests are independent of each other, unless one is named within the other (see [A test within a test](#a-test-within-a-test)).
- The decision is the same on a server, in a browser and in an app: `assign(experiments, visitor)` is a pure function.

What follows from that:

- **Ramping only adds people.** Moving 10 to 30 keeps everyone who was in and adds more. The roll does not move, the threshold does.
- **Renaming a test re-draws everyone.** The name is part of the hash.
- **0 is off, 100 is everyone.** A fractional percentage is rounded. An entry that is not a finite number is left out.
- **No visitor, no test.** A client created without a visitor has every test off, unless the test is given to it.

### A test within a test

A name written `<parent>/<child>` is drawn only among the visitors in `<parent>`, so a test can split its own arm without touching the other one. For 50% control and the other 50% split evenly between two variants:

```json
{ "__resolveType": "split-traffic", "plp-optimizer": 50, "plp-optimizer/b": 50 }
```

```json
{ "__resolveType": "multivariate",
  "variants": [
    { "rule": { "__resolveType": "experiment", "name": "plp-optimizer" },
      "value": { "__resolveType": "lazy", "value": {
        "__resolveType": "multivariate",
        "variants": [
          { "rule": { "__resolveType": "experiment", "name": "plp-optimizer/b" },
            "value": { "__resolveType": "lazy", "value": "…variant B…" } },
          { "rule": { "__resolveType": "always" },
            "value": { "__resolveType": "lazy", "value": "…variant A…" } } ] } } },
    { "rule": { "__resolveType": "always" },
      "value": { "__resolveType": "lazy", "value": "…control…" } } ] }
```

- The child's percentage is a share of the parent's visitors: `plp-optimizer/b: 50` is 25% of all traffic. The child keeps its own roll, so ramping `plp-optimizer` to 80 gives 20/40/40 and keeps everyone already in A or B where they were.
- The child is off for every visitor outside the parent, whatever it is given: switching on only `plp-optimizer/b` in a preview shows the control to a visitor outside `plp-optimizer`. Switch both on to see B, the parent on and the child off to see A. The parent alone shows the visitor's own arm of the child.
- **A name already saved with a `/`** whose prefix is also a test now runs within it. `deco check` warns on every test it reads that way: rename one if the two are separate tests.
- The parent is the nearest prefix before a `/` that is a test of the same block (`a/b/c` falls back to `a` when there is no `a/b`). A `/` in a name whose prefix is no test changes nothing.
- Nothing else changes: the header, the cache key and the preview link carry the child as one more test.

### Who reads the visitor

The binding does it, once per request. On `@decocms/tanstack`, `createDecoWorker` calls `readVisitor(request)` (the cookie, or a new visitor), decides every test and campaign, and hands both to the app on the `x-deco-visitor` and `x-deco-assignments` headers. It removes any copy of those headers sent from outside. `contentClient(cms)` from `@decocms/tanstack/server` builds the client from them, so the page decides nothing again. On `@decocms/nextjs`, the proxy does the same with `decideVisitor` and `rewriteToAssignmentsRoute` (or `decideAssignments`) from `@decocms/nextjs/proxy`. The cookie goes out only on a first visit, and never from a preview.

Code outside a binding (a mobile app, a script) uses the exports of `@decocms/blocks/experiments`: `readVisitor`, `parseVisitor`, `serializeVisitor`, `newVisitor` and `assign`, then passes the visitor to `cms.client({ visitor })`.

### Forcing a test

`cms.client({ experiments: { "promo-copy": true } })` turns a test on (or off with `false`) whatever the visitor and the percentage. A name the saved block does not have stays out. Studio's preview link does this with `__test=<name>=on|off` (see [`draft-preview.md`](./draft-preview.md)).

This gives a safe launch path:

1. Add the test at `0` and the variant behind `experiment { name }`.
2. Preview it with the test switched on.
3. Publish, then raise the percentage.

### Visitors from v7

v8 neither reads nor writes v7's `deco_segment` cookie, so its stored decisions are not honoured: a visitor with only that cookie is a first visit, with a new id, and is drawn again. Move each v7 random test into `experiments` under the same name, so its results keep their name (the `deco-v7-to-v8-migration` skill reports each one); `@decocms/compat-v7` has no `random` to register.

## Campaigns

In `.deco/blocks/campaigns.json`:

```json
{
  "__resolveType": "calendar",
  "black-friday": { "start": "2026-11-27T00:00:00-03:00", "end": "2026-11-30T00:00:00-03:00" }
}
```

```json
{ "rule": { "__resolveType": "campaign", "name": "black-friday" }, "value": { "__resolveType": "lazy", "value": "…" } }
```

- A window runs from `start` (inclusive) to `end` (exclusive). An empty or missing bound is open.
- A bound must be an ISO 8601 date-time with an offset (`Z` or `±hh:mm`). A date alone, a date-time without an offset, a day the calendar does not have or a free-text date reads as "never". `deco check` reports such a bound as an error and suggests a fix. Write the store's own offset.
- The moment checked is the client's `date`: `cms.client({ date })`, or when the client was created. A preview can set it with `__at` (see [`draft-preview.md`](./draft-preview.md)).
- `cms.client({ campaigns: { "black-friday": true } })` forces a campaign on or off, like a test.
- There are no inline dates on a rule. A `campaign` rule always names a campaign, so all date logic lives in one block. v7's date matcher has no alias: the migration renames it to `date`, and `deco check` reports every `date` rule with how to move it into `campaigns`.

### Recurring schedules

v7's cron matcher has no v8 counterpart. Write each occurrence as its own window, or write a custom rule that reads `currentClient().date` (see [`custom-matchers.md`](./custom-matchers.md)). A custom date rule is not part of the assignments the cache keys on, so read [`caching-variants.md`](./caching-variants.md) first.

## `deco check` messages

| Message | Fix |
|---|---|
| `no test "<name>" in the saved block "experiments": this rule is always false` | Add the test to `experiments`, or fix the name |
| `no campaign "<name>" in the saved block "campaigns": this rule is always false` | Add the campaign, or fix the name |
| `this campaign rule names no campaign, so it is always false` | Set `name` |
| `the campaign "<name>" starts at "…"` (or `ends at`), followed by `a date without a time or offset`, `which has no offset` or `which isn't written as a campaign reads it`, then `so it never runs` | Write the bound as the message suggests: date, `T`, time and offset |
| `unknown block type "date"` | Move the rule to `campaign` as the message says |

## Reading the results

v8 decides who sees what. It does not record conversions. Send the arm with every event:

- With `startAnalytics({ experiments })` from `@decocms/blocks/analytics/client`, pass the map that decided the page (on TanStack, `requestAssignments(request)?.experiments` from `@decocms/tanstack/server`; never on a preview). Every event then carries each test as `on` or `off` in `exp`. A child test is sent only while its parent is on, so `plp-optimizer` compares control with both variants, and `plp-optimizer/b` compares B with A with no filter to remember.
- On any binding, the page's own client gives the same answer: `const [tests] = await client.resolve("experiments")` gives each test's name and `true` or `false`, never a percentage.
- In the browser, the `deco_vid` cookie holds the visitor; `parseVisitor` and `assign` from `@decocms/blocks/experiments` give the same answer as the server for a given `experiments` block.

Count users, not sessions: the id is per visitor. Then use the `ab-testing` skill in decocms/skills to plan the sample size, check the sample ratio and read significance.
