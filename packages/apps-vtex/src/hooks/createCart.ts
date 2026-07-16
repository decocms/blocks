/**
 * Cart v2 factory — modular, granular, framework-agnostic client hooks.
 *
 * Built on the same module-singleton + listener pattern as `createUseCart`
 * (no `@tanstack/react-query` required, works identically under Next.js and
 * TanStack Start), but redesigned around the Cart v2 goals:
 *
 *   - **Lazy**: nothing hits VTEX on mount. No OrderForm is created until the
 *     first add-to-cart. The badge shows 0 (or the reconciled count) until then.
 *   - **Granular**: separate hooks per concern (`useCartSummary` for the badge,
 *     `useCart` for the drawer, `useShipping`, `useGifts`) so a component pulls
 *     only what it renders.
 *   - **Minimal by default + optimistic**: `useAddToCart` bumps the local count
 *     immediately and reconciles from the server's projected response. The
 *     optimistic + reconciliation logic lives here so the storefront never
 *     reimplements it.
 *
 * Injection: pass your site's `invoke` (the generated server-function proxy).
 * The `CreateCartInvoke` interface declares only the v2 methods this factory
 * calls — a structural subset, same as `CreateUseCartInvoke`.
 *
 * @example
 * ```ts
 * // src/hooks/cart.ts
 * import { createCart } from "@decocms/apps/vtex/hooks/createCart";
 * import { invoke } from "~/server/invoke";
 * export const { useCart, useCartSummary, useAddToCart } = createCart({ invoke });
 * ```
 */

import type {
  CartProjection,
  CartSection,
  CartSummary,
  CartSummaryWithItems,
  Minicart,
} from "@decocms/apps-commerce/types";
import { useEffect, useState } from "react";
import type { CartItemAttachments } from "../loaders/cart/attachments";
import type { CartGifts } from "../loaders/cart/gifts";
import type { CartShipping } from "../loaders/cart/shipping";
import type { OrderForm } from "../types";
import type { VtexCartProjectionResult } from "../utils/cartProjection";

/** Structural subset of the invoke proxy this factory needs. */
export interface CreateCartInvoke {
  vtex: {
    actions: {
      getOrCreateCartV2: (args: {
        data: { orderFormId?: string; projection?: CartProjection; sections?: CartSection[] };
      }) => Promise<unknown>;
      addItemsToCartV2: (args: {
        data: {
          orderFormId: string;
          orderItems: Array<{ id: string; seller: string; quantity: number }>;
          projection?: CartProjection;
          sections?: CartSection[];
        };
      }) => Promise<unknown>;
      updateCartItemsV2: (args: {
        data: {
          orderFormId: string;
          orderItems: Array<{ index: number; quantity: number }>;
          projection?: CartProjection;
          sections?: CartSection[];
        };
      }) => Promise<unknown>;
      addCouponToCartV2: (args: {
        data: {
          orderFormId: string;
          text: string;
          projection?: CartProjection;
          sections?: CartSection[];
        };
      }) => Promise<unknown>;
    };
    loaders: {
      cart: {
        summary: (args: { data?: { orderFormId?: string } }) => Promise<CartSummary>;
        full: (args: {
          data?: {
            orderFormId?: string;
            freeShippingTarget?: number;
            locale?: string;
            checkoutHref?: string;
            enableCoupon?: boolean;
          };
        }) => Promise<Minicart<OrderForm | null>>;
        shipping: (args: {
          data: {
            items: Array<{ id: string | number; quantity: number; seller: string }>;
            postalCode: string;
            country?: string;
          };
        }) => Promise<CartShipping>;
        gifts: (args: { data?: { orderFormId?: string } }) => Promise<CartGifts>;
        attachments: (args: {
          data: { orderFormId?: string; itemIndex: number };
        }) => Promise<CartItemAttachments>;
      };
    };
  };
}

export interface CreateCartOptions {
  invoke: CreateCartInvoke;
  /** Override the orderFormId cookie name. Default: VTEX standard. */
  orderFormCookieName?: string;
  /** Override the cookie max-age in seconds. Default: 7 days. */
  orderFormCookieMaxAge?: number;
}

const EMPTY_SUMMARY: CartSummary = { orderFormId: null, totalItems: 0, total: 0 };

export interface AddToCartOptions {
  /** What the server should return. Default: `"summary+items"`. */
  projection?: CartProjection;
  sections?: CartSection[];
}

export interface UseCartInclude {
  /** Fetch the full minicart (drawer). Default: false. */
  full?: boolean;
}

