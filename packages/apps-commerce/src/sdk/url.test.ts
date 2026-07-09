import { describe, expect, it } from "vitest";
import { relative } from "./url";

describe("relative()", () => {
	describe("base behaviour (no options)", () => {
		it("returns undefined for undefined input", () => {
			expect(relative(undefined)).toBeUndefined();
		});

		it("returns undefined for empty string input", () => {
			expect(relative("")).toBeUndefined();
		});

		it("preserves a relative path-only URL", () => {
			expect(relative("/p/foo")).toBe("/p/foo");
		});

		it("preserves a relative path with search params", () => {
			expect(relative("/p/foo?a=1&b=2")).toBe("/p/foo?a=1&b=2");
		});

		it("strips the origin from an absolute URL", () => {
			expect(relative("https://x.example.com/p/foo?a=1")).toBe("/p/foo?a=1");
		});

		it("returns the original string when URL parsing fails", () => {
			// `new URL` against the `https://localhost` base accepts almost
			// anything string-shaped, so genuine throws are rare. The catch
			// branch exists as a defence against non-string-like values
			// reaching the helper through type-erased call sites — we
			// exercise it by forcing a non-string through the public API.
			const malformed = {
				toString() {
					throw new Error("boom");
				},
			} as unknown as string;
			expect(relative(malformed)).toBe(malformed);
		});
	});

	describe("stripSearchParams", () => {
		it("removes the listed key", () => {
			expect(
				relative("/p/foo?idsku=1&keep=2", {
					stripSearchParams: ["idsku"],
				}),
			).toBe("/p/foo?keep=2");
		});

		it("removes multiple listed keys", () => {
			expect(
				relative("/p/foo?idsku=1&skuId=2&keep=3", {
					stripSearchParams: ["idsku", "skuId"],
				}),
			).toBe("/p/foo?keep=3");
		});

		it("drops the trailing ? when ALL params are stripped", () => {
			expect(
				relative("/p/foo?idsku=1&skuId=2", {
					stripSearchParams: ["idsku", "skuId"],
				}),
			).toBe("/p/foo");
		});

		it("is a no-op when stripSearchParams is empty", () => {
			expect(relative("/p/foo?a=1", { stripSearchParams: [] })).toBe("/p/foo?a=1");
		});

		it("is a no-op when stripSearchParams is undefined (option object only)", () => {
			expect(relative("/p/foo?a=1", {})).toBe("/p/foo?a=1");
		});

		it("silently ignores keys that are not present in the URL", () => {
			expect(
				relative("/p/foo?keep=1", {
					stripSearchParams: ["idsku", "skuId"],
				}),
			).toBe("/p/foo?keep=1");
		});

		it("strips keys from absolute URLs while still removing the origin", () => {
			expect(
				relative("https://x.example.com/p/foo?idsku=1&keep=2", {
					stripSearchParams: ["idsku"],
				}),
			).toBe("/p/foo?keep=2");
		});

		it("preserves repeated keys for params not in the strip list", () => {
			// URLSearchParams keeps repeats; relative() must not collapse them.
			expect(
				relative("/p/foo?tag=a&tag=b&idsku=1", {
					stripSearchParams: ["idsku"],
				}),
			).toBe("/p/foo?tag=a&tag=b");
		});

		it("removes ALL occurrences of a repeated key when listed", () => {
			expect(
				relative("/p/foo?idsku=1&idsku=2&keep=3", {
					stripSearchParams: ["idsku"],
				}),
			).toBe("/p/foo?keep=3");
		});
	});

	describe("backwards compatibility with the 1-arg signature", () => {
		it("matches the pre-options behaviour byte-for-byte for relative paths", () => {
			expect(relative("/p/foo?a=1")).toBe("/p/foo?a=1");
		});

		it("matches the pre-options behaviour byte-for-byte for absolute URLs", () => {
			expect(relative("https://x.example.com/path?q=1")).toBe("/path?q=1");
		});

		it('preserves the previous "://path-style" passthrough behaviour', () => {
			// The original 9-line apps `relative()` parsed this against
			// the localhost base too — both old and new implementations
			// return "/://no-scheme". This assertion locks in the byte-
			// for-byte identical behaviour for the no-options case.
			expect(relative("://no-scheme")).toBe("/://no-scheme");
		});
	});
});
