import { describe, expect, it } from "vitest";
import { getWebsiteConfig } from "./client";
import { configure } from "./mod";

describe("configure", () => {
	const mockResolveSecret = async () => null;

	it("returns an AppDefinition with name website", async () => {
		const result = await configure({}, mockResolveSecret);

		expect(result).not.toBeNull();
		expect(result.name).toBe("website");
		expect(result.manifest).toBeDefined();
		expect(result.state.config).toBeDefined();
	});

	it("passes SEO config from block data", async () => {
		const seo = { title: "My Site", description: "A great site" };
		const result = await configure({ seo }, mockResolveSecret);

		expect(result.state.config.seo).toEqual(seo);
	});

	it("configures the global singleton", async () => {
		const seo = { title: "Singleton Test" };
		await configure({ seo }, mockResolveSecret);

		const config = getWebsiteConfig();
		expect(config.seo).toEqual(seo);
	});

	it("works with null/undefined block", async () => {
		const result = await configure(null, mockResolveSecret);

		expect(result.name).toBe("website");
		expect(result.state.config.seo).toBeUndefined();
	});

	it("manifest has loaders and sections", async () => {
		const result = await configure({}, mockResolveSecret);

		expect(Object.keys(result.manifest.loaders).length).toBeGreaterThan(0);
		expect(Object.keys(result.manifest.sections ?? {}).length).toBeGreaterThan(0);
	});
});
