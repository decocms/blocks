import { describe, expect, it } from "vitest";
import type { AppManifest } from "./app-types";
import { extractHandlers } from "./manifest-utils";

describe("extractHandlers", () => {
	it("flattens module namespaces into individual handler entries", () => {
		const searchProducts = () => {};
		const getProductById = () => {};
		const addItem = () => {};

		const manifest: AppManifest = {
			name: "test",
			loaders: {
				"test/loaders/catalog": {
					searchProducts,
					getProductById,
					SOME_CONSTANT: "not a function",
				},
			},
			actions: {
				"test/actions/cart": {
					addItem,
				},
			},
		};

		const handlers = extractHandlers(manifest);

		expect(handlers["test/loaders/catalog/searchProducts"]).toBe(searchProducts);
		expect(handlers["test/loaders/catalog/getProductById"]).toBe(getProductById);
		expect(handlers).not.toHaveProperty("test/loaders/catalog/SOME_CONSTANT");
		expect(handlers["test/actions/cart/addItem"]).toBe(addItem);
	});

	it("returns empty object for empty manifest", () => {
		const manifest: AppManifest = { name: "empty", loaders: {}, actions: {} };
		expect(extractHandlers(manifest)).toEqual({});
	});

	it("handles multiple modules per category", () => {
		const fn1 = () => {};
		const fn2 = () => {};

		const manifest: AppManifest = {
			name: "multi",
			loaders: {
				"app/loaders/a": { fn1 },
				"app/loaders/b": { fn2 },
			},
			actions: {},
		};

		const handlers = extractHandlers(manifest);
		expect(handlers["app/loaders/a/fn1"]).toBe(fn1);
		expect(handlers["app/loaders/b/fn2"]).toBe(fn2);
	});
});
