/**
 * Tests for the GraphQL helpers used by product loaders.
 *
 * Parity with deco-cx/apps/magento/utils/graphql.ts — pure functions,
 * so behavior is exhaustively pinnable. Each test mirrors a real call
 * site in the (still-unported) product loaders.
 */
import { describe, expect, it } from "vitest";
import {
	filtersFromLoaderGraphQL,
	filtersFromUrlGraphQL,
	formatUrlSuffix,
	getCustomFields,
	transformFilterGraphQL,
	transformFilterValueGraphQL,
	transformSortGraphQL,
} from "../utils/graphql";

describe("transformSortGraphQL", () => {
	it("returns undefined when sortBy is absent", () => {
		expect(transformSortGraphQL({})).toBeUndefined();
		expect(transformSortGraphQL({ order: "DESC" })).toBeUndefined();
	});

	it("defaults order to ASC when not provided", () => {
		expect(transformSortGraphQL({ sortBy: { value: "price" } })).toEqual({
			price: "ASC",
		});
	});

	it("respects DESC order", () => {
		expect(transformSortGraphQL({ sortBy: { value: "name" }, order: "DESC" })).toEqual({
			name: "DESC",
		});
	});

	it("supports custom sort options (any string value)", () => {
		expect(transformSortGraphQL({ sortBy: { value: "best_seller_rank" } as any })).toEqual({
			best_seller_rank: "ASC",
		});
	});
});

describe("transformFilterValueGraphQL", () => {
	it("EQUAL → { eq: value }", () => {
		expect(transformFilterValueGraphQL("ABC", "EQUAL")).toEqual({ eq: "ABC" });
	});

	it("MATCH → { match: value }", () => {
		expect(transformFilterValueGraphQL("foo bar", "MATCH")).toEqual({
			match: "foo bar",
		});
	});

	it("RANGE → { from, to } split on the FIRST underscore", () => {
		expect(transformFilterValueGraphQL("10_50", "RANGE")).toEqual({
			from: "10",
			to: "50",
		});
	});

	it("RANGE with multi-underscore value: only first underscore splits", () => {
		// Magento's URL param `price=10_50_extra` is unusual but pinned
		// to substring(0, idx) + substring(idx+1) which keeps the trailing
		// underscore on the `to` side.
		expect(transformFilterValueGraphQL("10_50_extra", "RANGE")).toEqual({
			from: "10",
			to: "50_extra",
		});
	});
});

describe("filtersFromUrlGraphQL", () => {
	it("picks up known filter keys from URL searchParams", () => {
		const url = new URL("https://x.test/?sku=ABC&color=red&unknown=zzz");
		expect(filtersFromUrlGraphQL(url)).toEqual({
			sku: { eq: "ABC" },
			color: { eq: "red" },
		});
	});

	it("handles RANGE filters (price)", () => {
		const url = new URL("https://x.test/?price=10_50");
		expect(filtersFromUrlGraphQL(url)).toEqual({
			price: { from: "10", to: "50" },
		});
	});

	it("handles MATCH filters (name, description)", () => {
		const url = new URL("https://x.test/?name=foo+bar");
		expect(filtersFromUrlGraphQL(url)).toEqual({
			name: { match: "foo bar" },
		});
	});

	it("layers customFilters on top of defaults", () => {
		const url = new URL("https://x.test/?tag__phebo=fragrancia&sku=X");
		expect(filtersFromUrlGraphQL(url, [{ value: "tag__phebo", type: "EQUAL" }])).toEqual({
			tag__phebo: { eq: "fragrancia" },
			sku: { eq: "X" },
		});
	});

	it("returns empty object when no filterable param is set", () => {
		expect(filtersFromUrlGraphQL(new URL("https://x.test/?totally=other"))).toEqual({});
	});
});

describe("filtersFromLoaderGraphQL", () => {
	it("returns empty object when undefined", () => {
		expect(filtersFromLoaderGraphQL(undefined)).toEqual({});
	});

	it("collapses array of FilterProps into a keyed object", () => {
		expect(
			filtersFromLoaderGraphQL([
				{ name: "sku", type: { eq: "A" } },
				{ name: "color", type: { in: ["red", "blue"] } },
			]),
		).toEqual({
			sku: { eq: "A" },
			color: { in: ["red", "blue"] },
		});
	});
});

describe("transformFilterGraphQL — merge order", () => {
	it("loader-derived filters override URL-derived ones on key collisions", () => {
		// A section hard-coding `sale=true` should ignore any conflicting URL hint.
		const url = new URL("https://x.test/?sale=false");
		expect(
			transformFilterGraphQL(url, undefined, [{ name: "sale", type: { eq: "true" } }]),
		).toEqual({
			sale: { eq: "true" },
		});
	});

	it("non-colliding sources merge cleanly", () => {
		const url = new URL("https://x.test/?sku=ABC");
		expect(
			transformFilterGraphQL(url, undefined, [{ name: "category_id", type: { eq: "42" } }]),
		).toEqual({
			sku: { eq: "ABC" },
			category_id: { eq: "42" },
		});
	});
});

describe("formatUrlSuffix", () => {
	it("strips a single leading slash", () => {
		expect(formatUrlSuffix("/granado/")).toBe("granado/");
	});

	it("appends trailing slash when missing", () => {
		expect(formatUrlSuffix("granado")).toBe("granado/");
	});

	it("leaves trailing slash alone", () => {
		expect(formatUrlSuffix("granado/")).toBe("granado/");
	});
});

describe("getCustomFields", () => {
	it("returns undefined when active=false", () => {
		expect(getCustomFields({ active: false }, ["a", "b"])).toBeUndefined();
	});

	it("returns overrideList when present (ignores fallback)", () => {
		expect(getCustomFields({ active: true, overrideList: ["x", "y"] }, ["a", "b"])).toEqual([
			"x",
			"y",
		]);
	});

	it("falls back to provided customFields when overrideList is empty/absent", () => {
		expect(getCustomFields({ active: true, overrideList: [] }, ["a", "b"])).toEqual(["a", "b"]);
		expect(getCustomFields({ active: true }, ["a", "b"])).toEqual(["a", "b"]);
	});

	it("defaults config to {active:false} when omitted", () => {
		expect(getCustomFields(undefined, ["a"])).toBeUndefined();
	});
});
