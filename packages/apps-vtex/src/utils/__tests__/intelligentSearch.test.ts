import { describe, expect, it } from "vitest";
import { isFilterParam, toPath, withDefaultFacets, withDefaultParams } from "../intelligentSearch";

describe("withDefaultFacets", () => {
	it("returns a copy of the facets array", () => {
		const facets = [{ key: "category", value: "shoes" }];
		const result = withDefaultFacets(facets);
		expect(result).toEqual(facets);
		expect(result).not.toBe(facets);
	});

	it("returns empty array for empty input", () => {
		expect(withDefaultFacets([])).toEqual([]);
	});
});

describe("toPath", () => {
	it("builds path from facets", () => {
		const facets = [
			{ key: "category", value: "shoes" },
			{ key: "brand", value: "nike" },
		];
		expect(toPath(facets)).toBe("category/shoes/brand/nike");
	});

	it("handles facets with empty key", () => {
		const facets = [{ key: "", value: "shoes" }];
		expect(toPath(facets)).toBe("shoes");
	});

	it("returns empty string for empty facets", () => {
		expect(toPath([])).toBe("");
	});
});

describe("withDefaultParams", () => {
	it("fills in defaults", () => {
		const result = withDefaultParams({});
		expect(result).toEqual({
			page: 1,
			count: 12,
			query: "",
			sort: "",
			fuzzy: "auto",
			locale: "pt-BR",
			hideUnavailableItems: false,
			simulationBehavior: "default",
		});
	});

	it("increments page by 1", () => {
		expect(withDefaultParams({ page: 0 }).page).toBe(1);
		expect(withDefaultParams({ page: 2 }).page).toBe(3);
	});

	it("preserves provided values", () => {
		const result = withDefaultParams({
			query: "shoes",
			count: 24,
			sort: "price:asc",
			fuzzy: "0",
			hideUnavailableItems: true,
		});
		expect(result.query).toBe("shoes");
		expect(result.count).toBe(24);
		expect(result.sort).toBe("price:asc");
		expect(result.fuzzy).toBe("0");
		expect(result.hideUnavailableItems).toBe(true);
	});

	it("omits fuzzy when empty string", () => {
		const result = withDefaultParams({ fuzzy: "" });
		expect(result).not.toHaveProperty("fuzzy");
	});
});

describe("isFilterParam", () => {
	it("returns true for filter params", () => {
		expect(isFilterParam("filter.category")).toBe(true);
		expect(isFilterParam("filter.brand")).toBe(true);
	});

	it("returns false for non-filter params", () => {
		expect(isFilterParam("page")).toBe(false);
		expect(isFilterParam("query")).toBe(false);
		expect(isFilterParam("filterNot")).toBe(false);
	});
});
