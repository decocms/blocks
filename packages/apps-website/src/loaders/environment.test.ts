import { describe, expect, it } from "vitest";
import EnvironmentLoader from "./environment";

describe("EnvironmentLoader", () => {
	it("reads from process.env when name is set in development", () => {
		const original = process.env.NODE_ENV;
		process.env.NODE_ENV = "development";
		process.env.MY_ENV_VAR = "hello";
		const result = EnvironmentLoader({ value: "fallback", name: "MY_ENV_VAR" });
		expect(result.get()).toBe("hello");
		delete process.env.MY_ENV_VAR;
		process.env.NODE_ENV = original;
	});

	it("does not read process.env outside development", () => {
		const original = process.env.NODE_ENV;
		process.env.NODE_ENV = "production";
		process.env.MY_ENV_VAR = "hello";
		const result = EnvironmentLoader({ value: "fallback", name: "MY_ENV_VAR" });
		expect(result.get()).toBe("fallback");
		delete process.env.MY_ENV_VAR;
		process.env.NODE_ENV = original;
	});

	it("returns value when env var is not set", () => {
		const result = EnvironmentLoader({ value: "fallback", name: "NONEXISTENT_VAR" });
		expect(result.get()).toBe("fallback");
	});

	it("returns null when value is empty", () => {
		const result = EnvironmentLoader({ value: "" });
		expect(result.get()).toBeNull();
	});
});
