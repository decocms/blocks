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

- A visitor has an id: 16 random bytes as 22 base64url characters, stored in the `deco_segment` cookie for a year. The cookie is not `HttpOnly`, so an analytics script can read it.
- For each test, the visitor's roll is a hash of `<test name>:<id>` (MurmurHash3, in `bucketing.ts`), a fixed number from 0 to 99.99. The visitor is in the test when the roll is below the percentage.
- Nothing per test is stored. One id serves every test, a new test needs no new state, and two tests are independent of each other.
- The decision is the same on a server, in a browser and in an app: `assign(experiments, visitor)` is a pure function.

What follows from that:

- **Ramping only adds people.** Moving 10 to 30 keeps everyone who was in and adds more. The roll does not move, the threshold does.
- **Renaming a test re-draws everyone.** The name is part of the hash.
- **0 is off, 100 is everyone.** A fractional percentage is rounded. An entry that is not a finite number is left out.
- **No visitor, no test.** A client created without a visitor has every test off, unless the test is given to it.

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

The cookie keeps v7's name and format. A v7 visitor gets an id on their next visit, and v7's stored decisions are honoured while the percentage they were made at holds. After it moves, a v7 visitor in a test that grows stays in, and one out of a test that shrinks stays out. To keep a v7 random test's groups, move it into `experiments` under the same name (the `deco-v7-to-v8-migration` skill reports each one). Do not also register v7's `random` matcher: two writers of `deco_segment` undo each other.

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
- There are no inline dates on a rule. A `campaign` rule always names a campaign, so all date logic lives in one block. v7's date matcher and the prerelease `date` rule have no alias; `deco check` says how to move each one.

### Recurring schedules

v7's cron matcher has no v8 counterpart. Write each occurrence as its own window, or write a custom rule that reads `currentClient().date` (see [`custom-matchers.md`](./custom-matchers.md)). A custom date rule is not part of the assignments the cache keys on, so read [`caching-variants.md`](./caching-variants.md) first.

## `deco check` messages

| Message | Fix |
|---|---|
| `no test "<name>" in the saved block "experiments": this rule is always false` | Add the test to `experiments`, or fix the name |
| `no campaign "<name>" in the saved block "campaigns": this rule is always false` | Add the campaign, or fix the name |
| `this campaign rule names no campaign, so it is always false` | Set `name` |
| `the campaign "<name>" starts at "…", which isn't written as a campaign reads it, so it never runs` (or `ends at`) | Write the bound with a time and an offset |

## Reading the results

v8 decides who sees what. It does not record conversions, and its analytics module does not add the test arm to events. Send the arm yourself:

- On TanStack, `requestAssignments()` from `@decocms/tanstack/server` returns each test on or off for the request, as the worker decided it. Pass the arms the page rendered to your analytics events.
- On Next.js, the assignments route's segment names the tests the page rendered.
- In the browser, the `deco_segment` cookie holds the visitor; `parseVisitor` and `assign` from `@decocms/blocks/experiments` give the same answer as the server for a given `experiments` block.

Count users, not sessions: the id is per visitor. Then use the `ab-testing` skill in decocms/skills to plan the sample size, check the sample ratio and read significance.
