/**
 * Tests for the `createUseCart` factory.
 *
 * The hook itself depends on React (useState/useEffect), and apps-start
 * does not pull in @testing-library/react. So we test the parts of the
 * factory that don't require a React renderer: shape, isolation, and the
 * pure `itemToAnalyticsItem` helper. Hook semantics are exercised by the
 * site-level integration smoke test (the template has shipped to two
 * production sites).
 */

import { describe, expect, it } from "vitest";
import { type CreateUseCartInvoke, createUseCart } from "../createUseCart";

function makeInvoke(): CreateUseCartInvoke {
	const noop = async () => ({ orderFormId: "of-1", items: [] }) as never;
	return {
		vtex: {
			actions: {
				getOrCreateCart: noop,
				addItemsToCart: noop,
				updateCartItems: noop,
				addCouponToCart: noop,
				updateOrderFormAttachment: noop,
				simulateCart: noop,
			},
		},
	};
}

describe("createUseCart — factory shape", () => {
	it("returns useCart, resetCart, itemToAnalyticsItem", () => {
		const cart = createUseCart({ invoke: makeInvoke() });
		expect(typeof cart.useCart).toBe("function");
		expect(typeof cart.resetCart).toBe("function");
		expect(typeof cart.itemToAnalyticsItem).toBe("function");
	});

	it("two factory calls produce independent itemToAnalyticsItem references", () => {
		const a = createUseCart({ invoke: makeInvoke() });
		const b = createUseCart({ invoke: makeInvoke() });
		// Different closures => different function identities.
		expect(a.itemToAnalyticsItem).not.toBe(b.itemToAnalyticsItem);
		expect(a.useCart).not.toBe(b.useCart);
		expect(a.resetCart).not.toBe(b.resetCart);
	});

	it("accepts custom orderFormCookieName / maxAge without throwing", () => {
		expect(() =>
			createUseCart({
				invoke: makeInvoke(),
				orderFormCookieName: "custom_of_id",
				orderFormCookieMaxAge: 3600,
			}),
		).not.toThrow();
	});
});

describe("createUseCart — itemToAnalyticsItem", () => {
	const { itemToAnalyticsItem } = createUseCart({ invoke: makeInvoke() });

	it("maps the canonical fields", () => {
		const out = itemToAnalyticsItem(
			{
				id: "sku-1",
				productId: "prod-1",
				name: "Widget",
				skuName: "Widget Blue",
				sellingPrice: 1990,
				price: 2490,
				listPrice: 2490,
				quantity: 2,
				seller: "1",
				additionalInfo: { brandName: "Acme" },
			} as never,
			0,
		);
		expect(out).toEqual({
			item_id: "prod-1",
			item_group_id: "prod-1",
			item_name: "Widget",
			item_variant: "Widget Blue",
			item_brand: "Acme",
			price: 19.9,
			discount: 5,
			quantity: 2,
			coupon: undefined,
			affiliation: "1",
			index: 0,
		});
	});

	it("falls back to skuName when name is missing", () => {
		const out = itemToAnalyticsItem(
			{
				productId: "p",
				skuName: "Fallback",
				sellingPrice: 100,
				listPrice: 100,
				quantity: 1,
				seller: "1",
			} as never,
			3,
		);
		expect(out.item_name).toBe("Fallback");
		expect(out.index).toBe(3);
	});

	it("uses price when sellingPrice is missing", () => {
		const out = itemToAnalyticsItem(
			{
				productId: "p",
				name: "n",
				price: 1000,
				listPrice: 1000,
				quantity: 1,
				seller: "1",
			} as never,
			0,
		);
		expect(out.price).toBe(10);
	});

	it("computes zero discount when listPrice equals sellingPrice", () => {
		const out = itemToAnalyticsItem(
			{
				productId: "p",
				name: "n",
				sellingPrice: 500,
				listPrice: 500,
				quantity: 1,
				seller: "1",
			} as never,
			0,
		);
		expect(out.discount).toBe(0);
	});

	it("rounds discount to 2 decimal places", () => {
		const out = itemToAnalyticsItem(
			{
				productId: "p",
				name: "n",
				sellingPrice: 1000,
				listPrice: 1333,
				quantity: 1,
				seller: "1",
			} as never,
			0,
		);
		expect(out.discount).toBe(3.33);
	});

	it("preserves coupon when supplied", () => {
		const out = itemToAnalyticsItem(
			{
				productId: "p",
				name: "n",
				sellingPrice: 100,
				listPrice: 100,
				quantity: 1,
				seller: "1",
				coupon: "SAVE10",
			} as never,
			0,
		);
		expect(out.coupon).toBe("SAVE10");
	});

	it("uses empty string brand when additionalInfo is missing", () => {
		const out = itemToAnalyticsItem(
			{
				productId: "p",
				name: "n",
				sellingPrice: 100,
				listPrice: 100,
				quantity: 1,
				seller: "1",
			} as never,
			0,
		);
		expect(out.item_brand).toBe("");
	});
});
