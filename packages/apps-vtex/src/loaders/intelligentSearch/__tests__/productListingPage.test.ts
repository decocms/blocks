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

	it("resets a malformed ?page= to 0 instead of propagating NaN", () => {
		expect(resolvePage(undefined, "abc")).toBe(0);
	});

	it("floors a fractional page and never returns a negative page", () => {
		expect(resolvePage(2.7, undefined)).toBe(2);
		expect(resolvePage(-1, undefined)).toBe(0);
	});
});
