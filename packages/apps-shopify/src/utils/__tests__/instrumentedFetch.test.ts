/**
 * Smoke tests for the pre-wired Shopify fetch factory. Same wiring
 * assertions as `vtex/utils/__tests__/instrumentedFetch.test.ts`.
 */

import { configureMeter, type MeterAdapter } from "@decocms/blocks/sdk/observability";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShopifyFetch } from "../instrumentedFetch";

type Labels = Record<string, string | number | boolean>;

function captureHistogram(): {
	calls: { name: string; value: number; attrs: Labels }[];
	meter: MeterAdapter;
} {
	const calls: { name: string; value: number; attrs: Labels }[] = [];
	const meter: MeterAdapter = {
		counterInc: vi.fn(),
		gaugeSet: vi.fn(),
		histogramRecord: (name, value, attrs) => {
			calls.push({ name, value, attrs: attrs ?? {} });
		},
	};
	return { calls, meter };
}

describe("createShopifyFetch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		configureMeter({
			counterInc: () => {},
			gaugeSet: () => {},
			histogramRecord: () => {},
		});
	});

	it("emits http.client.request.duration with provider=shopify on success", async () => {
		const { calls, meter } = captureHistogram();
		configureMeter(meter);

		const baseFetch = vi.fn(async () => new Response("{}", { status: 200 }));
		const fetchFn = createShopifyFetch({ baseFetch: baseFetch as typeof fetch });

		await fetchFn("https://store.myshopify.com/api/2025-04/graphql.json", { method: "POST" });

		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("http.client.request.duration");
		expect(calls[0].attrs).toMatchObject({
			provider: "shopify",
			operation: "storefront.graphql",
			status_class: "2xx",
		});
	});

	it("honors init.operation (used by the GraphQL client to stamp <OperationName>)", async () => {
		const { calls, meter } = captureHistogram();
		configureMeter(meter);

		const baseFetch = vi.fn(async () => new Response("{}", { status: 200 }));
		const fetchFn = createShopifyFetch({ baseFetch: baseFetch as typeof fetch });

		await fetchFn("https://store.myshopify.com/api/2025-04/graphql.json", {
			method: "POST",
			operation: "ProductBySlug",
		});

		expect(calls[0].attrs.operation).toBe("ProductBySlug");
	});

	it("skips histogram emission when disableHistogram is true", async () => {
		const { calls, meter } = captureHistogram();
		configureMeter(meter);

		const baseFetch = vi.fn(async () => new Response("{}", { status: 200 }));
		const fetchFn = createShopifyFetch({
			baseFetch: baseFetch as typeof fetch,
			disableHistogram: true,
		});

		await fetchFn("https://store.myshopify.com/api/2025-04/graphql.json", { method: "POST" });

		expect(calls).toHaveLength(0);
	});
});
