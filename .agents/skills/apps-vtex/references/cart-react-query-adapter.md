# Optional TanStack Query adapter — `createCartQuery`

For sites already using `@tanstack/react-query`, the factory-less adapter provides the same API wired into a QueryClient:

```ts
import { createCartQuery } from "@decocms/apps-vtex/hooks/cartQuery";
import { invoke } from "~/server/invoke";

export const {
  useCartSummary, useCartFull, useAddToCart, useShipping, useGifts, useAttachments,
} = createCartQuery({ invoke });
```

Full parity with the factory — six hooks. Key differences vs `createCart`:
- `useCartSummary`, `useCartFull`, `useGifts`, `useAttachments(itemIndex)` return standard `useQuery` results with `enabled: false` by default — lazy, opt-in per call.
- `useShipping({ items, postalCode })` is a `useQuery` **keyed by `{ postalCode, items }`** with a 5 min `staleTime`. Because shipping options are not user-personalized, this gives you client-side cache + dedupe for free, on top of the server-side simulation cache the loader already has (see [issue #373](https://github.com/decocms/blocks/issues/373) and [`cart-loaders.md`](./cart-loaders.md)). `enabled` turns on automatically when a postal code + items are present.
- `useAddToCart` returns a standard `useMutation` with `onMutate` optimistic bump + `onError` rollback + `onSuccess` reconciliation (badge, or `FULL_KEY` cache when `projection: "minicart"`).
- Requires `QueryClientProvider` in the tree.

Import this adapter only if you have `@tanstack/react-query` in your site — it is declared as an optional peer dependency in `@decocms/apps-vtex`.
