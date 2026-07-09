/**
 * Tests for the `createUseWishlist` factory.
 *
 * The hook itself depends on React (useState/useEffect), and apps-start
 * does not pull in @testing-library/react. So we test the parts that
 * don't require a renderer: factory shape, isolation, and the pure
 * helpers `findWishlistEntry` + `legacyAddArgsToCanonical` which encode
 * the most error-prone invariants (id matching + legacy arg swap).
 */

import { describe, expect, it } from "vitest";
import type { WishlistItem } from "../../loaders/wishlist";
import {
	type CreateUseWishlistInvoke,
	createUseWishlist,
	findWishlistEntry,
	legacyAddArgsToCanonical,
} from "../createUseWishlist";

function makeInvoke(): CreateUseWishlistInvoke {
	return {
		vtex: {
			loaders: {
				wishlist: async () => [],
			},
			actions: {
				addToWishlist: async () => [],
				removeFromWishlist: async () => [],
			},
		},
	};
}

describe("createUseWishlist — factory shape", () => {
	it("returns useWishlist, resetWishlist", () => {
		const w = createUseWishlist({ invoke: makeInvoke() });
		expect(typeof w.useWishlist).toBe("function");
		expect(typeof w.resetWishlist).toBe("function");
	});

	it("two factory calls produce independent function references", () => {
		const a = createUseWishlist({ invoke: makeInvoke() });
		const b = createUseWishlist({ invoke: makeInvoke() });
		expect(a.useWishlist).not.toBe(b.useWishlist);
		expect(a.resetWishlist).not.toBe(b.resetWishlist);
	});
});

describe("legacyAddArgsToCanonical — arg swap", () => {
	it("maps legacy (productId=sku, productGroupId=parent) to canonical { productId, sku }", () => {
		// In analytics terms: item_id is the SKU; item_group_id is the
		// VTEX productId. Sites destructure these from analytics objects
		// and pass them to wishlist.addItem in that order.
		const out = legacyAddArgsToCanonical("sku-1", "prod-100");
		expect(out).toEqual({ productId: "prod-100", sku: "sku-1" });
	});

	it("preserves empty strings without coercing", () => {
		const out = legacyAddArgsToCanonical("", "");
		expect(out).toEqual({ productId: "", sku: "" });
	});
});

describe("findWishlistEntry — id matching", () => {
	const items: WishlistItem[] = [
		{ id: "entry-1", productId: "prod-1", sku: "sku-1", title: "A" },
		{ id: "entry-2", productId: "prod-2", sku: "sku-2", title: "B" },
	];

	it("matches by sku (the legacy `productId` arg passed by sites)", () => {
		const entry = findWishlistEntry(items, "sku-1");
		expect(entry?.id).toBe("entry-1");
	});

	it("matches by productId as a fallback", () => {
		const entry = findWishlistEntry(items, "prod-2");
		expect(entry?.id).toBe("entry-2");
	});

	it("returns undefined when no match", () => {
		expect(findWishlistEntry(items, "missing")).toBeUndefined();
	});

	it("returns undefined for empty list", () => {
		expect(findWishlistEntry([], "anything")).toBeUndefined();
	});
});
