import { afterEach, describe, expect, it, vi } from "vitest";
import { configureShopify, setShopifyFetch } from "../../client";
import { getCart } from "../cart";

type GraphQLBody = { query: string; variables?: Record<string, unknown> };

const json = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

const cartPayload = (id: string) => ({
	data: {
		cart: {
			id,
			checkoutUrl: "https://example.myshopify.com/cart",
			totalQuantity: 0,
			lines: { nodes: [] },
			cost: {
				subtotalAmount: { amount: "0", currencyCode: "USD" },
				totalAmount: { amount: "0", currencyCode: "USD" },
			},
		},
	},
});

function mockStorefront(handler: (body: GraphQLBody) => Response) {
	const calls: GraphQLBody[] = [];
	setShopifyFetch(async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as GraphQLBody;
		calls.push(body);
		return handler(body);
	});
	configureShopify({ storeName: "example", storefrontAccessToken: "token" });
	return calls;
}

describe("getCart", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("replaces a cart that Shopify no longer knows", async () => {
		const calls = mockStorefront(({ query, variables }) => {
			if (query.includes("mutation CreateCart")) {
				return json({ data: { payload: { cart: { id: "gid://shopify/Cart/new" } } } });
			}
			if (variables?.id === "gid://shopify/Cart/stale") {
				return json({ errors: [{ message: "Not Found", extensions: { code: "NOT_FOUND" } }] });
			}
			return json(cartPayload(String(variables?.id)));
		});

		const responseHeaders = new Headers();
		const cart = await getCart(new Headers({ cookie: "cart=stale" }), responseHeaders, {
			countryCode: "US",
			languageCode: "EN",
		});

		expect(cart?.id).toBe("gid://shopify/Cart/new");
		expect(responseHeaders.get("Set-Cookie")).toContain("cart=new");
		expect(calls.map((c) => c.variables)).toEqual([
			{ id: "gid://shopify/Cart/stale", countryCode: "US", languageCode: "EN" },
			{ countryCode: "US", languageCode: "EN" },
			{ id: "gid://shopify/Cart/new", countryCode: "US", languageCode: "EN" },
		]);
	});

	it("rethrows errors other than NOT_FOUND", async () => {
		mockStorefront(() => json({ errors: [{ message: "Throttled" }] }));

		await expect(getCart(new Headers({ cookie: "cart=abc" }))).rejects.toThrow("Throttled");
	});
});
