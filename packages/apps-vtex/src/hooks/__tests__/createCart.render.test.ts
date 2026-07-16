// @vitest-environment jsdom
/**
 * Render-based tests for the `createCart` factory (Cart v2).
 *
 * The factory-shape tests in `createCart.test.ts` run in node and never render.
 * These exercise the actual hook behaviour that needs a React renderer:
 * `useAddToCart().add()` returning the server's projected payload (so a caller
 * can drive a toast without a second fetch) and the optimistic badge bump.
 *
 * No `@testing-library/react` in the tree — we hand-roll a tiny render harness
 * on `react-dom/client` (jsdom env, declared in the docblock above).
 */

import type { CartSummaryWithItems } from "@decocms/apps-commerce/types";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { type CreateCartInvoke, createCart } from "../createCart";

// React's act() requires this flag when driving updates manually.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderHook<T>(useHook: () => T) {
  const ref = { current: undefined as unknown as T };
  function Probe() {
    ref.current = useHook();
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Probe));
  });
  return { ref, unmount: () => act(() => root.unmount()) };
}

/** Fake invoke whose addItemsToCartV2 returns a `summary+items` projection. */
function makeInvoke(): CreateCartInvoke {
  const projected: CartSummaryWithItems = {
    orderFormId: "of-1",
    totalItems: 1,
    total: 100,
    items: [
      {
        item_id: "sku-1",
        item_name: "Camiseta",
        item_variant: "P Azul",
        image: "https://img.example/x.jpg",
        price: 100,
        quantity: 1,
      },
    ],
  };
  return {
    vtex: {
      actions: {
        getOrCreateCartV2: async () => ({ orderFormId: "of-1", totalItems: 0, total: 0 }),
        addItemsToCartV2: async () => projected as never,
        updateCartItemsV2: async () => ({ ok: true }) as never,
        addCouponToCartV2: async () => ({ ok: true }) as never,
      },
      loaders: {
        cart: {
          summary: async () => ({ orderFormId: "of-1", totalItems: 0, total: 0 }),
          full: async () => ({ original: null }) as never,
          shipping: async () => ({ postalCode: "00000-000", options: [] }),
          gifts: async () => ({ orderFormId: "of-1", selectableGifts: [], ratesAndBenefits: null }),
          attachments: async () => ({
            orderFormId: "of-1",
            itemIndex: 0,
            attachments: [],
            attachmentOfferings: [],
          }),
        },
      },
    },
  };
}

describe("createCart — useAddToCart.add()", () => {
  it("returns the projected payload for a toast without a second fetch", async () => {
    const cart = createCart({ invoke: makeInvoke() });
    const { ref, unmount } = renderHook(() => cart.useAddToCart());

    let result: unknown;
    await act(async () => {
      result = await ref.current.add({ id: "sku-1", seller: "1" });
    });

    expect(result).toMatchObject({
      totalItems: 1,
      total: 100,
      items: [{ item_name: "Camiseta", item_variant: "P Azul", price: 100 }],
    });
    unmount();
  });

  it("reconciles the summary badge from the projected response", async () => {
    const cart = createCart({ invoke: makeInvoke() });
    const add = renderHook(() => cart.useAddToCart());
    const badge = renderHook(() => cart.useCartSummary());

    expect(badge.ref.current.totalItems).toBe(0);

    await act(async () => {
      await add.ref.current.add({ id: "sku-1", seller: "1" });
    });

    // Reconciled from the server projection (1), not just the optimistic bump.
    expect(badge.ref.current.totalItems).toBe(1);
    add.unmount();
    badge.unmount();
  });
});
