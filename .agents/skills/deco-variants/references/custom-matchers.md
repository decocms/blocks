# Custom rules

A rule is a block function that returns a boolean. A site adds one by adding a key to its block map (the default export of `.deco/index.ts`). There is no matcher kind to declare and no flag to set.

## The smallest rule

```ts
// .deco/index.ts
import { type Blocks, currentClient } from "@decocms/blocks";

interface WeekdayProps {
  /** @title Days (0 = Sunday) */
  days?: number[];
}

/**
 * @title Weekday
 * @description True on the days listed, in UTC.
 */
const weekday = ({ days = [] }: WeekdayProps): boolean =>
  days.includes(currentClient().date.getUTCDay());

export default {
  weekday,
  // …sections and loaders
} satisfies Blocks;
```

Content uses it like any rule: `{ "__resolveType": "weekday", "days": [0, 6] }`.

## How Studio finds it

`deco schema` reads each block function's props type and its awaited return type. A function whose return type is `boolean` (or a promise of one) goes in the `matchers` group, and the `rule` field of every variant offers that group. So:

- Declare the return type. A function typed as returning `any` gets the warning "returns any, so it isn't offered for any field".
- The props type becomes the rule's form. The JSDoc on the function and its props sets titles and descriptions. The `deco-cms-schema` skill covers the tags and the shapes that break a form.
- Run `deco schema` (and send it to Studio) after adding a rule, or the picker will not show it.

## What a rule can read

A v8 block function gets only its inputs. Everything else comes from one of these:

- **The client**, through `currentClient()` from `@decocms/blocks`: `client.visitor` (the visitor, or `null`), `client.date` (the moment campaigns run at), `client.version`, and `client.resolve(name)` to read another saved block. Call `currentClient()` at the start of the function, before any `await`: on runtimes without `AsyncLocalStorage` it is only set while the function runs synchronously.
- **The request**, through the framework, the way `@decocms/compat-v7`'s `matcherContext` does it: TanStack Start's `getRequest()` from `@tanstack/react-start/server`, or Next's `headers()` from `next/headers`. On a TanStack client-side navigation the request is the server-function call, not the page, so its URL is not the page's.
- **Props** saved in the content.

Prefer props and the client over the request. A rule that reads the request (a cookie, a header, the location, the query) makes the page depend on something the binding's assignments do not hold, so a page cache keyed on them can serve one visitor's variant to another. Read [`caching-variants.md`](./caching-variants.md) before shipping one.

## Errors

A rule that throws fails its block with `BLOCK_FAILED`, and the page with it. v7 treated a throwing matcher as "no match", and so do the compat matchers. If that is what you want, catch inside the rule and return `false`.

```ts
import { getRequest } from "@tanstack/react-start/server";

const hasPromoCookie = (): boolean => {
  try {
    return (getRequest().headers.get("cookie") ?? "").includes("promo=1");
  } catch {
    return false;
  }
};
```

## Naming

- The key in the block map is the type the content writes. Keys in the block map win over built-ins, so a key named `campaign` or `experiment` replaces the built-in rule (and `deco check` stops checking its names). Pick a new name unless that is the intent.
- To keep v7 content working, register the rule under v7's type name (for example `website/matchers/environment.ts`, which `@decocms/compat-v7` leaves to the site because it read the process environment).
- Saved blocks cannot take a built-in name (`deco check`: "has the name of a built-in block").

## Rules with several parts

Combine rules without writing code:

- Order the variants: the first true rule wins, so "A and not B" is a `B → fallback` variant above an `A → value` variant.
- `multi` from `@decocms/compat-v7/matchers` gives `and` and `or` over inner rules (see [`v7-matchers.md`](./v7-matchers.md)).

v8 has no `negate` matcher. Reordering the variants usually covers it: put the case to exclude first, with the fallback value.

## Not needed in v8

- v7's `export const cacheable = true` on a matcher, and the framework's cache-decision gates. v8 has no such flag: the binding decides what the cache keys on (see [`caching-variants.md`](./caching-variants.md)).
- A "flag" file per value type. `multivariate` takes any value.
