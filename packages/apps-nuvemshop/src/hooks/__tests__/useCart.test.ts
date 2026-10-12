import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addItem,
  CART_STORAGE_KEY,
  CheckoutError,
  cartStore,
  checkout,
  fetchCartDetails,
  removeItem,
  setQuantity,
} from "../useCart";

const shirt = { productId: 1, variantId: 10, quantity: 1 };
const pants = { productId: 2, variantId: 20, quantity: 1 };

describe("cart reducers", () => {
  it("adds, merges quantities and caps at 99 (API limit per variant)", () => {
    expect(addItem([], shirt)).toEqual([shirt]);
    expect(addItem([shirt], { ...shirt, quantity: 2 })).toEqual([{ ...shirt, quantity: 3 }]);
    expect(addItem([shirt], { ...shirt, quantity: 500 })[0].quantity).toBe(99);
  });
  it("sets quantity and drops the line at 0", () => {
    expect(setQuantity([shirt, pants], 20, 4)).toEqual([shirt, { ...pants, quantity: 4 }]);
    expect(setQuantity([shirt, pants], 10, 0)).toEqual([pants]);
    expect(removeItem([shirt, pants], 10)).toEqual([pants]);
  });
});

describe("cartStore", () => {
  beforeEach(() => {
    localStorage.clear();
    cartStore.set([]);
  });

  it("persists to localStorage and notifies subscribers", () => {
    const seen = vi.fn();
    const off = cartStore.subscribe(seen);
    cartStore.update((items) => addItem(items, shirt));
    expect(cartStore.get()).toEqual([shirt]);
    expect(JSON.parse(localStorage.getItem(CART_STORAGE_KEY)!)).toEqual([shirt]);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it("picks up writes from other tabs", () => {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([pants]));
    window.dispatchEvent(new StorageEvent("storage", { key: CART_STORAGE_KEY }));
    expect(cartStore.get()).toEqual([pants]);
  });

  it("survives corrupt storage", () => {
    localStorage.setItem(CART_STORAGE_KEY, "{not json");
    window.dispatchEvent(new StorageEvent("storage", { key: CART_STORAGE_KEY }));
    expect(cartStore.get()).toEqual([]);
  });
});

describe("checkout", () => {
  it("invokes createCheckout and navigates to the hosted checkout", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ checkoutUrl: "https://checkout.example/1" })),
      );
    const navigate = vi.fn();
    await checkout([shirt], "PROMO", navigate);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/deco/invoke/nuvemshop/actions/createCheckout");
    expect(JSON.parse(String(init!.body))).toEqual({ items: [shirt], coupon: "PROMO" });
    expect(navigate).toHaveBeenCalledWith("https://checkout.example/1");
    fetchSpy.mockRestore();
  });

  it("throws a typed CheckoutError (e.g. rejected coupon) instead of navigating", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "coupon_rejected", message: "nope" })),
      );
    const navigate = vi.fn();
    const err = await checkout([shirt], "BAD", navigate).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutError);
    expect(err.code).toBe("coupon_rejected");
    expect(navigate).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("throws the server error instead of navigating", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("boom", { status: 500 }));
    const navigate = vi.fn();
    await expect(checkout([shirt], undefined, navigate)).rejects.toThrow(/500/);
    expect(navigate).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("fetchCartDetails", () => {
  it("invokes the cart loader with the items and returns its result", async () => {
    const details = { lines: [], itemCount: 0, subtotal: 0 };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(details)));
    expect(await fetchCartDetails([shirt])).toEqual(details);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/deco/invoke/nuvemshop/loaders/cart");
    expect(JSON.parse(String(init!.body))).toEqual({ items: [shirt] });
    fetchSpy.mockRestore();
  });

  it("skips the request for an empty cart", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await fetchCartDetails([])).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
