/**
 * Tests for the features loader.
 *
 * Parity with deco-cx/apps/magento/loaders/features.ts (Fresh/Deno, prod):
 * the legacy loader was a 3-arg `(_props, _req, ctx) => ctx.features`.
 * The ported version uses the module-global config instead of a per-
 * request ctx, but the surface area downstream is the same — a plain
 * object pulled from the resolved magento CMS block.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { configureMagento } from "../client";
import features from "../loaders/features";

describe("features loader", () => {
	beforeEach(() => {
		configureMagento({
			baseUrl: "https://loja.example.com/",
			apiKey: "key",
			storeId: 1,
			site: "example",
			features: {
				dangerouslyDisableWishlist: false,
				dangerouslyDisableOnLoadUpdate: true,
				dangerouslyReturnNullAfterAction: true,
				dangerouslyDontReturnCartAfterAction: true,
				dangerouslyDisableOnVisibilityChangeUpdate: true,
			},
		});
	});

	it("returns the feature flags object from the config", () => {
		expect(features()).toEqual({
			dangerouslyDisableWishlist: false,
			dangerouslyDisableOnLoadUpdate: true,
			dangerouslyReturnNullAfterAction: true,
			dangerouslyDontReturnCartAfterAction: true,
			dangerouslyDisableOnVisibilityChangeUpdate: true,
		});
	});

	it("returns an empty object when features are not configured", () => {
		configureMagento({
			baseUrl: "https://loja.example.com/",
			apiKey: "key",
			storeId: 1,
			site: "example",
			// features omitted
		});
		expect(features()).toEqual({});
	});
});
