import { describe, expect, it } from "vitest";
import { slugify } from "../slugify";

describe("slugify", () => {
	it("lowercases and removes spaces", () => {
		expect(slugify("Hello World")).toBe("hello-world");
	});

	it("replaces accented characters", () => {
		expect(slugify("Calçados")).toBe("calcados");
		expect(slugify("São Paulo")).toBe("sao-paulo");
		expect(slugify("Café")).toBe("cafe");
	});

	it("replaces special characters with hyphens", () => {
		expect(slugify("shoes/running")).toBe("shoes-running");
		expect(slugify("men's wear")).toBe("men-s-wear");
	});

	it("removes commas", () => {
		expect(slugify("shoes,sandals")).toBe("shoessandals");
	});

	it("handles already slugified strings", () => {
		expect(slugify("already-slugified")).toBe("already-slugified");
	});

	it("handles empty string", () => {
		expect(slugify("")).toBe("");
	});
});
