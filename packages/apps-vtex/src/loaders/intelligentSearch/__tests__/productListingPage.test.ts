import { describe, expect, it } from "vitest";
import { mapLabelledFuzzyToFuzzy, resolvePage } from "../productListingPage";

describe("mapLabelledFuzzyToFuzzy", () => {
	it("translates 'automatic' to 'auto'", () => {
		expect(mapLabelledFuzzyToFuzzy("automatic")).toBe("auto");
	});

	it("translates 'enabled' to '1'", () => {
		expect(mapLabelledFuzzyToFuzzy("enabled")).toBe("1");
	});

	it("translates 'disabled' to '0'", () => {
		expect(mapLabelledFuzzyToFuzzy("disabled")).toBe("0");
	});

	it("returns undefined for missing label", () => {
		expect(mapLabelledFuzzyToFuzzy(undefined)).toBeUndefined();
	});
});

describe("resolvePage (#391)", () => {
	it("defaults to page 0 with no props.page and no URL page", () => {
		expect(resolvePage(undefined, undefined)).toBe(0);
	});

	it("converts a 1-indexed URL ?page= to the 0-indexed internal page", () => {
		expect(resolvePage(undefined, "3")).toBe(2);
	});

	it("uses props.page directly (already 0-indexed) over the URL", () => {
		expect(resolvePage(5, "3")).toBe(5);
	});

	it("coerces a string props.page instead of silently falling back to 0", () => {
		expect(resolvePage("3", undefined)).toBe(3);
	});

	it("falls through to the URL page when props.page is a non-finite string", () => {
		expect(resolvePage("not-a-number", "3")).toBe(2);
	});

	it("floors a fractional props.page and never returns a negative page", () => {
		expect(resolvePage(2.7, undefined)).toBe(2);
		expect(resolvePage(-1, undefined)).toBe(0);
	});
});

// deco-cx's `pageOf` sends `Number(page) - 1` to Intelligent Search without a
// clamp; IS rejects a page below 1 and the PLP answers 404. Clamping to the
// first page served page 1 as an indexable duplicate under `?page=0`.
describe("resolvePage — a ?page= that names no page is not found", () => {
	it.each([
		["0", "?page=0"],
		["-1", "?page=-1"],
		["abc", "?page=abc"],
		["NaN", "?page=NaN"],
	])("%s → null (%s)", (raw) => {
		expect(resolvePage(undefined, raw)).toBeNull();
	});

	it("an empty ?page= is still the first page", () => {
		expect(resolvePage(undefined, "")).toBe(0);
	});

	it("?page=1 is the first page", () => {
		expect(resolvePage(undefined, "1")).toBe(0);
	});

	it("floors a fractional ?page=, which deco-cx accepts", () => {
		expect(resolvePage(undefined, "1.5")).toBe(0);
		expect(resolvePage(undefined, "2.5")).toBe(1);
	});

	it("a CMS props.page wins over an invalid ?page=", () => {
		expect(resolvePage(2, "0")).toBe(2);
	});

	it("a non-numeric props.page still falls through to the URL — and to its verdict", () => {
		expect(resolvePage("not-a-number", "0")).toBeNull();
	});
});
