# Migrating gradually from the legacy cart

Cart v2 is **additive** — the legacy `useCart` / `createUseCart` keep working untouched. But the two systems hold **independent state**: `createCart` is its own module-singleton and does not share the badge count, cart cookie read timing, or listeners with `createUseCart`. During the transition, keep **one source of truth for the badge** — don't let a v1 badge and a v2 badge run side by side, or they will diverge (v1 creates a cart on mount and counts eagerly; v2 is lazy).

Recommended order, component by component:

1. **Badge + add-to-cart together** → `useCartSummary` + `useAddToCart`. Migrate these as a pair: the badge's source of truth must be the same singleton that `add()` reconciles into. This is also where you get the biggest win — the eager on-mount cart creation disappears.
2. **Drawer** → `useCart({ include: { full: open } })`. Replace the legacy drawer's `fetchCart`/`getOrCreateCart` reads. `updateQuantity` / `removeItem` / `addCoupon` return the projected `Minicart`.
3. **On-demand extras** → `useShipping`, `useGifts`, `useAttachments`. These had no legacy equivalent as separate reads; wire them where the drawer previously pulled everything at once.

Until every add-to-cart entry point is on v2, do not delete the legacy hooks — a mixed page (v1 PDP button + v2 badge) will show a stale count because the two singletons don't notify each other.
