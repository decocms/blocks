/**
 * Client-side cart for the Nuvemshop Storefront API.
 *
 * The API has no server cart — only `POST /checkouts`, which opens a core
 * cart from line items and returns the hosted checkout URL. So the cart
 * lives in `localStorage` (shared across tabs) and `checkout()` hands it to
 * the `createCheckout` action, which then redirects.
 *
 * Prices/totals aren't stored: render them from the products you already
 * have; the hosted checkout re-validates stock, prices and the coupon.
 *
 * ```tsx
 * const { items, count, addItem, checkout } = useCart();
 * <button onClick={() => addItem({ productId, variantId, quantity: 1 })}>Comprar</button>
 * ```
 */
import { useSyncExternalStore } from "react";
import type { CartItem } from "../actions/createCheckout";

export type { CartItem };

export const CART_STORAGE_KEY = "nuvemshop:cart";
/** The API sums repeated variants up to 99. */
const MAX_QTY = 99;

export const addItem = (items: CartItem[], item: CartItem): CartItem[] => {
  const existing = items.find((i) => i.variantId === item.variantId);
  if (!existing) return [...items, { ...item, quantity: Math.min(item.quantity, MAX_QTY) }];
  return setQuantity(items, item.variantId, existing.quantity + item.quantity);
};

export const setQuantity = (items: CartItem[], variantId: number, quantity: number): CartItem[] =>
  quantity <= 0
    ? removeItem(items, variantId)
    : items.map((i) =>
        i.variantId === variantId ? { ...i, quantity: Math.min(quantity, MAX_QTY) } : i,
      );

export const removeItem = (items: CartItem[], variantId: number): CartItem[] =>
  items.filter((i) => i.variantId !== variantId);

const EMPTY: CartItem[] = [];

function read(): CartItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : EMPTY;
  } catch {
    return EMPTY;
  }
}

function createCartStore() {
  let items: CartItem[] | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of listeners) l();
  };

  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key !== CART_STORAGE_KEY) return;
      items = read();
      notify();
    });
  }

  const store = {
    get: (): CartItem[] => (items ??= typeof localStorage === "undefined" ? EMPTY : read()),
    set(next: CartItem[]) {
      items = next;
      if (typeof localStorage !== "undefined")
        localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(next));
      notify();
    },
    update: (fn: (items: CartItem[]) => CartItem[]) => store.set(fn(store.get())),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store;
}

export const cartStore = createCartStore();

/** Creates the Nuvemshop checkout for `items` and navigates to it. */
export async function checkout(
  items: CartItem[],
  coupon?: string,
  navigate: (url: string) => void = (url) => window.location.assign(url),
) {
  const res = await fetch("/deco/invoke/nuvemshop/actions/createCheckout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items, coupon }),
  });
  if (!res.ok) throw new Error(`Checkout failed (${res.status}): ${await res.text()}`);
  const { checkoutUrl } = (await res.json()) as { checkoutUrl: string };
  navigate(checkoutUrl);
}

export function useCart() {
  const items = useSyncExternalStore(cartStore.subscribe, cartStore.get, () => EMPTY);
  return {
    items,
    count: items.reduce((n, i) => n + i.quantity, 0),
    addItem: (item: CartItem) => cartStore.update((c) => addItem(c, item)),
    setQuantity: (variantId: number, quantity: number) =>
      cartStore.update((c) => setQuantity(c, variantId, quantity)),
    removeItem: (variantId: number) => cartStore.update((c) => removeItem(c, variantId)),
    clear: () => cartStore.set([]),
    checkout: (coupon?: string) => checkout(items, coupon),
  };
}
