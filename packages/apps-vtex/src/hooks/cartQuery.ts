/**
 * Cart v2 — optional TanStack Query adapter.
 *
 * The base factory (`createCart`) is intentionally QueryClient-free so it runs
 * anywhere. Sites already invested in TanStack Query can use this adapter
 * instead to get cache integration, `staleTime`, devtools, and cross-component
 * query sharing — while keeping the exact same invoke injection and the same
 * server-side fragmentation/projection contract.
 *
 * Importing this module pulls in `@tanstack/react-query` (a peer dependency).
 * If your site does not use react-query, import `createCart` instead.
 *
 * @example
 * ```ts
 * import { createCartQuery } from "@decocms/apps/vtex/hooks/cartQuery";
 * import { invoke } from "~/server/invoke";
 * export const { useCartSummary, useCartFull, useAddToCart } = createCartQuery({ invoke });
 * ```
 */

import type {
  CartProjection,
  CartSection,
  CartSummary,
  Minicart,
} from "@decocms/apps-commerce/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CartItemAttachments } from "../loaders/cart/attachments";
import type { CartGifts } from "../loaders/cart/gifts";
import type { CartShipping } from "../loaders/cart/shipping";
import type { OrderForm } from "../types";
import type { CreateCartInvoke } from "./createCart";

export interface CreateCartQueryOptions {
  invoke: CreateCartInvoke;
  orderFormCookieName?: string;
}

const SUMMARY_KEY = ["vtex", "cart", "summary"] as const;
const FULL_KEY = ["vtex", "cart", "full"] as const;
const SHIPPING_KEY = ["vtex", "cart", "shipping"] as const;
const GIFTS_KEY = ["vtex", "cart", "gifts"] as const;
const ATTACHMENTS_KEY = ["vtex", "cart", "attachments"] as const;

