import { describe, expect, it } from "vitest";
import { vtexOperationRouter } from "../operationRouter";

describe("vtexOperationRouter", () => {
	const acct = "https://store.vtexcommercestable.com.br";

	describe("Intelligent Search", () => {
		it("captures the IS endpoint as the operation suffix", () => {
			expect(
				vtexOperationRouter(
					`${acct}/api/io/_v/api/intelligent-search/product_search/electronics`,
					"GET",
				),
			).toBe("intelligent-search.product_search");
			expect(
				vtexOperationRouter(`${acct}/api/io/_v/api/intelligent-search/top_searches`, "GET"),
			).toBe("intelligent-search.top_searches");
			expect(vtexOperationRouter(`${acct}/api/io/_v/api/intelligent-search/facets`, "GET")).toBe(
				"intelligent-search.facets",
			);
			expect(
				vtexOperationRouter(`${acct}/api/io/_v/api/intelligent-search/search_suggestions`, "GET"),
			).toBe("intelligent-search.search_suggestions");
		});

		it("strips query string before matching", () => {
			expect(
				vtexOperationRouter(
					`${acct}/api/io/_v/api/intelligent-search/product_search?query=foo&sort=price`,
					"GET",
				),
			).toBe("intelligent-search.product_search");
		});
	});

	describe("Checkout / orderForm", () => {
		it("differentiates create vs get on orderForm", () => {
			expect(vtexOperationRouter(`${acct}/api/checkout/pub/orderForm`, "POST")).toBe(
				"checkout.orderform.create",
			);
			expect(vtexOperationRouter(`${acct}/api/checkout/pub/orderForm`, "GET")).toBe(
				"checkout.orderform.get",
			);
		});

		it("differentiates items add/update/remove by HTTP method", () => {
			const url = `${acct}/api/checkout/pub/orderForm/abc123/items`;
			expect(vtexOperationRouter(url, "POST")).toBe("checkout.orderform.items.add");
			expect(vtexOperationRouter(url, "PATCH")).toBe("checkout.orderform.items.update");
			expect(vtexOperationRouter(url, "PUT")).toBe("checkout.orderform.items.update");
			expect(vtexOperationRouter(url, "DELETE")).toBe("checkout.orderform.items.remove");
		});

		it("recognizes the /items/update legacy mass-update endpoint", () => {
			expect(
				vtexOperationRouter(`${acct}/api/checkout/pub/orderForm/abc123/items/update`, "POST"),
			).toBe("checkout.orderform.items.update");
		});

		it("handles coupons, profile, shippingData, paymentData", () => {
			const id = "abc123";
			expect(vtexOperationRouter(`${acct}/api/checkout/pub/orderForm/${id}/coupons`, "POST")).toBe(
				"checkout.orderform.coupons",
			);
			expect(vtexOperationRouter(`${acct}/api/checkout/pub/orderForm/${id}/profile`, "POST")).toBe(
				"checkout.orderform.profile",
			);
			expect(
				vtexOperationRouter(`${acct}/api/checkout/pub/orderForm/${id}/shippingData/...`, "POST"),
			).toBe("checkout.orderform.shipping");
			expect(
				vtexOperationRouter(`${acct}/api/checkout/pub/orderForm/${id}/paymentData/...`, "POST"),
			).toBe("checkout.orderform.payment");
		});

		it("matches the singleton orderForm/{id} root with the right method", () => {
			expect(vtexOperationRouter(`${acct}/api/checkout/pub/orderForm/abc`, "GET")).toBe(
				"checkout.orderform.get",
			);
			expect(vtexOperationRouter(`${acct}/api/checkout/pub/orderForm/abc`, "PATCH")).toBe(
				"checkout.orderform.update",
			);
		});

		it("maps simulation, regions, postal-code", () => {
			expect(vtexOperationRouter(`${acct}/api/checkout/pub/orderForms/simulation`, "POST")).toBe(
				"checkout.simulation",
			);
			expect(vtexOperationRouter(`${acct}/api/checkout/pub/regions`, "GET")).toBe(
				"checkout.regions",
			);
			expect(vtexOperationRouter(`${acct}/api/checkout/pub/postal-code/BRA/01310`, "GET")).toBe(
				"checkout.postal-code",
			);
		});
	});

	describe("Sessions + segments", () => {
		it("differentiates sessions GET vs POST", () => {
			expect(vtexOperationRouter(`${acct}/api/sessions`, "GET")).toBe("sessions.get");
			expect(vtexOperationRouter(`${acct}/api/sessions`, "POST")).toBe("sessions.update");
		});

		it("matches segments", () => {
			expect(vtexOperationRouter(`${acct}/api/segments/abc-123`, "GET")).toBe("segments.get");
		});
	});

	describe("Catalog System", () => {
		it("captures the most-specific catalog endpoints first", () => {
			expect(
				vtexOperationRouter(`${acct}/api/catalog_system/pub/portal/pagetype/eletronicos`, "GET"),
			).toBe("catalog.pagetype");
			expect(
				vtexOperationRouter(
					`${acct}/api/catalog_system/pub/products/crossselling/whoboughtalsobought/123`,
					"GET",
				),
			).toBe("catalog.crossselling.whoboughtalsobought");
			expect(
				vtexOperationRouter(`${acct}/api/catalog_system/pub/products/variations/123`, "GET"),
			).toBe("catalog.products.variations");
			expect(
				vtexOperationRouter(`${acct}/api/catalog_system/pub/products/search/?fq=x`, "GET"),
			).toBe("catalog.products.search");
			expect(vtexOperationRouter(`${acct}/api/catalog_system/pub/facets/search/x`, "GET")).toBe(
				"catalog.facets.search",
			);
			expect(vtexOperationRouter(`${acct}/api/catalog_system/pub/category/tree/3`, "GET")).toBe(
				"catalog.category.tree",
			);
			expect(
				vtexOperationRouter(`${acct}/api/catalog_system/pvt/sku/stockkeepingunitbyid/123`, "GET"),
			).toBe("catalog.sku");
		});

		it("falls back to catalog.other for unrecognized catalog paths", () => {
			expect(
				vtexOperationRouter(`${acct}/api/catalog_system/pvt/specification/groupGet/123`, "GET"),
			).toBe("catalog.specification");
			expect(vtexOperationRouter(`${acct}/api/catalog_system/pub/brand/list`, "GET")).toBe(
				"catalog.brand",
			);
		});
	});

	describe("Masterdata", () => {
		it("encodes the entity name as the operation suffix", () => {
			expect(vtexOperationRouter(`${acct}/api/dataentities/AD/search`, "GET")).toBe(
				"masterdata.AD",
			);
			expect(vtexOperationRouter(`${acct}/api/dataentities/wishlist_lists/documents`, "POST")).toBe(
				"masterdata.wishlist_lists",
			);
		});
	});

	describe("OMS", () => {
		it("differentiates orders list vs cancel", () => {
			expect(vtexOperationRouter(`${acct}/api/oms/user/orders`, "GET")).toBe("oms.orders");
			expect(vtexOperationRouter(`${acct}/api/oms/user/orders/v999-01/cancel`, "POST")).toBe(
				"oms.orders.cancel",
			);
			expect(vtexOperationRouter(`${acct}/api/oms/pvt/orders/v999-01`, "GET")).toBe(
				"oms.orders.pvt",
			);
		});
	});

	describe("VTEX ID", () => {
		it("maps the auth surface", () => {
			expect(vtexOperationRouter(`${acct}/api/vtexid/pub/logout?scope=x`, "GET")).toBe(
				"vtexid.logout",
			);
			expect(vtexOperationRouter(`${acct}/api/vtexid/pub/authentication/start`, "GET")).toBe(
				"vtexid.authentication.start",
			);
			expect(
				vtexOperationRouter(`${acct}/api/vtexid/pub/authentication/classic/validate`, "POST"),
			).toBe("vtexid.authentication.validate");
			expect(vtexOperationRouter(`${acct}/api/vtexid/pub/authenticated/user`, "GET")).toBe(
				"vtexid.user",
			);
		});

		it("falls back to vtexid.other for unmapped vtexid paths", () => {
			expect(vtexOperationRouter(`${acct}/api/vtexid/pub/refreshtoken`, "POST")).toBe(
				"vtexid.other",
			);
		});
	});

	describe("VTEX IO + GraphQL", () => {
		it("matches the IO private graphql endpoint", () => {
			expect(vtexOperationRouter(`https://store.myvtex.com/_v/private/graphql/v1`, "POST")).toBe(
				"io.graphql",
			);
		});

		it("matches the IO segment endpoint", () => {
			expect(
				vtexOperationRouter(`https://store.myvtex.com/_v/segment/admin-pvt/whatever`, "GET"),
			).toBe("io.segment");
		});
	});

	describe("Edge cases", () => {
		it("returns undefined for fully unrecognized URLs", () => {
			expect(vtexOperationRouter(`${acct}/somethingelse/random`, "GET")).toBeUndefined();
		});

		it("does not throw on unparseable URLs and still tries to match", () => {
			expect(vtexOperationRouter("not-a-real-url", "GET")).toBeUndefined();
			expect(vtexOperationRouter("/api/sessions?x=1", "GET")).toBe("sessions.get");
		});

		it("is case-insensitive on the method", () => {
			expect(vtexOperationRouter(`${acct}/api/sessions`, "post")).toBe("sessions.update");
			expect(vtexOperationRouter(`${acct}/api/sessions`, "Get")).toBe("sessions.get");
		});

		it("recognizes sitemap.xml + sitemap-products-0.xml", () => {
			expect(vtexOperationRouter(`${acct}/sitemap.xml`, "GET")).toBe("sitemap");
			expect(vtexOperationRouter(`${acct}/sitemap-products-0.xml`, "GET")).toBe("sitemap");
		});
	});
});
