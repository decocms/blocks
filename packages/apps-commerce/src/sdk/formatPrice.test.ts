import { describe, expect, it } from "vitest";
import { formatPrice, formatPriceRange } from "./formatPrice";

describe("formatPrice", () => {
	it("formats a number to BRL by default", () => {
		const result = formatPrice(123.45);
		// Intl-formatted with NBSP between "R$" and the number; just check the
		// digits are present.
		expect(result).toMatch(/123,45/);
		expect(result).toMatch(/R\$/);
	});

	it("returns null for undefined/null", () => {
		expect(formatPrice(undefined)).toBeNull();
		expect(formatPrice(null)).toBeNull();
	});

	it("returns null for non-finite numbers", () => {
		expect(formatPrice(Number.NaN)).toBeNull();
		expect(formatPrice(Number.POSITIVE_INFINITY)).toBeNull();
	});

	it("respects currency + locale overrides", () => {
		const result = formatPrice(99, "USD", "en-US");
		expect(result).toMatch(/\$99/);
	});
});

describe("formatPriceRange", () => {
	it("formats a min:max string with the default currency", () => {
		const result = formatPriceRange("10:50");
		expect(result).toMatch(/10,00/);
		expect(result).toMatch(/50,00/);
		expect(result).toContain(" - ");
	});

	it("respects currency / locale overrides", () => {
		const result = formatPriceRange("10:50", "USD", "en-US");
		expect(result).toMatch(/\$10/);
		expect(result).toMatch(/\$50/);
	});

	it("respects a custom separator", () => {
		const result = formatPriceRange("10:50", "BRL", "pt-BR", " a ");
		expect(result).toContain(" a ");
	});

	it("returns the input unchanged when there's no colon", () => {
		expect(formatPriceRange("not-a-range")).toBe("not-a-range");
	});

	it("returns the input unchanged when bounds aren't numeric", () => {
		expect(formatPriceRange("foo:bar")).toBe("foo:bar");
	});

	it("returns the input unchanged for non-string input", () => {
		expect(formatPriceRange(undefined as unknown as string)).toBeUndefined();
	});
});
