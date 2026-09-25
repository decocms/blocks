import { describe, expect, it } from "vitest";
import { configureVtex, getVtexConfig, normalizePublicUrl, storeBaseUrl } from "../../client";

describe("normalizePublicUrl", () => {
	it("strips the scheme", () => {
		expect(normalizePublicUrl("https://store.example.com")).toBe("store.example.com");
		expect(normalizePublicUrl("http://store.example.com")).toBe("store.example.com");
	});

	it("strips trailing slashes", () => {
		expect(normalizePublicUrl("store.example.com/")).toBe("store.example.com");
		expect(normalizePublicUrl("https://store.example.com///")).toBe("store.example.com");
	});

	it("leaves a bare host untouched", () => {
		expect(normalizePublicUrl("store.example.com")).toBe("store.example.com");
	});

	it("treats empty and whitespace-only values as absent", () => {
		expect(normalizePublicUrl(undefined)).toBeUndefined();
		expect(normalizePublicUrl("")).toBeUndefined();
		expect(normalizePublicUrl("  ")).toBeUndefined();
		expect(normalizePublicUrl("https://")).toBeUndefined();
	});
});

describe("storeBaseUrl", () => {
	// The value License Manager shows, pasted verbatim into the CMS. Interpolated
	// by hand this produced `https://https://store.example.com/`, which parses as
	// host `https` — every product URL in the payload became `https://https/…`.
	it("builds a valid URL from a publicUrl that carries the scheme", () => {
		const url = storeBaseUrl({ account: "acme", publicUrl: "https://store.example.com/" });
		expect(url).toBe("https://store.example.com");
		expect(new URL("/product/p", url).href).toBe("https://store.example.com/product/p");
	});

	it("builds a valid URL from a bare publicUrl host", () => {
		expect(storeBaseUrl({ account: "acme", publicUrl: "store.example.com" })).toBe(
			"https://store.example.com",
		);
	});

	it("falls back to the VTEX commerce host when publicUrl is absent", () => {
		expect(storeBaseUrl({ account: "acme" })).toBe("https://acme.vtexcommercestable.com.br");
	});

	it("respects a custom domain in the fallback", () => {
		expect(storeBaseUrl({ account: "acme", domain: "com" })).toBe(
			"https://acme.vtexcommercestable.com",
		);
	});

	it("reads the configured singleton when no config is passed", () => {
		configureVtex({ account: "acme", publicUrl: "https://store.example.com/" });
		expect(getVtexConfig().publicUrl).toBe("store.example.com");
		expect(storeBaseUrl()).toBe("https://store.example.com");
	});
});
