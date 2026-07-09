import { describe, expect, it } from "vitest";
import { extractGraphqlOperationName } from "../graphqlOperationName";

describe("extractGraphqlOperationName", () => {
	it("returns the explicit name when provided, regardless of body content", () => {
		expect(extractGraphqlOperationName("query Whatever { x }", "ForcedName")).toBe("ForcedName");
		expect(extractGraphqlOperationName("", "Override")).toBe("Override");
	});

	it("extracts a single named query", () => {
		expect(
			extractGraphqlOperationName("query ProductBySlug($slug: String!) { product { id } }"),
		).toBe("ProductBySlug");
	});

	it("extracts a single named mutation", () => {
		expect(
			extractGraphqlOperationName("mutation CartLinesAdd($cartId: ID!) { cartLinesAdd { } }"),
		).toBe("CartLinesAdd");
	});

	it("extracts a single named subscription", () => {
		expect(extractGraphqlOperationName("subscription OrderEvents { orderUpdated { id } }")).toBe(
			"OrderEvents",
		);
	});

	it("returns undefined for anonymous operations", () => {
		expect(extractGraphqlOperationName("{ product { id } }")).toBeUndefined();
		expect(extractGraphqlOperationName("query { product { id } }")).toBeUndefined();
	});

	it("returns undefined when document has more than one named operation (caller must disambiguate)", () => {
		const multi = `
			query OpA { a }
			query OpB { b }
		`;
		expect(extractGraphqlOperationName(multi)).toBeUndefined();
	});

	it("ignores the words query/mutation/subscription inside string literals", () => {
		const docWithStringy = `query RealName { thing(arg: "this query mutation subscription is a string") }`;
		expect(extractGraphqlOperationName(docWithStringy)).toBe("RealName");
	});

	it("ignores the words inside block strings (triple-quoted)", () => {
		const doc = `
			"""
			This block string mentions query Inner and mutation Inner2.
			"""
			query OuterReal { x }
		`;
		expect(extractGraphqlOperationName(doc)).toBe("OuterReal");
	});

	it("ignores the words inside # comments", () => {
		const doc = `
			# query CommentedOut { x }
			query Active { y }
		`;
		expect(extractGraphqlOperationName(doc)).toBe("Active");
	});

	it("returns undefined on an empty / nullish body", () => {
		expect(extractGraphqlOperationName("")).toBeUndefined();
		expect(extractGraphqlOperationName("   \n\t  ")).toBeUndefined();
	});

	it("handles a real-world Shopify storefront query shape", () => {
		const doc = `
			query ProductDetails($handle: String!, $country: CountryCode!) @inContext(country: $country) {
				product(handle: $handle) {
					id
					title
				}
			}
		`;
		expect(extractGraphqlOperationName(doc)).toBe("ProductDetails");
	});
});
