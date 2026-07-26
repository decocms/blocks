import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureVtex } from "../../client";

const simulateCartMock = vi.fn(async (props: any) => ({
	logisticsInfo: [{ slas: [{ id: "sla-1" }] }],
	echo: props,
}));

vi.mock("../../actions/checkout", () => ({
	simulateCart: (props: any) => simulateCartMock(props),
}));

import cartShipping, { getShippingSimulation } from "./shipping";
import { __resetSimulationCacheForTests } from "../../utils/simulationCache";

describe("getShippingSimulation (#373)", () => {
	beforeEach(() => {
		configureVtex({ account: "acme", salesChannel: "1" });
		__resetSimulationCacheForTests();
		simulateCartMock.mockClear();
	});

	afterEach(() => {
		__resetSimulationCacheForTests();
	});

	const props = {
		items: [{ id: "1", quantity: 1, seller: "1" }],
		postalCode: "01310-100",
	};

	it("calls simulateCart on a cache MISS and caches the response body", async () => {
		const result = await getShippingSimulation(props);
		expect(simulateCartMock).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ logisticsInfo: [{ slas: [{ id: "sla-1" }] }], echo: expect.anything() });
	});

	it("serves the cached response on a second call with the same tuple — no 2nd simulateCart call", async () => {
		await getShippingSimulation(props);
		await getShippingSimulation(props);
		expect(simulateCartMock).toHaveBeenCalledTimes(1);
	});

	it("calls simulateCart again for a different postalCode (different cache key)", async () => {
		await getShippingSimulation(props);
		await getShippingSimulation({ ...props, postalCode: "20040-020" });
		expect(simulateCartMock).toHaveBeenCalledTimes(2);
	});

	it("calls simulateCart again for a different items composition", async () => {
		await getShippingSimulation(props);
		await getShippingSimulation({ ...props, items: [{ id: "2", quantity: 1, seller: "1" }] });
		expect(simulateCartMock).toHaveBeenCalledTimes(2);
	});

	it("is order-insensitive for the items array (same composition, different order)", async () => {
		const twoItems = {
			...props,
			items: [
				{ id: "1", quantity: 1, seller: "1" },
				{ id: "2", quantity: 2, seller: "1" },
			],
		};
		const reordered = {
			...props,
			items: [
				{ id: "2", quantity: 2, seller: "1" },
				{ id: "1", quantity: 1, seller: "1" },
			],
		};
		await getShippingSimulation(twoItems);
		await getShippingSimulation(reordered);
		expect(simulateCartMock).toHaveBeenCalledTimes(1);
	});

	it("varies the cache key by salesChannel (different sc → different simulation)", async () => {
		await getShippingSimulation(props);
		configureVtex({ account: "acme", salesChannel: "2" });
		await getShippingSimulation(props);
		expect(simulateCartMock).toHaveBeenCalledTimes(2);
	});

	it("the cached response never carries cookies — only the plain JSON body", async () => {
		const result = await getShippingSimulation(props);
		expect(result).not.toHaveProperty("headers");
		expect(JSON.stringify(result)).not.toContain("set-cookie");
	});
});

describe("cartShipping (drawer loader, built on getShippingSimulation)", () => {
	beforeEach(() => {
		configureVtex({ account: "acme", salesChannel: "1" });
		__resetSimulationCacheForTests();
		simulateCartMock.mockClear();
	});

	afterEach(() => {
		__resetSimulationCacheForTests();
	});

	const props = {
		items: [{ id: "1", quantity: 1, seller: "1" }],
		postalCode: "01310-100",
	};

	it("returns empty options when items or postalCode are missing", async () => {
		expect(await cartShipping({ items: [], postalCode: "" })).toEqual({
			postalCode: "",
			options: [],
		});
	});

	it("normalizes SLAs from the (cached) simulation into a de-duplicated option list", async () => {
		const result = await cartShipping(props);
		expect(result.postalCode).toBe(props.postalCode);
		expect(result.options).toHaveLength(1);
		expect(result.options[0].id).toBe("sla-1");
	});

	it("shares the underlying simulation cache — a second call does not re-simulate", async () => {
		await cartShipping(props);
		await cartShipping(props);
		expect(simulateCartMock).toHaveBeenCalledTimes(1);
	});
});