export interface UseCartV2Options {
  include?: UseCartInclude;
  freeShippingTarget?: number;
  locale?: string;
  checkoutHref?: string;
  enableCoupon?: boolean;
}

/** Build a per-site set of Cart v2 hooks. */
export function createCart(opts: CreateCartOptions) {
  const { invoke } = opts;
  const COOKIE_NAME = opts.orderFormCookieName ?? "checkout.vtex.com__orderFormId";
  const COOKIE_MAX_AGE = opts.orderFormCookieMaxAge ?? 7 * 24 * 3600;

  // --- module-singleton state --------------------------------------------
  let _summary: CartSummary = EMPTY_SUMMARY;
  let _minicart: Minicart<OrderForm | null> | null = null;
  let _loading = false;
  const _listeners = new Set<() => void>();

  function notify() {
    for (const fn of _listeners) fn();
  }
  function setSummary(s: CartSummary) {
    _summary = s;
    notify();
  }
  function setMinicart(m: Minicart<OrderForm | null> | null) {
    _minicart = m;
    if (m) {
      // Keep the badge in sync whenever the full cart is loaded.
      _summary = {
        orderFormId: m.original?.orderFormId ?? _summary.orderFormId,
        totalItems: m.storefront.items.reduce((n, i) => n + (i.quantity ?? 0), 0),
        total: m.storefront.total,
      };
    }
    notify();
  }
  function setLoading(v: boolean) {
    _loading = v;
    notify();
  }

  // --- cookie helpers ----------------------------------------------------
  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function getOrderFormIdFromCookie(): string | null {
    if (typeof document === "undefined") return null;
    const re = new RegExp(`${escapeRegex(COOKIE_NAME)}=([^;]*)`);
    const match = document.cookie.match(re);
    return match ? decodeURIComponent(match[1]) : null;
  }
  function setOrderFormIdCookie(id: string) {
    if (typeof document === "undefined") return;
    // biome-ignore lint/suspicious/noDocumentCookie: the orderFormId cookie is intentionally client-readable (VTEX standard, mirrored by createUseCart).
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(id)}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
  }

  /**
   * Ensure an OrderForm exists. Only called from mutations — never on mount —
   * so a browsing-only visitor provisions no cart. If the cookie has an id we
   * trust it; otherwise we create one (projection "summary" — we only need the
   * id + count back).
   */
  async function ensureOrderFormId(): Promise<string> {
    const existing = _summary.orderFormId ?? getOrderFormIdFromCookie();
    if (existing) {
      _summary = { ..._summary, orderFormId: existing };
      return existing;
    }
    const created = (await invoke.vtex.actions.getOrCreateCartV2({
      data: { projection: "summary" },
    })) as CartSummary;
    if (created.orderFormId) setOrderFormIdCookie(created.orderFormId);
    setSummary(created);
    return created.orderFormId ?? "";
  }

  /** Reconcile local state from a projected mutation response. */
  function reconcile(result: unknown, projection: CartProjection) {
    if (projection === "none") return; // optimistic-only; nothing to reconcile
    if (projection === "minicart") {
      setMinicart(result as Minicart<OrderForm | null>);
      return;
    }
    // "summary" | "summary+items" | "raw" all expose the totals we need.
    const r = result as Partial<CartSummaryWithItems> & { value?: number };
    if (r && typeof r.totalItems === "number") {
      setSummary({
        orderFormId: r.orderFormId ?? _summary.orderFormId,
        totalItems: r.totalItems,
        total: r.total ?? _summary.total,
      });
    }
  }

  // --- shared React subscription ----------------------------------------
  function useCartState() {
    const [, forceRender] = useState(0);
    useEffect(() => {
      const listener = () => forceRender((n) => n + 1);
      _listeners.add(listener);
      return () => {
        _listeners.delete(listener);
      };
    }, []);
  }

  // --- hooks -------------------------------------------------------------

  /** Badge hook. Reads the local summary; never triggers a VTEX call by itself. */
  function useCartSummary() {
    useCartState();
    return { summary: _summary, totalItems: _summary.totalItems, loading: _loading };
  }

  /**
   * Add-to-cart with built-in optimistic count + reconciliation.
   * `projection: "none"` → pure 200, optimistic-only (no server data used).
   */
  function useAddToCart(hookOpts: AddToCartOptions = {}) {
    useCartState();
    const projection: CartProjection = hookOpts.projection ?? "summary+items";

    async function add(params: {
      id: string;
      seller: string;
      quantity?: number;
    }): Promise<VtexCartProjectionResult> {
      const qty = params.quantity ?? 1;
      // Optimistic: bump the badge immediately.
      setSummary({ ..._summary, totalItems: _summary.totalItems + qty });
      setLoading(true);
      try {
        const orderFormId = await ensureOrderFormId();
        const result = await invoke.vtex.actions.addItemsToCartV2({
          data: {
            orderFormId,
            orderItems: [{ id: params.id, seller: params.seller, quantity: qty }],
            projection,
            sections: hookOpts.sections,
          },
        });
        reconcile(result, projection);
        // Return the projected payload so callers can drive a toast / analytics
        // without a second fetch (e.g. `summary+items` → name/image/price/variant).
        return result as VtexCartProjectionResult;
      } catch (err) {
        // Roll back the optimistic bump on failure.
        setSummary({ ..._summary, totalItems: Math.max(0, _summary.totalItems - qty) });
        console.error("[cart] addToCart failed:", err);
        throw err;
      } finally {
        setLoading(false);
      }
    }

    return { add, loading: _loading };
  }

  /**
   * Composed cart hook for the drawer. Fetches ONLY what `include` enables —
   * default is nothing beyond the already-local summary. Call `openDrawer()`
   * (or pass `include.full`) to load the full minicart on demand.
   */
  function useCart(cartOpts: UseCartV2Options = {}) {
    useCartState();
    const wantFull = cartOpts.include?.full === true;

    // biome-ignore lint/correctness/useExhaustiveDependencies: the drawer loads once when enabled; storefront options are stable per-mount and must not re-trigger the fetch.
    useEffect(() => {
      if (!wantFull) return;
      let cancelled = false;
      setLoading(true);
      invoke.vtex.loaders.cart
        .full({
          data: {
            freeShippingTarget: cartOpts.freeShippingTarget,
            locale: cartOpts.locale,
            checkoutHref: cartOpts.checkoutHref,
            enableCoupon: cartOpts.enableCoupon,
          },
        })
        .then((m) => {
          if (!cancelled) setMinicart(m);
        })
        .catch((err) => console.error("[cart] load full failed:", err))
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [wantFull]);

    async function refresh() {
      const m = await invoke.vtex.loaders.cart.full({
        data: {
          freeShippingTarget: cartOpts.freeShippingTarget,
          locale: cartOpts.locale,
          checkoutHref: cartOpts.checkoutHref,
          enableCoupon: cartOpts.enableCoupon,
        },
      });
      setMinicart(m);
      return m;
    }

    async function updateQuantity(index: number, quantity: number) {
      const orderFormId = await ensureOrderFormId();
      setLoading(true);
      try {
        const result = await invoke.vtex.actions.updateCartItemsV2({
          data: { orderFormId, orderItems: [{ index, quantity }], projection: "minicart" },
        });
        reconcile(result, "minicart");
        return result as Minicart<OrderForm | null>;
      } finally {
        setLoading(false);
      }
    }

    async function removeItem(index: number) {
      return updateQuantity(index, 0);
    }

    async function addCoupon(text: string) {
      const orderFormId = await ensureOrderFormId();
      setLoading(true);
      try {
        const result = await invoke.vtex.actions.addCouponToCartV2({
          data: { orderFormId, text, projection: "minicart" },
        });
        reconcile(result, "minicart");
        return result as Minicart<OrderForm | null>;
      } finally {
        setLoading(false);
      }
    }

    return {
      minicart: _minicart,
      summary: _summary,
      loading: _loading,
      refresh,
      updateQuantity,
      removeItem,
      addCoupon,
    };
  }

  /** On-demand shipping estimate for the drawer. Not cached (see loader note). */
  function useShipping() {
    useCartState();
    async function estimate(params: {
      items: Array<{ id: string | number; quantity: number; seller: string }>;
      postalCode: string;
      country?: string;
    }) {
      return invoke.vtex.loaders.cart.shipping({ data: params });
    }
    return { estimate };
  }

  /** On-demand selectable-gifts / promotions read. */
  function useGifts() {
    useCartState();
    async function load() {
      return invoke.vtex.loaders.cart.gifts({ data: {} });
    }
    return { load };
  }

  /** On-demand attachments/offerings read for a single line (engraving, gift-wrap…). */
  function useAttachments() {
    useCartState();
    async function load(itemIndex: number) {
      return invoke.vtex.loaders.cart.attachments({ data: { itemIndex } });
    }
    return { load };
  }

  /** Reset all module-level state (e.g. after logout / order placed). */
  function resetCart() {
    _summary = EMPTY_SUMMARY;
    _minicart = null;
    _loading = false;
    notify();
  }

  return {
    useCart,
    useCartSummary,
    useAddToCart,
    useShipping,
    useGifts,
    useAttachments,
    resetCart,
  };
}