/** TanStack Query flavour of the Cart v2 hooks. */
export function createCartQuery(opts: CreateCartQueryOptions) {
  const { invoke } = opts;
  const COOKIE_NAME = opts.orderFormCookieName ?? "checkout.vtex.com__orderFormId";

  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function getOrderFormIdFromCookie(): string | null {
    if (typeof document === "undefined") return null;
    const m = document.cookie.match(new RegExp(`${escapeRegex(COOKIE_NAME)}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setOrderFormIdCookie(id: string) {
    if (typeof document === "undefined") return;
    // biome-ignore lint/suspicious/noDocumentCookie: the orderFormId cookie is intentionally client-readable (VTEX standard).
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(id)}; path=/; max-age=${7 * 24 * 3600}; SameSite=Lax`;
  }
  async function ensureOrderFormId(current: string | null): Promise<string> {
    const existing = current ?? getOrderFormIdFromCookie();
    if (existing) return existing;
    const created = (await invoke.vtex.actions.getOrCreateCartV2({
      data: { projection: "summary" },
    })) as CartSummary;
    if (created.orderFormId) setOrderFormIdCookie(created.orderFormId);
    return created.orderFormId ?? "";
  }

  /**
   * Badge query. Lazy: `enabled` defaults to false so it only runs when the
   * caller opts in (e.g. after the cart cookie exists) — no cart is created on
   * mount.
   */
  function useCartSummary(options?: { enabled?: boolean; staleTime?: number }) {
    return useQuery({
      queryKey: SUMMARY_KEY,
      queryFn: () => invoke.vtex.loaders.cart.summary({ data: {} }),
      enabled: options?.enabled ?? false,
      staleTime: options?.staleTime ?? 30_000,
    });
  }

  /** Full drawer query. `enabled` gated so it fires when the drawer opens. */
  function useCartFull(options?: {
    enabled?: boolean;
    staleTime?: number;
    freeShippingTarget?: number;
    locale?: string;
    checkoutHref?: string;
    enableCoupon?: boolean;
  }) {
    return useQuery<Minicart<OrderForm | null>>({
      queryKey: FULL_KEY,
      queryFn: () =>
        invoke.vtex.loaders.cart.full({
          data: {
            freeShippingTarget: options?.freeShippingTarget,
            locale: options?.locale,
            checkoutHref: options?.checkoutHref,
            enableCoupon: options?.enableCoupon,
          },
        }),
      enabled: options?.enabled ?? false,
      staleTime: options?.staleTime ?? 30_000,
    });
  }

  function useAddToCart(hookOpts?: { projection?: CartProjection; sections?: CartSection[] }) {
    const queryClient = useQueryClient();
    const projection: CartProjection = hookOpts?.projection ?? "summary+items";

    return useMutation({
      mutationFn: async (params: { id: string; seller: string; quantity?: number }) => {
        const current = queryClient.getQueryData<CartSummary>(SUMMARY_KEY)?.orderFormId ?? null;
        const orderFormId = await ensureOrderFormId(current);
        return invoke.vtex.actions.addItemsToCartV2({
          data: {
            orderFormId,
            orderItems: [{ id: params.id, seller: params.seller, quantity: params.quantity ?? 1 }],
            projection,
            sections: hookOpts?.sections,
          },
        });
      },
      // Optimistic badge bump.
      onMutate: async (params) => {
        await queryClient.cancelQueries({ queryKey: SUMMARY_KEY });
        const prev = queryClient.getQueryData<CartSummary>(SUMMARY_KEY);
        const qty = params.quantity ?? 1;
        queryClient.setQueryData<CartSummary>(SUMMARY_KEY, (s) => ({
          orderFormId: s?.orderFormId ?? null,
          total: s?.total ?? 0,
          totalItems: (s?.totalItems ?? 0) + qty,
        }));
        return { prev };
      },
      onError: (_err, _params, ctx) => {
        if (ctx?.prev) queryClient.setQueryData(SUMMARY_KEY, ctx.prev);
      },
      onSuccess: (result) => {
        if (projection === "minicart") {
          queryClient.setQueryData(FULL_KEY, result);
        } else if (projection !== "none") {
          const r = result as Partial<CartSummary>;
          if (r && typeof r.totalItems === "number") {
            queryClient.setQueryData<CartSummary>(SUMMARY_KEY, {
              orderFormId: r.orderFormId ?? null,
              totalItems: r.totalItems,
              total: r.total ?? 0,
            });
          }
        }
      },
    });
  }

  /**
   * Shipping estimate query. Keyed by `{ postalCode, items }` — which is NOT
   * user-personalized — so react-query's cache/dedupe gives you the caching
   * the server-side loader can't do yet (see the loader's caching note).
   * `enabled` defaults on when a postal code is present.
   */
  function useShipping(
    params: {
      items: Array<{ id: string | number; quantity: number; seller: string }>;
      postalCode: string;
      country?: string;
    },
    options?: { enabled?: boolean; staleTime?: number },
  ) {
    return useQuery<CartShipping>({
      queryKey: [...SHIPPING_KEY, params.postalCode, params.items],
      queryFn: () => invoke.vtex.loaders.cart.shipping({ data: params }),
      enabled: options?.enabled ?? Boolean(params.postalCode && params.items.length),
      staleTime: options?.staleTime ?? 5 * 60_000,
    });
  }

  /** Selectable-gifts / promotions query. `enabled` gated (default false). */
  function useGifts(options?: { enabled?: boolean; staleTime?: number }) {
    return useQuery<CartGifts>({
      queryKey: GIFTS_KEY,
      queryFn: () => invoke.vtex.loaders.cart.gifts({ data: {} }),
      enabled: options?.enabled ?? false,
      staleTime: options?.staleTime ?? 30_000,
    });
  }

  /** Single-line attachments query. `enabled` gated (default false). */
  function useAttachments(itemIndex: number, options?: { enabled?: boolean; staleTime?: number }) {
    return useQuery<CartItemAttachments>({
      queryKey: [...ATTACHMENTS_KEY, itemIndex],
      queryFn: () => invoke.vtex.loaders.cart.attachments({ data: { itemIndex } }),
      enabled: options?.enabled ?? false,
      staleTime: options?.staleTime ?? 30_000,
    });
  }

  return { useCartSummary, useCartFull, useAddToCart, useShipping, useGifts, useAttachments };
}
