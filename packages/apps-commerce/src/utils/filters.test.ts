import { describe, expect, it } from "vitest";
import { formatRange, parseRange } from "./filters";

describe("parseRange", () => {
	it("parses valid range", () => {
		expect(parseRange("10:50")).toEqual({ from: 10, to: 50 });
	});

	it("parses decimal range", () => {
		expect(parseRange("34.90:56.90")).toEqual({ from: 34.9, to: 56.9 });
	});

	it("returns null for invalid range", () => {
		expect(parseRange("abc:def")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseRange("")).toBeNull();
	});

	it("returns null for single value", () => {
		expect(parseRange("10")).toBeNull();
	});
});

describe("formatRange", () => {
	it("formats range correctly", () => {
		expect(formatRange(10, 50)).toBe("10:50");
	});

	it("formats decimal range", () => {
		expect(formatRange(34.9, 56.9)).toBe("34.9:56.9");
	});
});
