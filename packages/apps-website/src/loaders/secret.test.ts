import { describe, expect, it } from "vitest";
import SecretLoader from "./secret";

describe("SecretLoader", () => {
	it("reads from process.env when name is set", () => {
		process.env.MY_SECRET = "super-secret";
		const result = SecretLoader({ encrypted: "xxx", name: "MY_SECRET" });
		expect(result.get()).toBe("super-secret");
		delete process.env.MY_SECRET;
	});

	it("returns null when encrypted is empty", () => {
		const result = SecretLoader({ encrypted: "" });
		expect(result.get()).toBeNull();
	});

	it("returns encrypted value as fallback in dev", () => {
		const original = process.env.NODE_ENV;
		process.env.NODE_ENV = "test";
		const result = SecretLoader({ encrypted: "encrypted-value", name: "NONEXISTENT" });
		expect(result.get()).toBe("encrypted-value");
		process.env.NODE_ENV = original;
	});

	it("reads empty-string env var correctly", () => {
		process.env.EMPTY_SECRET = "";
		const result = SecretLoader({ encrypted: "fallback", name: "EMPTY_SECRET" });
		expect(result.get()).toBe("");
		delete process.env.EMPTY_SECRET;
	});
});
