/**
 * End-to-end guard for the acceptance criteria of "real props schemas in
 * /deco/meta": after a site wires VTEX the standard way
 * (createVtexCommerceLoaders → registerCommerceLoaders), the composed meta
 * must publish the real props of the app's loaders/actions — enums included —
 * not the `__resolveType`-only stubs.
 */

import { registerCommerceLoaders } from "@decocms/blocks/cms";
import { composeMeta, type MetaResponse } from "@decocms/blocks/cms/client";
import { describe, expect, it } from "vitest";
import { createVtexCommerceLoaders } from "../commerceLoaders";
import { registerVtexSchemas } from "../schemas";

const b64 = (s: string) => Buffer.from(s).toString("base64");

const emptySiteMeta = (): MetaResponse => ({
	major: 1,
	version: "1.0.0",
	namespace: "site",
	site: "test",
	manifest: { blocks: {} },
	schema: { definitions: {}, root: {} },
});

describe("vtex schemas in the composed meta", () => {
	// Mirrors a real site setup: build the loader map (this also registers the
	// real schemas), then register it (which auto-registers the stubs).
	registerCommerceLoaders(createVtexCommerceLoaders());
	registerVtexSchemas();
	const meta = composeMeta(emptySiteMeta());
	const def = (key: string) => meta.schema.definitions[b64(key)];

	it("publishes real props for the intelligent-search PDP loader (both key forms)", () => {
		for (const key of [
			"vtex/loaders/intelligentSearch/productDetailsPage.ts",
			"vtex/loaders/intelligentSearch/productDetailsPage",
		]) {
			const d = def(key);
			expect(d, key).toBeDefined();
			expect(d.properties.slug, key).toMatchObject({ type: "string" });
			expect(d.properties.__resolveType.enum, key).toEqual([key]);
			expect(d.additionalProperties, key).toBeUndefined();
		}
	});

	it("publishes the legacy PLP loader with its sort enum preserved", () => {
		const d = def("vtex/loaders/legacy/productListingPage.ts");
		expect(d).toBeDefined();
		expect(d.properties.sort.enum).toContain("OrderByPriceDESC");
		expect(d.properties.sort.enum).toContain("OrderByPriceASC");
		expect(d.properties.count).toMatchObject({ type: "number" });
		expect(d.properties.fq).toMatchObject({ type: "string" });
	});

	it("requires no user input on the legacy PLP loader — url/baseUrl derive from __pageUrl", () => {
		const d = def("vtex/loaders/legacy/productListingPage.ts");
		// Every prop is now optional (url/baseUrl fall back to the
		// resolver-injected __pageUrl); composeMeta adds only __resolveType.
		expect(d.required ?? []).toEqual(["__resolveType"]);
		// The injected prop itself never reaches the form.
		expect(d.properties.__pageUrl).toBeUndefined();
	});

	it("keeps only legit user input required on the other legacy loaders", () => {
		expect(def("vtex/loaders/legacy/productDetailsPage.ts").required).toEqual([
			"__resolveType",
			"slug",
		]);
		expect(def("vtex/loaders/legacy/productList.ts").required).toEqual([
			"__resolveType",
			"query",
		]);
	});

	it("publishes real props for a checkout action", () => {
		const d = def("vtex/actions/checkout/addItemsToCart.ts");
		expect(d).toBeDefined();
		expect(d.properties.orderItems).toMatchObject({ type: "array" });
		expect(d.additionalProperties).toBeUndefined();
	});

	it("keeps the JSON-editor stub shape for keys without a generated schema", () => {
		// Registered by createVtexCommerceLoaders but owned by another namespace —
		// no schemas.gen entry, so the stub (additionalProperties: true) survives.
		const d = def("commerce/loaders/navbar.ts");
		expect(d).toBeDefined();
		expect(d.additionalProperties).toBe(true);
		expect(Object.keys(d.properties)).toEqual(["__resolveType"]);
	});
});
