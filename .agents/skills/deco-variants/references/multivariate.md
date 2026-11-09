# The `multivariate` block

`multivariate` is a built-in block (`packages/blocks/src/v8/builtins/multivariate.ts`). Its `variants` is a list of `{ rule, value }`. The result is the value of the first variant whose rule resolves to `true`, or `undefined` when no rule does.

## Shape

```json
{
  "__resolveType": "multivariate",
  "variants": [
    { "rule": { "__resolveType": "campaign", "name": "black-friday" },
      "value": { "__resolveType": "lazy", "value": "Black Friday: up to 70% off" } },
    { "rule": { "__resolveType": "always" },
      "value": { "__resolveType": "lazy", "value": "Free shipping over $50" } }
  ]
}
```

- `rule` is any block whose function returns a boolean (or a promise of one). In Studio's schema the rule field points at the `matchers` group, which holds every block function `deco schema` sees returning a boolean.
- `value` is wrapped in a `lazy` block. The TypeScript type is `Variant<T> = { rule: boolean; value: Lazy<T> }`, exported from `@decocms/blocks`, with `Lazy<T> = () => Promise<T>`. The wrapper is what makes only the winning value resolve. A section, a loader or a fetch inside a losing variant never runs.
- The value can be anything a field can hold: a section, a string, a list, a loader call, another `multivariate`.
- A `multivariate` can sit anywhere a value can: as a page section, inside one field of a section (a single title), or as a saved block of its own.
- The optional `experiment` field (a string, "the stable ID of an A/B test" in the schema) is not read by the runtime. The rules decide.

`deco check` reports a value saved without the `lazy` wrapper: "a variant's value must be a lazy block". At runtime such a value is returned as is instead of failing the page, but it was resolved before the rules ran, so every variant's value did its work.

## How it resolves

The resolver treats `multivariate` as a special case (`packages/blocks/src/v8/resolver.ts`, `#resolveFirstMatch`):

1. The other fields resolve as usual.
2. The variants resolve one at a time, in order. For each one, the rule resolves first.
3. At the first rule that is `true`, it stops. Later variants are left out, so their rules never run.
4. The function gets the variants up to the winner and calls the winner's lazy value.

What follows from that:

- **Order is the logic.** Narrow rules first, `always` last. A `never` rule is how the editor hides a variant.
- **No fallback, no value.** Without an `always` at the end, a visitor that matches nothing gets `undefined`. Sometimes that is the goal ("desktop only"), often it is a bug.
- **Later rules have no side effects.** A rule after the winner never runs. With v7's sticky `random`, that means no draw and no cookie for that test on this request, as in v7.
- **Rules run in sequence, not in parallel.** Each async rule waits for the one before it. A slow rule early in the list delays the whole slot. The built-in `experiment` and `campaign` read a saved block once per client, however many rules ask.
- **Results are memoized per request.** The resolver keeps one result per block function and inputs for the life of a client, so two identical rules on one page run once. Treat results as read-only.
- **A rule that throws fails the block** with `BLOCK_FAILED`. v7's matchers from `@decocms/compat-v7/matchers` catch their own errors and answer `false`, as v7 did. A site's own rule should do the same if a failure should mean "no match" (see [`custom-matchers.md`](./custom-matchers.md)).

## Rules as saved blocks

A rule can be a saved block, reused by name. A saved block named `Hero test` with `{ "__resolveType": "experiment", "name": "hero" }` is used as:

```json
{ "rule": { "__resolveType": "Hero test" }, "value": { "__resolveType": "lazy", "value": "…" } }
```

The resolver merges `{ ...saved, ...arguments }` and looks the type up again, so a reference can override the saved inputs. `deco check` follows the reference when it checks the `name` of an `experiment` or `campaign` rule.

## Replacing the built-in

A key named `multivariate` in the site's block map replaces the built-in. It is then an ordinary block: every rule resolves before the function runs, and the first-match short-circuit is gone. Do not do this unless you need every rule's result.

## Content from v7 and Fresh

The well-known legacy names resolve without a block-map entry (`packages/blocks/src/v8/builtins/legacy.ts`):

| Legacy type | Built-in |
|---|---|
| `website/flags/multivariate.ts` | `multivariate` |
| `website/flags/multivariate/section.ts` | `multivariate` |
| `website/matchers/always.ts` | `always` |
| `website/matchers/never.ts` | `never` |

Under a legacy name, values are saved plain, and the runtime wraps each in `lazy` on the way in, so only the winner runs there too.

The other per-kind flag types (image, message, page and so on), the `$live/…` names and v7's date matcher have no alias. The one-time migration rewrites them (the `deco-v7-to-v8-migration` skill). v7's other matchers are in [`v7-matchers.md`](./v7-matchers.md).

In v7 a "custom flag type" was a file per value type. v8 has no such files: `multivariate` is generic over its value, so there is nothing to write per type.

## Symptoms

| Symptom | Likely cause |
|---|---|
| The slot is empty for some visitors | No `always` variant at the end |
| The second variant never shows | An `always` (or a rule that is always true) sits above it |
| Every variant's loader runs | Values saved without `lazy`; run `deco check` |
| `UNKNOWN_BLOCK` on a rule | A v7 matcher that is not registered (see [`v7-matchers.md`](./v7-matchers.md)), or a saved rule that was deleted |
| `deco check`: "no test … this rule is always false" | The test name is not in the saved block `experiments` (see [`experiments-and-campaigns.md`](./experiments-and-campaigns.md)) |
| Variant right on a fresh load, wrong from cache | A rule reads something the cache key does not hold (see [`caching-variants.md`](./caching-variants.md)) |
