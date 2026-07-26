import { afterEach, describe, expect, it } from "vitest";
import {
	__resetSimulationCacheForTests,
	getSimulationCache,
	setSimulationCache,
} from "../simulationCache";

describe("simulationCache (#373)", () => {
	afterEach(() => {
		__resetSimulationCacheForTests();
	});

	it("default in-process cache: returns null on miss, then the value after put", async () => {
		const cache = getSimulationCache();
		expect(await cache.get("k")).toBeNull();
		await cache.put("k", "v", 60);
		expect(await cache.get("k")).toBe("v");
	});

	it("expires an entry past its TTL", async () => {
		const cache = getSimulationCache();
		await cache.put("k", "v", 0); // already expired
		await new Promise((r) => setTimeout(r, 5));
		expect(await cache.get("k")).toBeNull();
	});

	it("setSimulationCache injects a custom implementation", async () => {
		const store = new Map<string, string>();
		setSimulationCache({
			get: (k) => store.get(k) ?? null,
			put: (k, v) => {
				store.set(k, v);
			},
		});
		const cache = getSimulationCache();
		await cache.put("k", "custom-value", 60);
		expect(await cache.get("k")).toBe("custom-value");
		expect(store.get("k")).toBe("custom-value");
	});
});
