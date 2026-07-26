/**
 * Tests for the `createCart` factory (Cart v2).
 *
 * Like `createUseCart`, hook render semantics need a React renderer that
 * apps-start does not pull in, so we cover the factory's shape and instance
 * isolation. The optimistic + reconciliation behaviour is exercised by the
 * site-level smoke test.
 */

import { describe, expect, it, vi } from "vitest";
import { type CreateCartInvoke, createCart } from "../createCart";

function makeInvoke(): CreateCartInvoke {
  const summary = async () => ({ orderFormId: "of-1", totalItems: 0, total: 0 });
  const anyNoop = async () => ({ ok: true }) as never;
  return {
    vtex: {
      actions: {
        getOrCreateCartV2: async () => ({ orderFormId: "of-1", totalItems: 0, total: 0 }),
        addItemsToCartV2: anyNoop,
        updateCartItemsV2: anyNoop,
        addCouponToCartV2: anyNoop,
      },
      loaders: {
        cart: {
          summary,
          full: async () => ({
            original: null,
            storefront: {
              items: [],
              total: 0,
              subtotal: 0,
              discounts: 0,
              locale: "pt-BR",
              currency: "BRL",
              freeShippingTarget: 0,
              checkoutHref: "/checkout",
            },
          }),
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

describe("createCart — factory shape", () => {
  it("returns the full granular hook set", () => {
    const cart = createCart({ invoke: makeInvoke() });
    expect(typeof cart.useCart).toBe("function");
    expect(typeof cart.useCartSummary).toBe("function");
    expect(typeof cart.useAddToCart).toBe("function");
    expect(typeof cart.useShipping).toBe("function");
    expect(typeof cart.useGifts).toBe("function");
    expect(typeof cart.useAttachments).toBe("function");
    expect(typeof cart.resetCart).toBe("function");
  });

  it("two factory calls produce independent hook identities", () => {
    const a = createCart({ invoke: makeInvoke() });
    const b = createCart({ invoke: makeInvoke() });
    expect(a.useCart).not.toBe(b.useCart);
    expect(a.useAddToCart).not.toBe(b.useAddToCart);
    expect(a.resetCart).not.toBe(b.resetCart);
  });

  it("accepts custom cookie name / max-age without throwing", () => {
    expect(() =>
      createCart({
        invoke: makeInvoke(),
        orderFormCookieName: "custom_of",
        orderFormCookieMaxAge: 3600,
      }),
    ).not.toThrow();
  });

  it("does not call any invoke method at construction time (lazy)", () => {
    const invoke = makeInvoke();
    const getOrCreate = vi.spyOn(invoke.vtex.actions, "getOrCreateCartV2");
    const summary = vi.spyOn(invoke.vtex.loaders.cart, "summary");
    createCart({ invoke });
    expect(getOrCreate).not.toHaveBeenCalled();
    expect(summary).not.toHaveBeenCalled();
  });
});
