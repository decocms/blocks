import { describe, expect, it } from "vitest";
import { shopifyOperationRouter } from "../operationRouter";

describe("shopifyOperationRouter", () => {
	const store = "https://acme.myshopify.com";

	it("recognizes the storefront GraphQL endpoint", () => {
		expect(shopifyOperationRouter(`${store}/api/2025-04/graphql.json`, "POST")).toBe(
			"storefront.graphql",
		);
	});

	it("recognizes the admin GraphQL endpoint", () => {
		expect(shopifyOperationRouter(`${store}/admin/api/2025-04/graphql.json`, "POST")).toBe(
			"admin.graphql",
		);
	});

	it("maps admin REST product / order / customer / inventory endpoints", () => {
		expect(shopifyOperationRouter(`${store}/admin/api/2025-04/products.json`, "GET")).toBe(
			"admin.products",
		);
		expect(shopifyOperationRouter(`${store}/admin/api/2025-04/orders/123.json`, "GET")).toBe(
			"admin.orders",
		);
		expect(shopifyOperationRouter(`${store}/admin/api/2025-04/customers.json`, "GET")).toBe(
			"admin.customers",
		);
		expect(shopifyOperationRouter(`${store}/admin/api/2025-04/inventory_levels.json`, "GET")).toBe(
			"admin.inventory",
		);
	});

	it("maps storefront checkout + cart endpoints", () => {
		expect(shopifyOperationRouter(`${store}/api/2025-04/checkouts/abc.json`, "POST")).toBe(
			"storefront.checkout",
		);
		expect(shopifyOperationRouter(`${store}/cart.js`, "GET")).toBe("storefront.cart");
		expect(shopifyOperationRouter(`${store}/cart/add.js`, "POST")).toBe("storefront.cart");
	});

	it("returns undefined for unrecognized paths", () => {
		expect(shopifyOperationRouter(`${store}/random/path`, "GET")).toBeUndefined();
	});

	it("does not throw on unparseable URLs", () => {
		expect(shopifyOperationRouter("not-a-url", "GET")).toBeUndefined();
		expect(shopifyOperationRouter("/api/2025-04/graphql.json", "POST")).toBe("storefront.graphql");
	});

	it("is case-insensitive on method (no behavioral impact today; future-proofing)", () => {
		expect(shopifyOperationRouter(`${store}/api/2025-04/graphql.json`, "post")).toBe(
			"storefront.graphql",
		);
	});
});
